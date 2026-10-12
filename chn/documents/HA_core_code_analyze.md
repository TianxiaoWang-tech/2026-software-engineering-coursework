已通读 HA 核心代码（`__main__.py`、`runner.py`、`bootstrap.py`、`setup.py`、`loader.py`、`core.py`、`util/async_.py`、`helpers/entity_platform.py` 等）。下面是完整的架构与运行栈分析。

---

# Home Assistant 核心架构分析

**版本**：2026.11.0.dev0（`const.py`），Python ≥ 3.14.2

## 一、总览：三个核心对象 + 一条事件循环

HA 的一切都围绕**一个单例对象 `HomeAssistant`（`hass`）**展开，它在单个 asyncio 事件循环线程里运行，并通过三个核心子系统协作：

```
hass
├── bus          EventBus        事件总线（发布/订阅）
├── states       StateMachine    实体状态机（entity_id → State）
├── services     ServiceRegistry 服务注册与调用
├── config       Config          配置（config dir / YAML / core config）
├── config_entries ConfigEntries 配置条目（UI 配置的核心机制）
├── data         HassDict        任意组件可用的共享数据桶
├── loop         asyncio 事件循环
├── timeout      TimeoutManager  分层超时管理
└── _tasks / _background_tasks   任务追踪
```

这三者形成 **观察-控制-自动化** 的数据流闭环：
`EventBus`（事件）→ 触发器/自动化监听事件 → 调用 `services`（服务）→ 服务改变 `states`（状态机）→ 状态变化再次通过 `EventBus` 广播。

---

## 二、启动运行栈（完整调用链）

### 1. 进程入口 `__main__.py`
```
main()
 ├─ validate_python / validate_environment / validate_os
 ├─ get_arguments()  → 解析 CLI（--config --recovery-mode --debug 等）
 ├─ restore_backup() → 如检测到备份恢复则重启
 ├─ ensure_config_path()
 ├─ runner.ensure_single_execution()  → fcntl.flock 文件锁（.ha_run.lock）防多实例
 ├─ faulthandler.enable()
 └─ runner.run(runtime_conf)  → 真正启动
```

### 2. `runner.py` — 事件循环的创建
```python
def run(runtime_config):
    loop = create_event_loop(runtime_config.debug)   # asyncio.EventLoop()
    configure_event_loop(loop, debug):
        loop.set_exception_handler(...)
        executor = InterruptibleThreadPoolExecutor(thread_name_prefix="SyncWorker", max_workers=64)
        loop.set_default_executor(executor)           # 默认线程池，跑阻塞 IO
        loop.time = monotonic                        # 性能优化：直接绑定 monotonic
    asyncio.set_event_loop(loop)
    loop.run_until_complete(setup_and_run_hass(runtime_config))
```

关键点：**同步阻塞调用走 64 线程的 `SyncWorker` 线程池**，不阻塞事件循环。退出时用 `_cancel_all_tasks_with_timeout` 取消所有 task 并 `shutdown_asyncgens / shutdown_default_executor`。

### 3. `bootstrap.py` — 引导启动（最核心）
```
async_setup_hass()
 ├─ create_hass()                      # 构造 HomeAssistant 对象
 │    ├─ loader.async_setup(hass)      # 初始化组件缓存
 │    └─ async_enable_logging()        # 日志（RotatingFileHandler 等）
 ├─ async_ensure_config_exists()
 ├─ block_async_io.enable()            # 开启阻塞 IO 检测
 ├─ process_ha_config_upgrade          # executor 里跑，YAML 升级
 ├─ async_hass_config_yaml()           # 解析 configuration.yaml
 └─ async_from_config_dict(config, hass)   # ← 主引导
```

### 4. `async_from_config_dict` — 分阶段装配
```
async_from_config_dict()
 ├─ hass.config_entries = ConfigEntries(hass, config)
 ├─ async_get_custom_components()      # 扫描 custom_components/
 ├─ async_load_base_functionality()    # 并行加载注册表：
 │    ├─ area/category/device/entity/floor/issue/label registry
 │    ├─ restore_state, config_entries 初始化, template, condition, trigger...
 │    └─ _init_blocking_io_modules_in_executor()
 ├─ 设置 CORE_INTEGRATIONS = {"homeassistant", "persistent_notification"}
 ├─ async_process_ha_core_config()     # 处理 homeassistant: 核心配置
 └─ _async_set_up_integrations()       # ← 分三阶段加载所有集成
```

**三阶段加载**（`_async_set_up_integrations`）：
```
Stage 0（无超时/短超时的关键集成，按序子阶段）:
  logging+http deps → labs → frontend → recorder → debugpy → zeroconf
Stage 1（发现类，先更新依赖再给 Stage 2 用）:
  bluetooth, dhcp, ssdp, usb, mqtt_eventstream, cloud, hassio
Stage 2（其余所有域 + 依赖）:
  每个 domain 用 async_setup_component 并发（gather）装配
  最后 async_block_till_done() 等待全部完成
```

依赖解析在 `_async_resolve_domains_and_preload` 中完成，还会**后台预加载** requirements 版本、翻译、storage，避免启动时"惊群"。

### 5. 完成启动 → 进入运行
```
hass.async_run()          # core.py
 ├─ async_start()
 │    ├─ set_state(CoreState.starting)
 │    ├─ fire EVENT_HOMEASSISTANT_START
 │    ├─ 等待 _tasks 完成（TIMEOUT_EVENT_START=15s）
 │    ├─ 运行 _startup_jobs
 │    └─ set_state(CoreState.running) + fire EVENT_HOMEASSISTANT_STARTED
 └─ await self._stopped.wait()   # 阻塞直到停止
```

---

## 三、核心子系统设计

### 1. 事件总线 `EventBus`（core.py）
- `async_listen(event_type, listener, event_filter)` 订阅，`async_fire` 发布。
- **`MATCH_ALL`（`*`）** 可监听所有事件（`state_changed`、`state_reported`、`homeassistant_close` 除外）。
- **防死循环**：嵌套 fire 进入 `_event_queue`，超过 `_MAX_QUEUED_EVENT_DISPATCHES=10000` 抛错。
- 线程安全封装：`fire()`/`listen()` 用 `run_callback_threadsafe` 跨线程投递到事件循环。

### 2. 状态机 `StateMachine` + `State`
- `States` 容器维护 `entity_id → State` 和 `domain → {entity_id}` 二级索引。
- `async_set` 写状态时做**增量比较**：
  - 状态和属性都没变 → 只更新 `last_reported`，发 `state_reported`（不是 changed）
  - 变了 → 创建新 `State`，旧 state `expire()`（替换 context 以便 GC），发 `state_changed`
- `State` 用 `__slots__` + `propcache` 的 `under_cached_property` 做大量缓存优化，并支持压缩状态（`as_compressed_state`）用于 WebSocket 批量推送。

### 3. 服务 `ServiceRegistry` / `ServiceCall`
- `async_register(domain, service, func, schema)` 注册，`async_call` 调用。
- `SupportsResponse`：NONE / OPTIONAL / ONLY 三种响应模式。
- 服务 schema 用 `probatio`（HA 自研的 voloptuous 替代）校验。

### 4. Context（因果追踪）
每个事件/状态/服务调用都带一个 `Context`（ULID id + user_id + parent_id + origin_event），实现**全链路因果追踪**（谁触发了谁）。

### 5. 生命周期状态机 `CoreState`
```
not_running → starting → running → stopping → final_write → stopped
```
`set_state()` 会失效 `is_running`/`is_stopping` 的缓存属性。

### 6. 优雅停机 `async_stop`（四阶段）
```
Stage 1: 运行 _shutdown_jobs            （20s 超时）
Stage 2: 取消后台任务 → fire STOP → 等集成停止（100s）
Stage 3: fire FINAL_WRITE → 等最终写盘   （60s）
Stage 4: fire CLOSE → 收尾任务 → 关 executor（30s）
```

---

## 四、并发模型（关键设计）

| 机制 | 用途 |
|---|---|
| **事件循环线程** | 所有 `async_*` 逻辑，唯一主线程 |
| **`SyncWorker` 线程池（64）** | `async_add_executor_job`，跑阻塞 IO（DB/文件/网络库） |
| **`ImportExecutor`（1 线程）** | `async_add_import_executor_job`，专用于 import 集成代码，避免 GIL/死锁 |
| **`HassJob` + `@callback`** | 预分类任务类型（Coroutine/Callback/Executor），避免每次运行时判断 |
| **`create_eager_task`** | `eager_start=True`，减少事件循环往返 |
| **`_tasks` vs `_background_tasks`** | 普通任务阻塞 `async_block_till_done`；后台任务不阻塞启动、关闭时自动取消 |

`add_job`/`async_add_executor_job`/`async_create_task` 等是分派的核心入口，它们根据 callable 类型（协程/@callback/普通函数）自动决定跑在事件循环还是 executor。

---

## 五、目录结构分层

```
homeassistant/
├── core.py              核心对象（HomeAssistant/EventBus/StateMachine/Service）
├── runner.py            事件循环 + 进程运行
├── bootstrap.py         引导装配（分阶段）
├── setup.py             组件装配逻辑
├── loader.py            Integration 类 + manifest.json 加载
├── config.py / core_config.py  配置处理
├── config_entries.py    ConfigEntry 机制（UI 配置）
├── components/          2000+ 集成（每个 = 一个 domain，含 manifest.json）
├── helpers/             可复用辅助（entity/registry/template/trigger...）
├── util/                底层工具（async_/executor/json/dt...）
├── generated/           编译期生成（config_flows/ssdp/zeroconf 等清单）
└── auth/                认证
```

---

## 六、设计思想总结

1. **单线程事件循环 + 有界线程池**：所有状态变更、事件、服务都在事件循环里串行化，天然无锁；阻塞操作全部下放 executor。
2. **事件驱动 + 状态机**：以 `EventBus` 为中枢，`StateMachine` 为真相源，自动化/前端/录音机（recorder）都作为事件的观察者。
3. **Integration/Manifest 体系**：每个集成是 `manifest.json` 驱动的独立包，`loader.Integration` 统一管理依赖、requirements、平台加载、阻塞名单。
4. **分阶段启动 + 超时降级**：Stage 0/1/2 有序启动，任一关键集成失败自动降级到 recovery mode。
5. **极致性能优化**：`__slots__`、propcache、`loop.time = monotonic`、压缩状态、预加载翻译/requirements/storage，都是为了支撑上万实体的规模。

---

需要我深入某个子系统的细节吗？比如 **config entries（配置条目）机制**、**entity platform 的实体生命周期**、**WebSocket API 推送链路**，或 **recorder 的数据库写入路径**。