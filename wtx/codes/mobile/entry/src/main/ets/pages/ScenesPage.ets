/**
 * mobile/.../pages/ScenesPage.ets
 * 场景页：一键执行"回家 / 离家 / 睡眠"（FR-5.1 / FR-5.4）。
 */

import { gateway } from '../net/GatewayClient';
import { SceneRunParams } from '../model/Types';
import { promptAction } from '@kit.ArkUI';

interface SceneView {
  id: string;
  name: string;
  actionCount: number;
  enabled: boolean;
}

/** 网关返回的场景原始结构（actions 只取长度） */
interface SceneRaw {
  id: string;
  name: string;
  actions?: Object[];
  enabled: boolean;
}

@Entry
@Component
struct ScenesPage {
  @State scenes: SceneView[] = [];
  @State running: string = '';

  aboutToAppear(): void {
    this.refresh();
  }

  async refresh(): Promise<void> {
    const res = await gateway.request<Record<string, Object>>('scene.list');
    if (res.ok && res.data) {
      const raw = res.data['scenes'] as SceneRaw[];
      const views: SceneView[] = [];
      for (const s of raw) {
        const actions: Object[] | undefined = s.actions;
        const view: SceneView = {
          id: s.id,
          name: s.name,
          actionCount: actions ? actions.length : 0,
          enabled: s.enabled,
        };
        views.push(view);
      }
      this.scenes = views;
    }
  }

  async run(id: string): Promise<void> {
    if (this.running !== '') return;
    this.running = id;
    try {
      const runParams: SceneRunParams = { sceneId: id };
      const res = await gateway.request<Record<string, Object>>('scene.run', runParams);
      if (res.ok) {
        const results = res.data?.['results'] as Object[] | undefined;
        const failed = (results ?? []).filter((r) => (r as Record<string, boolean>)['ok'] === false).length;
        promptAction.showToast({ message: failed === 0 ? '场景执行完成' : `${failed} 个动作失败` });
      } else {
        promptAction.showToast({ message: res.message ?? '执行失败' });
      }
    } finally {
      this.running = '';
    }
  }

  build() {
    Column({ space: 12 }) {
      Text('场景').fontSize(22).fontWeight(FontWeight.Bold).width('92%').margin({ top: 16 })

      List({ space: 12 }) {
        ForEach(this.scenes, (s: SceneView) => {
          ListItem() {
            Row() {
              Column({ space: 4 }) {
                Text(s.name).fontSize(16).fontWeight(FontWeight.Medium)
                Text(`${s.actionCount} 个动作 · ${s.enabled ? '已启用' : '已停用'}`)
                  .fontSize(11).fontColor('#888')
              }.alignItems(HorizontalAlign.Start)
              Blank()
              Button(this.running === s.id ? '执行中…' : '执行')
                .height(34)
                .fontSize(13)
                .enabled(this.running === '' && s.enabled)
                .onClick(() => this.run(s.id))
            }
            .padding(14)
            .backgroundColor(Color.White)
            .borderRadius(12)
          }
        })
      }
      .layoutWeight(1)
      .width('92%')

      Text('自动化规则（定时/状态触发）由网关执行，断网亦有效').fontSize(11).fontColor('#999').margin({ bottom: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }
}
