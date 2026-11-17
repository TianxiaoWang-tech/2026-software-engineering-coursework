/**
 * gateway/adapters/base.mjs
 * 品牌空调适配器基类。
 *
 * 契约见 contracts/ac-adapter.d.ts：上层只认 hvac_mode / target_temp / fan_speed / swing，
 * 品牌差异（码值、能力子集、通道）全部收敛到子类。
 *
 * 说明：本参考实现使用**示例码值**（模拟红外码）演示映射关系，
 * 真实部署时把 encode() 里的码表替换为实测码库或厂商 API 参数即可，
 * 上层代码与场景规则无需任何改动（这就是 NFR-11 要证明的事）。
 */

import { AppError, ErrorCode, FailReason } from '../core/errors.mjs';

export class BaseAcAdapter {
  /**
   * @param {{logger?: any, send: (deviceId: string, capability: string, value: any, meta: any) => Promise<any>}} deps
   */
  constructor({ logger = null, send }) {
    if (typeof send !== 'function') throw new TypeError('send function is required');
    this.logger = logger;
    this.send = send;
    /** 子类必须覆盖 */
    this.profileDef = {
      brand: 'unknown',
      transport: 'sim',
      modes: [],
      fanSpeeds: [],
      swing: false,
      minTemp: 16,
      maxTemp: 30,
      tempStep: 1,
    };
  }

  get brand() {
    return this.profileDef.brand;
  }

  get transport() {
    return this.profileDef.transport;
  }

  async init() {
    this.logger?.info(`ac adapter ${this.brand} (${this.transport}) ready`);
  }

  profile() {
    return { ...this.profileDef };
  }

  /** 能力校验：不支持的模式/风速/温度必须在这里被拒绝（FR-3.3） */
  validate(capability, value) {
    const p = this.profileDef;
    switch (capability) {
      case 'hvac_mode':
        if (!p.modes.includes(value)) {
          throw new AppError(`${p.brand} 空调不支持模式 ${value}`, {
            code: ErrorCode.UNSUPPORTED,
            reason: FailReason.UNSUPPORTED,
          });
        }
        return;
      case 'fan_speed':
        if (!p.fanSpeeds.includes(value)) {
          throw new AppError(`${p.brand} 空调不支持风速 ${value}`, {
            code: ErrorCode.UNSUPPORTED,
            reason: FailReason.UNSUPPORTED,
          });
        }
        return;
      case 'swing':
        if (!p.swing && value === true) {
          throw new AppError(`${p.brand} 空调不支持摆风`, {
            code: ErrorCode.UNSUPPORTED,
            reason: FailReason.UNSUPPORTED,
          });
        }
        return;
      case 'target_temp': {
        if (typeof value !== 'number' || value < p.minTemp || value > p.maxTemp) {
          throw new AppError(`${p.brand} 空调温度范围为 ${p.minTemp}–${p.maxTemp}℃`, {
            code: ErrorCode.BAD_PARAMS,
            reason: FailReason.UNSUPPORTED,
          });
        }
        if ((value - p.minTemp) % p.tempStep !== 0) {
          throw new AppError(`${p.brand} 空调温度步进为 ${p.tempStep}℃`, { code: ErrorCode.BAD_PARAMS });
        }
        return;
      }
      case 'switch':
        return;
      default:
        throw new AppError(`空调不支持能力 ${capability}`, {
          code: ErrorCode.UNSUPPORTED,
          reason: FailReason.UNSUPPORTED,
        });
    }
  }

  /** 子类实现：统一能力 → 品牌侧码值/参数 */
  encode(cmd) {
    throw new Error('encode() must be implemented by adapter');
  }

  async set(deviceId, cmd) {
    this.validate(cmd.capability, cmd.value);
    const vendorCode = this.encode(cmd);
    this.logger?.debug(`[${this.brand}] ${deviceId} ${cmd.capability}=${cmd.value} -> ${vendorCode}`);
    await this.send(deviceId, cmd.capability, cmd.value, { vendorCode, brand: this.brand, msgId: cmd.msgId });
    return { ok: true, vendorCode };
  }

  /** 品牌上报 → 统一状态；默认透传，子类可覆盖做码值反查 */
  parseState(deviceId, raw) {
    return raw ?? {};
  }
}
