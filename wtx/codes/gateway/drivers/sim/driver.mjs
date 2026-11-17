/**
 * gateway/drivers/sim/driver.mjs
 * 仿真驱动 —— 无硬件也能完整演示四大中心（FR-8.4 / AT-09）。
 *
 * 它实现与真实驱动完全相同的 SPI，因此业务层无法区分"仿真"与"真机"，
 * 这也是答辩现场最稳妥的兜底方案。
 */

import {
  acCapabilities,
  climateSensorCapabilities,
  deviceDescriptor,
  lightCapabilities,
  lockCapabilities,
  motionSensorCapabilities,
} from '../../core/capabilities.mjs';

const GREE_PROFILE = { modes: ['cool', 'heat', 'dry', 'fan'], fanSpeeds: ['auto', 'low', 'medium', 'high'], swing: true, minTemp: 16, maxTemp: 30, step: 1 };
const MIDEA_PROFILE = { modes: ['cool', 'heat', 'dry'], fanSpeeds: ['auto', 'low', 'high'], swing: true, minTemp: 17, maxTemp: 30, step: 1 };
const HAIER_PROFILE = { modes: ['cool', 'heat', 'fan'], fanSpeeds: ['auto', 'low', 'medium'], swing: false, minTemp: 16, maxTemp: 30, step: 1 };

export class SimDriver {
  constructor({ logger = null, applyLatencyMs = 10 } = {}) {
    this.id = 'sim';
    this.protocols = ['sim'];
    this.logger = logger;
    this.applyLatencyMs = applyLatencyMs;
    this.ctx = null;
    /** @type {Map<string, {descriptor:any, state:any, timers:any[]}>} */
    this.devices = new Map();
    this.heartbeat = null;
  }

  async start(ctx) {
    this.ctx = ctx;
    // 心跳：注册表有 offlineTimeoutMs 的离线判定（FR-1.7），
    // 仿真设备必须周期性上报"我在线"，否则闲置一分钟后会被判离线。
    this.heartbeat = setInterval(() => {
      for (const [deviceId] of this.devices) this.ctx.emitAvailability(deviceId, true);
    }, 20_000);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    this.logger?.info('sim driver started');
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, entry] of this.devices) entry.timers.forEach((t) => clearInterval(t));
    this.devices.clear();
  }

  /** 返回一套"三室两厅 + 三个品牌空调"的演示家庭 */
  async discover() {
    return [
      deviceDescriptor({
        id: 'sim-light-living',
        name: '客厅主灯',
        category: 'light',
        capabilities: lightCapabilities({ dimming: true, colorTemp: true }),
        areaId: 'living',
        brand: 'generic',
        model: 'L1',
      }),
      deviceDescriptor({
        id: 'sim-light-bedroom',
        name: '主卧灯',
        category: 'light',
        capabilities: lightCapabilities({ dimming: true }),
        areaId: 'bedroom',
        brand: 'generic',
        model: 'L2',
      }),
      deviceDescriptor({
        id: 'sim-light-corridor',
        name: '走廊灯',
        category: 'light',
        capabilities: lightCapabilities({ dimming: true }),
        areaId: 'corridor',
        brand: 'generic',
        model: 'L3',
      }),
      deviceDescriptor({
        id: 'sim-sensor-living',
        name: '客厅温湿度',
        category: 'sensor',
        capabilities: climateSensorCapabilities(),
        areaId: 'living',
        model: 'TH01',
      }),
      deviceDescriptor({
        id: 'sim-motion-corridor',
        name: '走廊人体感应',
        category: 'sensor',
        capabilities: motionSensorCapabilities(),
        areaId: 'corridor',
        model: 'PIR01',
      }),
      // 三个品牌空调：能力子集不同，用于验证 FR-3.3/3.4/3.5
      deviceDescriptor({
        id: 'ac-gree-living',
        name: '客厅空调（格力）',
        category: 'ac',
        capabilities: acCapabilities(GREE_PROFILE),
        areaId: 'living',
        brand: 'gree',
        model: 'KFR-35GW',
        vendorRef: { profile: GREE_PROFILE },
      }),
      deviceDescriptor({
        id: 'ac-midea-bedroom',
        name: '主卧空调（美的）',
        category: 'ac',
        capabilities: acCapabilities(MIDEA_PROFILE),
        areaId: 'bedroom',
        brand: 'midea',
        model: 'KFR-26GW',
        vendorRef: { profile: MIDEA_PROFILE },
      }),
      deviceDescriptor({
        id: 'ac-haier-study',
        name: '书房空调（海尔）',
        category: 'ac',
        capabilities: acCapabilities(HAIER_PROFILE),
        areaId: 'study',
        brand: 'haier',
        model: 'KFR-32GW',
        vendorRef: { profile: HAIER_PROFILE },
      }),
      deviceDescriptor({
        id: 'sim-lock-front',
        name: '入户门禁',
        category: 'lock',
        capabilities: lockCapabilities(),
        areaId: 'entrance',
        model: 'DL01',
      }),
    ];
  }

  async attach(device) {
    if (this.devices.has(device.id)) return;
    const state = {};
    for (const cap of device.capabilities) {
      if (cap.valueType === 'boolean') state[cap.kind] = cap.kind === 'lock_state' ? false : false;
      else if (cap.valueType === 'enum') state[cap.kind] = cap.enumValues?.[0];
      else state[cap.kind] = cap.min ?? 0;
    }
    // 更符合直觉的初值：只填设备**真正声明过**的能力。
    // 早期版本对 category==='sensor' 一律塞 temperature/humidity，
    // 导致人体传感器被灌入未声明的能力，日志刷 "ignored undeclared capability"。
    const declared = new Set(device.capabilities.map((cap) => cap.kind));
    const nicer = {
      temperature: 26.5,
      humidity: 45,
      motion: false,
      illuminance: 320,
      lock: false,
      lock_state: 'locked',
      door_state: 'closed',
      switch: false,
      hvac_mode: 'cool',
      target_temp: 26,
      fan_speed: 'auto',
      swing: false,
    };
    for (const [kind, value] of Object.entries(nicer)) {
      if (declared.has(kind)) state[kind] = value;
    }

    const entry = { descriptor: device, state, timers: [] };
    this.devices.set(device.id, entry);

    // 温湿度传感器缓慢漂移，让界面有"活"的感觉
    if (device.category === 'sensor' && declared.has('temperature')) {
      const timer = setInterval(() => {
        const patch = {};
        if (declared.has('temperature')) {
          const drift = (Math.random() - 0.5) * 0.2;
          entry.state.temperature = Math.round((entry.state.temperature + drift) * 10) / 10;
          patch.temperature = entry.state.temperature;
        }
        if (declared.has('humidity')) {
          entry.state.humidity = Math.max(30, Math.min(70, Math.round(entry.state.humidity + (Math.random() - 0.5) * 2)));
          patch.humidity = entry.state.humidity;
        }
        if (Object.keys(patch).length > 0) this.ctx.emitState(device.id, patch);
      }, 5000);
      if (typeof timer.unref === 'function') timer.unref();
      entry.timers.push(timer);
    }

    this.ctx.emitState(device.id, { ...state });
    this.ctx.emitAvailability(device.id, true);
  }

  async detach(deviceId) {
    const entry = this.devices.get(deviceId);
    entry?.timers.forEach((t) => clearInterval(t));
    this.devices.delete(deviceId);
  }

  /** 模拟设备执行指令：延迟一小段时间后回传状态（贴近真实链路） */
  async set(deviceId, capability, value) {
    const entry = this.devices.get(deviceId);
    if (!entry) throw new Error(`sim device not attached: ${deviceId}`);

    if (capability === 'lock') {
      entry.state.lock = value;
      entry.state.lock_state = value ? 'unlocked' : 'locked';
      entry.state.door_state = value ? 'open' : 'closed';
      this.emitLater(deviceId, { lock_state: entry.state.lock_state, door_state: entry.state.door_state });
      return;
    }

    entry.state[capability] = value;
    this.emitLater(deviceId, { [capability]: value });
  }

  emitLater(deviceId, patch) {
    const entry = this.devices.get(deviceId);
    setTimeout(() => {
      if (!this.devices.has(deviceId)) return;
      Object.assign(entry.state, patch);
      this.ctx.emitState(deviceId, patch);
    }, this.applyLatencyMs);
  }

  /* ------------------------ 演示/测试辅助接口 ------------------------ */

  /** 人为触发一次人体感应（用于联动演示与自动化测试） */
  triggerMotion(deviceId, { lux = 30 } = {}) {
    const entry = this.devices.get(deviceId);
    if (!entry) throw new Error(`unknown sim device: ${deviceId}`);
    entry.state.illuminance = lux;
    this.ctx.emitState(deviceId, { illuminance: lux, motion: true });
    setTimeout(() => {
      if (!this.devices.has(deviceId)) return;
      entry.state.motion = false;
      this.ctx.emitState(deviceId, { motion: false });
    }, 300);
  }

  setClimate(deviceId, { temperature, humidity }) {
    const patch = {};
    if (temperature !== undefined) patch.temperature = temperature;
    if (humidity !== undefined) patch.humidity = humidity;
    this.ctx.emitState(deviceId, patch);
  }

  /** 模拟设备掉线/上线 */
  setAvailability(deviceId, online) {
    this.ctx.emitAvailability(deviceId, online);
  }

  has(deviceId) {
    return this.devices.has(deviceId);
  }

  stateOf(deviceId) {
    return this.devices.get(deviceId)?.state;
  }
}
