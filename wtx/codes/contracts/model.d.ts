/**
 * contracts/model.d.ts
 * 领域模型契约 —— 全项目唯一的数据结构定义。
 * 冻结版本：v1.0（2026-11-01）  所有者：A
 * 规则：冻结后只增不改；任何人不得在此文件之外另立同名类型。
 */

/** 区域（房间）标识 */
export type AreaId = string;
/** 设备标识，全局唯一，建议 `vendor:model:serial` 形式 */
export type DeviceId = string;
/** 实体标识 = `${DeviceId}#${capability}` */
export type EntityId = string;

/* ------------------------------------------------------------------ */
/* 能力（Capability）                                                   */
/* ------------------------------------------------------------------ */

/** 系统支持的全部能力项。新增设备类型 = 新增能力项，不改上层逻辑 */
export type CapabilityKind =
  // 照明
  | 'switch'
  | 'brightness'        // 1–100
  | 'color_temp'        // 2700–6500 K
  // 温湿度与空调
  | 'temperature'       // ℃，只读
  | 'humidity'          // %RH，只读
  | 'hvac_mode'         // cool | heat | fan | dry | auto
  | 'target_temp'       // 16–30 ℃
  | 'fan_speed'         // auto | low | medium | high
  | 'swing'             // 摆风开关
  // 门禁
  | 'lock'              // 开锁指令（写）
  | 'lock_state'        // locked | unlocked，只读
  | 'door_state'        // open | closed | ajar，只读
  // 传感器
  | 'motion'            // 人体感应，只读
  | 'illuminance';      // 环境光照 lux，只读

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  /** 值的类型 */
  valueType: 'boolean' | 'number' | 'enum';
  unit?: string;
  /** 数值型取值范围（含端点） */
  min?: number;
  max?: number;
  step?: number;
  /** 枚举型可选值 */
  enumValues?: string[];
  readable: boolean;
  writable: boolean;
}

/* ------------------------------------------------------------------ */
/* 设备与实体                                                          */
/* ------------------------------------------------------------------ */

export type DeviceCategory = 'light' | 'ac' | 'sensor' | 'lock';
export type DeviceProtocol = 'mqtt' | 'http' | 'modbus' | 'ir' | 'sim';

export interface DeviceDescriptor {
  id: DeviceId;
  name: string;
  category: DeviceCategory;
  /** 展示用品牌名，如 海尔 / 格力 / 美的；传感器可为空 */
  brand?: string;
  model?: string;
  /** 接入协议，由驱动声明 */
  protocol: DeviceProtocol;
  /** 驱动标识，如 mqtt / sim / ac-haier */
  driver: string;
  areaId?: AreaId;
  capabilities: CapabilityDescriptor[];
  /** 厂商侧标识（MQTT 主题前缀、红外码集等），驱动自定义 */
  vendorRef?: Record<string, unknown>;
}

export interface DeviceRecord extends DeviceDescriptor {
  online: boolean;
  onlineAt: number;      // 最后一次在线时间戳（ms）
  createdAt: number;
}

/** 实体 = 设备 × 能力 的运行时投影 */
export interface Entity {
  id: EntityId;
  deviceId: DeviceId;
  capability: CapabilityKind;
  descriptor: CapabilityDescriptor;
  value: CapabilityValue;
  updatedAt: number;
  /** 超过该时长无更新即视为陈旧（由 NFR/FR-3.1 使用） */
  staleAfterMs?: number;
}

export type CapabilityValue = boolean | number | string;

/** 设备状态快照：capability -> value */
export type StateMap = Partial<Record<CapabilityKind, CapabilityValue>>;

/* ------------------------------------------------------------------ */
/* 区域与场景                                                          */
/* ------------------------------------------------------------------ */

export interface Area {
  id: AreaId;
  name: string;
  sort: number;
}

export type ActionVerb = 'set';
export interface Action {
  deviceId: DeviceId;
  capability: CapabilityKind;
  value: CapabilityValue;
  /** 可选：动作执行前的等待毫秒数（用于场景顺序执行） */
  delayMs?: number;
}

export interface Scene {
  id: string;
  name: string;
  areaId?: AreaId;
  actions: Action[];
  enabled: boolean;
}

export type TriggerKind = 'time' | 'state';
export interface TimeTrigger {
  kind: 'time';
  /** 本地时间 'HH:mm' */
  at: string;
  /** 每周生效日，1=周一 … 7=周日；空表示每天 */
  weekdays?: number[];
  once?: boolean;
}
export interface StateTrigger {
  kind: 'state';
  entity: EntityId;
  /** 状态满足下列任一条件即触发 */
  on: 'change' | 'above' | 'below' | 'equals';
  value?: CapabilityValue;
}
export type Trigger = TimeTrigger | StateTrigger;

export interface Condition {
  entity: EntityId;
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'between';
  value: CapabilityValue;
  value2?: CapabilityValue;
  /** 生效时间段 'HH:mm-HH:mm'，可空 */
  timeRange?: string;
}

export interface Automation {
  id: string;
  name: string;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  /** 同一自动化两次触发的冷却时间（ms），防抖（FR-3.6） */
  cooldownMs?: number;
  lastFiredAt?: number;
}

/* ------------------------------------------------------------------ */
/* 用户与权限                                                          */
/* ------------------------------------------------------------------ */

export type Role = 'admin' | 'member' | 'guest';

export interface User {
  id: string;
  name: string;
  role: Role;
  /** 加盐哈希后的口令，绝不明文（FR-7.1） */
  passwordHash: string;
  salt: string;
  createdAt: number;
}

export interface Session {
  token: string;
  userId: string;
  role: Role;
  issuedAt: number;
  expiresAt: number;
}

/* ------------------------------------------------------------------ */
/* 事件与日志                                                          */
/* ------------------------------------------------------------------ */

export interface DomainEvent<T = unknown> {
  type: string;          // 如 'state_changed' / 'device_online' / 'door_opened'
  at: number;
  data: T;
}

export interface StateChangedData {
  entityId: EntityId;
  deviceId: DeviceId;
  capability: CapabilityKind;
  oldValue: CapabilityValue | undefined;
  newValue: CapabilityValue;
}

export interface OperationResult {
  ok: boolean;
  /** 失败原因分类（FR-3.5：四类原因可区分） */
  reason?: 'offline' | 'timeout' | 'unsupported' | 'forbidden' | 'internal';
  message?: string;
  /** 端到端耗时（ms） */
  elapsedMs?: number;
}

export interface AccessLogEntry {
  id: string;
  userId: string;
  method: 'app' | 'panel' | 'key';
  result: 'success' | 'failure';
  at: number;
  note?: string;
}

export interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  target?: string;
  result: 'success' | 'failure';
  at: number;
}
