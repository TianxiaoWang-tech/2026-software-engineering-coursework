/**
 * gateway/services/devices.mjs
 * 设备服务：把"驱动发现/指令"与"注册表"接起来（FR-1.1 ~ FR-1.5）。
 *
 * 驱动的上下文（DriverContext）在这里实现，驱动只认 4 个回调，
 * 不直接接触注册表，从而保证驱动可替换、可单测。
 */

import { AppError, ErrorCode } from '../core/errors.mjs';
import { randomId } from '../security/crypto.mjs';

export class DeviceService {
  constructor({ registry, control, bus, logger = null }) {
    this.registry = registry;
    this.control = control;
    this.bus = bus;
    this.logger = logger;
    /** @type {Map<string, any>} */
    this.drivers = new Map();
    /** 待确认的发现结果（FR-1.1） */
    this.pending = new Map();
    /** 自动接入开关：true 时发现即接入（演示友好），false 时进入待确认列表 */
    this.autoAccept = true;
  }

  registerDriver(driver) {
    this.drivers.set(driver.id, driver);
    this.control.registerDriver(driver);
    // 注意：bus.emit 派发的是事件对象 {type, at, data}
    this.bus.on('discovered', (event) => this.onDiscovered(event.data.descriptor));
    return driver;
  }

  /** 驱动的上下文对象（依赖注入的关键） */
  contextFor(driverId, extra = {}) {
    return {
      emitState: (deviceId, state) => {
        try {
          this.registry.setState(deviceId, state, { source: `driver:${driverId}` });
        } catch (err) {
          this.logger?.warn(`driver ${driverId} emitted invalid state: ${err.message}`);
        }
      },
      emitDiscovered: (descriptor) => this.bus.emit('discovered', { descriptor, driverId }),
      emitAvailability: (deviceId, online) => this.registry.markOnline(deviceId, online),
      log: (level, msg, meta) => this.logger?.[level]?.(`[${driverId}] ${msg}`, meta),
      config: extra.config ?? {},
      ...extra,
    };
  }

  /** 发现即登记；已存在则忽略（重复宣告） */
  onDiscovered(descriptor) {
    if (this.registry.hasDevice(descriptor.id)) return;
    if (this.autoAccept) {
      this.addDevice(descriptor).catch((err) => this.logger?.warn(`auto add failed: ${err.message}`));
    } else {
      this.pending.set(descriptor.id, descriptor);
      this.bus.emit('device_pending', { descriptor });
    }
  }

  async addDevice(descriptor) {
    const record = this.registry.addDevice(descriptor);
    const driver = this.drivers.get(descriptor.driver);
    if (!driver) throw new AppError(`未找到驱动 ${descriptor.driver}`, { code: ErrorCode.INTERNAL });
    await driver.attach(record);
    this.bus.emit('device_attached', { deviceId: record.id, driver: descriptor.driver });
    return record;
  }

  async removeDevice(deviceId) {
    const device = this.registry.getDevice(deviceId);
    const driver = this.drivers.get(device.driver);
    await driver?.detach?.(deviceId);
    this.registry.removeDevice(deviceId);
    this.pending.delete(deviceId);
  }

  updateDevice(deviceId, patch) {
    return this.registry.updateDevice(deviceId, patch);
  }

  listPending() {
    return [...this.pending.values()];
  }

  acceptPending(deviceId) {
    const descriptor = this.pending.get(deviceId);
    if (!descriptor) throw new AppError('待接入设备不存在', { code: ErrorCode.NOT_FOUND });
    this.pending.delete(deviceId);
    return this.addDevice(descriptor);
  }

  /** 启动所有驱动并接入其发现的设备 */
  async startAll() {
    for (const driver of this.drivers.values()) {
      const ctx = this.contextFor(driver.id);
      await driver.start(ctx);
      const found = (await driver.discover?.()) ?? [];
      for (const descriptor of found) {
        if (!this.registry.hasDevice(descriptor.id)) await this.addDevice(descriptor);
      }
    }
  }

  async stopAll() {
    for (const driver of this.drivers.values()) {
      try {
        await driver.stop?.();
      } catch (err) {
        this.logger?.warn(`driver ${driver.id} stop failed: ${err.message}`);
      }
    }
  }

  newId(prefix) {
    return randomId(prefix);
  }
}
