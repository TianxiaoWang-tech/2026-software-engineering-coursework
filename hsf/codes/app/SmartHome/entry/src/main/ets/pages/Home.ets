import { DeviceKind, DeviceState, RoomGroup, SceneOption } from '../model/DeviceModel';
import { DevicePort } from '../ports/DevicePort';
import { getDevicePort } from '../services/AdapterProvider';

const PAGE_BG: string = '#F3F5F9';
const CARD_BG: string = '#FFFFFF';

@Entry
@Component
struct Home {
  @State groups: RoomGroup[] = [];
  @State tempText: string = '--';
  @State humidityText: string = '--';
  @State deviceCount: number = 0;
  @State alarmText: string = '';
  @State activeScene: string = 'home';
  private port: DevicePort = getDevicePort();
  private scenes: SceneOption[] = [
    new SceneOption('home', '回家'),
    new SceneOption('away', '离家'),
    new SceneOption('sleep', '睡眠')
  ];
  private listener: () => void = (): void => {
    this.refresh();
  };

  aboutToAppear(): void {
    this.port.subscribe(this.listener);
    this.port.start();
    this.refresh();
  }

  aboutToDisappear(): void {
    this.port.unsubscribe(this.listener);
  }

  private refresh(): void {
    const all: DeviceState[] = this.port.listDevices();
    this.deviceCount = all.length;
    const rooms: string[] = [];
    all.forEach((d: DeviceState): void => {
      if (rooms.indexOf(d.room) < 0) {
        rooms.push(d.room);
      }
    });
    const next: RoomGroup[] = [];
    rooms.forEach((room: string): void => {
      const list: DeviceState[] = all.filter((d: DeviceState): boolean => d.room === room);
      next.push(new RoomGroup(room, list));
    });
    this.groups = next;
    const sensor: DeviceState | undefined = all.find((d: DeviceState): boolean => d.kind === DeviceKind.SENSOR_TH);
    if (sensor !== undefined) {
      this.tempText = sensor.temperature.toFixed(1);
      this.humidityText = sensor.humidity.toString();
    }
    const smoke: DeviceState | undefined = all.find((d: DeviceState): boolean => d.kind === DeviceKind.SMOKE && d.alarm);
    this.alarmText = smoke === undefined ? '' : ('烟雾告警：' + smoke.name + '，请立即处理');
  }

  private runScene(key: string): void {
    this.activeScene = key;
    const all: DeviceState[] = this.port.listDevices();
    all.forEach((d: DeviceState): void => {
      if (d.kind === DeviceKind.LIGHT) {
        this.port.setPower(d.id, key === 'home' && d.room === '客厅');
      } else if (d.kind === DeviceKind.AC) {
        this.port.setPower(d.id, key !== 'away');
        this.port.setTargetTemp(d.id, key === 'sleep' ? 27 : 26);
      } else if (d.kind === DeviceKind.CURTAIN) {
        this.port.setCurtainPosition(d.id, key === 'home' ? 100 : 0);
      } else if (d.kind === DeviceKind.LOCK) {
        this.port.setLockState(d.id, true);
      }
    });
  }

  private openDetail(id: string): void {
    AppStorage.setOrCreate<string>('selectedDeviceId', id);
    try {
      this.getUIContext().getRouter().pushUrl({ url: 'pages/DeviceDetail' });
    } catch (err) {
      console.error('pushUrl failed: ' + JSON.stringify(err));
    }
  }

  @Builder
  deviceCard(d: DeviceState) {
    Row() {
      Text(d.icon)
        .fontSize(26)
        .width(46)
        .textAlign(TextAlign.Center)
      Column() {
        Text(d.name).fontSize(16).fontWeight(FontWeight.Medium).fontColor('#1F2937')
        Text(d.statusText).fontSize(12).fontColor('#8A94A6').margin({ top: 3 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 6 })
      if (d.kind === DeviceKind.LIGHT || d.kind === DeviceKind.AC) {
        Toggle({ type: ToggleType.Switch, isOn: d.on })
          .onChange((isOn: boolean) => {
            this.port.setPower(d.id, isOn);
          })
      } else {
        Text(d.online ? '在线' : '离线')
          .fontSize(11)
          .fontColor(d.online ? '#1D9A6C' : '#B0B7C3')
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .backgroundColor('#F0F4F1')
          .borderRadius(8)
      }
    }
    .width('100%')
    .padding(14)
    .backgroundColor(CARD_BG)
    .borderRadius(16)
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: 10 })
    .onClick(() => {
      this.openDetail(d.id);
    })
  }

  build() {
    Column() {
      Column() {
        Row() {
          Column() {
            Text('我的家').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
            Text(this.deviceCount + ' 个设备 · 本地模拟运行').fontSize(12).fontColor('#D9E3FF').margin({ top: 4 })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Text('LocalMock')
            .fontSize(11)
            .fontColor('#FFFFFF')
            .padding({ left: 10, right: 10, top: 5, bottom: 5 })
            .backgroundColor('#33FFFFFF')
            .borderRadius(10)
        }
        .width('100%')

        Row() {
          Column() {
            Text(this.tempText + ' °C').fontSize(19).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
            Text('温度').fontSize(11).fontColor('#D9E3FF').margin({ top: 2 })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          Column() {
            Text(this.humidityText + ' %').fontSize(19).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
            Text('湿度').fontSize(11).fontColor('#D9E3FF').margin({ top: 2 })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          Column() {
            Text(this.deviceCount.toString()).fontSize(19).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
            Text('设备').fontSize(11).fontColor('#D9E3FF').margin({ top: 2 })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .margin({ top: 20 })
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 22, bottom: 26 })
      .linearGradient({ angle: 135, colors: [['#4C7DF0', 0.0], ['#7A5AF8', 1.0]] })
      .borderRadius({ bottomLeft: 26, bottomRight: 26 })

      Column() {
        Row() {
          ForEach(this.scenes, (s: SceneOption) => {
            Button(s.label)
              .fontSize(13)
              .height(34)
              .layoutWeight(1)
              .fontColor(this.activeScene === s.key ? '#FFFFFF' : '#4C7DF0')
              .backgroundColor(this.activeScene === s.key ? '#4C7DF0' : '#E8EEFC')
              .borderRadius(17)
              .margin({ left: 5, right: 5 })
              .onClick(() => {
                this.runScene(s.key);
              })
          }, (s: SceneOption) => s.key + ':' + (this.activeScene === s.key).toString())
        }
        .width('100%')
        .margin({ top: 14 })

        if (this.alarmText !== '') {
          Row() {
            Text('🚨').fontSize(18)
            Text(this.alarmText).fontSize(13).fontColor('#B42318').margin({ left: 8 }).layoutWeight(1)
          }
          .width('100%')
          .padding(12)
          .backgroundColor('#FEE4E2')
          .borderRadius(12)
          .margin({ top: 12 })
          .onClick(() => {
            this.port.acknowledgeAlarm('kitchen_smoke');
          })
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16 })

      Scroll() {
        Column() {
          ForEach(this.groups, (g: RoomGroup) => {
            Column() {
              Row() {
                Text(g.room).fontSize(14).fontWeight(FontWeight.Medium).fontColor('#5A6476').layoutWeight(1)
                Text(g.devices.length + ' 个').fontSize(11).fontColor('#9AA3B2')
              }
              .width('100%')
              .margin({ top: 14, bottom: 8 })
              ForEach(g.devices, (d: DeviceState) => {
                this.deviceCard(d)
              }, (d: DeviceState) => d.id + ':' + d.statusText)
            }
            .width('100%')
          }, (g: RoomGroup) => g.room + ':' + g.devices.map((d: DeviceState): string => d.statusText).join('|'))
          Text('点击卡片进入控制页 · 数据由 LocalMockAdapter 每 2 秒刷新')
            .fontSize(11)
            .fontColor('#9AA3B2')
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 10, bottom: 24 })
        }
        .width('100%')
        .padding({ left: 16, right: 16 })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }
}
