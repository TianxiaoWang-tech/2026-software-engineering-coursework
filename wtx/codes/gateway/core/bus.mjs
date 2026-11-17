/**
 * gateway/core/bus.mjs
 * 事件总线 —— 内核的事件中枢（对标 Home Assistant 的 event bus）。
 * 所有状态变化、设备上下线、场景执行、告警都以此广播，
 * 业务模块之间不直接依赖，只通过事件解耦。
 */

export class EventBus {
  constructor({ logger = null } = {}) {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    this.logger = logger;
    this.emitted = []; // 便于测试回溯
  }

  /**
   * 订阅事件；返回取消订阅函数。
   * 通配符 '*' 可监听全部事件（用于审计、日志、推送桥接）。
   */
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('handler must be a function');
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this.handlers.get(type)?.delete(fn);
  }

  listenerCount(type) {
    return (this.handlers.get(type)?.size ?? 0) + (this.handlers.get('*')?.size ?? 0);
  }

  /**
   * 同步派发。单个处理器抛错不得影响其他处理器（隔离故障），
   * 错误进入日志而非冒泡到调用方。
   */
  emit(type, data) {
    const at = Date.now();
    const event = { type, at, data };
    this.emitted.push(event);
    // 复制一份，避免处理器内部增删订阅导致遍历异常
    const targets = [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const fn of targets) {
      try {
        fn(event);
      } catch (err) {
        this.logger?.error(`event handler failed: ${type} — ${err?.message ?? err}`, { type });
      }
    }
    return event;
  }

  /** 清空（测试用） */
  reset() {
    this.handlers.clear();
    this.emitted.length = 0;
  }
}
