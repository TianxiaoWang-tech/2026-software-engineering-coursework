/**
 * contracts/ac-adapter.d.ts
 * 品牌空调适配器契约 —— 屏蔽海尔/格力/美的等品牌差异的核心抽象。
 * 冻结版本：v1.0（2026-11-01）  所有者：A（实现：B）
 *
 * 设计要点（FR-3.5 / NFR-11）：
 *   上层只认 hvac_mode / target_temp / fan_speed / swing 四个统一能力；
 *   品牌差异（码值、能力子集、传输通道）全部收敛在适配器内部。
 *   新增一个品牌 = 新增一个适配器文件 + 注册，界面与规则引擎零改动。
 */

import type { CapabilityKind, CapabilityValue, DeviceId, StateMap } from './model.d.ts';

/** 统一空调能力集合 */
export type AcCapability = Extract<
  CapabilityKind,
  'hvac_mode' | 'target_temp' | 'fan_speed' | 'swing'
>;

/** 品牌接入通道 */
export type AcTransportKind =
  | 'cloud_api'   // 厂商开放 API（需要授权与云端账号）
  | 'ir'          // 红外码库（本地发射，无需授权，推荐）
  | 'modbus'      // 通用网关的 Modbus 映射
  | 'sim';        // 仿真

/** 品牌能力子集：不同品牌支持的模式/风速并不一致（FR-3.3 置灰依据） */
export interface AcCapabilityProfile {
  brand: string;
  transport: AcTransportKind;
  /** 支持的模式，决定界面置灰项 */
  modes: Array<'cool' | 'heat' | 'fan' | 'dry' | 'auto'>;
  fanSpeeds: Array<'auto' | 'low' | 'medium' | 'high'>;
  swing: boolean;
  minTemp: number;
  maxTemp: number;
  tempStep: number;
}

export interface AcCommand {
  /** 指令唯一 ID，用于回执匹配（FR-3.4） */
  msgId: string;
  capability: AcCapability;
  value: CapabilityValue;
}

export interface AcResult {
  ok: boolean;
  /** 失败原因，与 model.OperationResult.reason 对齐 */
  reason?: 'offline' | 'timeout' | 'unsupported' | 'forbidden' | 'internal';
  message?: string;
  /** 厂商侧回执码（调试用） */
  vendorCode?: string | number;
}

export interface AcAdapter {
  /** 品牌标识：'haier' | 'gree' | 'midea' */
  readonly brand: string;
  /** 接入通道 */
  readonly transport: AcTransportKind;

  /** 该品牌的能力子集，供界面渲染与指令校验 */
  profile(deviceId: DeviceId): AcCapabilityProfile;

  /** 初始化（加载码库、登录厂商云等） */
  init(): Promise<void>;

  /**
   * 下发统一能力指令，内部负责映射为品牌协议。
   * 必须自行完成"统一值 → 品牌码值"的翻译，不得把品牌概念泄漏给调用方。
   */
  set(deviceId: DeviceId, cmd: AcCommand): Promise<AcResult>;

  /** 解析品牌侧上报，产出统一状态（可只含变化的部分） */
  parseState(deviceId: DeviceId, raw: unknown): StateMap;
}

/** 适配器注册表 */
export interface AcAdapterRegistry {
  register(adapter: AcAdapter): void;
  /** 按品牌取适配器；未注册时返回 undefined，调用方需降级为只读 */
  get(brand: string): AcAdapter | undefined;
  list(): AcAdapter[];
}
