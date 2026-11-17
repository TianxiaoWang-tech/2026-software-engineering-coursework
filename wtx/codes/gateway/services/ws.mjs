/**
 * gateway/services/ws.mjs
 * 双端通信服务端：WebSocket（RFC6455 最小实现）+ ECDH 密钥交换 + 信封加密。
 *
 * 三层加密在链路上的落点（NFR-9 / AT-08）：
 *   传输层：TLS（配置证书时启用；参考实现默认明文跑测试，生产必须开）
 *   数据层：每条业务报文用会话密钥 AES-256-GCM 加密（Envelope.payload）
 *   密钥层：会话密钥由 ECDH(X25519) 协商 + HKDF 派生，一次连接一把，不落盘
 *
 * 握手：
 *   C → S  { type:'hello', pubKey }
 *   S → C  { type:'hello_ack', pubKey, salt, fingerprint }
 *   之后所有帧为 Envelope（密文）
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { EventEmitter } from 'node:events';
import { AppError, ErrorCode } from '../core/errors.mjs';
import { seal, open } from '../security/crypto.mjs';
import { generateX25519KeyPair, deriveX25519Secret, deriveSessionKey } from '../security/x25519.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------- RFC6455 帧编解码 ------------------------- */

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode，服务端不加掩码
  return Buffer.concat([header, payload]);
}

export function encodeText(text) {
  return encodeFrame(0x01, Buffer.from(text, 'utf8'));
}

/** 客户端→服务端帧带掩码，必须解掩码 */
export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) === 0x80;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  let payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { fin, opcode, payload, totalLength: offset + len };
}

/* ------------------------------ 服务端 ------------------------------ */

export class GatewayWsServer extends EventEmitter {
  constructor({ api, app, logger = null, host = '127.0.0.1', port = 8765, tls = null }) {
    super();
    this.api = api;
    this.app = app;
    this.logger = logger;
    this.host = host;
    this.port = port;
    this.tls = tls;
    this.server = null;
    this.connections = new Set();
    this.sockets = new Set();
  }

  async listen() {
    const handler = (req, socket) => this.onUpgrade(req, socket);
    this.server = this.tls
      ? (await import('node:https')).createServer({ key: this.tls.key, cert: this.tls.cert })
      : http.createServer();
    this.server.on('upgrade', handler);
    this.server.on('request', (req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('此端口仅接受 WebSocket 连接');
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    this.logger?.info(`ws server listening on ${this.tls ? 'wss' : 'ws'}://${this.host}:${this.port}`);
    return { host: this.host, port: this.port, secure: Boolean(this.tls) };
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.connections.clear();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const conn = {
      socket,
      buffer: Buffer.alloc(0),
      key: null, // 会话密钥，握手完成后才有
      seq: 0,
      lastClientSeq: -1,
      authed: false,
      unsubscribe: null,
      alive: true,
    };
    this.connections.add(conn);
    this.sockets.add(socket);

    socket.on('data', (chunk) => this.onData(conn, chunk));
    socket.on('close', () => {
      this.connections.delete(conn);
      this.sockets.delete(socket);
      conn.unsubscribe?.();
      this.emit('disconnect');
    });
    socket.on('error', () => socket.destroy());
  }

  onData(conn, chunk) {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(conn.buffer);
      if (!frame) break;
      conn.buffer = conn.buffer.subarray(frame.totalLength);
      if (frame.opcode === 0x08) {
        conn.socket.end(encodeFrame(0x08));
        return;
      }
      if (frame.opcode === 0x09) {
        conn.socket.write(encodeFrame(0x0a, frame.payload));
        continue;
      }
      if (frame.opcode === 0x01) {
        this.onText(conn, frame.payload.toString('utf8')).catch((err) => {
          this.logger?.error(`ws handler error: ${err.message}`);
        });
      }
    }
  }

  async onText(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.sendRaw(conn, { type: 'error', code: 'BAD_PARAMS', message: 'JSON 解析失败' });
    }

    // 握手阶段
    if (msg.type === 'hello') {
      // X25519：公钥为 32 字节原始值，与 HarmonyOS cryptoFramework 的表示一致
      const { publicKeyRaw, privateKey } = generateX25519KeyPair();
      const secret = deriveX25519Secret(privateKey, Buffer.from(msg.pubKey, 'base64'));
      const salt = crypto.randomBytes(16);
      conn.key = deriveSessionKey(secret, salt);
      conn.salt = salt.toString('base64');
      let fingerprint = null;
      try {
        fingerprint = this.app.keystore?.fingerprint ?? null;
      } catch (err) {
        this.logger?.warn(`keystore fingerprint unavailable: ${err.message}`);
      }
      return this.sendRaw(conn, {
        type: 'hello_ack',
        pubKey: publicKeyRaw.toString('base64'),
        salt: conn.salt,
        fingerprint,
        protocolVersion: 1,
      });
    }

    if (!conn.key) {
      return this.sendRaw(conn, { type: 'error', code: 'UNAUTHORIZED', message: '请先完成密钥协商' });
    }

    // 解密信封
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    if (envelope.v !== 1 || !envelope.nonce || !envelope.payload) {
      return this.sendEnvelope(conn, envelope.id, { ok: false, code: 'BAD_PARAMS', message: '信封格式错误' });
    }
    if (typeof envelope.seq !== 'number' || envelope.seq <= conn.lastClientSeq) {
      // 防重放（FR-7.4）
      return this.sendEnvelope(conn, envelope.id, { ok: false, code: 'REPLAY', message: '重放报文被拒绝' });
    }
    conn.lastClientSeq = envelope.seq;

    let request;
    try {
      request = open(conn.key, envelope, { aad: `${envelope.id}:${envelope.seq}` });
      this.logger?.debug?.(`信封解密成功 method=${request.method} id=${envelope.id} seq=${envelope.seq}`);
    } catch (err) {
      this.logger?.warn(`信封解密失败：${err.message}（id=${envelope.id} seq=${envelope.seq} 长度=${envelope.payload.length}）`);
      return this.sendEnvelope(conn, envelope.id, { ok: false, code: 'BAD_PARAMS', message: '解密失败或报文被篡改' });
    }

    // 分发
    let response;
    try {
      const result = await this.api.call(request);
      response = { ok: true, data: result.data };
      if (request.method === 'auth.login') {
        conn.authed = true;
        this.subscribePush(conn);
      }
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError(err.message, { code: ErrorCode.INTERNAL });
      response = { ok: false, code: appErr.code, message: appErr.message };
    }
    this.sendEnvelope(conn, envelope.id, response);
  }

  /** 登录后推送状态变化与告警（移动端无需轮询） */
  subscribePush(conn) {
    if (conn.unsubscribe) return;
    const bus = this.app.bus;
    const forward = (event) => {
      if (!conn.alive) return;
      const name = { state_changed: 'state.changed', availability: 'device.availability', alarm: 'alarm.push', scene_executed: 'scene.executed' }[event.type];
      if (!name) return;
      this.sendEnvelope(conn, `evt_${Date.now()}`, { event: name, at: event.at, data: event.data }, 'evt');
    };
    const offs = ['state_changed', 'availability', 'alarm', 'scene_executed'].map((t) => bus.on(t, forward));
    conn.unsubscribe = () => offs.forEach((off) => off());
  }

  sendRaw(conn, obj) {
    if (conn.socket.destroyed) return;
    conn.socket.write(encodeText(JSON.stringify(obj)));
  }

  /** 加密后发送 */
  sendEnvelope(conn, id, body, kind = 'res') {
    if (!conn.key || conn.socket.destroyed) return;
    conn.seq += 1;
    const aad = `${id}:${conn.seq}`;
    const { nonce, payload } = seal(conn.key, body, { aad });
    this.sendRaw(conn, { v: 1, id, seq: conn.seq, kind, nonce, payload });
  }
}

/** 解析 tls 配置：证书文件存在才启用 */
export function loadTlsConfig({ keyPath, certPath }) {
  if (!keyPath || !certPath) return null;
  return { key: keyPath, cert: certPath };
}

export { URL };
