/**
 * gateway/services/control.mjs
 * 统一控制出口 —— 所有业务模块（照明/空调/门禁/场景）下发指令都经过这里。
 *
 * 为什么要集中：一处实现"在线检查 → 能力校验 → 驱动调用 → 计时 → 失败分类"，
 * 保证 FR-3.5（四类失败原因可区分）与 FR-3.4（超时/重试语义）只有一份实现。
 */

import { AppError, ErrorCode, FailReason, toResult } from '../core/errors.mjs';

export class ControlService {
  constructor({ registry, bus, logger = null, now = () => Date.now() }) {
    this.registry = registry;
    this.bus = bus;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, import('../../contracts/driver.d.ts').Driver>} */
    this.drivers = new Map();
  }

  registerDriver(driver) {
    this.drivers.set(driver.id, driver);
  }

  getDriver(driverId) {
    return this.drivers.get(driverId);
  }

  /**
   * 下发控制指令。
   * @param {{deviceId: string, capability: string, value: any, actor?: string}} req
   * @returns {Promise<{ok: boolean, elapsedMs?: number, reason?: string, message?: string}>}
   */
  async control({ deviceId, capability, value, actor = 'system' }) {
    const startedAt = this.now();
    try {
      const device = this.registry.getDevice(deviceId);

      const entity = this.registry.findEntity(deviceId, capability);
      if (!entity) {
        throw new AppError(`设备不支持能力 ${capability}`, {
          code: ErrorCode.UNSUPPORTED,
          reason: FailReason.UNSUPPORTED,
        });
      }
      if (!entity.descriptor.writable) {
        throw new AppError(`能力 ${capability} 为只读`, {
          code: ErrorCode.UNSUPPORTED,
          reason: FailReason.UNSUPPORTED,
        });
      }
      if (!device.online) {
        throw new AppError('设备离线，指令未下发', { code: ErrorCode.OFFLINE, reason: FailReason.OFFLINE });
      }

      // 归一化/范围校验在注册表内统一做（FR-3.7）
      const normalized = this.registry.normalize(entity.descriptor, value);

      const driver = this.drivers.get(device.driver);
      if (!driver) {
        throw new AppError(`未找到驱动 ${device.driver}`, { code: ErrorCode.INTERNAL });
      }

      await driver.set(deviceId, capability, normalized);

      const result = { ok: true, elapsedMs: this.now() - startedAt };
      this.bus.emit('control', { deviceId, capability, value: normalized, actor, ...result });
      return result;
    } catch (err) {
      const result = toResult(err, this.now() - startedAt);
      this.bus.emit('control_failed', { deviceId, capability, value, actor, ...result });
      this.logger?.warn(`control failed ${deviceId}.${capability}: ${result.message}`);
      return result;
    }
  }

  /** 供场景/自动化使用：失败不中断后续动作，但记录结果 */
  async controlMany(actions, actor = 'scene') {
    const results = [];
    for (const action of actions) {
      if (action.delayMs) await new Promise((r) => setTimeout(r, action.delayMs));
      const r = await this.control({ ...action, actor });
      results.push({ action: `${action.deviceId}.${action.capability}`, ...r });
    }
    return results;
  }
}
