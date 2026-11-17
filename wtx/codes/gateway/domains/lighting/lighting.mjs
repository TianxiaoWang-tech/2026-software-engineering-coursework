/**
 * gateway/domains/lighting/lighting.mjs
 * 照明中心（SRS M2 / FR-2.1 ~ FR-2.6）
 *
 * 承担三件事：
 *   1. 远程开关/调光/色温（含越界钳制，FR-2.3）
 *   2. 人体感应自动亮灯（FR-2.4）：光照低于阈值 + 检测到人 → 开灯，夜间低亮度
 *   3. 无人自动关灯（FR-2.5）：持续无人超过阈值 → 关灯，期间再有人则重新计时
 */

import { AppError, ErrorCode } from '../../core/errors.mjs';

export const DEFAULT_LIGHTING_CONFIG = {
  motionLuxThreshold: 50,   // lux 低于此值才自动开灯
  nightBrightness: 10,      // 夜间亮度 %
  dayBrightness: 100,
  nightRange: ['22:00', '06:00'],
  noMotionTimeoutMs: 120_000,
  /** 可注入 useNightBrightness，便于测试 */
};

export class LightingService {
  constructor({ registry, bus, control, logger = null, now = () => Date.now(), config = {} }) {
    this.registry = registry;
    this.bus = bus;
    this.control = control;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_LIGHTING_CONFIG, ...config };

    /** areaId -> 最后检测到人的时间 */
    this.lastMotionAt = new Map();
    /** areaId -> 自动点亮的灯（用于无人后只关自己开的灯） */
    this.autoOnLights = new Map();
    /** areaId -> timer */
    this.offTimers = new Map();

    this.unsubscribers = [
      bus.on('state_changed', (evt) => this.onStateChanged(evt.data)),
    ];
  }

  stop() {
    for (const off of this.unsubscribers) off();
    for (const t of this.offTimers.values()) clearTimeout(t);
    this.offTimers.clear();
  }

  /* ----------------------------- 远程控制 ----------------------------- */

  /** 开关灯（FR-2.1） */
  async setSwitch(deviceId, on, actor = 'user') {
    return this.control.control({ deviceId, capability: 'switch', value: Boolean(on), actor });
  }

  /** 调光（FR-2.2）：越界钳制到 1–100，而不是报错 */
  async setBrightness(deviceId, level, actor = 'user') {
    const clamped = Math.max(1, Math.min(100, Math.round(Number(level))));
    return this.control.control({ deviceId, capability: 'brightness', value: clamped, actor });
  }

  /** 色温（FR-2.3）：越界钳制 */
  async setColorTemp(deviceId, kelvin, actor = 'user') {
    const clamped = Math.max(2700, Math.min(6500, Math.round(Number(kelvin) / 100) * 100));
    return this.control.control({ deviceId, capability: 'color_temp', value: clamped, actor });
  }

  /* --------------------------- 人体感应联动 --------------------------- */

  onStateChanged({ deviceId, capability, newValue }) {
    if (capability !== 'motion') return;
    const device = this.registry.devices.get(deviceId);
    if (!device) return;
    const areaId = device.areaId ?? '_';

    if (newValue === true) {
      this.lastMotionAt.set(areaId, this.now());
      this.onMotionDetected(areaId).catch((err) => this.logger?.warn(`motion handler failed: ${err.message}`));
    } else {
      this.scheduleAutoOff(areaId);
    }
  }

  async onMotionDetected(areaId) {
    // 取该区域的光照值判断是否需要开灯（FR-2.4：光照足够则不动作）
    const lux = this.currentLuxOf(areaId);
    const shouldTurnOn = lux === undefined || lux < this.config.motionLuxThreshold;
    if (!shouldTurnOn) {
      this.logger?.debug(`motion in ${areaId}, lux=${lux} >= threshold, skip`);
      return;
    }

    // 取消待执行的关灯定时
    if (this.offTimers.has(areaId)) {
      clearTimeout(this.offTimers.get(areaId));
      this.offTimers.delete(areaId);
    }

    const brightness = this.isNight() ? this.config.nightBrightness : this.config.dayBrightness;
    const lights = this.lightsOf(areaId);
    const turnedOn = [];

    for (const light of lights) {
      if (this.registry.getState(light.id).switch === true) continue; // 已亮的不动
      const r = await this.control.control({
        deviceId: light.id,
        capability: 'switch',
        value: true,
        actor: 'motion',
      });
      if (r.ok) {
        turnedOn.push(light.id);
        if (brightness < 100 && this.registry.findEntity(light.id, 'brightness')) {
          await this.control.control({ deviceId: light.id, capability: 'brightness', value: brightness, actor: 'motion' });
        }
      }
    }

    if (turnedOn.length > 0) {
      this.autoOnLights.set(areaId, turnedOn);
      this.bus.emit('lighting_auto_on', { areaId, lights: turnedOn, brightness, lux });
    }
    return turnedOn;
  }

  /** 无人后延时关灯（FR-2.5）：期间再有人则重新计时 */
  scheduleAutoOff(areaId) {
    if (this.offTimers.has(areaId)) clearTimeout(this.offTimers.get(areaId));
    const timer = setTimeout(() => {
      this.offTimers.delete(areaId);
      this.autoOff(areaId).catch((err) => this.logger?.warn(`auto off failed: ${err.message}`));
    }, this.config.noMotionTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.offTimers.set(areaId, timer);
  }

  async autoOff(areaId) {
    const last = this.lastMotionAt.get(areaId) ?? 0;
    // 期间又检测到人 → 不关
    if (this.now() - last < this.config.noMotionTimeoutMs) {
      this.scheduleAutoOff(areaId);
      return [];
    }
    const lights = this.autoOnLights.get(areaId) ?? [];
    const turnedOff = [];
    for (const deviceId of lights) {
      const r = await this.control.control({ deviceId, capability: 'switch', value: false, actor: 'motion' });
      if (r.ok) turnedOff.push(deviceId);
    }
    this.autoOnLights.delete(areaId);
    if (turnedOff.length > 0) this.bus.emit('lighting_auto_off', { areaId, lights: turnedOff });
    return turnedOff;
  }

  /* ------------------------------ 工具 ------------------------------ */

  lightsOf(areaId) {
    return this.registry.listDevices().filter((d) => d.category === 'light' && (d.areaId ?? '_') === areaId);
  }

  currentLuxOf(areaId) {
    const sensor = this.registry
      .listDevices()
      .find((d) => d.category === 'sensor' && d.brand === undefined && this.registry.getState(d.id).illuminance !== undefined && (d.areaId ?? '_') === areaId);
    return sensor ? this.registry.getState(sensor.id).illuminance : undefined;
  }

  isNight(at = this.now()) {
    const [start, end] = this.config.nightRange;
    const d = new Date(at);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const toMin = (s) => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    const s = toMin(start);
    const e = toMin(end);
    return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
  }

  /** 越权/非法参数统一转换 */
  static assertWritable(registry, deviceId, capability) {
    const entity = registry.findEntity(deviceId, capability);
    if (!entity) throw new AppError(`设备不支持 ${capability}`, { code: ErrorCode.UNSUPPORTED });
    if (!entity.descriptor.writable) throw new AppError(`${capability} 只读`, { code: ErrorCode.UNSUPPORTED });
  }
}
