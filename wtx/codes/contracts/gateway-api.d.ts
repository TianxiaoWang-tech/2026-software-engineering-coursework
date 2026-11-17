/**
 * contracts/gateway-api.d.ts
 * 移动端 ↔ 控制网关 通信协议契约（WebSocket over TLS + 应用层 AEAD）。
 * 冻结版本：v1.0（2026-11-01）  所有者：A（消费方：C）
 *
 * 报文分两层：
 *   外层 Envelope：明文路由信息 + 加密载荷（FR-7.4 数据层加密）
 *   内层 Request/Response/Event：业务语义
 */

import type {
  AreaId,
  Area,
  Automation,
  CapabilityKind,
  CapabilityValue,
  DeviceId,
  DeviceRecord,
  EntityId,
  OperationResult,
  Scene,
  StateMap,
} from './model.d.ts';

/* ------------------------------------------------------------------ */
/* 外层：加密信封                                                      */
/* ------------------------------------------------------------------ */

export interface Envelope {
  /** 协议版本，当前 1 */
  v: 1;
  /** 请求/响应关联 ID；推送帧为独立 ID */
  id: string;
  /** 单调递增序号，服务端用于拒绝重放（FR-7.4） */
  seq: number;
  /** 帧类型放明文，便于网关在不解密时做限流与路由 */
  kind: 'req' | 'res' | 'evt';
  /** AES-256-GCM 随机 nonce（base64，12 字节） */
  nonce: string;
  /** 密文（base64），全部业务字段都在里面 */
  payload: string;
}

/* ------------------------------------------------------------------ */
/* 内层：业务语义                                                      */
/* ------------------------------------------------------------------ */

export type RequestMethod =
  | 'auth.login'
  | 'auth.logout'
  | 'system.hello'
  | 'area.list'
  | 'device.list'
  | 'device.add'
  | 'device.remove'
  | 'device.rename'
  | 'state.get'
  | 'climate.profile'
  | 'control.set'
  | 'scene.list'
  | 'scene.run'
  | 'automation.list'
  | 'automation.save'
  | 'access.open'
  | 'access.logs'
  | 'ops.selfCheck';

export interface Request<T = unknown> {
  method: RequestMethod;
  params: T;
  /** 会话令牌；auth.login 时为空 */
  token?: string;
}

export interface Response<T = unknown> {
  ok: boolean;
  /** 错误码，见 ErrorCode */
  code?: ErrorCode;
  message?: string;
  data?: T;
}

/** 推送事件（服务端主动） */
export type EventName =
  | 'state.changed'
  | 'device.availability'
  | 'alarm.push'
  | 'scene.executed';

export interface EventPayload {
  event: EventName;
  at: number;
  data: unknown;
}

export type ErrorCode =
  | 'UNAUTHORIZED'    // 未登录/令牌过期
  | 'FORBIDDEN'       // 越权（FR-4.5）
  | 'NOT_FOUND'
  | 'BAD_PARAMS'
  | 'OFFLINE'         // 设备离线
  | 'TIMEOUT'         // 指令超时
  | 'UNSUPPORTED'     // 设备不支持该能力
  | 'REPLAY'          // 重放被拒
  | 'INTERNAL';

/* ------------------------------------------------------------------ */
/* 各方法参数与返回                                                     */
/* ------------------------------------------------------------------ */

export interface LoginParams { name: string; password: string }
export interface LoginResult { token: string; role: 'admin' | 'member' | 'guest'; expiresAt: number }

export interface HelloResult {
  gatewayId: string;
  version: string;
  protocolVersion: 1;
  /** 服务端公钥指纹（三层加密中的密钥层校验用） */
  keyFingerprint: string;
}

export interface DeviceListResult {
  areas: Area[];
  devices: DeviceRecord[];
  /** 每个设备的最新状态快照，避免首屏 N 次请求 */
  states: Record<DeviceId, StateMap>;
}

export interface ControlParams {
  deviceId: DeviceId;
  capability: CapabilityKind;
  value: CapabilityValue;
}

export interface SceneRunResult { sceneId: string; results: Array<{ action: string; ok: boolean }> }

export interface AccessOpenParams { deviceId: DeviceId; /** 二次确认口令或 PIN */ confirm: string }
export interface AccessOpenResult extends OperationResult { logId?: string }

export interface StateGetParams { entityIds?: EntityId[]; deviceId?: DeviceId }
export interface StateGetResult { states: Record<EntityId, { value: CapabilityValue; updatedAt: number; stale: boolean }> }

export interface AreaListResult { areas: Area[] }

export interface AutomationSaveParams { automation: Automation }
export interface AutomationListResult { automations: Automation[] }

export interface ClimateProfileParams { deviceId: DeviceId }
export interface ClimateProfileResult {
  brand: string;
  transport: string;
  modes: string[];
  fanSpeeds: string[];
  swing: boolean;
  minTemp: number;
  maxTemp: number;
  tempStep: number;
}

export interface SceneListResult { scenes: Scene[] }

export interface OpsSelfCheckResult {
  at: number;
  checks: Array<{ name: string; ok: boolean; detail?: string; suggestion?: string }>;
}

/** 不同方法 → 参数/返回类型的映射，供实现处做类型约束 */
export interface ApiMap {
  'auth.login': { params: LoginParams; result: LoginResult };
  'system.hello': { params: Record<string, never>; result: HelloResult };
  'area.list': { params: Record<string, never>; result: AreaListResult };
  'device.list': { params: Record<string, never>; result: DeviceListResult };
  'device.add': { params: { descriptor: DeviceRecord }; result: { id: DeviceId } };
  'device.remove': { params: { deviceId: DeviceId }; result: Record<string, never> };
  'device.rename': { params: { deviceId: DeviceId; name?: string; areaId?: AreaId }; result: Record<string, never> };
  'state.get': { params: StateGetParams; result: StateGetResult };
  'climate.profile': { params: ClimateProfileParams; result: ClimateProfileResult };
  'control.set': { params: ControlParams; result: OperationResult };
  'scene.list': { params: Record<string, never>; result: SceneListResult };
  'scene.run': { params: { sceneId: string }; result: SceneRunResult };
  'automation.list': { params: Record<string, never>; result: AutomationListResult };
  'automation.save': { params: AutomationSaveParams; result: { id: string } };
  'access.open': { params: AccessOpenParams; result: AccessOpenResult };
  'access.logs': { params: { limit?: number }; result: { logs: unknown[] } };
  'ops.selfCheck': { params: Record<string, never>; result: OpsSelfCheckResult };
}
