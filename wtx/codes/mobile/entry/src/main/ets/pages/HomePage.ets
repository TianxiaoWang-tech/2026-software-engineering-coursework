/**
 * mobile/.../pages/HomePage.ets
 * 首页：四大中心入口 + 设备总览（FR-6.2 / FR-6.3）。
 * 订阅网关推送，状态变化自动刷新，无需手动下拉。
 */

import { router } from '@kit.ArkUI';
import { gateway } from '../net/GatewayClient';
import { Area, DeviceRecord, DeviceListResult, StateMap } from '../model/Types';

interface CenterCard {
  key: string;
  title: string;
  desc: string;
  page: string;
  color: string;
}

@Entry
@Component
struct HomePage {
  @State areas: Area[] = [];
  @State devices: DeviceRecord[] = [];
  @State states: Record<string, StateMap> = {};
  @State online: number = 0;

  private centers: CenterCard[] = [
    { key: 'light', title: '照明中心', desc: '开关 · 调光 · 人体感应', page: 'pages/LightingPage', color: '#FFB74D' },
    { key: 'climate', title: '温湿度中心', desc: '温度 · 湿度 · 多品牌空调', page: 'pages/ClimatePage', color: '#4FC3F7' },
    { key: 'access', title: '智能门禁', desc: '远程开门 · 开锁记录', page: 'pages/AccessPage', color: '#81C784' },
    { key: 'scene', title: '场景', desc: '回家 · 离家 · 睡眠', page: 'pages/ScenesPage', color: '#9575CD' },
  ];

  aboutToAppear(): void {
    gateway.onEvent = () => this.refresh();
    this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const data = (await gateway.loadDevices()) as DeviceListResult;
      if (!data) return;
      this.areas = data.areas;
      this.devices = data.devices;
      this.states = data.states;
      this.online = data.devices.filter((d) => d.online).length;
    } catch (e) {
      // 连接断开时保持上次数据，不弹窗打断
    }
  }

  private devicesOf(category: string): DeviceRecord[] {
    return this.devices.filter((d) => d.category === category);
  }

  private summaryOf(d: DeviceRecord): string {
    const s = this.states[d.id];
    if (!s) return '—';
    if (d.category === 'light') return s.switch ? `已开 · ${s.brightness ?? 100}%` : '已关';
    if (d.category === 'ac') return s.switch ? `${s.hvac_mode} · ${s.target_temp}℃` : '已关';
    if (d.category === 'sensor') return `${s.temperature ?? '--'}℃ / ${s.humidity ?? '--'}%`;
    if (d.category === 'lock') return s.lock_state === 'unlocked' ? '已开锁' : '已上锁';
    return '—';
  }

  build() {
    Column() {
      Row() {
        Column({ space: 2 }) {
          Text('我的家').fontSize(24).fontWeight(FontWeight.Bold)
          Text(`${this.devices.length} 台设备 · ${this.online} 台在线`).fontSize(12).fontColor('#888')
        }.alignItems(HorizontalAlign.Start)
        Blank()
        Button('刷新').fontSize(12).height(32).onClick(() => this.refresh())
      }.width('92%').margin({ top: 16, bottom: 12 })

      Grid() {
        ForEach(this.centers, (c: CenterCard) => {
          GridItem() {
            Column({ space: 6 }) {
              Text(c.title).fontSize(16).fontWeight(FontWeight.Medium).fontColor('#fff')
              Text(c.desc).fontSize(11).fontColor('#FFFFFFCC')
            }
            .alignItems(HorizontalAlign.Start)
            .padding(14)
            .width('100%')
            .height('100%')
            .borderRadius(14)
            .backgroundColor(c.color)
            .onClick(() => router.pushUrl({ url: c.page }))
          }
        })
      }
      .columnsTemplate('1fr 1fr')
      .rowsTemplate('1fr 1fr')
      .rowsGap(12)
      .columnsGap(12)
      .width('92%')
      .height(180)

      Text('设备').fontSize(16).fontWeight(FontWeight.Medium).width('92%').margin({ top: 16, bottom: 8 })

      List({ space: 8 }) {
        ForEach(this.devices, (d: DeviceRecord) => {
          ListItem() {
            Row() {
              Column({ space: 2 }) {
                Text(d.name).fontSize(15)
                Text(`${d.brand ? d.brand + ' · ' : ''}${d.areaId ?? '未分配'}`)
                  .fontSize(11)
                  .fontColor('#999')
              }.alignItems(HorizontalAlign.Start)
              Blank()
              Text(this.summaryOf(d)).fontSize(13).fontColor(d.online ? '#333' : '#BBB')
            }
            .width('100%')
            .padding(12)
            .backgroundColor(Color.White)
            .borderRadius(10)
          }
        })
      }
      .layoutWeight(1)
      .width('92%')

      Button('场景快捷入口').width('92%').margin({ bottom: 16 })
        .onClick(() => router.pushUrl({ url: 'pages/ScenesPage' }))
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }
}
