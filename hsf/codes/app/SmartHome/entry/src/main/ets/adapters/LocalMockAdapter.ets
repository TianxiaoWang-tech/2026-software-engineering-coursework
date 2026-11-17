import { AcFanSpeed, AcMode, DeviceKind, DeviceState } from '../model/DeviceModel';
import { DeviceChangeListener, DevicePort } from '../ports/DevicePort';

const TAG: string = 'LocalMockAdapter';
const TICK_MS: number = 2000;

/**
 * In-app virtual devices. No network, no hardware: every device lives in memory
 * and a 2s timer keeps the sensor drifting so the UI looks alive.
 */
export class LocalMockAdapter implements DevicePort {
  private static instance: LocalMockAdapter | undefined = undefined;

  private devices: DeviceState[] = [];
  private listeners: DeviceChangeListener[] = [];
  private timerId: number = -1;
  private running: boolean = false;

  private constructor() {
    this.devices = LocalMockAdapter.createDevices();
    this.emit();
  }

  static getInstance(): LocalMockAdapter {
    if (LocalMockAdapter.instance === undefined) {
      LocalMockAdapter.instance = new LocalMockAdapter();
    }
    return LocalMockAdapter.instance;
  }

  private static createDevices(): DeviceState[] {
    const list: DeviceState[] = [];

    const livingLight: DeviceState = new DeviceState('living_light', '客厅主灯', DeviceKind.LIGHT, '客厅');
    livingLight.on = true;
    livingLight.brightness = 80;
    list.push(livingLight);

    const livingSensor: DeviceState = new DeviceState('living_sensor', '客厅温湿度', DeviceKind.SENSOR_TH, '客厅');
    livingSensor.temperature = 25.6;
    livingSensor.humidity = 52;
    livingSensor.battery = 92;
    list.push(livingSensor);

    const livingAc: DeviceState = new DeviceState('living_ac', '客厅空调', DeviceKind.AC, '客厅');
    livingAc.targetTemp = 26;
    livingAc.mode = AcMode.COOL;
    livingAc.fanSpeed = AcFanSpeed.AUTO;
    list.push(livingAc);

    const livingCurtain: DeviceState = new DeviceState('living_curtain', '客厅窗帘', DeviceKind.CURTAIN, '客厅');
    livingCurtain.position = 60;
    list.push(livingCurtain);

    const bedroomLight: DeviceState = new DeviceState('bedroom_light', '卧室灯', DeviceKind.LIGHT, '卧室');
    bedroomLight.brightness = 40;
    list.push(bedroomLight);

    const doorLock: DeviceState = new DeviceState('door_lock', '入户门锁', DeviceKind.LOCK, '玄关');
    doorLock.battery = 76;
    list.push(doorLock);

    const kitchenSmoke: DeviceState = new DeviceState('kitchen_smoke', '厨房烟感', DeviceKind.SMOKE, '厨房');
    kitchenSmoke.battery = 87;
    list.push(kitchenSmoke);

    return list;
  }

  private static modeText(mode: AcMode): string {
    switch (mode) {
      case AcMode.COOL:
        return '制冷';
      case AcMode.HEAT:
        return '制热';
      case AcMode.FAN:
        return '送风';
      default:
        return '自动';
    }
  }

  private static describe(d: DeviceState): string {
    switch (d.kind) {
      case DeviceKind.LIGHT:
        return d.on ? ('已开启 · 亮度 ' + d.brightness + '%') : '已关闭';
      case DeviceKind.AC:
        return d.on ? (d.targetTemp + '°C · ' + LocalMockAdapter.modeText(d.mode)) : '已关闭';
      case DeviceKind.SENSOR_TH:
        return d.temperature.toFixed(1) + '°C · ' + d.humidity + '%RH';
      case DeviceKind.CURTAIN:
        if (d.position >= 100) {
          return '已打开';
        }
        if (d.position <= 0) {
          return '已关闭';
        }
        return '开合 ' + d.position + '%';
      case DeviceKind.LOCK:
        return d.locked ? '已上锁' : '已解锁';
      case DeviceKind.SMOKE:
        return d.alarm ? '烟雾告警' : '正常';
      default:
        return d.online ? '在线' : '离线';
    }
  }

  private emit(): void {
    this.devices.forEach((d: DeviceState): void => {
      d.statusText = LocalMockAdapter.describe(d);
    });
    const snapshot: DeviceChangeListener[] = this.listeners.slice();
    snapshot.forEach((listener: DeviceChangeListener): void => {
      listener();
    });
  }

  private mutate(id: string, action: string, apply: (d: DeviceState) => void): void {
    const d: DeviceState | undefined = this.getDevice(id);
    if (d === undefined) {
      console.warn(TAG + ' unknown device: ' + id);
      return;
    }
    apply(d);
    console.info(TAG + ' ' + d.name + ' <- ' + action);
    this.emit();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timerId = setInterval((): void => {
      this.tick();
    }, TICK_MS);
    console.info(TAG + ' started (tick=' + TICK_MS + 'ms)');
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    clearInterval(this.timerId);
    this.timerId = -1;
    console.info(TAG + ' stopped');
  }

  isOnline(): boolean {
    return this.running;
  }

  listDevices(): DeviceState[] {
    return this.devices.map((d: DeviceState): DeviceState => d.copy());
  }

  getDevice(id: string): DeviceState | undefined {
    return this.devices.find((d: DeviceState): boolean => d.id === id);
  }

  setPower(id: string, on: boolean): void {
    this.mutate(id, on ? 'power on' : 'power off', (d: DeviceState): void => {
      d.on = on;
    });
  }

  setBrightness(id: string, value: number): void {
    const target: number = Math.max(1, Math.min(100, Math.round(value)));
    this.mutate(id, 'brightness=' + target, (d: DeviceState): void => {
      d.brightness = target;
      if (target > 0) {
        d.on = true;
      }
    });
  }

  setTargetTemp(id: string, value: number): void {
    const target: number = Math.max(16, Math.min(32, Math.round(value)));
    this.mutate(id, 'targetTemp=' + target, (d: DeviceState): void => {
      d.targetTemp = target;
    });
  }

  setAcMode(id: string, mode: AcMode): void {
    this.mutate(id, 'mode=' + mode, (d: DeviceState): void => {
      d.mode = mode;
      d.on = true;
    });
  }

  setAcFanSpeed(id: string, speed: AcFanSpeed): void {
    this.mutate(id, 'fanSpeed=' + speed, (d: DeviceState): void => {
      d.fanSpeed = speed;
      d.on = true;
    });
  }

  setCurtainPosition(id: string, value: number): void {
    const target: number = Math.max(0, Math.min(100, Math.round(value)));
    this.mutate(id, 'curtain=' + target, (d: DeviceState): void => {
      d.position = target;
    });
  }

  setLockState(id: string, locked: boolean): void {
    this.mutate(id, locked ? 'lock' : 'unlock', (d: DeviceState): void => {
      d.locked = locked;
    });
  }

  triggerSmokeAlarm(id: string): void {
    this.mutate(id, 'smoke alarm', (d: DeviceState): void => {
      d.alarm = true;
    });
  }

  acknowledgeAlarm(id: string): void {
    this.mutate(id, 'alarm ack', (d: DeviceState): void => {
      d.alarm = false;
    });
  }

  subscribe(listener: DeviceChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
  }

  unsubscribe(listener: DeviceChangeListener): void {
    const index: number = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  private tick(): void {
    const sensors: DeviceState[] = this.devices.filter((d: DeviceState): boolean => d.kind === DeviceKind.SENSOR_TH);
    sensors.forEach((sensor: DeviceState): void => {
      const ac: DeviceState | undefined = this.devices.find((d: DeviceState): boolean =>
        d.kind === DeviceKind.AC && d.on && d.room === sensor.room);
      let temp: number = sensor.temperature + (Math.random() - 0.5) * 0.2;
      if (ac !== undefined) {
        temp = temp + (ac.targetTemp - temp) * 0.08;
      }
      sensor.temperature = Math.round(temp * 10) / 10;
      let hum: number = sensor.humidity + (Math.random() - 0.5) * 1.2;
      if (hum < 30) {
        hum = 30;
      }
      if (hum > 85) {
        hum = 85;
      }
      sensor.humidity = Math.round(hum);
    });
    this.emit();
  }
}
