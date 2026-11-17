/**
 * mobile/.../pages/LoginPage.ets
 * 登录页：输入网关地址与账户，建立加密连接（FR-6.1/FR-6.3）。
 */

import { router } from '@kit.ArkUI';
import { gateway } from '../net/GatewayClient';
import { promptAction } from '@kit.ArkUI';

@Entry
@Component
struct LoginPage {
  @State host: string = '192.168.1.100';
  @State port: string = '8765';
  @State user: string = 'admin';
  @State password: string = '';
  @State busy: boolean = false;
  @State status: string = '未连接';

  async doLogin(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = '正在协商密钥…';
    try {
      const url = `ws://${this.host}:${this.port}`;
      await gateway.connect(url);
      this.status = '密钥协商完成，正在登录…';
      const ok = await gateway.login(this.user, this.password);
      if (ok) {
        this.status = '登录成功';
        router.replaceUrl({ url: 'pages/HomePage' });
      } else {
        this.status = '登录失败';
        promptAction.showToast({ message: '用户名或口令错误' });
      }
    } catch (e) {
      this.status = `连接失败：${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: 18 }) {
      Text('家居设备控制').fontSize(28).fontWeight(FontWeight.Bold).margin({ top: 60 })
      Text('OpenHarmony 网关 · 加密连接').fontSize(14).fontColor('#666')

      Row({ space: 8 }) {
        TextInput({ text: this.host, placeholder: '网关地址' })
          .layoutWeight(2)
          .onChange((v: string) => (this.host = v))
        TextInput({ text: this.port, placeholder: '端口' })
          .layoutWeight(1)
          .type(InputType.Number)
          .onChange((v: string) => (this.port = v))
      }.width('86%')

      TextInput({ text: this.user, placeholder: '用户名' })
        .width('86%')
        .onChange((v: string) => (this.user = v))

      TextInput({ text: this.password, placeholder: '口令' })
        .width('86%')
        .type(InputType.Password)
        .onChange((v: string) => (this.password = v))

      Button(this.busy ? '连接中…' : '连接并登录')
        .width('86%')
        .height(46)
        .enabled(!this.busy)
        .onClick(() => this.doLogin())

      Text(this.status).fontSize(12).fontColor('#888')
      Blank()
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }
}
