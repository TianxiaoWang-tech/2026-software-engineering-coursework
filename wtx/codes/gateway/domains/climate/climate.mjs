/**
 * gateway/domains/climate/climate.mjs
 * 温湿度控制中心（SRS M3 / FR-3.1 ~ FR-3.7）
 *
 * 职责：
 *   1. 空调控制统一入口：把指令交给对应品牌的 AcAdapter
 *   2. 对外提供"该品牌支持什么"，供界面置灰（FR-3.3）
 *   3. 温湿度联动：超阈值自动开空调/除湿，带冷却时间防抖（FR-3.6）
 */

import { AppError, ErrorCode, FailReason } from '../../core/errors.mjs';
import { randomId } from '../../security/crypto.mjs';

export const DEFAULT_CLIMATE_CONFIG = {
  tempHigh: 28,
  tempLow: 20,
  humidityHigh: 70,
  autoTargetTemp: 25,
  cooldownMs: 60_000,
};

export class ClimateService {
  constructor({ registry, bus, control, adapters, logger = null, now = () => Date.now(), config = {} }) {
    this.registry = registry;
    this.bus = bus;
    this.control = control;
    this.adapters = adapters;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_CLIMATE_CONFIG, ...config };

    /** 最近一次下发的品牌码值，键为 `deviceId#capability`（测试与诊断用） */
    this.lastVendorCode = new Map();
    /** 联动冷却 */
    this.lastAutoAt = new Map();

    this.unsubscribers = [bus.on('state_changed', (evt) => this.onStateChanged(evt.data))];
  }

  stop() {
    for (const off of this.unsubscribers) off();
  }

  /* --------------------------- 查询 --------------------------- */

  /** 供界面渲染：哪些模式/风速可选，温度范围多少（FR-3.3 置灰依据） */
  capabilitiesFor(deviceId) {
    const device = this.registry.getDevice(deviceId);
    const adapter = this.adapters.get(device.brand);
    if (adapter) return adapter.profile(deviceId);
    // 无适配器时退回设备自带的 profile（只读控制）
    const fallback = device.vendorRef?.profile;
    if (fallback) return { brand: device.brand ?? 'unknown', transport: 'sim', swing: false, ...fallback };
    throw new AppError(`设备 ${deviceId} 缺少品牌能力信息`, { code: ErrorCode.INTERNAL, reason: FailReason.INTERNAL });
  }

  /* --------------------------- 控制 --------------------------- */

  async set(deviceId, capability, value, actor = 'user') {
    const device = this.registry.getDevice(deviceId);
    const adapter = this.adapters.get(device.brand);

    if (!adapter) {
      // 没有品牌适配器：退化为通用能力下发（例如仿真空调未注册品牌）
      return this.control.control({ deviceId, capability, value, actor });
    }

    const cmd = { msgId: randomId('ac_'), capability, value };
    try {
      const result = await adapter.set(deviceId, cmd);
      this.lastVendorCode.set(`${deviceId}#${capability}`, result.vendorCode);
      this.bus.emit('ac_command', { deviceId, brand: device.brand, capability, value, vendorCode: result.vendorCode, actor });
      return { ok: true, elapsedMs: 0, vendorCode: result.vendorCode };
    } catch (err) {
      const reason = err?.reason ?? FailReason.INTERNAL;
      this.bus.emit('control_failed', { deviceId, capability, value, actor, reason, message: err.message });
      return { ok: false, reason, message: err.message };
    }
  }

  async setSwitch(deviceId, on, actor = 'user') {
    return this.set(deviceId, 'switch', Boolean(on), actor);
  }

  async setMode(deviceId, mode, actor = 'user') {
    return this.set(deviceId, 'hvac_mode', mode, actor);
  }

  async setTemperature(deviceId, temp, actor = 'user') {
    return this.set(deviceId, 'target_temp', Number(temp), actor);
  }

  async setFanSpeed(deviceId, speed, actor = 'user') {
    return this.set(deviceId, 'fan_speed', speed, actor);
  }

  async setSwing(deviceId, on, actor = 'user') {
    return this.set(deviceId, 'swing', Boolean(on), actor);
  }

  /* ----------------------- 温湿度联动（FR-3.6） ----------------------- */

  onStateChanged({ deviceId, capability, newValue }) {
    if (capability !== 'temperature' && capability !== 'humidity') return;
    const device = this.registry.devices.get(deviceId);
    if (!device || device.category !== 'sensor') return;

    const areaId = device.areaId;
    if (!areaId) return;
    const acs = this.registry.listDevices().filter((d) => d.category === 'ac' && d.areaId === areaId);
    if (acs.length === 0) return;

    for (const ac of acs) {
      const last = this.lastAutoAt.get(ac.id) ?? 0;
      if (this.now() - last < this.config.cooldownMs) continue;

      if (capability === 'temperature' && newValue > this.config.tempHigh) {
        this.autoAdjust(ac, { mode: 'cool', temp: this.config.autoTargetTemp, why: `温度 ${newValue}℃ 高于阈值 ${this.config.tempHigh}℃` });
      } else if (capability === 'temperature' && newValue < this.config.tempLow) {
        this.autoAdjust(ac, { mode: 'heat', temp: this.config.autoTargetTemp, why: `温度 ${newValue}℃ 低于阈值 ${this.config.tempLow}℃` });
      } else if (capability === 'humidity' && newValue > this.config.humidityHigh) {
        this.autoAdjust(ac, { mode: 'dry', temp: this.config.autoTargetTemp, why: `湿度 ${newValue}% 高于阈值 ${this.config.humidityHigh}%` });
      }
    }
  }

  async autoAdjust(ac, { mode, temp, why }) {
    this.lastAutoAt.set(ac.id, this.now());
    this.logger?.info(`auto climate: ${ac.id} -> ${mode}/${temp}（${why}）`);
    this.bus.emit('climate_auto', { deviceId: ac.id, mode, temp, why });

    const state = this.registry.getState(ac.id);
    if (!state.switch) await this.setSwitch(ac.id, true, 'auto');
    const caps = this.capabilitiesFor(ac.id);
    if (caps.modes.includes(mode)) await this.setMode(ac.id, mode, 'auto');
    await this.setTemperature(ac.id, temp, 'auto');
  }
}
