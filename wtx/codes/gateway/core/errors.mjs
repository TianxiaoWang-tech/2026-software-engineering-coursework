/**
 * gateway/core/errors.mjs
 * 统一错误类型：把"内部异常"翻译成对外可区分的失败原因。
 * 对应 SRS FR-3.5（四类失败原因可区分）与 gateway-api ErrorCode。
 */

/** 对外错误码（与 contracts/gateway-api.d.ts 的 ErrorCode 保持一致） */
export const ErrorCode = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_PARAMS: 'BAD_PARAMS',
  OFFLINE: 'OFFLINE',
  TIMEOUT: 'TIMEOUT',
  UNSUPPORTED: 'UNSUPPORTED',
  REPLAY: 'REPLAY',
  INTERNAL: 'INTERNAL',
});

/** 失败原因（与 contracts/model.d.ts 的 OperationResult.reason 对齐） */
export const FailReason = Object.freeze({
  OFFLINE: 'offline',
  TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported',
  FORBIDDEN: 'forbidden',
  INTERNAL: 'internal',
});

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, reason?: string, details?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code ?? ErrorCode.INTERNAL;
    this.reason = opts.reason ?? FailReason.INTERNAL;
    this.details = opts.details;
  }

  toResult() {
    return { ok: false, reason: this.reason, message: this.message };
  }
}

/** 断言工具：条件不满足即抛出带分类的 AppError */
export function assert(cond, message, opts = {}) {
  if (!cond) throw new AppError(message, opts);
}

/** 把任意异常收敛成 OperationResult */
export function toResult(err, elapsedMs) {
  if (err instanceof AppError) {
    return { ok: false, reason: err.reason, message: err.message, elapsedMs };
  }
  return {
    ok: false,
    reason: FailReason.INTERNAL,
    message: err?.message ?? String(err),
    elapsedMs,
  };
}
