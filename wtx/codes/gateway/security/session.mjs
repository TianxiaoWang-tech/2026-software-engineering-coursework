/**
 * gateway/security/session.mjs
 * 会话令牌与权限校验（FR-7.2 / FR-4.2）。
 */

import { AppError, ErrorCode } from '../core/errors.mjs';
import { randomToken } from './crypto.mjs';

export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export const ROLE_RANK = { guest: 1, member: 2, admin: 3 };

export class SessionStore {
  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, any>} token -> session */
    this.sessions = new Map();
  }

  issue(user) {
    const token = randomToken(32);
    const session = {
      token,
      userId: user.id,
      name: user.name,
      role: user.role,
      issuedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  /** 校验令牌；过期或不存在一律 UNAUTHORIZED */
  verify(token) {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) throw new AppError('未登录或令牌无效', { code: ErrorCode.UNAUTHORIZED });
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(token);
      throw new AppError('登录已过期，请重新登录', { code: ErrorCode.UNAUTHORIZED });
    }
    return s;
  }

  revoke(token) {
    return this.sessions.delete(token);
  }

  cleanup() {
    const now = this.now();
    let removed = 0;
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  /** 权限判定：越权抛 FORBIDDEN，由上层记审计（FR-4.5） */
  requireRole(session, minRole) {
    if ((ROLE_RANK[session.role] ?? 0) < (ROLE_RANK[minRole] ?? 99)) {
      throw new AppError('权限不足', { code: ErrorCode.FORBIDDEN, reason: 'forbidden' });
    }
    return session;
  }
}
