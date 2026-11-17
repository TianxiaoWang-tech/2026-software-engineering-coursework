# SmartHome · 鸿蒙智能家居仿真 Demo（P1）

无硬件阶段的智能家居演示工程：基于 HarmonyOS / ArkTS 原生开发，用 **LocalMockAdapter** 在 App 内模拟一整套虚拟设备（灯、温湿度、空调、窗帘、门锁、烟感），界面与设备接入完全解耦。后续接真实设备或 Home Assistant / MQTT 网关时，只需替换 Adapter，UI 不动。

## 当前能力（P1）

- 首页「我的家」：房间分组卡片、温度/湿度实时指标（每 2 秒刷新）、设备开关、在线状态
- 场景按钮：回家 / 离家 / 睡眠，一键联动灯、空调、窗帘、门锁
- 设备详情页：灯（开关 + 亮度滑杆）、空调（开关 + 温度 ± / 模式 / 风速）、窗帘（开合度滑杆 + 全开全关）、门锁、温湿度、烟感
- 厨房烟感：触发告警后首页出现告警条，点击可解除
- 适配器：接口化 + 单例，事件订阅驱动 UI；`services/AdapterProvider.ets` 是唯一的切换点

## 架构

```
pages/ (UI: Home / DeviceDetail)
   │  只依赖 DevicePort 接口
ports/DevicePort.ets           设备操作与订阅接口
services/AdapterProvider.ets   适配器选择（当前 = LocalMockAdapter）
adapters/LocalMockAdapter.ets  端内虚拟设备 + 2s tick + 传感器漂移
model/DeviceModel.ets          设备物模型（DeviceKind / DeviceState ...）
```

后续新增 `adapters/HaAdapter.ets` 或 `adapters/MqttAdapter.ets` 后，只需在 `AdapterProvider` 里切换实现。

## 构建与运行

环境：DevEco Studio 26.0.0.865 + HarmonyOS SDK 26.0.0（API 26）+ 模拟器 HarmonyOS 7.0.0。

方式一（推荐）：用 DevEco Studio 打开本目录，选择 phone 模拟器（如 Mate 90 Pro）直接 Run。模拟器安装 HAP 可跳过签名。

方式二（命令行）：

```powershell
$env:DEVECO_SDK_HOME='D:\Program Files\Huawei\DevEco Studio\sdk'
& 'D:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' `
  'D:\Program Files\Huawei\DevEco Studio\tools\hvigor\hvigor\bin\hvigor.js' `
  assembleHap --no-daemon --mode module -p product=default -p module=entry@default
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`（未签名，模拟器可装）。真机安装需在 IDE 中配置自动签名。

安装到已连接模拟器：

```powershell
hdc install -r entry/build/default/outputs/default/entry-default-unsigned.hap
hdc shell aa start -a EntryAbility -b com.hsf.smarthome
```

## 多端

`entry/src/main/module.json5` 的 `deviceTypes` 已配置 `phone / tablet / 2in1`，并申请了 `ohos.permission.INTERNET`（后续接网关时用）。目前 UI 按手机竖屏设计，平板/2in1 可先运行后逐步适配。

## 已知限制 / 下一步

- 未配置签名（模拟器可跳过；真机与最终提交需补 `build-profile.json5` 的 signingConfigs）
- 设备数据仅在内存中，重启 App 回到初始状态（后续接 `@ohos.data.relationalStore` 持久化）
- 下一步：HA WebSocket/REST 适配器或自建 MQTT 网关适配器；规则引擎 / 历史曲线 / 能耗统计；真机移植（Hi3861 / Neptune 等 + MQTT）
