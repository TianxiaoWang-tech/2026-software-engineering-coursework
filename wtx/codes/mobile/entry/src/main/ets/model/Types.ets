/**
 * mobile/entry/src/main/ets/model/Types.ets
 * 与 contracts/model.d.ts 保持一致的类型定义（ArkTS 侧）。
 * 任何字段改动都必须先改 contracts，再同步到这里。
 */

export type CapabilityKind =
  | 'switch'
  | 'brightness'
  | 'color_temp'
  | 'temperature'
  | 'humidity'
  | 'hvac_mode'
  | 'target_temp'
  | 'fan_speed'
  | 'swing'
  | 'lock'
  | 'lock_state'
  | 'door_state'
  | 'motion'
  | 'illuminance';

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  valueType: 'boolean' | 'number' | 'enum';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: string[];
  readable: boolean;
  writable: boolean;
}

export interface Area {
  id: string;
  name: string;
  sort: number;
}

export interface DeviceRecord {
  id: string;
  name: string;
  category: 'light' | 'ac' | 'sensor' | 'lock';
  brand?: string;
  model?: string;
  protocol: string;
  driver: string;
  areaId?: string;
  online: boolean;
  capabilities: CapabilityDescriptor[];
}

export type StateMap = Record<string, boolean | number | string>;

export interface DeviceListResult {
  areas: Area[];
  devices: DeviceRecord[];
  states: Record<string, StateMap>;
}

export interface Envelope {
  v: number;
  id: string;
  seq: number;
  kind: 'req' | 'res' | 'evt';
  nonce: string;
  payload: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  code?: string;
  message?: string;
  data?: T;
}

/** 与 contracts/gateway-api.d.ts 的 AcCapabilityProfile 对应 */
export interface AcCapabilityProfile {
  brand: string;
  transport: string;
  modes: string[];
  fanSpeeds: string[];
  swing: boolean;
  minTemp: number;
  maxTemp: number;
  tempStep: number;
}

export interface AccessLog {
  id: string;
  userId: string;
  method: string;
  result: string;
  note?: string;
  at: number;
}

/** 空调品牌展示名（FR-3.4：同一界面控多品牌）
 *  ArkTS 禁止无类型对象字面量，因此用 Map。 */
export const BRAND_LABEL: Map<string, string> = new Map<string, string>([
  ['gree', '格力'],
  ['midea', '美的'],
  ['haier', '海尔'],
]);

/* ---------- 请求参数类型（ArkTS 要求显式声明，禁止裸对象字面量） ---------- */

export interface LoginParams {
  name: string;
  password: string;
}

export interface DeviceIdParams {
  deviceId: string;
}

export interface ControlParams {
  deviceId: string;
  capability: string;
  value: boolean | number | string;
}

export interface AccessLogsParams {
  limit: number;
}

export interface AccessOpenParams {
  deviceId: string;
  confirm: string;
}

export interface SceneRunParams {
  sceneId: string;
}
