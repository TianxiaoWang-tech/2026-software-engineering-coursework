# 总体设计说明书

**项目名称：** 基于 OpenHarmony 操作系统的家居设备控制系统
**文档编号：** DES-HOME-OH-001
**版本：** V1.0
**编写日期：** 2026-11-01
**对应实现：** 仓库 `gateway/`（参考实现，Node 可直接运行）、`mobile/`（ArkTS 源码）、`simulators/`

---

## 1. 设计目标与约束

| 目标 | 来源 | 设计响应 |
|---|---|---|
| 四大中心全部可用 | 赛题基本功能需求 | 业务层按 4 个 domain 划分，共用一套内核 |
| 跨品牌空调统一控制 | FR-3.4 / FR-3.5 | 统一能力模型 + 品牌适配器（Adapter） |
| 新增设备/品牌零改内核 | NFR-11 | 驱动 SPI + 能力注册表 + 适配器注册表 |
| 三层加密 | 赛题非功能性需求 | 传输层 TLS + 数据层 AEAD + 密钥层 KEK/DEK |
| 断网可用 | FR-1.6 / NFR-3 | 网关本地执行，指令缓存与补发 |
| 双端（OHOS 网关 + HarmonyOS 手机） | 赛题"适配 HarmonyOS" | 业务逻辑与平台能力分离，协议对端实现 |
| 无硬件可演示 | FR-8.4 / 8.5 | 仿真驱动与实现 SPI 完全一致 |

**关键约束：** 参考实现零第三方依赖（Node 内置模块即可运行），便于在没有 DevEco/SDK 的环境中验证业务正确性；ArkTS 侧只替换"平台能力层"。

---

## 2. 架构总览

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层                                                         │
│   mobile(HarmonyOS/ArkTS): 6 页   │   gateway 触屏面板(ArkUI)   │
├──────────────────────────────────────────────────────────────┤
│ 通信层                                                         │
│   WebSocket(RFC6455) + X25519 协商 + 信封 AEAD + 防重放         │
│   ApiService: 方法路由 / 四级权限 / 审计留痕                     │
├──────────────────────────────────────────────────────────────┤
│ 业务层（四大中心）                                              │
│   lighting │ climate(+adapters) │ access │ rules(scene/automation) │
├──────────────────────────────────────────────────────────────┤
│ 服务层                                                         │
│   ControlService(在线/能力/超时)   DeviceService(生命周期)       │
├──────────────────────────────────────────────────────────────┤
│ 内核层                                                         │
│   EventBus · Registry(状态机/实体/在线/陈旧) · Capabilities      │
├──────────────────────────────────────────────────────────────┤
│ 驱动层（SPI）                                                   │
│   SimDriver │ MqttDriver(自研 MQTT 3.1.1) │ (预留) HTTP/Modbus   │
├──────────────────────────────────────────────────────────────┤
│ 安全层                                                         │
│   crypto(AEAD/scrypt) · KeyStore(KEK/DEK, 可轮换) · Users/Session│
└──────────────────────────────────────────────────────────────┘
```

### 2.2 依赖方向

**单向向下**：表现层 → 通信层 → 业务层 → 服务层 → 内核层 → 驱动层。
内核**不认识**任何设备品牌；业务层**不认识**任何协议；驱动**不认识**任何业务规则。
这是三个"零改动"承诺（NFR-11）的结构保证。

### 2.3 一次控制指令的完整路径

```
手机 UI
  └─ GatewayClient.control()      # 明文对象
      └─ AES-256-GCM(会话密钥, aad=id:seq)
          └─ WebSocket 帧 ──► 网关 GatewayWsServer
                                └─ 解密 + 校验 seq（防重放）
                                    └─ ApiService.control.set（权限/审计）
                                        └─ ClimateService.set
                                            └─ AcAdapter.set（统一能力→品牌码值）
                                                └─ ControlService.control（在线/能力/计时）
                                                    └─ Driver.set
                                                        └─ MQTT PUBLISH home/<id>/set
                                                            └─ 设备 ACK → state 回流
                                                                └─ Registry.setState → EventBus
                                                                    └─ 推送 state.changed ──► 手机
```

---

## 3. 模块划分

| 模块 | 代码位置 | 职责 | 不负责 |
|---|---|---|---|
| 内核 | `gateway/core/` | 事件总线、状态机、注册表、能力目录、日志、错误分类 | 协议、业务规则 |
| 驱动 | `gateway/drivers/` | 协议编解码、连接管理、发现与回执 | 状态合法性判断 |
| 适配器 | `gateway/adapters/` | 品牌能力映射（码值/参数） | 设备连接 |
| 服务 | `gateway/services/` | 统一控制出口、设备生命周期、API 路由、WS 服务 | 具体业务语义 |
| 业务 | `gateway/domains/` | 照明/温湿度/门禁/规则的业务规则 | 传输、存储细节 |
| 安全 | `gateway/security/` | AEAD、密钥库、账户、会话、X25519 | 业务授权策略（在 API 层） |
| 仿真 | `simulators/` | 模拟真实设备的 MQTT 行为 | 业务逻辑 |

---

## 4. 核心机制

### 4.1 事件总线与状态机

- **单写入口**：所有状态变化必须经 `Registry.setState()`，它做三件事：类型/范围校验 → 差异计算 → 逐项广播 `state_changed`。
- **差异广播**：只有真正变化的能力才产生事件，避免界面无效刷新（性能要求 NFR-2）。
- **故障隔离**：单个订阅者抛错只记日志，不影响其他订阅者与主流程。
- **在线判定**：`lastSeenAt` + 心跳超时（默认 90s，`sweep()` 周期扫描）；MQTT 场景另有 LWT 即时置离线。
- **陈旧判定**：实体级 `staleAfterMs`（默认 5min），供界面标注"陈旧"而非显示过期值当作实时值（FR-3.1）。

### 4.2 驱动 SPI 与设备生命周期

```
发现(discover/discovery topic)
  → DeviceService.onDiscovered
    → Registry.addDevice（为每个能力建实体）
      → Driver.attach（驱动接管）
        → 状态上报 → Registry.setState
          → 删除时 Driver.detach → Registry.removeDevice
```

驱动只拿到 4 个回调（`emitState` / `emitDiscovered` / `emitAvailability` / `log`），
因此**驱动无法绕过状态机**，也无法直接操作业务对象。

### 4.3 品牌适配器与能力模型

统一空调能力只有四项：`hvac_mode` / `target_temp` / `fan_speed` / `swing`。

| 品牌 | 通道 | 支持模式 | 风速 | 摆风 | 温度范围 |
|---|---|---|---|---|---|
| 格力 | 红外码库 | 制冷/制热/除湿/送风 | 自动/低/中/高 | ✔ | 16–30℃ |
| 美的 | 厂商云 API | 制冷/制热/除湿 | 自动/低/高 | ✔ | **17**–30℃ |
| 海尔 | Modbus 网关 | 制冷/制热/送风 | 自动/低/中 | **✘** | 16–30℃ |

三处差异（模式集、风速集、摆风）直接驱动界面置灰行为（FR-3.3），
而"新增品牌"只需实现 `BaseAcAdapter.encode()` 并在注册表登记一行。

### 4.4 规则引擎

- **场景**：动作数组按序执行，支持 `delayMs`，单动作失败不阻断后续，但结果逐条记录。
- **自动化**：`trigger → conditions → actions`。
  - 时间触发按分钟去重（`HH:mm@日期`），重启后从配置恢复；
  - 状态触发基于 `state_changed`，支持 `change/above/below/equals`；
  - 条件支持数值比较、区间与生效时间段；
  - `cooldownMs` 防抖，避免传感器抖动导致反复执行。

### 4.5 三层加密与密钥生命周期

| 层 | 机制 | 实现位置 | 验证方式 |
|---|---|---|---|
| 传输层 | TLS 1.2+（生产必开；测试环境用明文以便观测） | 平台 `@ohos.net.socket` / Node `tls` | 抓包 |
| 数据层 | AES-256-GCM，AAD 绑定 `报文id:序号` | `security/crypto.mjs`、`net/crypto.ets` | 篡改/重放测试 |
| 密钥层 | KEK(scrypt 派生于设备口令) 包裹 DEK；DEK 可轮换；文件内无明文密钥 | `security/keystore.mjs` | 落盘检查 + 轮换测试 |

会话密钥独立于 DEK：每次连接用 X25519 协商一次性会话密钥（HKDF 派生），**不落盘、不复用**。

### 4.6 双端通信协议

```
C → S   {type:'hello', pubKey: base64(32B)}
S → C   {type:'hello_ack', pubKey, salt, fingerprint}
    ── 双方 HKDF(secret, salt, "gw-session-v1") → 32B 会话密钥 ──
C → S   {v:1, id, seq, kind:'req', nonce, payload=AESGCM(json, aad=id:seq)}
S → C   {v:1, id, seq', kind:'res', nonce, payload}
S → C   {v:1, id, seq'', kind:'evt', ...}   # 登录后推送状态/告警
```

服务端为每个连接维护 `lastClientSeq`，`seq` 非递增即拒绝（REPLAY）。
`fingerprint` 让客户端可校验网关密钥未被替换（密钥层保护的一环，登录前即可用）。

---

## 5. 数据模型

```
Area 1 ── n Device 1 ── n Entity
                  │
                  ├── n AcProfile（品牌/通道/能力子集/码库引用）
                  └── n AccessLog（开锁留痕，只追加）

User 1 ── n Session      Scene 1 ── n Action
Automation 1 ── n Condition / Action    AuditLog（只追加）
StateLog（时序状态，30 天保留）
```

参考实现以内存对象承载（`Registry`），生产环境由 `relationalStore` 落库；
实体/字段与 `contracts/model.d.ts` 一一对应，切换存储层不影响业务代码。

---

## 6. 部署形态

### 6.1 演示/开发（零硬件）

```
node gateway/main.mjs --broker --mqtt   # 网关 + 内置 Broker
node simulators/run.mjs --port 1883    # 设备仿真器（可选，内置驱动已含仿真家庭）
```

### 6.2 开发板（目标形态）

```
RK3568 类开发板（OpenHarmony）
  ├─ 网关应用（ArkTS UI + 常驻服务）
  └─ 内置 Broker 或局域网 Mosquitto
        ↑
   HarmonyOS 手机（HAP）
```

### 6.3 真实设备

MQTT 设备接入 `home/<id>/{state,set,ack,availability}`；
空调经红外发射模块（格力）或厂商云/Modbus 网关（美的/海尔）接入，由适配器屏蔽差异。

---

## 7. 关键设计决策（ADR 摘要）

| 决策 | 选项 | 结论与理由 |
|---|---|---|
| AD-1 | 迁移 HA vs 自研 | 自研。HA 依赖 Python 3.14 + 数十个原生扩展 + Linux 系统服务，OHOS 侧不可行（见可行性分析） |
| AD-2 | 引入 npm 依赖 vs 零依赖 | 零依赖。评审环境不一定可联网安装；自研 MQTT/WS 也便于展示协议理解深度 |
| AD-3 | 云优先 vs 本地优先 | 本地优先。断网可用是差异化卖点，也符合隐私诉求 |
| AD-4 | 统一能力模型 vs 每设备一套接口 | 统一模型。这是"新增品牌零改界面"的唯一前提（NFR-11） |
| AD-5 | P-256 vs X25519 | X25519。公钥为 32 字节原始值，与 HarmonyOS cryptoFramework 表示一致，少一层 DER 解析 |
| AD-6 | 密钥存文件 vs 平台密钥库 | 参考实现用 KEK/DEK 双层文件库并留 HUKS 接口；生产替换为 HUKS，边界不变（无 getKey 方法） |
| AD-7 | 单一 discovery 主题 vs 每设备主题 | 每设备主题。retain 只保留最后一条，共用主题会互相覆盖（联调时实际踩到） |

---

## 8. 需求追溯

| 需求 | 设计落点 | 验证 |
|---|---|---|
| FR-1.1~1.8 设备接入 | Driver SPI + DeviceService + MqttDriver | `tests/e2e-mqtt.test.mjs` |
| FR-2.1~2.6 照明 | `domains/lighting` | `tests/app.test.mjs` |
| FR-3.1~3.7 温湿度/空调 | `domains/climate` + `adapters/*` | `tests/app.test.mjs` |
| FR-4.1~4.5 门禁 | `domains/access` | `tests/app.test.mjs` |
| FR-5.1~5.6 场景自动化 | `domains/rules` | `tests/app.test.mjs` |
| FR-6.1~6.6 多端界面 | `mobile/` + ApiService | `tests/api.test.mjs` |
| FR-7.1~7.6 三层加密 | `security/*` + `services/ws.mjs` | `tests/core.test.mjs`、`tests/api.test.mjs` |
| FR-8.1~8.6 运维演示 | `ops.selfCheck` + `scripts/demo.mjs` | `npm run demo` |

---

## 9. 已知限制与后续工作

| 项 | 现状 | 计划 |
|---|---|---|
| ArkTS 侧编译 | 未在真机编译（缺少 SDK 与设备） | 按文件头 `[需验证]` 项逐一确认，重点在 X25519 DER 前缀 |
| TLS 证书 | 服务端支持 `tls` 选项，测试用明文 + AEAD | 生产用设备证书，或对接 HUKS 托管密钥 |
| 持久化 | 内存为主，密钥库已落盘 | 接入 relationalStore，按 `model.d.ts` 建表 |
| 红外码库 | 示例码值 | 用实测码替换 `encode()` 表，接口不变 |
| 网关触屏面板 | 未实现 | 复用 ApiService，ArkUI 横屏布局 |
