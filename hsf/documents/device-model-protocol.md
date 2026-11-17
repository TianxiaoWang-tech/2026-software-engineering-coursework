# 设备物模型与通信协议（P1 基线）

本文定义智能家居系统的设备物模型、消息格式与适配器契约。当前 P1 由 `LocalMockAdapter` 在端内实现；P2 起同一套模型通过 MQTT / Home Assistant 传输，协议字段不变。

## 1. 设备类型（物模型）

| kind | 名称 | 主要属性 | 可执行操作 |
| --- | --- | --- | --- |
| `light` | 灯 | `on`、`brightness`(1–100)、`colorTemp` | `setPower`、`setBrightness` |
| `sensor_th` | 温湿度传感器 | `temperature`(°C)、`humidity`(%RH)、`battery` | 只读上报 |
| `ac` | 空调 | `on`、`targetTemp`(16–32)、`mode`(cool/heat/fan/auto)、`fanSpeed`(auto/low/mid/high) | `setPower`、`setTargetTemp`、`setAcMode`、`setAcFanSpeed` |
| `curtain` | 窗帘 | `position`(0–100，100=全开) | `setCurtainPosition` |
| `lock` | 智能门锁 | `locked`、`battery` | `setLockState` |
| `smoke` | 烟雾传感器 | `alarm`、`battery` | `triggerSmokeAlarm`、`acknowledgeAlarm` |

公共字段：`id`、`name`、`room`、`online`、`statusText`（UI 展示串，由适配器统一生成）。

设备清单（LocalMock 初始值）：

| id | 名称 | 房间 | 初始状态 |
| --- | --- | --- | --- |
| `living_light` | 客厅主灯 | 客厅 | 开，亮度 80% |
| `living_sensor` | 客厅温湿度 | 客厅 | 25.6°C / 52%RH |
| `living_ac` | 客厅空调 | 客厅 | 关，26°C，制冷，自动风 |
| `living_curtain` | 客厅窗帘 | 客厅 | 开合 60% |
| `bedroom_light` | 卧室灯 | 卧室 | 关，亮度 40% |
| `door_lock` | 入户门锁 | 玄关 | 已上锁，电量 76% |
| `kitchen_smoke` | 厨房烟感 | 厨房 | 正常，电量 87% |

## 2. 适配器契约（DevicePort）

```ts
interface DevicePort {
  start(): void;
  stop(): void;
  isOnline(): boolean;
  listDevices(): DeviceState[];
  getDevice(id: string): DeviceState | undefined;
  setPower(id: string, on: boolean): void;
  setBrightness(id: string, value: number): void;
  setTargetTemp(id: string, value: number): void;
  setAcMode(id: string, mode: AcMode): void;
  setAcFanSpeed(id: string, value: AcFanSpeed): void;
  setCurtainPosition(id: string, value: number): void;
  setLockState(id: string, locked: boolean): void;
  triggerSmokeAlarm(id: string): void;
  acknowledgeAlarm(id: string): void;
  subscribe(listener: () => void): void;
  unsubscribe(listener: () => void): void;
}
```

约定：所有 setter 立即生效并触发一次变更通知；`listDevices()` 返回快照，UI 不直接持有内部对象。

## 3. 消息格式（MQTT / 网关）

```json
{ "v": 1, "msgId": "uuid", "ts": 1763364000000, "deviceId": "living_light", "type": "property/report", "data": { "on": true, "brightness": 80 } }
```

Topic：

| topic | 方向 | 说明 |
| --- | --- | --- |
| `home/{homeId}/property/report` | 设备 → 云端/App | 属性上报 |
| `home/{homeId}/service/invoke` | App → 设备 | 下发控制 |
| `home/{homeId}/service/reply` | 设备 → App | 控制回执 |
| `home/{homeId}/event/report` | 设备 → App | 告警等事件 |
| `home/{homeId}/online` | 设备 → App | 在线状态（LWT） |

P2 接入 MQTT 时，`MqttAdapter` 负责把上述 topic 映射为 `DeviceState` 并调用监听回调；P3 接入 Home Assistant 时，`HaAdapter` 通过 REST（`/api/states`、`/api/services/{domain}/{service}`）与 WebSocket（`/api/websocket`，订阅 `state_changed`）实现同样的契约，实体映射见下表。

## 4. HA 实体映射（P3 计划）

| 物模型 | HA domain | 备注 |
| --- | --- | --- |
| light | `light` | `brightness` 0–255 需换算成 0–100 |
| ac | `climate` | `hvac_mode` / `temperature` / `fan_mode` |
| curtain | `cover` | `current_position` |
| lock | `lock` | `lock` / `unlock` |
| smoke | `binary_sensor` + `automation` | `device_class: smoke` |
| sensor_th | `sensor` | 温度/湿度两个实体 |

## 5. 安全基线（P4 计划）

- 传输：TLS（MQTT over TLS 或 HA https）；App 侧校验证书
- 鉴权：每设备独立 token / 密钥，控制指令签名（HMAC-SHA256 + 时间戳防重放）
- 密钥存储：HarmonyOS HUKS（`@ohos.security.huks`），不落明文
- 数据：本地持久化使用应用沙箱 + 加密（敏感字段）
