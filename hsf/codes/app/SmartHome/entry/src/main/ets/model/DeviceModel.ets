/**
 * Shared device model for the smart home demo.
 * UI and adapters only exchange DeviceState / RoomGroup, never raw protocol payloads.
 */

export enum DeviceKind {
  LIGHT = 'light',
  AC = 'ac',
  SENSOR_TH = 'sensor_th',
  CURTAIN = 'curtain',
  LOCK = 'lock',
  SMOKE = 'smoke'
}

export enum AcMode {
  COOL = 'cool',
  HEAT = 'heat',
  FAN = 'fan',
  AUTO = 'auto'
}

export enum AcFanSpeed {
  AUTO = 'auto',
  LOW = 'low',
  MID = 'mid',
  HIGH = 'high'
}

/** Option rows used by @Builder ForEach, so build() always reads plain fields. */
export class SceneOption {
  key: string;
  label: string;

  constructor(key: string, label: string) {
    this.key = key;
    this.label = label;
  }
}

export class ModeOption {
  mode: AcMode;
  label: string;

  constructor(mode: AcMode, label: string) {
    this.mode = mode;
    this.label = label;
  }
}

export class SpeedOption {
  speed: AcFanSpeed;
  label: string;

  constructor(speed: AcFanSpeed, label: string) {
    this.speed = speed;
    this.label = label;
  }
}

export class DeviceState {
  id: string;
  name: string;
  kind: DeviceKind;
  room: string;
  icon: string;
  typeName: string;
  statusText: string = '';
  online: boolean = true;

  // light
  on: boolean = false;
  brightness: number = 60;
  colorTemp: number = 4000;

  // sensor / battery
  temperature: number = 25;
  humidity: number = 50;
  battery: number = 100;

  // air conditioner
  targetTemp: number = 26;
  mode: AcMode = AcMode.COOL;
  fanSpeed: AcFanSpeed = AcFanSpeed.AUTO;

  // curtain: 0 closed, 100 open
  position: number = 0;

  // door lock
  locked: boolean = true;

  // smoke detector
  alarm: boolean = false;

  constructor(id: string, name: string, kind: DeviceKind, room: string) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.room = room;
    this.icon = iconOfKind(kind);
    this.typeName = nameOfKind(kind);
  }

  copy(): DeviceState {
    const d: DeviceState = new DeviceState(this.id, this.name, this.kind, this.room);
    d.statusText = this.statusText;
    d.online = this.online;
    d.on = this.on;
    d.brightness = this.brightness;
    d.colorTemp = this.colorTemp;
    d.temperature = this.temperature;
    d.humidity = this.humidity;
    d.battery = this.battery;
    d.targetTemp = this.targetTemp;
    d.mode = this.mode;
    d.fanSpeed = this.fanSpeed;
    d.position = this.position;
    d.locked = this.locked;
    d.alarm = this.alarm;
    return d;
  }
}

export class RoomGroup {
  room: string;
  devices: DeviceState[];

  constructor(room: string, devices: DeviceState[]) {
    this.room = room;
    this.devices = devices;
  }
}

export function iconOfKind(kind: DeviceKind): string {
  switch (kind) {
    case DeviceKind.LIGHT:
      return '💡';
    case DeviceKind.AC:
      return '❄️';
    case DeviceKind.SENSOR_TH:
      return '🌡️';
    case DeviceKind.CURTAIN:
      return '🪟';
    case DeviceKind.LOCK:
      return '🔒';
    case DeviceKind.SMOKE:
      return '🚨';
    default:
      return '📦';
  }
}

export function nameOfKind(kind: DeviceKind): string {
  switch (kind) {
    case DeviceKind.LIGHT:
      return '灯光';
    case DeviceKind.AC:
      return '空调';
    case DeviceKind.SENSOR_TH:
      return '温湿度';
    case DeviceKind.CURTAIN:
      return '窗帘';
    case DeviceKind.LOCK:
      return '门锁';
    case DeviceKind.SMOKE:
      return '烟感';
    default:
      return '设备';
  }
}
