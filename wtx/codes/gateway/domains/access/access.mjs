/**
 * gateway/domains/access/access.mjs
 * 智能门禁（SRS M4 / FR-4.1 ~ FR-4.5）
 *
 * 安全要点：
 *   - 远程开门必须二次确认（PIN），失败也留痕（FR-4.1/4.3）
 *   - 门未关超时、非授权开启都会推告警（FR-4.4）
 *   - 开门后自动上锁，避免"忘关门"（FR-4.5）
 */

import { AppError, ErrorCode } from '../../core/errors.mjs';
import { randomId } from '../../security/crypto.mjs';

export const DEFAULT_ACCESS_CONFIG = {
  autoLockMs: 60_000,   // 开门后自动上锁
  ajarAlarmMs: 60_000,  // 门未关告警
  pin: '2468',          // 二次确认口令（生产环境应存于 HUKS）
};

export class AccessService {
  constructor({ registry, bus, control, logger = null, now = () => Date.now(), config = {} }) {
    this.registry = registry;
    this.bus = bus;
    this.control = control;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_ACCESS_CONFIG, ...config };

    /** @type {Array<any>} 开锁记录（不可篡改语义由"只追加"保证） */
    this.logs = [];
    this.lockTimers = new Map();
    this.ajarTimers = new Map();

    this.unsubscribers = [bus.on('state_changed', (evt) => this.onStateChanged(evt.data))];
  }

  stop() {
    for (const off of this.unsubscribers) off();
    for (const t of this.lockTimers.values()) clearTimeout(t);
    for (const t of this.ajarTimers.values()) clearTimeout(t);
    this.lockTimers.clear();
    this.ajarTimers.clear();
  }

  setPin(pin) {
    if (!/^\d{4,8}$/.test(pin)) throw new AppError('PIN 必须为 4–8 位数字', { code: ErrorCode.BAD_PARAMS });
    this.config.pin = pin;
  }

  /** 远程开门：二次确认 → 下发 → 留痕 → 自动上锁 */
  async open({ deviceId, userId, method = 'app', confirm, role = 'member' }) {
    const device = this.registry.getDevice(deviceId);
    if (device.category !== 'lock') {
      throw new AppError('该设备不是门禁', { code: ErrorCode.BAD_PARAMS });
    }

    // 权限：访客不可开门（FR-7.2）
    if (role === 'guest') {
      this.record(userId, method, 'failure', '访客无开门权限');
      throw new AppError('访客无开门权限', { code: ErrorCode.FORBIDDEN, reason: 'forbidden' });
    }

    // 二次确认（FR-4.1）
    if (confirm !== this.config.pin) {
      this.record(userId, method, 'failure', '二次确认口令错误');
      this.bus.emit('door_denied', { deviceId, userId, reason: 'bad_confirm' });
      throw new AppError('二次确认口令错误', { code: ErrorCode.FORBIDDEN, reason: 'forbidden' });
    }

    const result = await this.control.control({ deviceId, capability: 'lock', value: true, actor: userId });
    if (!result.ok) {
      this.record(userId, method, 'failure', result.message ?? '下发失败');
      return { ...result, logId: null };
    }

    const entry = this.record(userId, method, 'success', '远程开门');
    this.bus.emit('door_opened', { deviceId, userId, logId: entry.id });

    // 自动上锁（FR-4.5）
    const timer = setTimeout(() => this.autoLock(deviceId), this.config.autoLockMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.lockTimers.set(deviceId, timer);

    return { ok: true, elapsedMs: result.elapsedMs, logId: entry.id };
  }

  async autoLock(deviceId) {
    this.lockTimers.delete(deviceId);
    const r = await this.control.control({ deviceId, capability: 'lock', value: false, actor: 'auto-lock' });
    this.logger?.info(`auto lock ${deviceId}: ${r.ok ? 'ok' : r.message}`);
    this.bus.emit('door_locked', { deviceId, automatic: true, ok: r.ok });
    return r;
  }

  record(userId, method, result, note) {
    const entry = {
      id: randomId('al_'),
      userId,
      method,
      result,
      note,
      at: this.now(),
    };
    this.logs.push(entry);
    return entry;
  }

  listLogs({ limit = 50 } = {}) {
    return this.logs.slice(-limit).reverse();
  }

  /** 门长时间未关 → 告警（FR-4.4） */
  onStateChanged({ deviceId, capability, newValue }) {
    if (capability !== 'door_state') return;

    if (newValue === 'open' || newValue === 'ajar') {
      if (this.ajarTimers.has(deviceId)) return;
      const timer = setTimeout(() => {
        this.ajarTimers.delete(deviceId);
        const state = this.registry.getState(deviceId);
        if (state.door_state === 'closed') return;
        const alarm = {
          type: 'door_ajar',
          deviceId,
          at: this.now(),
          message: `门未关闭超过 ${Math.round(this.config.ajarAlarmMs / 1000)} 秒`,
        };
        this.bus.emit('alarm', alarm);
        this.logger?.warn(alarm.message);
      }, this.config.ajarAlarmMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.ajarTimers.set(deviceId, timer);
    } else if (newValue === 'closed') {
      const t = this.ajarTimers.get(deviceId);
      if (t) clearTimeout(t);
      this.ajarTimers.delete(deviceId);
    }
  }
}
