/**
 * simulators/devices.mjs
 * 设备仿真器：用 MQTT 主题模拟真实设备（灯 / 温湿度 / 空调 / 门锁）。
 *
 * 与真实设备的差别只在"物理层"：报文格式、主题、遗嘱、回执全部按约定实现，
 * 因此网关侧无需任何特殊处理——这正是 AT-09（无硬件演示）与 AT-07（离线检测）的证据来源。
 */

import { MqttClient } from '../gateway/drivers/mqtt/client.mjs';
import { lightCapabilities, climateSensorCapabilities, acCapabilities, lockCapabilities } from '../gateway/core/capabilities.mjs';

const GREE_PROFILE = { modes: ['cool', 'heat', 'dry', 'fan'], fanSpeeds: ['auto', 'low', 'medium', 'high'], swing: true, minTemp: 16, maxTemp: 30, step: 1 };

/** 默认演示设备集合 */
export function demoDevices() {
  return [
    {
      id: 'mqtt-light-1',
      name: '书房台灯',
      category: 'light',
      model: 'TL-01',
      areaId: 'study',
      capabilities: lightCapabilities({ dimming: true, colorTemp: false }),
      initial: { switch: false, brightness: 100 },
    },
    {
      id: 'mqtt-sensor-1',
      name: '书房温湿度',
      category: 'sensor',
      model: 'TH-02',
      areaId: 'study',
      capabilities: climateSensorCapabilities(),
      initial: { temperature: 24.2, humidity: 52 },
    },
    {
      id: 'mqtt-ac-1',
      name: '书房空调',
      category: 'ac',
      brand: 'gree',
      model: 'KFR-35GW',
      areaId: 'study',
      capabilities: acCapabilities(GREE_PROFILE),
      initial: { switch: false, hvac_mode: 'cool', target_temp: 26, fan_speed: 'auto', swing: false },
    },
  ];
}

export class DeviceSimulator {
  /**
   * @param {{host?: string, port: number, devices?: any[], logger?: any}} opts
   */
  constructor({ host = '127.0.0.1', port, devices = demoDevices(), logger = null }) {
    this.host = host;
    this.port = port;
    this.logger = logger;
    this.devices = new Map();
    for (const d of devices) this.devices.set(d.id, { ...d, state: { ...d.initial }, client: null });
    this.running = false;
  }

  async start() {
    for (const [id, dev] of this.devices) {
      const client = new MqttClient({
        host: this.host,
        port: this.port,
        clientId: `dev-${id}`,
        keepalive: 20,
        will: { topic: `home/${id}/availability`, payload: 'offline', qos: 1, retain: true },
        logger: this.logger,
      });
      client.on('message', (msg) => this.onMessage(id, msg));
      await client.connect();
      dev.client = client;

      // 宣告（每设备一个 retain 主题，便于网关后启动也能发现）
      await client.publish(
        `home/discovery/${id}`,
        JSON.stringify({
          id,
          name: dev.name,
          category: dev.category,
          brand: dev.brand,
          model: dev.model,
          areaId: dev.areaId,
          capabilities: dev.capabilities,
        }),
        { qos: 1, retain: true },
      );

      await client.subscribe(`home/${id}/set`, 1);
      await client.publish(`home/${id}/availability`, 'online', { qos: 1, retain: true });
      await client.publish(`home/${id}/state`, JSON.stringify({ ...dev.state, ts: Date.now() }), { qos: 1 });
      this.logger?.info(`sim device ready: ${id} (${dev.name})`);
    }
    this.running = true;
    return this;
  }

  onMessage(deviceId, { topic, payload }) {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    let cmd;
    try {
      cmd = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }

    const capability = cmd.capability;
    const value = cmd.value;
    const valid = dev.capabilities.some((c) => c.kind === capability && c.writable);
    if (!valid) {
      dev.client.publish(
        `home/${deviceId}/ack`,
        JSON.stringify({ msg_id: cmd.msg_id, result: 'error', error: `不支持能力 ${capability}` }),
        { qos: 1 },
      );
      return;
    }

    dev.state[capability] = value;
    if (capability === 'lock') {
      dev.state.lock_state = value ? 'unlocked' : 'locked';
      dev.state.door_state = value ? 'open' : 'closed';
    }

    // 先回执，再上报状态（贴近真实设备的执行顺序）
    dev.client.publish(`home/${deviceId}/ack`, JSON.stringify({ msg_id: cmd.msg_id, result: 'ok' }), { qos: 1 });
    dev.client.publish(`home/${deviceId}/state`, JSON.stringify({ ...dev.state, ts: Date.now() }), { qos: 1 });
    this.logger?.debug(`sim device ${deviceId} applied ${capability}=${value}`);
  }

  /** 模拟传感器读数变化 */
  publishSensor(deviceId, patch) {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    Object.assign(dev.state, patch);
    dev.client.publish(`home/${deviceId}/state`, JSON.stringify({ ...dev.state, ts: Date.now() }), { qos: 1 });
  }

  /** 模拟设备掉线（异常断开 → broker 发布遗嘱） */
  dropDevice(deviceId) {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    dev.client.destroy();
    dev.client = null;
  }

  stateOf(deviceId) {
    return this.devices.get(deviceId)?.state;
  }

  async stop() {
    for (const dev of this.devices.values()) {
      if (!dev.client) continue;
      try {
        await dev.client.publish(`home/${dev.id}/availability`, 'offline', { qos: 1, retain: true });
      } catch {
        /* 忽略 */
      }
      dev.client.end();
      dev.client = null;
    }
    this.running = false;
  }
}
