# Home Assistant 源码向 OpenHarmony 迁移的可行性分析

| 项目 | 内容 |
|---|---|
| 文档类型 | 可行性分析（简要版） |
| 分析对象 | Home Assistant Core（`home-assistant/core`） |
| 源码版本 | `2026.12.0.dev0`，提交 `56d268c2`（2026-10-31） |
| 目标平台 | OpenHarmony |
| 编写日期 | 2026-11-01 |

---

## 一、结论摘要

**结论：不能直接"移植"，需要重新实现运行时底座。**

Home Assistant（下称 HA）的业务代码是纯 Python、与平台无关；真正卡住迁移的是它依赖的 Linux 系统环境。因此按层次拆开后，三层的结论完全不同：

| 层次 | 主要内容 | 迁移可行性 | 工作量 |
|---|---|---|---|
| 前端层 | Lit / TypeScript Web Components | **可迁移**，运行于 ArkWeb 容器，几乎零改动 | 小 |
| 领域内核层 | 事件总线、状态机、实体/设备/区域注册表、自动化与脚本引擎、模板引擎 | **逻辑可复用**，但需先具备 Python 运行时 | 中 |
| 系统集成与部署层 | 蓝牙（BlueZ/D-Bus）、Zigbee 串口、mDNS 发现、Supervisor/Add-on（Docker）、常驻服务模型 | **不可迁移**，须整体重写 | 极大 |

一句话概括：**HA 的"业务"能搬，"地基"搬不走。**

---

## 二、分析依据

源码取自 GitHub 官方仓库，浅克隆（`--depth=1`）后本地统计：

| 指标 | 数值 |
|---|---|
| 版本 | 2026.12.0.dev0 |
| 文件数 / 体积 | 30,297 个 / 约 256 MB |
| 集成（插件）数量 | 1,563 个 |
| Python 源文件 | 10,936 个（其中测试 9,095 个） |
| 第三方依赖条目 | 3,670 条（`requirements_all.txt`） |
| 要求的 Python 版本 | ≥ 3.14.10（`.python-version`） |

集成按 `iot_class` 分布（说明迁移时的难易结构）：

| 类型 | 数量 | 迁移难度 |
|---|---|---|
| local_polling（局域网轮询） | 436 | 中，依赖网络与部分系统服务 |
| cloud_polling（云端轮询） | 406 | **低，仅需 HTTP 客户端** |
| local_push（局域网推送） | 271 | 高，多依赖 BLE/mDNS |
| cloud_push（云端推送） | 119 | 低 |
| calculated / assumed_state / 未标注 | 331 | 低 |

> 关键判断：**云端类集成（525 个）最好搬，本地类集成才依赖系统服务**。这与直觉相反。

---

## 三、关键障碍

### 障碍 1：Python 运行时版本不匹配

- HA 2026.12 要求 Python **≥ 3.14.10**。
- OpenHarmony 社区目前成熟的 CPython 移植为 **3.13.5**，且官方定位是"标准库（除图形相关）+ **纯 Python** pip 库"。
- 影响：必须先完成 CPython 3.14 向 OpenHarmony 的交叉编译移植，才具备讨论后续问题的前提。

### 障碍 2：原生扩展需要全部重新编译

HA 强依赖的 C/Rust 扩展（来自 `homeassistant/package_constraints.txt`）：

`cryptography 50.0.2`、`orjson 3.13.0`、`PyNaCl 1.6.2`、`ciso8601 2.3.3`、`dbus-fast 5.0.22`、`habluetooth 7.1.2`、`Pillow 13.0.0`、`numpy 2.3.2`、`SQLAlchemy 2.0.54`、`zeroconf 0.152.0`

- 这些库在 PyPI 上只提供 manylinux / macOS / Windows 轮子，**没有 OpenHarmony 版本**。
- OpenHarmony 使用 **musl libc**，与 manylinux 的 glibc 二进制不兼容，无法直接加载。
- 影响：需使用 OHOS NDK 逐包交叉编译并适配构建脚本，数量达数十个，是迁移中工作量最大、最不可控的部分。

### 障碍 3：系统服务"不存在"而非"不兼容"

| 依赖 | HA 中的使用 | OpenHarmony 现状 | 后果 |
|---|---|---|---|
| BlueZ + D-Bus | 13 个集成通过 `dbus-fast` / `bleak` 访问蓝牙 | 无 D-Bus，使用自研 btservice 与 IPC | BLE 类集成后端需重写 |
| Docker | Supervisor 与全部 Add-on | 无 Docker | Add-on 生态完全不可用 |
| 串口设备 | Zigbee/Z-Wave USB 棒（`/dev/ttyACM*`） | 应用沙箱限制设备节点访问 | 硬件直连类集成不可用 |
| systemd / D-Bus | 服务管理、`hassio` 集成 | 无对应机制 | 部署与运维体系失效 |
| multicast / mDNS | `zeroconf`、SSDP 自动发现 | 受权限与网络策略限制 | 自动发现需重新实现 |

### 障碍 4：进程模型冲突

- HA 的运行形态是**常驻服务 + 线程池执行器 + 长期连接**（WebSocket、MQTT、设备连接）。
- OpenHarmony 应用是**沙箱应用 + 后台执行受限**（长时任务需申请且类型有限）。
- 影响：这是操作系统层面的模型差异，无法通过修改代码解决，只能改造部署形态或申请系统级能力。

> 需要区分两个平台：**OpenHarmony**（开源、可定制、可部署于 RK3568 等开发板、可获取 root 权限运行原生服务）与 **HarmonyOS NEXT**（手机/平板，应用沙箱严格、后台难以常驻）。上述障碍在后者上更为严重。

---

## 四、实施路线对比

| 路线 | 方案描述 | 工作量 | 风险 | 适用场景 |
|---|---|---|---|---|
| **A. 前端迁移**（推荐） | HA 保留在 Linux 端（树莓派/服务器/Docker），OpenHarmony 设备仅作为显示与控制终端，通过 ArkWeb 加载 HA 前端并调用 WebSocket API | 1～2 周 | 低 | 产品化落地、课程演示 |
| **B. 架构复刻** | 不复用代码，用 ArkTS/C++ 重写轻量中控：事件总线 + 实体状态机 + MQTT 接入 + 精简前端，对标 HA 的数据模型 | 3～4 个月 | 中 | 毕业设计、技术预研 |
| **C. 内核整体迁移** | 在 OpenHarmony 上运行 HA Core 本体 | 6 个月以上（单人） | 极高 | 不建议作为课程项目 |

**路线 A 的合理性**：HA 本身是 B/S 架构，前端与后端通过 WebSocket 通信，天然支持"后端异构、客户端多端"。将 OpenHarmony 定位为客户端，符合其能力边界，也避免了全部系统集成改造。

**路线 B 的合理性**：若目标是"在 OpenHarmony 上拥有一个智能家居中控"，可借鉴 HA 的领域模型（实体—设备—区域三层抽象、事件驱动、集成插件化），但不必承担其全部历史包袱与 1,563 个集成的适配成本。

**路线 C 不可行的核心原因**：迁移成本集中在与业务价值无关的编译适配（障碍 1、2），而系统集成层（障碍 3、4）无论如何都必须重写，最终得到的并非"HA"，而是一个新系统。

---

## 五、许可证与合规

- HA 采用 **Apache License 2.0**，允许使用、修改、再分发，也允许闭源分发。
- 义务：保留版权声明与 `NOTICE` 文件；对修改过的文件作出说明；不得使用其商标暗示官方背书。
- 结论：**法律层面无障碍**，全部问题集中在工程实现。

---

## 六、结论与建议

1. **技术上**：HA 的源码无法"直接移植"到 OpenHarmony。纯 Python 的领域内核具备复用价值，但受制于 Python 运行时、原生扩展与系统服务三层缺口。
2. **工程上**：迁移的主要成本不在业务逻辑，而在编译适配与系统服务重写，投入产出比低。
3. **建议**：
   - 若目标是**快速可用**，采用路线 A，将 OpenHarmony 设备定位为 HA 的客户端/面板；
   - 若目标是**教学与研究**，采用路线 B，复刻 HA 的架构设计而非代码；
   - 不建议以路线 C 作为课程项目选题，风险与课程目标不匹配。

---

## 附录：证据来源

| 结论 | 证据 |
|---|---|
| 版本与规模 | 本地源码 `git log -1`、文件统计（2026-11-01） |
| Python 版本要求 | `pyproject.toml`（`requires-python = ">=3.14.2"`）、`.python-version`（3.14.10） |
| 原生依赖清单 | `homeassistant/package_constraints.txt` |
| 集成数量与类型分布 | `homeassistant/components/*/manifest.json` 统计 |
| Bluetooth/D-Bus 依赖 | 13 个集成 manifest 引用 `dbus-fast` / `bleak` |
| OpenHarmony Python 现状 | OpenHarmony 社区 `ohos_python` 项目（CPython 3.13.5 交叉编译集成，面向纯 Python 库） |
