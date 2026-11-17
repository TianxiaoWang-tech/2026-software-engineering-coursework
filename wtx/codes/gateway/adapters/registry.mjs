/**
 * gateway/adapters/registry.mjs
 * 品牌适配器注册表 —— 新增品牌只需在此注册一行。
 */

export class AcAdapterRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    /** @type {Map<string, any>} */
    this.adapters = new Map();
  }

  register(adapter) {
    if (!adapter?.brand) throw new TypeError('adapter.brand is required');
    this.adapters.set(adapter.brand, adapter);
    this.logger?.info(`ac adapter registered: ${adapter.brand} (${adapter.transport})`);
    return adapter;
  }

  get(brand) {
    return brand ? this.adapters.get(brand) : undefined;
  }

  list() {
    return [...this.adapters.values()];
  }

  async initAll() {
    for (const a of this.adapters.values()) await a.init?.();
  }
}
