/**
 * gateway/drivers/mqtt/driver.mjs
 * MQTT 设备驱动：把 MQTT 主题语义翻译成驱动 SPI 的语义。
 *
 * 主题约定（见 SRS 5.3 / contracts）：
 *   home/discovery                 设备宣告（retain）        → emitDiscovered
 *   home/<id>/state                状态上报                  → emitState
 *   home/<id>/set                  控制指令（网关→设备）
 *   home/<id>/ack                  指令回执                  → 完成 set() 的等待
 *   home/<id>/availability         online/offline（LWT）      → emitAvailability
 */

import { AppError, ErrorCode, FailReason } from '../../core/errors.mjs';
import { MqttClient } from './client.mjs';
import { randomId } from '../../security/crypto.mjs';

const isCategory = (v) => ['light', 'ac', 'sensor', 'lock'].includes(v);

export class MqttDriver {
  constructor({
    host = '127.0.0.1',
    port = 1883,
    clientId = `gw-${randomId().slice(0, 6)}`,
    ackTimeoutMs = 5000,
    logger = null,
  } = {}) {
    this.id = 'mqtt';
    this.protocols = ['mqtt'];
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.ackTimeoutMs = ackTimeoutMs;
    this.logger = logger;

    this.client = null;
    this.ctx = null;
    /** @type {Map<string, any>} 已接管设备 */
    this.devices = new Map();
    /** @type {Map<string, {resolve:Function, reject:Function, timer:any}>} msgId -> waiter */
    this.pendingAcks = new Map();
  }

  async start(ctx) {
    this.ctx = ctx;
    const client = new MqttClient({
      host: this.host,
      port: this.port,
      clientId: this.clientId,
      keepalive: 20,
      will: { topic: `gateway/${this.clientId}/availability`, payload: 'offline', qos: 1, retain: true },
      logger: this.logger,
    });
    this.client = client;
    client.on('message', (msg) => this.handleMessage(msg));
    client.on('close', () => this.logger?.warn('mqtt driver connection closed'));

    await client.connect();
    await client.subscribe('home/discovery/+', 1);
    await client.subscribe('home/+/state', 1);
    await client.subscribe('home/+/availability', 1);
    await client.subscribe('home/+/ack', 1);
    await client.publish(`gateway/${this.clientId}/availability`, 'online', { qos: 1, retain: true });
    this.logger?.info(`mqtt driver connected to ${this.host}:${this.port}`);
  }

  async stop() {
    for (const [, waiter] of this.pendingAcks) {
      clearTimeout(waiter.timer);
      waiter.reject(new AppError('driver stopping', { code: ErrorCode.INTERNAL }));
    }
    this.pendingAcks.clear();
    try {
      await this.client?.publish(`gateway/${this.clientId}/availability`, 'offline', { qos: 1, retain: true });
    } catch {
      /* 忽略 */
    }
    this.client?.end();
    this.client = null;
  }

  handleMessage({ topic, payload }) {
    const text = payload.toString('utf8');
    const parts = topic.split('/');

    // 每台设备一个 discovery 主题（retain 才不会被互相覆盖）
    if (topic.startsWith('home/discovery/')) {
      let info;
      try {
        info = JSON.parse(text);
      } catch {
        this.logger?.warn('bad discovery payload');
        return;
      }
      if (!info?.id) return;
      this.ctx.emitDiscovered({
        id: String(info.id),
        name: info.name ?? String(info.id),
        category: isCategory(info.category) ? info.category : 'sensor',
        brand: info.brand,
        model: info.model,
        protocol: 'mqtt',
        driver: this.id,
        areaId: info.areaId,
        capabilities: info.capabilities ?? [],
        vendorRef: { topicPrefix: `home/${info.id}` },
      });
      return;
    }

    const [, deviceId, kind] = parts;
    if (!deviceId) return;

    if (kind === 'state') {
      let state;
      try {
        state = JSON.parse(text);
      } catch {
        this.logger?.warn(`bad state payload from ${deviceId}`);
        return;
      }
      const { ts, ...values } = state;
      this.ctx.emitState(deviceId, values);
      return;
    }

    if (kind === 'availability') {
      this.ctx.emitAvailability(deviceId, text === 'online');
      return;
    }

    if (kind === 'ack') {
      let ack;
      try {
        ack = JSON.parse(text);
      } catch {
        return;
      }
      const waiter = this.pendingAcks.get(ack.msg_id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pendingAcks.delete(ack.msg_id);
      if (ack.result === 'ok') waiter.resolve(ack);
      else waiter.reject(new AppError(ack.error ?? '设备执行失败', { code: ErrorCode.INTERNAL }));
    }
  }

  async discover() {
    // 主动发现依赖设备侧 retain 的 discovery 消息，无需额外请求
    return [];
  }

  async attach(device) {
    this.devices.set(device.id, device);
  }

  async detach(deviceId) {
    this.devices.delete(deviceId);
  }

  /**
   * 下发指令并等待回执（FR-3.4 / FR-2.6）。
   * 超时抛 TIMEOUT，由上层转成"控制失败-超时"提示。
   */
  async set(deviceId, capability, value) {
    if (!this.client || this.client.state !== 'connected') {
      throw new AppError('网关与 broker 未连接', { code: ErrorCode.OFFLINE, reason: FailReason.OFFLINE });
    }
    const msgId = randomId('m_');
    const topic = `home/${deviceId}/set`;
    const ack = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msgId);
        reject(new AppError('设备响应超时', { code: ErrorCode.TIMEOUT, reason: FailReason.TIMEOUT }));
      }, this.ackTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingAcks.set(msgId, { resolve, reject, timer });
    });

    await this.client.publish(topic, JSON.stringify({ msg_id: msgId, capability, value }), { qos: 1 });
    await ack;
  }
}
