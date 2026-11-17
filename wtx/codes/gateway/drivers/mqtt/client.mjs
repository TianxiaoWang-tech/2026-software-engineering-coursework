/**
 * gateway/drivers/mqtt/client.mjs
 * 最小 MQTT 3.1.1 客户端（QoS 0/1、遗嘱、心跳、自动重连由驱动层负责）。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import * as p from './packet.mjs';

export class MqttClient extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port = 1883,
    clientId = `gw_${Math.random().toString(16).slice(2, 10)}`,
    keepalive = 30,
    will = null,
    username,
    password,
    connectTimeoutMs = 5000,
    logger = null,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.keepalive = keepalive;
    this.will = will;
    this.username = username;
    this.password = password;
    this.connectTimeoutMs = connectTimeoutMs;
    this.logger = logger;

    this.socket = null;
    this.parser = new p.PacketParser();
    this.state = 'idle';
    this.nextPacketId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:any}>} */
    this.pending = new Map();
    this.keepaliveTimer = null;
    this.subscriptions = new Map();
  }

  connect() {
    if (this.state === 'connected') return Promise.resolve(this);
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy();
        this.state = 'closed';
        reject(new Error(`MQTT connect timeout (${this.host}:${this.port})`));
      }, this.connectTimeoutMs);

      socket.on('connect', () => {
        socket.write(
          p.buildConnect({
            clientId: this.clientId,
            keepalive: this.keepalive,
            will: this.will ?? undefined,
            username: this.username,
            password: this.password,
          }),
        );
      });

      socket.on('data', (chunk) => {
        let packets;
        try {
          packets = this.parser.push(chunk);
        } catch (err) {
          this.logger?.error(`mqtt parse error: ${err.message}`);
          socket.destroy();
          return;
        }
        for (const pkt of packets) this.handlePacket(pkt, { timer, resolve, reject });
      });

      socket.on('close', () => {
        clearTimeout(timer);
        this.stopKeepalive();
        this.failPending(new Error('MQTT connection closed'));
        if (this.state !== 'closed') {
          this.state = 'closed';
          this.emit('close');
        }
      });

      socket.on('error', (err) => {
        this.logger?.warn(`mqtt socket error: ${err.message}`);
        if (this.state === 'connecting') {
          clearTimeout(timer);
          this.state = 'closed';
          reject(err);
          return;
        }
        // 没有监听者时不能 emit('error')，否则 Node 会抛未捕获异常
        if (this.listenerCount('error') > 0) this.emit('error', err);
      });
    });
  }

  handlePacket({ type, flags, body }, ctx) {
    switch (type) {
      case p.T.CONNACK: {
        const { code } = p.decodeConnack(body);
        if (code !== 0) {
          ctx.reject(new Error(`MQTT CONNACK refused: code=${code}`));
          return;
        }
        clearTimeout(ctx.timer);
        this.state = 'connected';
        this.startKeepalive();
        this.emit('connect');
        ctx.resolve(this);
        return;
      }
      case p.T.PUBLISH: {
        const msg = p.decodePublish(flags, body);
        if (msg.qos === 1 && msg.packetId) this.socket.write(p.buildPuback(msg.packetId));
        this.emit('message', msg);
        return;
      }
      case p.T.PUBACK: {
        const packetId = body.readUInt16BE(0);
        this.settle(packetId);
        return;
      }
      case p.T.SUBACK: {
        const { packetId, granted } = p.decodeSuback(body);
        this.settle(packetId, granted);
        return;
      }
      case p.T.PINGRESP:
        return;
      default:
        this.logger?.debug(`mqtt unhandled packet type ${type}`);
    }
  }

  settle(packetId, value) {
    const entry = this.pending.get(packetId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(packetId);
    entry.resolve(value);
  }

  takePacketId() {
    const id = this.nextPacketId;
    this.nextPacketId = this.nextPacketId >= 0xffff ? 1 : this.nextPacketId + 1;
    return id;
  }

  waitFor(packetId, label, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId);
        reject(new Error(`${label} timeout`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(packetId, { resolve, reject, timer });
    });
  }

  startKeepalive() {
    this.stopKeepalive();
    const period = Math.max(5, this.keepalive / 2) * 1000;
    this.keepaliveTimer = setInterval(() => {
      if (this.state === 'connected') this.socket?.write(p.buildPingreq());
    }, period);
    if (typeof this.keepaliveTimer.unref === 'function') this.keepaliveTimer.unref();
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  failPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  async subscribe(filter, qos = 1) {
    if (this.state !== 'connected') throw new Error('MQTT not connected');
    const packetId = this.takePacketId();
    const wait = this.waitFor(packetId, `SUBSCRIBE ${filter}`);
    this.socket.write(p.buildSubscribe({ packetId, subs: [{ filter, qos }] }));
    const granted = await wait;
    this.subscriptions.set(filter, qos);
    return granted;
  }

  /** QoS 0 立即返回；QoS 1 等待 PUBACK */
  async publish(topic, payload, { qos = 0, retain = false } = {}) {
    if (this.state !== 'connected') throw new Error('MQTT not connected');
    const packetId = qos > 0 ? this.takePacketId() : undefined;
    const buf = p.buildPublish({ topic, payload, qos, retain, packetId });
    if (qos === 0) {
      this.socket.write(buf);
      return;
    }
    const wait = this.waitFor(packetId, `PUBLISH ${topic}`);
    this.socket.write(buf);
    await wait;
  }

  /** 正常断开（不触发遗嘱） */
  end() {
    this.stopKeepalive();
    this.state = 'closed';
    try {
      this.socket?.write(p.buildDisconnect());
      this.socket?.end();
    } catch {
      /* 忽略 */
    }
  }

  /** 强制断开（对端会收到遗嘱，用于测试离线检测） */
  destroy() {
    this.stopKeepalive();
    this.state = 'closed';
    this.socket?.destroy();
  }
}
