/**
 * gateway/security/users.mjs
 * 本地账户与登录策略（FR-7.1 / FR-7.2）。
 * 口令只以 scrypt 加盐哈希保存；连续失败 5 次锁定 5 分钟。
 */

import { AppError, ErrorCode } from '../core/errors.mjs';
import { hashPassword, verifyPassword, randomId } from './crypto.mjs';

const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

export class UserStore {
  constructor({ now = () => Date.now(), logger = null } = {}) {
    this.now = now;
    this.logger = logger;
    /** @type {Map<string, any>} name -> user */
    this.byName = new Map();
    /** @type {Map<string, {count:number, lockUntil:number}>} */
    this.failures = new Map();
  }

  create({ name, password, role = 'member' }) {
    if (!name) throw new AppError('user.name is required', { code: ErrorCode.BAD_PARAMS });
    if (this.byName.has(name)) throw new AppError('user already exists', { code: ErrorCode.BAD_PARAMS });
    const { hash, salt } = hashPassword(password);
    const user = { id: randomId('u_'), name, role, passwordHash: hash, salt, createdAt: this.now() };
    this.byName.set(name, user);
    return user;
  }

  getByName(name) {
    return this.byName.get(name);
  }

  list() {
    return [...this.byName.values()];
  }

  /**
   * 认证：成功返回用户，失败抛 UNAUTHORIZED（不区分"用户不存在"与"口令错误"）。
   * 锁定期间直接拒绝，避免暴力破解。
   */
  authenticate(name, password) {
    const state = this.failures.get(name);
    if (state && state.lockUntil > this.now()) {
      const secs = Math.ceil((state.lockUntil - this.now()) / 1000);
      throw new AppError(`账户已锁定，请 ${secs} 秒后重试`, { code: ErrorCode.UNAUTHORIZED });
    }

    const user = this.byName.get(name);
    const ok = user ? verifyPassword(password, { hash: user.passwordHash, salt: user.salt }) : false;
    if (!ok) {
      const next = { count: (state?.count ?? 0) + 1, lockUntil: 0 };
      if (next.count >= MAX_FAILURES) {
        next.lockUntil = this.now() + LOCK_MS;
        next.count = 0;
        this.logger?.warn(`account locked: ${name}`);
      }
      this.failures.set(name, next);
      throw new AppError('用户名或口令错误', { code: ErrorCode.UNAUTHORIZED });
    }

    this.failures.delete(name);
    return user;
  }

  /** 测试/运维用：查看失败计数 */
  failureCount(name) {
    return this.failures.get(name)?.count ?? 0;
  }
}
