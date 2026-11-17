/**
 * gateway/drivers/mqtt/broker.mjs
 * 内置轻量 MQTT Broker（用于局域网部署与自动化测试）。
 *
 * 赛题允许自选实现，内置 Broker 的好处：网关单机即可演示，
 * 不依赖 mosquitto 安装；生产环境可替换为任意标准 Broker。
 *
 * 支持：CONNECT/CONNACK、SUBSCRIBE/SUBACK、PUBLISH(QoS 0/1)、
 *       PUBACK、PINGREQ/PINGRESP、DISCONNECT、遗嘱消息、保留消息、通配符。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import * as p from './packet.mjs';

export class MqttBroker extends EventEmitter {
  constructor({ port = 1883, host = '127.0.0.1', logger = null } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.logger = logger;
    this.server = null;
    /** @type {Set<any>} */
    this.sessions = new Set();
    /** @type {Map<string, {payload: Buffer, qos: number}>} 保留消息 */
    this.retained = new Map();
    this.packetId = 1;
    this.stats = { connections: 0, published: 0, delivered: 0 };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.logger?.info(`MQTT broker listening on ${this.host}:${this.port}`);
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const s of this.sessions) s.socket.destroy();
      this.sessions.clear();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  nextPacketId() {
    const id = this.packetId;
    this.packetId = this.packetId >= 0xffff ? 1 : this.packetId + 1;
    return id;
  }

  handleConnection(socket) {
    socket.setNoDelay(true);
    const session = {
      id: `c${this.stats.connections + 1}`,
      socket,
      parser: new p.PacketParser(),
      clientId: null,
      will: null,
      clean: true,
      subs: new Map(),
      closed: false,
      keepalive: 60,
    };
    this.stats.connections += 1;
    this.sessions.add(session);

    socket.on('data', (chunk) => {
      let packets;
      try {
        packets = session.parser.push(chunk);
      } catch (err) {
        this.logger?.warn(`broker parse error: ${err.message}`);
        socket.destroy();
        return;
      }
      for (const pkt of packets) this.handlePacket(session, pkt);
    });

    socket.on('close', () => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(session);
      // 非正常断开：发布遗嘱（FR-1.7 离线检测依赖此机制）
      if (session.will) {
        this.logger?.debug(`publishing will for ${session.clientId}`);
        this.route(session.will.topic, Buffer.from(session.will.payload ?? ''), {
          qos: session.will.qos ?? 0,
          retain: session.will.retain ?? false,
          from: session,
        });
      }
      this.emit('disconnect', { clientId: session.clientId });
    });

    socket.on('error', () => {
      /* 连接级错误由 close 统一处理 */
    });
  }

  handlePacket(session, { type, flags, body }) {
    switch (type) {
      case p.T.CONNECT: {
        const info = p.decodeConnect(body);
        session.clientId = info.clientId;
        session.will = info.will;
        session.clean = info.clean;
        session.keepalive = info.keepalive;
        session.socket.write(p.buildConnack({ sessionPresent: false, code: 0 }));
        this.logger?.debug(`broker: ${info.clientId} connected`);
        this.emit('connect', { clientId: info.clientId });
        return;
      }
      case p.T.SUBSCRIBE: {
        const { packetId, subs } = p.decodeSubscribe(body);
        const granted = [];
        for (const s of subs) {
          session.subs.set(s.filter, s.qos);
          granted.push(s.qos);
        }
        session.socket.write(p.buildSuback({ packetId, granted }));
        // 仅对本次订阅涉及的过滤器补发保留消息，避免重复投递
        for (const s of subs) {
          for (const [topic, rec] of this.retained) {
            if (p.topicMatches(s.filter, topic)) {
              this.deliver(session, topic, rec.payload, Math.min(rec.qos, s.qos ?? 0), true);
            }
          }
        }
        return;
      }
      case p.T.PUBLISH: {
        const msg = p.decodePublish(flags, body);
        this.stats.published += 1;
        if (msg.qos === 1) session.socket.write(p.buildPuback(msg.packetId));
        this.route(msg.topic, msg.payload, { qos: msg.qos, retain: msg.retain, from: session });
        return;
      }
      case p.T.PINGREQ:
        session.socket.write(p.buildPingresp());
        return;
      case p.T.DISCONNECT:
        session.closed = true;
        session.will = null; // 正常断开不触发遗嘱
        session.socket.end();
        return;
      default:
        this.logger?.debug(`broker: unhandled packet ${type}`);
    }
  }

  /** 按订阅关系分发 */
  route(topic, payload, { qos = 0, retain = false, from = null } = {}) {
    if (retain) {
      if (payload.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, { payload, qos });
    }
    for (const session of this.sessions) {
      if (session.closed || session === from) continue;
      for (const [filter, subQos] of session.subs) {
        if (p.topicMatches(filter, topic)) {
          this.deliver(session, topic, payload, Math.min(qos, subQos), false);
          break;
        }
      }
    }
    this.emit('message', { topic, payload, qos });
  }

  deliver(session, topic, payload, qos, retain) {
    const packetId = qos > 0 ? this.nextPacketId() : undefined;
    try {
      session.socket.write(p.buildPublish({ topic, payload, qos, retain, packetId }));
      this.stats.delivered += 1;
    } catch (err) {
      this.logger?.warn(`deliver failed: ${err.message}`);
    }
  }
}
