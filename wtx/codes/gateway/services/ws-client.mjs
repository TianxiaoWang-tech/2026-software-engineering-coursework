/**
 * gateway/services/ws-client.mjs
 * 双端通信的参考客户端（C 在 ArkTS 侧按同一协议实现）。
 *
 * 用途：自动化测试、命令行演示、以及给前端同学的对端实现参照。
 * 与 ws.mjs 对称：HTTP Upgrade → ECDH 握手 → 信封加密请求/响应。
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { seal, open } from '../security/crypto.mjs';
import { generateX25519KeyPair, deriveX25519Secret, deriveSessionKey } from '../security/x25519.mjs';
import { randomToken } from '../security/crypto.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeMaskedText(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];

  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
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
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), totalLength: offset + len };
}

export class GatewayClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 8765, logger = null } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.key = null;
    this.seq = 0;
    this.pending = new Map();
    this.token = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      const wsKey = crypto.randomBytes(16).toString('base64');

      const onError = (err) => reject(err);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      let handshakeDone = false;
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        if (!handshakeDone) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = this.buffer.subarray(0, end).toString('utf8');
          if (!head.includes('101')) {
            reject(new Error(`WebSocket 握手失败: ${head.split('\r\n')[0]}`));
            return;
          }
          const expected = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
          if (!head.includes(expected)) {
            reject(new Error('Sec-WebSocket-Accept 校验失败'));
            return;
          }
          handshakeDone = true;
          this.buffer = this.buffer.subarray(end + 4);
        }

        for (;;) {
          const frame = decodeServerFrame(this.buffer);
          if (!frame) break;
          this.buffer = this.buffer.subarray(frame.totalLength);
          if (frame.opcode === 0x01) this.onText(frame.payload.toString('utf8'));
          else if (frame.opcode === 0x08) this.close();
        }
      });

      socket.once('close', () => reject(new Error('连接已关闭')));
      socket.on('error', () => this.close());

      // 握手完成后做 ECDH（X25519，32 字节原始公钥）
      const { publicKeyRaw, privateKey } = generateX25519KeyPair();
      this.kp = { publicKeyRaw, privateKey };
      this.publicKeyRaw = publicKeyRaw;

      const waitHello = setInterval(() => {
        if (!handshakeDone) return;
        clearInterval(waitHello);
        socket.write(encodeMaskedText(JSON.stringify({ type: 'hello', pubKey: this.publicKeyRaw.toString('base64') })));
      }, 5);
      if (typeof waitHello.unref === 'function') waitHello.unref();

      this.once('ready', (info) => {
        socket.removeListener('error', onError);
        socket.on('close', () => reject(new Error('连接已关闭')));
        resolve(info);
      });
      this.once('fail', (err) => reject(err));
      setTimeout(() => reject(new Error('握手超时')), 5000).unref?.();
    });
  }

  onText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === 'hello_ack') {
      try {
        const serverPub = Buffer.from(msg.pubKey, 'base64');
        const secret = deriveX25519Secret(this.kp.privateKey, serverPub);
        const salt = Buffer.from(msg.salt, 'base64');
        this.key = deriveSessionKey(secret, salt);
        this.emit('ready', { fingerprint: msg.fingerprint, salt: msg.salt });
      } catch (err) {
        this.emit('fail', err);
      }
      return;
    }

    if (msg.type === 'error') {
      this.emit('fail', new Error(msg.message));
      return;
    }

    // 信封
    if (msg.v === 1 && msg.payload) {
      let body;
      try {
        body = open(this.key, msg, { aad: `${msg.id}:${msg.seq}` });
      } catch (err) {
        this.logger?.warn(`client decrypt failed: ${err.message}`);
        return;
      }
      if (msg.kind === 'evt') {
        this.emit('event', body);
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter.resolve(body);
      }
    }
  }

  async request(method, params = {}, token = this.token) {
    if (!this.key) throw new Error('尚未完成密钥协商');
    const id = randomToken(8);
    this.seq += 1;
    const aad = `${id}:${this.seq}`;
    const { nonce, payload } = seal(this.key, { method, params, token }, { aad });
    const frame = { v: 1, id, seq: this.seq, kind: 'req', nonce, payload };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, 8000);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });

    this.socket.write(encodeMaskedText(JSON.stringify(frame)));
    return promise;
  }

  async login(name, password) {
    const res = await this.request('auth.login', { name, password }, null);
    if (res.ok) this.token = res.data.token;
    return res;
  }

  close() {
    this.socket?.end();
    this.socket = null;
    this.key = null;
  }
}
