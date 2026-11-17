/**
 * gateway/app.mjs
 * 组合根（composition root）：把内核、驱动、业务、安全、接口装配成一个网关实例。
 *
 * 这里不写业务逻辑，只做"谁依赖谁"的装配，便于单测替换任意一层。
 */

import { EventBus } from './core/bus.mjs';
import { Registry } from './core/registry.mjs';
import { createLogger } from './core/log.mjs';
import { ControlService } from './services/control.mjs';
import { DeviceService } from './services/devices.mjs';
import { SimDriver } from './drivers/sim/driver.mjs';
import { MqttDriver } from './drivers/mqtt/driver.mjs';
import { GreeAdapter } from './adapters/ac-gree/adapter.mjs';
import { MideaAdapter } from './adapters/ac-midea/adapter.mjs';
import { HaierAdapter } from './adapters/ac-haier/adapter.mjs';
import { AcAdapterRegistry } from './adapters/registry.mjs';
import { LightingService } from './domains/lighting/lighting.mjs';
import { ClimateService } from './domains/climate/climate.mjs';
import { AccessService } from './domains/access/access.mjs';
import { SceneService, AutomationEngine } from './domains/rules/rules.mjs';
import { UserStore } from './security/users.mjs';
import { SessionStore } from './security/session.mjs';
import { FileKeyStore } from './security/keystore.mjs';
import { randomId } from './security/crypto.mjs';

export const GATEWAY_VERSION = '1.0.0';

export class GatewayApp {
  constructor({ config = {}, logger = null, now = () => Date.now(), persistence = null } = {}) {
    this.config = {
      logLevel: 'info',
      mqtt: { enabled: false, host: '127.0.0.1', port: 1883 },
      keystore: { file: null, passphrase: 'home-control-dev' },
      ...config,
    };
    this.now = now;
    this.logger = logger ?? createLogger({ level: this.config.logLevel });

    this.bus = new EventBus({ logger: this.logger });
    this.registry = new Registry({ bus: this.bus, logger: this.logger, now });
    this.control = new ControlService({ registry: this.registry, bus: this.bus, logger: this.logger, now });

    this.devices = new DeviceService({
      registry: this.registry,
      control: this.control,
      bus: this.bus,
      logger: this.logger,
    });

    this.adapters = new AcAdapterRegistry({ logger: this.logger });
    this.lighting = new LightingService({
      registry: this.registry,
      bus: this.bus,
      control: this.control,
      logger: this.logger,
      now,
    });
    this.climate = new ClimateService({
      registry: this.registry,
      bus: this.bus,
      control: this.control,
      adapters: this.adapters,
      logger: this.logger,
      now,
    });
    this.access = new AccessService({
      registry: this.registry,
      bus: this.bus,
      control: this.control,
      logger: this.logger,
      now,
    });
    this.scenes = new SceneService({ bus: this.bus, control: this.control, logger: this.logger, now });
    this.automations = new AutomationEngine({
      registry: this.registry,
      bus: this.bus,
      control: this.control,
      logger: this.logger,
      now,
    });

    this.users = new UserStore({ now, logger: this.logger });
    this.sessions = new SessionStore({ now });
    /** 审计日志（FR-7.6）：只追加，普通成员不可删除 */
    this.audit = [];
    this.keystore = null;
    this.persistence = persistence;
    this.started = false;
  }

  /** 密钥层初始化（HUKS 的参考实现） */
  initSecurity({ file, passphrase } = {}) {
    const file0 = file ?? this.config.keystore.file;
    if (!file0) {
      // 未指定文件时使用内存密钥库（测试/演示）
      this.keystore = new FileKeyStore({
        file: `${process.cwd()}/.runtime/keys.json`,
        passphrase: passphrase ?? this.config.keystore.passphrase,
        logger: this.logger,
      }).init();
    } else {
      this.keystore = new FileKeyStore({ file: file0, passphrase: passphrase ?? this.config.keystore.passphrase, logger: this.logger }).init();
    }
    return this.keystore;
  }

  /** 初始账户：首次启动创建管理员（FR-7.1） */
  initAccounts({ adminName = 'admin', adminPassword = 'admin12345' } = {}) {
    if (this.users.list().length === 0) {
      this.users.create({ name: adminName, password: adminPassword, role: 'admin' });
      this.users.create({ name: 'member', password: 'member12345', role: 'member' });
      this.users.create({ name: 'guest', password: 'guest12345', role: 'guest' });
    }
    return this.users.list();
  }

  /** 注册三个品牌适配器：上层只传统一能力，映射由适配器完成 */
  initAdapters() {
    const send = async (deviceId, capability, value) => this.control.control({ deviceId, capability, value, actor: 'adapter' });
    this.adapters.register(new GreeAdapter({ logger: this.logger.child('gree'), send }));
    this.adapters.register(new MideaAdapter({ logger: this.logger.child('midea'), send }));
    this.adapters.register(new HaierAdapter({ logger: this.logger.child('haier'), send }));
    return this.adapters;
  }

  /** 演示场景与自动化（答辩时一键展示联动能力） */
  seedScenes() {
    this.scenes.save({
      id: 'scene-home',
      name: '回家',
      actions: [
        { deviceId: 'sim-light-living', capability: 'switch', value: true },
        { deviceId: 'sim-light-living', capability: 'brightness', value: 80 },
        { deviceId: 'ac-gree-living', capability: 'switch', value: true },
        { deviceId: 'ac-gree-living', capability: 'target_temp', value: 24 },
      ],
    });
    this.scenes.save({
      id: 'scene-away',
      name: '离家',
      actions: [
        { deviceId: 'sim-light-living', capability: 'switch', value: false },
        { deviceId: 'sim-light-bedroom', capability: 'switch', value: false },
        { deviceId: 'ac-gree-living', capability: 'switch', value: false },
        { deviceId: 'ac-midea-bedroom', capability: 'switch', value: false },
      ],
    });
    this.scenes.save({
      id: 'scene-sleep',
      name: '睡眠',
      actions: [
        { deviceId: 'sim-light-living', capability: 'switch', value: false },
        { deviceId: 'sim-light-bedroom', capability: 'switch', value: true },
        { deviceId: 'sim-light-bedroom', capability: 'brightness', value: 10 },
      ],
    });

    this.automations.save({
      id: 'auto-humidity',
      name: '湿度过高开除湿',
      trigger: { kind: 'state', entity: 'sim-sensor-living#humidity', on: 'above', value: 70 },
      conditions: [],
      actions: [{ deviceId: 'ac-gree-living', capability: 'hvac_mode', value: 'dry' }],
      cooldownMs: 60_000,
    });
    this.automations.save({
      id: 'auto-night-off',
      name: '23:00 关客厅主灯',
      trigger: { kind: 'time', at: '23:00' },
      conditions: [],
      actions: [{ deviceId: 'sim-light-living', capability: 'switch', value: false }],
    });
    return { scenes: this.scenes.list(), automations: this.automations.list() };
  }

  /** 启动：仿真驱动 + 可选 MQTT 驱动 + 业务引擎 */
  async start({ withMqtt = null } = {}) {
    if (this.started) return this;

    this.registry.addArea({ id: 'living', name: '客厅', sort: 1 });
    this.registry.addArea({ id: 'bedroom', name: '主卧', sort: 2 });
    this.registry.addArea({ id: 'study', name: '书房', sort: 3 });
    this.registry.addArea({ id: 'corridor', name: '走廊', sort: 4 });
    this.registry.addArea({ id: 'entrance', name: '玄关', sort: 5 });

    this.initSecurity();
    this.initAccounts();
    this.initAdapters();
    await this.adapters.initAll();

    const sim = new SimDriver({ logger: this.logger.child('sim') });
    this.devices.registerDriver(sim);
    this.sim = sim;

    const useMqtt = withMqtt ?? this.config.mqtt.enabled;
    if (useMqtt) {
      const mqtt = new MqttDriver({
        host: this.config.mqtt.host,
        port: this.config.mqtt.port,
        logger: this.logger.child('mqtt'),
      });
      this.devices.registerDriver(mqtt);
      this.mqtt = mqtt;
    }

    await this.devices.startAll();
    this.seedScenes();
    this.automations.start();

    // 周期性扫描离线设备（FR-1.7）
    this.sweepTimer = setInterval(() => this.registry.sweep(), 15_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();

    this.started = true;
    this.logger.info(`gateway started: ${this.registry.listDevices().length} devices`);
    return this;
  }

  async stop() {
    this.started = false;
    clearInterval(this.sweepTimer);
    this.automations.stop();
    this.lighting.stop();
    this.climate.stop();
    this.access.stop();
    await this.devices.stopAll();
  }

  /** 供 API 使用的聚合快照 */
  snapshot() {
    return this.registry.snapshot();
  }

  /** 审计留痕（FR-7.6）：只追加 */
  recordAudit({ userId, action, target = null, result = 'success' }) {
    const entry = { id: randomId('aud_'), userId, action, target, result, at: this.now() };
    this.audit.push(entry);
    this.bus.emit('audit', entry);
    return entry;
  }
}
