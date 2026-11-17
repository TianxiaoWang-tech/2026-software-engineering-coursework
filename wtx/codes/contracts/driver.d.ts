/**
 * contracts/driver.d.ts
 * 驱动 SPI（Service Provider Interface）—— 所有设备接入方式的统一契约。
 * 冻结版本：v1.0（2026-11-01）  所有者：A
 *
 * 设计要点（NFR-11）：新增一种协议 = 实现本接口并注册，内核与业务层零改动。
 */

import type {
  DeviceDescriptor,
  DeviceId,
  DeviceProtocol,
  DeviceRecord,
  CapabilityKind,
  CapabilityValue,
  StateMap,
} from './model.d.ts';

export interface DriverContext {
  /** 驱动发布状态上报的唯一出口 */
  emitState(deviceId: DeviceId, state: StateMap): void;
  /** 驱动发现新设备 */
  emitDiscovered(desc: DeviceDescriptor): void;
  /** 驱动上报设备在线/离线（LWT 或心跳超时） */
  emitAvailability(deviceId: DeviceId, online: boolean): void;
  /** 日志 */
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown): void;
  /** 驱动配置（broker 地址、凭据等），来源于配置文件 */
  config: Record<string, unknown>;
}

export interface Driver {
  /** 驱动唯一标识，如 'mqtt' / 'sim' / 'ac-haier' */
  readonly id: string;
  /** 本驱动支持的接入协议 */
  readonly protocols: DeviceProtocol[];

  /** 生命周期：启动/停止（连接 broker、开监听等） */
  start(ctx: DriverContext): Promise<void>;
  stop(): Promise<void>;

  /** 可选：主动扫描/订阅发现 */
  discover?(): Promise<DeviceDescriptor[]>;

  /** 接管一个已登记的设备 */
  attach(device: DeviceRecord): Promise<void>;
  /** 释放设备（删除设备时调用） */
  detach(deviceId: DeviceId): Promise<void>;

  /**
   * 下发控制指令。返回即表示"已发出"，不代表设备已执行；
   * 执行结果通过 emitState 回流，确认超时由上层统一处理（FR-3.4）。
   */
  set(deviceId: DeviceId, capability: CapabilityKind, value: CapabilityValue): Promise<void>;
}

/** 驱动注册表条目 */
export interface DriverRegistration {
  driver: Driver;
  /** 该驱动负责的设备协议 */
  protocols: DeviceProtocol[];
}
