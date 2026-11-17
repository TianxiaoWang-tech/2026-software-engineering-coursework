/**
 * mobile/entry/src/main/ets/net/GatewayClient.ets
 * 双端通信客户端：WebSocket + X25519 协商 + 信封加密。
 * 协议与 gateway/services/ws-client.mjs 完全对称。
 *
 * ⚠️ 未在本机编译验证（缺 OpenHarmony SDK）；上真机需确认 webSocket 的
 *    send/on('message') 回调字段名（当前按 API 12 的 webSocket.MessageEvent 编写）。
 */

import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { Envelope, ApiResponse, ControlParams, LoginParams } from '../model/Types';
import { generateX25519, deriveSecret, deriveSessionKey, seal, open, base64ToBytes, bytesToBase64 } from './crypto';

const TEXT_ENCODER = new util.TextEncoder();
const TEXT_DECODER = util.TextDecoder.create('utf-8');

/** ArkTS 不允许用对象字面量声明类型，改为 interface */
interface Pending {
  resolve: (value: ApiResponse<Object>) => void;
  reject: (err: Error) => void;
  timer: number;
}

/** 加密前的请求体（显式声明，避免裸字面量） */
interface RequestBody {
  method: string;
  params: Object;
  token: string;
}

/** 推送帧（服务端主动下发，如 device.changed） */
interface PushEvent {
  event: string;
  at: number;
  data: Object;
}

export class GatewayClient {
  private ws: webSocket.WebSocket | null = null;
  private key: Uint8Array | null = null;
  private seq: number = 0;
  private token: string = '';
  private pending: Map<string, Pending> = new Map();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  /** 状态变化/告警推送回调（HomePage 订阅后实时刷新） */
  public onEvent: ((event: string, data: Object) => void) | null = null;

  get isReady(): boolean {
    return this.key !== null;
  }

  get authToken(): string {
    return this.token;
  }

  /** 连接并完成密钥协商；成功后所有报文均为密文 */
  connect(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const ws = webSocket.createWebSocket();
      this.ws = ws;

      ws.on('open', async () => {
        try {
          const kp = await generateX25519();
          this.privateKey = kp.sk;
          this.publicKey = kp.pubRaw;
          ws.send(JSON.stringify({ type: 'hello', pubKey: bytesToBase64(kp.pubRaw) }));
          console.info('[GW] hello 已发送 pubKey=' + bytesToBase64(kp.pubRaw));
        } catch (e) {
          console.error('[GW] 密钥生成失败: ' + (e as Error).message);
          reject(new Error(`密钥生成失败: ${(e as Error).message}`));
        }
      });

      // [已按 API 26 d.ts 核对] on('message', AsyncCallback<string | ArrayBuffer>)：
      // 回调签名是 (err, data)，不是 MessageEvent 对象。
      ws.on('message', (err: BusinessError, data: string | ArrayBuffer) => {
        if (err) {
          return;
        }
        const text = typeof data === 'string' ? data : TEXT_DECODER.decodeToString(new Uint8Array(data));
        this.onText(text);
      });

      ws.on('error', (err: BusinessError) => {
        this.readyReject?.(new Error(`WebSocket 错误: ${err.message}`));
      });

      ws.on('close', () => {
        this.key = null;
      });

      ws.connect(url, (err: BusinessError) => {
        if (err) reject(new Error(`连接失败: ${err.code} ${err.message}`));
      });
    });
  }

  private privateKey: bigint | null = null;
  private publicKey: Uint8Array | null = null;

  private async onText(text: string): Promise<void> {
    let msg: Record<string, Object>;
    try {
      msg = JSON.parse(text) as Record<string, Object>;
    } catch {
      return;
    }

    const type = msg.type as string | undefined;
    if (type === 'hello_ack') {
      const serverPub = base64ToBytes(msg.pubKey as string);
      const salt = base64ToBytes(msg.salt as string);
      console.info('[GW] hello_ack serverPub=' + (msg.pubKey as string) + ' salt=' + (msg.salt as string));
      const secret = await deriveSecret(this.privateKey!, serverPub);
      this.key = await deriveSessionKey(secret, salt);
      console.info('[GW] 会话密钥已派生');
      this.readyResolve?.();
      return;
    }

    if (type === 'error') {
      this.readyReject?.(new Error(msg.message as string));
      return;
    }

    const envelope: Envelope = JSON.parse(text) as Envelope;
    if (envelope.v !== 1 || !envelope.payload) {
      console.warn('[GW] 非法信封');
      return;
    }
    console.info('[GW] 收到帧 kind=' + envelope.kind + ' id=' + envelope.id + ' seq=' + envelope.seq);

    const aad = TEXT_ENCODER.encodeInto(`${envelope.id}:${envelope.seq}`);
    let body: Uint8Array;
    try {
      body = await open(this.key!, { nonce: base64ToBytes(envelope.nonce), payload: base64ToBytes(envelope.payload) }, aad);
    } catch (e) {
      console.error('[GW] 解密失败: ' + (e as Error).message);
      return; // 解密失败：报文被篡改或密钥不匹配，静默丢弃
    }
    const bodyText = TEXT_DECODER.decodeToString(body);

    if (envelope.kind === 'evt') {
      const evt: PushEvent = JSON.parse(bodyText) as PushEvent;
      this.onEvent?.(evt.event, evt.data);
      return;
    }

    const parsed: ApiResponse<Object> = JSON.parse(bodyText) as ApiResponse<Object>;
    const waiter = this.pending.get(envelope.id);
    if (waiter) {
      this.pending.delete(envelope.id);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    }
  }

  /** 发送加密请求（params 必须是显式类型的对象，ArkTS 不接受裸字面量） */
  async request<T>(method: string, params?: Object): Promise<ApiResponse<T>> {
    if (!this.key || !this.ws) throw new Error('尚未完成密钥协商');

    const id = util.generateRandomUUID(false);
    // ⚠️ 必须先把序号取成局部常量：seal() 是异步的，若期间别的请求把 this.seq 递增，
    // 信封里带的 seq 就会与 AAD 用的 seq 不一致，网关侧 GCM 校验必然失败（实测 seq=4 偶发）。
    const seq: number = this.seq + 1;
    this.seq = seq;
    const aad = TEXT_ENCODER.encodeInto(`${id}:${seq}`);
    const bodyObj: RequestBody = {
      method: method,
      params: params ?? new Object(),
      token: this.token,
    };
    const body = TEXT_ENCODER.encodeInto(JSON.stringify(bodyObj));
    const sealed = await seal(this.key, body, aad);

    const envelope: Envelope = {
      v: 1,
      id,
      seq: seq,
      kind: 'req',
      nonce: bytesToBase64(sealed.nonce),
      payload: bytesToBase64(sealed.payload),
    };

    const promise = new Promise<ApiResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, 8000);
      const p: Pending = {
        resolve: resolve as (value: ApiResponse<Object>) => void,
        reject: reject,
        timer: timer as number,
      };
      this.pending.set(id, p);
    });

    this.ws.send(JSON.stringify(envelope));
    console.info('[GW] 请求已发送 ' + method + ' id=' + id + ' seq=' + this.seq);
    return promise;
  }

  async login(name: string, password: string): Promise<boolean> {
    const params: LoginParams = { name: name, password: password };
    const res = await this.request<Record<string, Object>>('auth.login', params);
    if (res.ok && res.data) {
      this.token = res.data['token'] as string;
      return true;
    }
    return false;
  }

  async loadDevices(): Promise<Object | undefined> {
    const res = await this.request<Object>('device.list');
    return res.data;
  }

  async control(deviceId: string, capability: string, value: boolean | number | string): Promise<ApiResponse<Object>> {
    const params: ControlParams = { deviceId: deviceId, capability: capability, value: value };
    return this.request<Object>('control.set', params);
  }

  close(): void {
    this.ws?.close({ code: 1000, reason: 'bye' });
    this.ws = null;
    this.key = null;
  }
}

/** 全局单例：页面之间共享同一条加密连接 */
export const gateway = new GatewayClient();
