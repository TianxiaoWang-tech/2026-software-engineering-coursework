import { AcFanSpeed, AcMode, DeviceKind, DeviceState, ModeOption, SpeedOption } from '../model/DeviceModel';
import { DevicePort } from '../ports/DevicePort';
import { getDevicePort } from '../services/AdapterProvider';

const PAGE_BG: string = '#F3F5F9';
const CARD_BG: string = '#FFFFFF';
const ACCENT: string = '#4C7DF0';
const CHIP_BG: string = '#E8EEFC';

@Entry
@Component
struct DeviceDetail {
  @State device: DeviceState = new DeviceState('', '设备', DeviceKind.LIGHT, '');
  private deviceId: string = '';
  private port: DevicePort = getDevicePort();
  private modeOptions: ModeOption[] = [
    new ModeOption(AcMode.COOL, '制冷'),
    new ModeOption(AcMode.HEAT, '制热'),
    new ModeOption(AcMode.FAN, '送风'),
    new ModeOption(AcMode.AUTO, '自动')
  ];
  private speedOptions: SpeedOption[] = [
    new SpeedOption(AcFanSpeed.AUTO, '自动'),
    new SpeedOption(AcFanSpeed.LOW, '低'),
    new SpeedOption(AcFanSpeed.MID, '中'),
    new SpeedOption(AcFanSpeed.HIGH, '高')
  ];
  private listener: () => void = (): void => {
    this.refresh();
  };

  aboutToAppear(): void {
    this.deviceId = AppStorage.get<string>('selectedDeviceId') ?? '';
    this.port.subscribe(this.listener);
    const all: DeviceState[] = this.port.listDevices();
    if (this.deviceId === '' && all.length > 0) {
      this.deviceId = all[0].id;
    }
    this.refresh();
  }

  aboutToDisappear(): void {
    this.port.unsubscribe(this.listener);
  }

  private refresh(): void {
    const d: DeviceState | undefined = this.port.getDevice(this.deviceId);
    if (d !== undefined) {
      this.device = d.copy();
    }
  }

  @Builder
  sectionTitle(title: string) {
    Text(title)
      .fontSize(15)
      .fontColor('#1F2937')
      .width('100%')
  }

  @Builder
  lightPanel() {
    Column() {
      Row() {
        Text('电源').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.device.on })
          .onChange((isOn: boolean) => {
            this.port.setPower(this.deviceId, isOn);
          })
      }
      .width('100%')
      Divider().margin({ top: 14, bottom: 14 })
      Row() {
        Text('亮度').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Text(this.device.brightness + ' %').fontSize(15).fontColor(ACCENT)
      }
      .width('100%')
      Slider({ value: this.device.brightness, min: 1, max: 100, step: 1 })
        .width('100%')
        .trackThickness(6)
        .margin({ top: 8 })
        .onChange((value: number, mode: SliderChangeMode) => {
          this.port.setBrightness(this.deviceId, Math.round(value));
        })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  acPanel() {
    Column() {
      Row() {
        Text('电源').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.device.on })
          .onChange((isOn: boolean) => {
            this.port.setPower(this.deviceId, isOn);
          })
      }
      .width('100%')
      Divider().margin({ top: 14, bottom: 14 })
      Row() {
        Text('目标温度').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Row() {
          Text('−')
            .fontSize(22)
            .fontColor(ACCENT)
            .width(36)
            .height(36)
            .textAlign(TextAlign.Center)
            .backgroundColor(CHIP_BG)
            .borderRadius(18)
            .onClick(() => {
              this.port.setTargetTemp(this.deviceId, this.device.targetTemp - 1);
            })
          Text(this.device.targetTemp + '°C')
            .fontSize(24)
            .fontWeight(FontWeight.Bold)
            .fontColor('#1F2937')
            .width(78)
            .textAlign(TextAlign.Center)
          Text('+')
            .fontSize(22)
            .fontColor(ACCENT)
            .width(36)
            .height(36)
            .textAlign(TextAlign.Center)
            .backgroundColor(CHIP_BG)
            .borderRadius(18)
            .onClick(() => {
              this.port.setTargetTemp(this.deviceId, this.device.targetTemp + 1);
            })
        }
      }
      .width('100%')
      Divider().margin({ top: 14, bottom: 14 })
      this.sectionTitle('模式')
      Row() {
        ForEach(this.modeOptions, (opt: ModeOption) => {
          Text(opt.label)
            .fontSize(13)
            .fontColor(this.device.mode === opt.mode ? '#FFFFFF' : ACCENT)
            .height(32)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .backgroundColor(this.device.mode === opt.mode ? ACCENT : CHIP_BG)
            .borderRadius(16)
            .margin({ left: 4, right: 4 })
            .onClick(() => {
              this.port.setAcMode(this.deviceId, opt.mode);
            })
        }, (opt: ModeOption) => opt.mode + ':' + (this.device.mode === opt.mode).toString())
      }
      .width('100%')
      .margin({ top: 8 })
      this.sectionTitle('风速')
      Row() {
        ForEach(this.speedOptions, (opt: SpeedOption) => {
          Text(opt.label)
            .fontSize(13)
            .fontColor(this.device.fanSpeed === opt.speed ? '#FFFFFF' : ACCENT)
            .height(32)
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .backgroundColor(this.device.fanSpeed === opt.speed ? ACCENT : CHIP_BG)
            .borderRadius(16)
            .margin({ left: 4, right: 4 })
            .onClick(() => {
              this.port.setAcFanSpeed(this.deviceId, opt.speed);
            })
        }, (opt: SpeedOption) => opt.speed + ':' + (this.device.fanSpeed === opt.speed).toString())
      }
      .width('100%')
      .margin({ top: 8 })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  sensorPanel() {
    Column() {
      Row() {
        Column() {
          Text(this.device.temperature.toFixed(1)).fontSize(40).fontWeight(FontWeight.Bold).fontColor('#1F2937')
          Text('温度 °C').fontSize(12).fontColor('#8A94A6')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        Column() {
          Text(this.device.humidity.toString()).fontSize(40).fontWeight(FontWeight.Bold).fontColor('#1F2937')
          Text('湿度 %RH').fontSize(12).fontColor('#8A94A6')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      Divider().margin({ top: 14, bottom: 14 })
      Row() {
        Text('电量').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Text(this.device.battery + ' %').fontSize(15).fontColor(ACCENT)
      }
      .width('100%')
      Text('数据来源：LocalMockAdapter 每 2 秒随机漂移；同房间空调开启时会向目标温度靠拢。')
        .fontSize(12)
        .fontColor('#8A94A6')
        .width('100%')
        .margin({ top: 12 })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  curtainPanel() {
    Column() {
      Row() {
        Text('开合度').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Text(this.device.position + ' %').fontSize(15).fontColor(ACCENT)
      }
      .width('100%')
      Slider({ value: this.device.position, min: 0, max: 100, step: 5 })
        .width('100%')
        .trackThickness(6)
        .margin({ top: 12 })
        .onChange((value: number, mode: SliderChangeMode) => {
          this.port.setCurtainPosition(this.deviceId, Math.round(value));
        })
      Row() {
        Button('全部打开')
          .fontSize(13)
          .height(36)
          .layoutWeight(1)
          .backgroundColor(ACCENT)
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.port.setCurtainPosition(this.deviceId, 100);
          })
        Button('全部关闭')
          .fontSize(13)
          .height(36)
          .layoutWeight(1)
          .backgroundColor(CHIP_BG)
          .fontColor(ACCENT)
          .margin({ left: 12 })
          .onClick(() => {
            this.port.setCurtainPosition(this.deviceId, 0);
          })
      }
      .width('100%')
      .margin({ top: 14 })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  lockPanel() {
    Column() {
      Text(this.device.locked ? '🔒 已上锁' : '🔓 已解锁')
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1F2937')
        .width('100%')
        .textAlign(TextAlign.Center)
        .margin({ top: 8, bottom: 6 })
      Text('虚拟门锁，无真实硬件').fontSize(12).fontColor('#8A94A6').width('100%').textAlign(TextAlign.Center)
      Row() {
        Button('上锁')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor(ACCENT)
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.port.setLockState(this.deviceId, true);
          })
        Button('解锁')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor(CHIP_BG)
          .fontColor(ACCENT)
          .margin({ left: 12 })
          .onClick(() => {
            this.port.setLockState(this.deviceId, false);
          })
      }
      .width('100%')
      .margin({ top: 18 })
      Divider().margin({ top: 16, bottom: 14 })
      Row() {
        Text('电量').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Text(this.device.battery + ' %').fontSize(15).fontColor(ACCENT)
      }
      .width('100%')
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  smokePanel() {
    Column() {
      Text(this.device.alarm ? '⚠ 烟雾告警' : '✅ 状态正常')
        .fontSize(26)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.device.alarm ? '#B42318' : '#1F2937')
        .width('100%')
        .textAlign(TextAlign.Center)
        .margin({ top: 8, bottom: 6 })
      Text(this.device.alarm ? '请立即检查厨房，演示中可解除告警' : '虚拟烟感，使用下方按钮模拟报警')
        .fontSize(12)
        .fontColor('#8A94A6')
        .width('100%')
        .textAlign(TextAlign.Center)
      Row() {
        Button('模拟烟雾')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor('#B42318')
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.port.triggerSmokeAlarm(this.deviceId);
          })
        Button('解除警报')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor(CHIP_BG)
          .fontColor(ACCENT)
          .margin({ left: 12 })
          .onClick(() => {
            this.port.acknowledgeAlarm(this.deviceId);
          })
      }
      .width('100%')
      .margin({ top: 18 })
      Divider().margin({ top: 16, bottom: 14 })
      Row() {
        Text('电量').fontSize(15).fontColor('#1F2937').layoutWeight(1)
        Text(this.device.battery + ' %').fontSize(15).fontColor(ACCENT)
      }
      .width('100%')
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD_BG)
    .borderRadius(18)
    .margin({ top: 12 })
  }

  @Builder
  backButton() {
    Text('←')
      .fontSize(24)
      .fontColor('#1F2937')
      .width(44)
      .onClick(() => {
        try {
          this.getUIContext().getRouter().back();
        } catch (err) {
          console.error('router back failed: ' + JSON.stringify(err));
        }
      })
  }

  build() {
    Column() {
      Row() {
        this.backButton()
        Text(this.device.typeName)
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor('#1F2937')
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text(this.device.room)
          .fontSize(12)
          .fontColor('#8A94A6')
          .width(44)
          .textAlign(TextAlign.End)
      }
      .width('100%')
      .padding({ left: 12, right: 16, top: 14, bottom: 10 })

      List() {
        ListItem() {
          Column() {
            Row() {
              Text(this.device.icon).fontSize(42)
              Column() {
                Text(this.device.name).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#1F2937')
                Text(this.device.statusText).fontSize(14).fontColor('#5A6476').margin({ top: 4 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: 14 })
              Text(this.device.online ? '在线' : '离线')
                .fontSize(11)
                .fontColor(this.device.online ? '#1D9A6C' : '#B0B7C3')
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor('#F0F4F1')
                .borderRadius(8)
            }
            .width('100%')
            .padding(18)
            .backgroundColor(CARD_BG)
            .borderRadius(18)
            .alignItems(VerticalAlign.Center)
          }
          .width('100%')
          .padding({ left: 16, right: 16, top: 6 })
        }

        ListItem() {
          Column() {
            if (this.device.kind === DeviceKind.LIGHT) {
              this.lightPanel()
            } else if (this.device.kind === DeviceKind.AC) {
              this.acPanel()
            } else if (this.device.kind === DeviceKind.SENSOR_TH) {
              this.sensorPanel()
            } else if (this.device.kind === DeviceKind.CURTAIN) {
              this.curtainPanel()
            } else if (this.device.kind === DeviceKind.LOCK) {
              this.lockPanel()
            } else {
              this.smokePanel()
            }
            Text('设备抽象层：当前实现 = LocalMockAdapter（无硬件仿真）')
              .fontSize(11)
              .fontColor('#9AA3B2')
              .width('100%')
              .textAlign(TextAlign.Center)
              .margin({ top: 16 })
          }
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 28 })
        }
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
