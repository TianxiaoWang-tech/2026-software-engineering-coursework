/**
 * mobile/.../pages/LightingPage.ets
 * 照明中心：开关、亮度、色温（FR-2.1 ~ FR-2.3）。
 * 拖拽节流：滑动过程只更新本地值，松手才下发终值（FR-2.2）。
 */

import { gateway } from '../net/GatewayClient';
import { DeviceRecord, DeviceListResult, StateMap } from '../model/Types';
import { promptAction } from '@kit.ArkUI';

@Entry
@Component
struct LightingPage {
  @State lights: DeviceRecord[] = [];
  @State states: Record<string, StateMap> = {};
  @State dragging: Record<string, number> = {};

  aboutToAppear(): void {
    this.refresh();
  }

  async refresh(): Promise<void> {
    const data = (await gateway.loadDevices()) as DeviceListResult;
    if (!data) return;
    this.lights = data.devices.filter((d) => d.category === 'light');
    this.states = data.states;
  }

  private async toggle(id: string): Promise<void> {
    const s = this.states[id];
    const next = !(s?.switch === true);
    const res = await gateway.control(id, 'switch', next);
    if (!res.ok) promptAction.showToast({ message: res.message ?? '控制失败' });
    setTimeout(() => this.refresh(), 200);
  }

  private async commitBrightness(id: string, value: number): Promise<void> {
    const res = await gateway.control(id, 'brightness', Math.round(value));
    if (!res.ok) promptAction.showToast({ message: res.message ?? '调节失败' });
    setTimeout(() => this.refresh(), 200);
  }

  build() {
    Column({ space: 12 }) {
      Text('照明中心').fontSize(22).fontWeight(FontWeight.Bold).width('92%').margin({ top: 16 })

      List({ space: 12 }) {
        ForEach(this.lights, (d: DeviceRecord) => {
          ListItem() {
            Column({ space: 10 }) {
              Row() {
                Column({ space: 2 }) {
                  Text(d.name).fontSize(16).fontWeight(FontWeight.Medium)
                  Text(`${d.areaId ?? '未分配'} · ${d.online ? '在线' : '离线'}`)
                    .fontSize(11).fontColor(d.online ? '#4CAF50' : '#999')
                }.alignItems(HorizontalAlign.Start)
                Blank()
                Toggle({ type: ToggleType.Switch, isOn: this.states[d.id]?.switch === true })
                  .onChange(() => this.toggle(d.id))
              }.width('100%')

              Row({ space: 8 }) {
                Text('亮度').fontSize(12).fontColor('#666').width(32)
                Slider({
                  value: (this.dragging[d.id] ?? (this.states[d.id]?.brightness as number) ?? 100),
                  min: 1,
                  max: 100,
                  step: 1,
                })
                  .layoutWeight(1)
                  .onChange((v: number, mode: SliderChangeMode) => {
                    this.dragging[d.id] = v;
                    // 松手（End）才下发终值，拖动过程不刷屏（FR-2.2）
                    if (mode === SliderChangeMode.End) {
                      this.commitBrightness(d.id, v);
                    }
                  })
                Text(`${Math.round(this.dragging[d.id] ?? (this.states[d.id]?.brightness as number) ?? 100)}%`)
                  .fontSize(12).width(40).textAlign(TextAlign.End)
              }.width('100%')
            }
            .padding(14)
            .backgroundColor(Color.White)
            .borderRadius(12)
          }
        })
      }
      .layoutWeight(1)
      .width('92%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }
}
