/**
 * mobile/.../pages/AccessPage.ets
 * 智能门禁：门状态、远程开门（二次确认）、开锁记录（FR-4.1 ~ FR-4.4）。
 */

import { gateway } from '../net/GatewayClient';
import { AccessLog, AccessLogsParams, AccessOpenParams, DeviceListResult, DeviceRecord, StateMap } from '../model/Types';
import { promptAction } from '@kit.ArkUI';

@Entry
@Component
struct AccessPage {
  @State lock: DeviceRecord | null = null;
  @State state: StateMap = {};
  @State pin: string = '';
  @State logs: AccessLog[] = [];
  @State busy: boolean = false;
  @State confirmShow: boolean = false;

  aboutToAppear(): void {
    this.refresh();
  }

  async refresh(): Promise<void> {
    const data = (await gateway.loadDevices()) as DeviceListResult;
    if (!data) return;
    const locks = data.devices.filter((d) => d.category === 'lock');
    if (locks.length > 0) {
      this.lock = locks[0];
      this.state = data.states[locks[0].id] ?? {};
    }
    const logParams: AccessLogsParams = { limit: 10 };
    const res = await gateway.request<Record<string, Object>>('access.logs', logParams);
    if (res.ok && res.data) this.logs = res.data['logs'] as AccessLog[];
  }

  private async doOpen(): Promise<void> {
    if (!this.lock || this.busy) return;
    this.busy = true;
    try {
      const openParams: AccessOpenParams = { deviceId: this.lock.id, confirm: this.pin };
      const res = await gateway.request<Object>('access.open', openParams);
      if (res.ok) {
        promptAction.showToast({ message: '开门成功' });
        this.pin = '';
      } else {
        promptAction.showToast({ message: res.message ?? '开门失败' });
      }
    } finally {
      this.busy = false;
      setTimeout(() => this.refresh(), 300);
    }
  }

  build() {
    Column({ space: 14 }) {
      Text('智能门禁').fontSize(22).fontWeight(FontWeight.Bold).width('92%').margin({ top: 16 })

      Column({ space: 8 }) {
        Text(this.lock?.name ?? '未配置门禁').fontSize(14).fontColor('#666')
        Text(this.state.door_state === 'open' ? '门已打开' : '门已关闭')
          .fontSize(26).fontWeight(FontWeight.Bold)
          .fontColor(this.state.door_state === 'open' ? '#E57373' : '#4CAF50')
        Text(this.state.lock_state === 'unlocked' ? '锁：已开' : '锁：已上锁').fontSize(12).fontColor('#888')
      }
      .width('92%')
      .padding(18)
      .backgroundColor(Color.White)
      .borderRadius(14)

      // 二次确认（FR-4.1）：必须输入 PIN 才能下发
      Column({ space: 10 }) {
        Text('远程开门需要二次确认').fontSize(12).fontColor('#888')
        TextInput({ text: this.pin, placeholder: '请输入 4–8 位开门口令' })
          .type(InputType.Number)
          .maxLength(8)
          .onChange((v: string) => (this.pin = v))
        Button(this.busy ? '下发中…' : '确认开门')
          .width('100%')
          .height(44)
          .enabled(!this.busy && this.pin.length >= 4)
          .backgroundColor('#E57373')
          .onClick(() => this.doOpen())
      }
      .width('92%')
      .padding(16)
      .backgroundColor(Color.White)
      .borderRadius(14)

      Text('开锁记录').fontSize(15).fontWeight(FontWeight.Medium).width('92%')

      List({ space: 6 }) {
        ForEach(this.logs, (l: AccessLog) => {
          ListItem() {
            Row() {
              Column({ space: 2 }) {
                Text(l.note ?? l.method).fontSize(13)
                Text(new Date(l.at).toLocaleString()).fontSize(10).fontColor('#999')
              }.alignItems(HorizontalAlign.Start)
              Blank()
              Text(l.result === 'success' ? '成功' : '失败')
                .fontSize(12)
                .fontColor(l.result === 'success' ? '#4CAF50' : '#E57373')
            }
            .padding(12)
            .backgroundColor(Color.White)
            .borderRadius(10)
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
