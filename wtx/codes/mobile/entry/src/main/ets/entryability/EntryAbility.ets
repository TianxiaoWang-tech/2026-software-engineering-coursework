/**
 * mobile/entry/src/main/ets/entryability/EntryAbility.ets
 * 应用入口：加载登录页。
 *
 * 注：早期版本调用 setWindowLayoutFullScreen(true) 做"沉浸式"，但没有配
 * 安全区内边距，导致标题被状态栏压住（截图里"我的家"和 08:48 叠在一起）。
 * 竞赛演示以清晰为先，这里走系统默认的非全屏布局。
 */

import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const TAG: string = 'HomeControl';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, TAG, 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/LoginPage', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
    });
  }

  onDestroy(): void {
    hilog.info(0x0000, TAG, 'EntryAbility onDestroy');
  }
}
