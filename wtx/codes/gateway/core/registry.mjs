/**
 * gateway/core/registry.mjs
 * 设备/实体/区域注册表 + 状态机。
 *
 * 职责边界（对标 HA 的 entity registry / state machine）：
 *   - 管"有哪些设备、设备有什么能力、当前值是什么"
 *   - 不做协议解析（驱动的事）、不做业务规则（domain 的事）
 *   - 所有状态变化统一通过 setState 写入并广播 state_changed
 */

import { AppError, ErrorCode, FailReason, assert } from './errors.mjs';

export const DEFAULT_STALE_MS = 5 * 60 * 1000;      // FR-3.1：5 分钟陈旧
export const DEFAULT_OFFLINE_MS = 90 * 1000;        // FR-1.7：90 秒离线

export const entityIdOf = (deviceId, capability) => `${deviceId}#${capability}`;

export class Registry {
  /**
   * @param {{bus: import('./bus.mjs').EventBus, logger?: any, now?: () => number,
   *          offlineTimeoutMs?: number, staleMs?: number}} deps
   */
  constructor({ bus, logger = null, now = () => Date.now(), offlineTimeoutMs = DEFAULT_OFFLINE_MS, staleMs = DEFAULT_STALE_MS }) {
    this.bus = bus;
    this.logger = logger;
    this.now = now;
    this.offlineTimeoutMs = offlineTimeoutMs;
    this.staleMs = staleMs;

    /** @type {Map<string, any>} */
    this.areas = new Map();
    /** @type {Map<string, any>} */
    this.devices = new Map();
    /** @type {Map<string, any>} */
    this.entities = new Map();
  }

  /* ---------------------------- 区域 ---------------------------- */

  addArea({ id, name, sort = 0 }) {
    assert(id && name, 'area.id and area.name are required', { code: ErrorCode.BAD_PARAMS });
    this.areas.set(id, { id, name, sort });
    return this.areas.get(id);
  }

  listAreas() {
    return [...this.areas.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  /* ---------------------------- 设备 ---------------------------- */

  /**
   * 登记设备并为其每个能力生成实体（初值为能力默认值）。
   * @param {import('../../contracts/model.d.ts').DeviceDescriptor} desc
   */
  addDevice(desc) {
    assert(desc?.id, 'device.id is required', { code: ErrorCode.BAD_PARAMS });
    assert(!this.devices.has(desc.id), `device already exists: ${desc.id}`, {
      code: ErrorCode.BAD_PARAMS,
      message: '设备 ID 重复',
    });
    assert(Array.isArray(desc.capabilities) && desc.capabilities.length > 0, 'device must declare capabilities', {
      code: ErrorCode.BAD_PARAMS,
    });

    const kinds = new Set();
    for (const cap of desc.capabilities) {
      assert(cap?.kind, 'capability.kind is required', { code: ErrorCode.BAD_PARAMS });
      assert(!kinds.has(cap.kind), `duplicate capability: ${cap.kind}`, { code: ErrorCode.BAD_PARAMS });
      kinds.add(cap.kind);
    }

    if (desc.areaId) {
      assert(this.areas.has(desc.areaId), `unknown area: ${desc.areaId}`, { code: ErrorCode.BAD_PARAMS });
    }

    const record = {
      ...desc,
      online: desc.online ?? false,
      onlineAt: this.now(),
      createdAt: this.now(),
    };
    this.devices.set(record.id, record);

    for (const cap of record.capabilities) {
      const eid = entityIdOf(record.id, cap.kind);
      this.entities.set(eid, {
        id: eid,
        deviceId: record.id,
        capability: cap.kind,
        descriptor: cap,
        value: defaultValueOf(cap),
        updatedAt: this.now(),
        staleAfterMs: this.staleMs,
      });
    }

    this.bus.emit('device_added', { deviceId: record.id });
    return record;
  }

  getDevice(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) throw new AppError(`device not found: ${deviceId}`, { code: ErrorCode.NOT_FOUND });
    return d;
  }

  hasDevice(deviceId) {
    return this.devices.has(deviceId);
  }

  listDevices() {
    return [...this.devices.values()];
  }

  updateDevice(deviceId, patch) {
    const d = this.getDevice(deviceId);
    if (patch.areaId !== undefined && patch.areaId !== null) {
      assert(this.areas.has(patch.areaId), `unknown area: ${patch.areaId}`, { code: ErrorCode.BAD_PARAMS });
    }
    Object.assign(d, patch, { id: d.id });
    this.bus.emit('device_updated', { deviceId });
    return d;
  }

  removeDevice(deviceId) {
    this.getDevice(deviceId);
    this.devices.delete(deviceId);
    for (const [eid, e] of this.entities) {
      if (e.deviceId === deviceId) this.entities.delete(eid);
    }
    this.bus.emit('device_removed', { deviceId });
  }

  /* ---------------------------- 实体与状态 ---------------------------- */

  entitiesOf(deviceId) {
    return [...this.entities.values()].filter((e) => e.deviceId === deviceId);
  }

  getEntity(entityId) {
    const e = this.entities.get(entityId);
    if (!e) throw new AppError(`entity not found: ${entityId}`, { code: ErrorCode.NOT_FOUND });
    return e;
  }

  findEntity(deviceId, capability) {
    return this.entities.get(entityIdOf(deviceId, capability));
  }

  /** 设备的当前状态快照 */
  getState(deviceId) {
    const out = {};
    for (const e of this.entitiesOf(deviceId)) out[e.capability] = e.value;
    return out;
  }

  /**
   * 写入设备状态。只处理发生变化的项，逐项广播 state_changed。
   * @param {string} deviceId
   * @param {Record<string, any>} stateMap
   * @param {{source?: string}} [opts]
   */
  setState(deviceId, stateMap, { source = 'device' } = {}) {
    const device = this.getDevice(deviceId);
    const changes = [];

    for (const [capability, rawValue] of Object.entries(stateMap)) {
      const entity = this.findEntity(deviceId, capability);
      if (!entity) {
        // 驱动上报了未声明的能力：记录但不采纳（FR-1.8）
        this.logger?.warn(`ignored undeclared capability ${capability} from ${deviceId}`);
        continue;
      }
      const value = this.normalize(entity.descriptor, rawValue);
      if (entity.value === value) continue;
      const oldValue = entity.value;
      entity.value = value;
      entity.updatedAt = this.now();
      changes.push({ entityId: entity.id, deviceId, capability, oldValue, newValue: value });
    }

    device.onlineAt = this.now();
    if (!device.online) {
      device.online = true;
      this.bus.emit('availability', { deviceId, online: true });
    }

    for (const change of changes) {
      this.bus.emit('state_changed', { ...change, source });
    }
    return changes;
  }

  /** 值校验与归一化：类型、范围、枚举（FR-1.8 / FR-3.7） */
  normalize(descriptor, value) {
    const { valueType, min, max, enumValues, kind } = descriptor;
    if (valueType === 'boolean') {
      assert(typeof value === 'boolean', `capability ${kind} expects boolean`, {
        code: ErrorCode.BAD_PARAMS,
        reason: FailReason.UNSUPPORTED,
      });
      return value;
    }
    if (valueType === 'enum') {
      assert(enumValues?.includes(value), `capability ${kind} expects one of ${enumValues?.join('|')}`, {
        code: ErrorCode.BAD_PARAMS,
        reason: FailReason.UNSUPPORTED,
      });
      return value;
    }
    // number
    assert(typeof value === 'number' && Number.isFinite(value), `capability ${kind} expects a number`, {
      code: ErrorCode.BAD_PARAMS,
      reason: FailReason.UNSUPPORTED,
    });
    if (min !== undefined) {
      assert(value >= min, `capability ${kind} below min ${min} (got ${value})`, {
        code: ErrorCode.BAD_PARAMS,
        reason: FailReason.UNSUPPORTED,
      });
    }
    if (max !== undefined) {
      assert(value <= max, `capability ${kind} above max ${max} (got ${value})`, {
        code: ErrorCode.BAD_PARAMS,
        reason: FailReason.UNSUPPORTED,
      });
    }
    return value;
  }

  /* ---------------------------- 在线状态 ---------------------------- */

  markOnline(deviceId, online) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    // 心跳刷新必须更新 onlineAt，否则重复的"我在线"会被当成无变化而忽略，
    // 15 秒后 sweep() 会把一直有心跳的设备误判离线（实测：灯全变离线）。
    const changed = d.online !== online;
    d.online = online;
    d.onlineAt = this.now();
    if (!changed) return;
    this.bus.emit('availability', { deviceId, online });
    this.logger?.debug(`device ${deviceId} ${online ? 'online' : 'offline'}`);
  }

  /** 心跳扫描：超时未上报即判定离线（FR-1.7） */
  sweep() {
    const now = this.now();
    const flipped = [];
    for (const d of this.devices.values()) {
      if (d.online && now - d.onlineAt > this.offlineTimeoutMs) {
        this.markOnline(d.id, false);
        flipped.push(d.id);
      }
    }
    return flipped;
  }

  /** 实体是否陈旧（FR-3.1 / FR-3.7 数据新鲜度） */
  isStale(entity) {
    return this.now() - entity.updatedAt > (entity.staleAfterMs ?? this.staleMs);
  }

  /** 首屏所需的整体快照（对应 device.list 返回） */
  snapshot() {
    const states = {};
    for (const d of this.devices.values()) states[d.id] = this.getState(d.id);
    return { areas: this.listAreas(), devices: this.listDevices(), states };
  }
}

function defaultValueOf(cap) {
  if (cap.valueType === 'boolean') return false;
  if (cap.valueType === 'enum') return cap.enumValues?.[0] ?? '';
  return cap.min ?? 0;
}
