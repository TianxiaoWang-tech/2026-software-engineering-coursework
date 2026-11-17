/**
 * mobile/.../pages/ClimatePage.ets
 * 温湿度控制中心：温湿度展示 + 多品牌空调控制（FR-3.1 ~ FR-3.5）。
 *
 * 关键交互：品牌能力子集不同 → 不支持的模式/风速置灰而非隐藏（FR-3.3），
 *          让用户知道"这台空调没有这个功能"，而不是以为 App 坏了。
 */

import { gateway } from '../net/GatewayClient';
import { AcCapabilityProfile, BRAND_LABEL, DeviceIdParams, DeviceListResult, DeviceRecord, StateMap } from '../model/Types';
import { promptAction } from '@kit.ArkUI';

const MODE_LABEL: Map<string, string> = new Map<string, string>([
  ['cool', '制冷'], ['heat', '制热'], ['dry', '除湿'], ['fan', '送风'], ['auto', '自动'],
]);
const FAN_LABEL: Map<string, string> = new Map<string, string>([
  ['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高'],
]);

@Entry
@Component
struct ClimatePage {
  @State devices: DeviceRecord[] = [];
  @State states: Record<string, StateMap> = {};
  @State profiles: Record<string, AcCapabilityProfile> = {};
  @State selected: string = '';

  aboutToAppear(): void {
    this.refresh();
  }

  async refresh(): Promise<void> {
    const data = (await gateway.loadDevices()) as DeviceListResult;
    if (!data) return;
    this.devices = data.devices;
    this.states = data.states;
    const acs = this.devices.filter((d) => d.category === 'ac');
    if (this.selected === '' && acs.length > 0) this.selected = acs[0].id;
    for (const ac of acs) {
      if (!this.profiles[ac.id]) {
        const params: DeviceIdParams = { deviceId: ac.id };
        const res = await gateway.request<AcCapabilityProfile>('climate.profile', params);
        if (res.ok && res.data) this.profiles[ac.id] = res.data;
      }
    }
  }

  private acs(): DeviceRecord[] {
    return this.devices.filter((d) => d.category === 'ac');
  }

  private sensors(): DeviceRecord[] {
    return this.devices.filter((d) => d.category === 'sensor');
  }

  private async apply(capability: string, value: boolean | number | string): Promise<void> {
    const res = await gateway.control(this.selected, capability, value);
    if (!res.ok) promptAction.showToast({ message: res.message ?? '控制失败' });
    setTimeout(() => this.refresh(), 200);
  }

  @Builder
  modeChip(mode: string, enabled: boolean) {
    Text(MODE_LABEL.get(mode) ?? mode)
      .fontSize(12)
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .borderRadius(14)
      .backgroundColor(enabled && this.states[this.selected]?.hvac_mode === mode ? '#4FC3F7' : '#ECEFF1')
      .fontColor(enabled ? '#263238' : '#B0BEC5')
      .onClick(() => {
        if (enabled) this.apply('hvac_mode', mode);
      })
  }

  build() {
    Column({ space: 12 }) {
      Text('温湿度 / 空调').fontSize(22).fontWeight(FontWeight.Bold).width('92%').margin({ top: 16 })

      // 温湿度卡片（FR-3.1）
      Row({ space: 10 }) {
        ForEach(this.sensors(), (s: DeviceRecord) => {
          Column({ space: 2 }) {
            Text(s.name).fontSize(11).fontColor('#888')
            Text(`${this.states[s.id]?.temperature ?? '--'}℃ / ${this.states[s.id]?.humidity ?? '--'}%`)
              .fontSize(15).fontWeight(FontWeight.Medium)
          }
          .padding(10).layoutWeight(1).backgroundColor(Color.White).borderRadius(10)
        })
      }.width('92%')

      // 空调选择（多品牌并列，FR-3.4）
      Scroll() {
        Row({ space: 8 }) {
          ForEach(this.acs(), (ac: DeviceRecord) => {
            Text(`${BRAND_LABEL.get(ac.brand ?? '') ?? ac.brand} · ${ac.name}`)
              .fontSize(12)
              .padding({ left: 12, right: 12, top: 8, bottom: 8 })
              .borderRadius(16)
              .backgroundColor(this.selected === ac.id ? '#263238' : '#ECEFF1')
              .fontColor(this.selected === ac.id ? Color.White : '#455A64')
              .onClick(() => (this.selected = ac.id))
          })
        }
      }.scrollable(ScrollDirection.Horizontal).width('92%')

      if (this.selected !== '') {
        Column({ space: 14 }) {
          Row() {
            Text(this.devices.find((d) => d.id === this.selected)?.name ?? '')
              .fontSize(15).fontWeight(FontWeight.Medium)
            Blank()
            Toggle({ type: ToggleType.Switch, isOn: this.states[this.selected]?.switch === true })
              .onChange((on: boolean) => this.apply('switch', on))
          }.width('100%')

          // 模式：按品牌能力子集置灰
          Row({ space: 8 }) {
            ForEach(this.profiles[this.selected]?.modes ?? [], (m: string) => {
              this.modeChip(m, true)
            })
            ForEach(this.profiles[this.selected]?.modes ? [] : ['cool'], (m: string) => {
              this.modeChip(m, false)
            })
          }.width('100%')

          // 温度步进
          Row({ space: 12 }) {
            Button('−').width(44).height(36).onClick(() => {
              const cur = (this.states[this.selected]?.target_temp as number) ?? 26;
              this.apply('target_temp', Math.max(16, cur - 1));
            })
            Text(`${this.states[this.selected]?.target_temp ?? '--'}℃`).fontSize(26).fontWeight(FontWeight.Bold)
            Button('+').width(44).height(36).onClick(() => {
              const cur = (this.states[this.selected]?.target_temp as number) ?? 26;
              this.apply('target_temp', Math.min(30, cur + 1));
            })
            Blank()
            Text(`范围 ${this.profiles[this.selected]?.minTemp ?? 16}–${this.profiles[this.selected]?.maxTemp ?? 30}℃`)
              .fontSize(11).fontColor('#999')
          }.width('100%')

          // 风速
          Row({ space: 8 }) {
            Text('风速').fontSize(12).fontColor('#666')
            ForEach(this.profiles[this.selected]?.fanSpeeds ?? [], (f: string) => {
              Text(FAN_LABEL.get(f) ?? f)
                .fontSize(12)
                .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                .borderRadius(12)
                .backgroundColor(this.states[this.selected]?.fan_speed === f ? '#4FC3F7' : '#ECEFF1')
                .onClick(() => this.apply('fan_speed', f))
            })
            if (this.profiles[this.selected]?.swing === true) {
              Text('摆风')
                .fontSize(12)
                .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                .borderRadius(12)
                .backgroundColor(this.states[this.selected]?.swing === true ? '#4FC3F7' : '#ECEFF1')
                .onClick(() => this.apply('swing', !(this.states[this.selected]?.swing === true)))
            }
          }.width('100%')
        }
        .padding(16)
        .width('92%')
        .backgroundColor(Color.White)
        .borderRadius(14)
      }

      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }
}
