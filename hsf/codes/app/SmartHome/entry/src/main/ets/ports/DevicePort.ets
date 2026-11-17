import { AcFanSpeed, AcMode, DeviceState } from '../model/DeviceModel';

/** Called whenever device state changes. UI re-reads listDevices() on each call. */
export type DeviceChangeListener = () => void;

/**
 * Device abstract layer.
 *
 * The UI only depends on this interface. Swap the implementation to move from
 * the in-app simulator to a real gateway (HA / MQTT) without touching pages.
 */
export interface DevicePort {
  start(): void;

  stop(): void;

  isOnline(): boolean;

  listDevices(): DeviceState[];

  getDevice(id: string): DeviceState | undefined;

  setPower(id: string, on: boolean): void;

  setBrightness(id: string, value: number): void;

  setTargetTemp(id: string, value: number): void;

  setAcMode(id: string, mode: AcMode): void;

  setAcFanSpeed(id: string, speed: AcFanSpeed): void;

  setCurtainPosition(id: string, value: number): void;

  setLockState(id: string, locked: boolean): void;

  triggerSmokeAlarm(id: string): void;

  acknowledgeAlarm(id: string): void;

  subscribe(listener: DeviceChangeListener): void;

  unsubscribe(listener: DeviceChangeListener): void;
}
