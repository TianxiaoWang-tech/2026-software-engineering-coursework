/**
 * gateway/services/api.mjs
 * 业务 API 分发层（契约见 contracts/gateway-api.d.ts）。
 *
 * 职责：
 *   - 方法路由与权限判定（FR-7.2 / FR-4.5）
 *   - 把业务异常翻译成对外错误码
 *   - 写审计日志（FR-7.6）
 *
 * 这一层与传输无关：WebSocket、HTTP、单元测试都复用同一套分发。
 */

import { AppError, ErrorCode } from '../core/errors.mjs';

/** 只读方法：任何已登录角色可用 */
const READ_ONLY = new Set([
  'system.hello',
  'area.list',
  'device.list',
  'state.get',
  'scene.list',
  'automation.list',
  'access.logs',
  'climate.profile',
  'ops.selfCheck',
]);

/** 管理方法：仅 admin */
const ADMIN_ONLY = new Set(['device.add', 'device.remove', 'device.rename', 'automation.save']);

export class ApiService {
  constructor({ app, logger = null }) {
    this.app = app;
    this.logger = logger ?? app.logger;
    this.handlers = {
      'auth.login': this.login,
      'auth.logout': this.logout,
      'system.hello': this.hello,
      'area.list': this.areaList,
      'device.list': this.deviceList,
      'device.add': this.deviceAdd,
      'device.remove': this.deviceRemove,
      'device.rename': this.deviceRename,
      'state.get': this.stateGet,
      'climate.profile': this.climateProfile,
      'control.set': this.controlSet,
      'scene.list': this.sceneList,
      'scene.run': this.sceneRun,
      'automation.list': this.automationList,
      'automation.save': this.automationSave,
      'access.open': this.accessOpen,
      'access.logs': this.accessLogs,
      'ops.selfCheck': this.selfCheck,
    };
  }

  /**
   * 统一入口。
   * @param {{method: string, params?: object, token?: string}} req
   * @returns {Promise<{ok: true, data: any}>}
   */
  async call({ method, params = {}, token }) {
    const handler = this.handlers[method];
    if (!handler) {
      throw new AppError(`未知方法 ${method}`, { code: ErrorCode.BAD_PARAMS });
    }

    let session = null;
    // system.hello 用于登录前获取密钥指纹，因此豁免鉴权
    if (method !== 'auth.login' && method !== 'system.hello') {
      session = this.app.sessions.verify(token);
    }

    if (ADMIN_ONLY.has(method)) {
      this.app.sessions.requireRole(session, 'admin');
    } else if (!READ_ONLY.has(method) && method !== 'auth.login') {
      this.app.sessions.requireRole(session, 'member');
    }

    const data = await handler.call(this, params, session);
    return { ok: true, data };
  }

  /* ------------------------------ 认证 ------------------------------ */

  async login({ name, password }) {
    const user = this.app.users.authenticate(name, password);
    const session = this.app.sessions.issue(user);
    this.app.recordAudit({ userId: user.id, action: 'login', result: 'success' });
    return { token: session.token, role: session.role, expiresAt: session.expiresAt };
  }

  async logout(_params, session) {
    this.app.sessions.revoke(session.token);
    this.app.recordAudit({ userId: session.userId, action: 'logout', result: 'success' });
    return {};
  }

  async hello() {
    return {
      gatewayId: this.app.config.gatewayId ?? 'gateway-001',
      version: this.app.constructor.VERSION ?? '1.0.0',
      protocolVersion: 1,
      keyFingerprint: this.app.keystore?.fingerprint ?? 'unavailable',
    };
  }

  /* ------------------------------ 读取 ------------------------------ */

  async areaList() {
    return { areas: this.app.registry.listAreas() };
  }

  async deviceList() {
    return {
      ...this.app.registry.snapshot(),
      pending: this.app.devices.listPending(),
    };
  }

  async stateGet({ entityIds, deviceId }) {
    const states = {};
    const entities = entityIds?.length
      ? entityIds.map((id) => this.app.registry.getEntity(id))
      : this.app.registry.listDevices().filter((d) => !deviceId || d.id === deviceId).flatMap((d) => this.app.registry.entitiesOf(d.id));

    for (const e of entities) {
      states[e.id] = { value: e.value, updatedAt: e.updatedAt, stale: this.app.registry.isStale(e) };
    }
    return { states };
  }

  async sceneList() {
    return { scenes: this.app.scenes.list() };
  }

  /** 品牌能力子集：供界面置灰（FR-3.3） */
  async climateProfile({ deviceId }) {
    return this.app.climate.capabilitiesFor(deviceId);
  }

  async automationList() {
    return { automations: this.app.automations.list() };
  }

  async accessLogs({ limit } = {}) {
    return { logs: this.app.access.listLogs({ limit }) };
  }

  /* ------------------------------ 写操作 ------------------------------ */

  async deviceAdd({ descriptor }, session) {
    const record = await this.app.devices.addDevice(descriptor);
    this.app.recordAudit({ userId: session.userId, action: 'device.add', target: record.id, result: 'success' });
    return { id: record.id };
  }

  async deviceRemove({ deviceId }, session) {
    await this.app.devices.removeDevice(deviceId);
    this.app.recordAudit({ userId: session.userId, action: 'device.remove', target: deviceId, result: 'success' });
    return {};
  }

  async deviceRename({ deviceId, name, areaId }, session) {
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (areaId !== undefined) patch.areaId = areaId;
    this.app.registry.updateDevice(deviceId, patch);
    this.app.recordAudit({ userId: session.userId, action: 'device.rename', target: deviceId, result: 'success' });
    return {};
  }

  /** 控制入口：按设备类别路由到对应业务中心 */
  async controlSet({ deviceId, capability, value }, session) {
    const device = this.app.registry.getDevice(deviceId);

    if (device.category === 'lock') {
      throw new AppError('门禁开锁请使用 access.open（需二次确认）', { code: ErrorCode.FORBIDDEN, reason: 'forbidden' });
    }

    let result;
    if (device.category === 'light') {
      if (capability === 'switch') result = await this.app.lighting.setSwitch(deviceId, value, session.name);
      else if (capability === 'brightness') result = await this.app.lighting.setBrightness(deviceId, value, session.name);
      else if (capability === 'color_temp') result = await this.app.lighting.setColorTemp(deviceId, value, session.name);
      else result = await this.app.control.control({ deviceId, capability, value, actor: session.name });
    } else if (device.category === 'ac') {
      result = await this.app.climate.set(deviceId, capability, value, session.name);
    } else {
      result = await this.app.control.control({ deviceId, capability, value, actor: session.name });
    }

    this.app.recordAudit({
      userId: session.userId,
      action: `control.${capability}`,
      target: deviceId,
      result: result.ok ? 'success' : 'failure',
    });

    if (!result.ok) {
      throw new AppError(result.message ?? '控制失败', { code: codeOfReason(result.reason), reason: result.reason });
    }
    return result;
  }

  async sceneRun({ sceneId }, session) {
    const record = await this.app.scenes.run(sceneId, { actor: session.name });
    return { sceneId, ok: record.ok, results: record.results, elapsedMs: record.elapsedMs };
  }

  async automationSave({ automation }, session) {
    const saved = this.app.automations.save(automation);
    this.app.recordAudit({ userId: session.userId, action: 'automation.save', target: saved.id, result: 'success' });
    return { id: saved.id };
  }

  async accessOpen({ deviceId, confirm }, session) {
    const result = await this.app.access.open({
      deviceId,
      userId: session.userId,
      method: 'app',
      confirm,
      role: session.role,
    });
    this.app.recordAudit({
      userId: session.userId,
      action: 'access.open',
      target: deviceId,
      result: result.ok ? 'success' : 'failure',
    });
    return result;
  }

  /** 自检（FR-8.1） */
  async selfCheck() {
    const checks = [];
    const devices = this.app.registry.listDevices();
    checks.push({
      name: '设备总数',
      ok: devices.length > 0,
      detail: `${devices.length} 台，在线 ${devices.filter((d) => d.online).length} 台`,
      suggestion: devices.length === 0 ? '请检查驱动是否启动' : undefined,
    });
    checks.push({
      name: '驱动加载',
      ok: this.app.devices.drivers.size > 0,
      detail: [...this.app.devices.drivers.keys()].join(', '),
    });
    checks.push({
      name: '品牌适配器',
      ok: this.app.adapters.list().length >= 3,
      detail: this.app.adapters.list().map((a) => `${a.brand}(${a.transport})`).join(', '),
    });
    checks.push({
      name: '密钥库',
      ok: Boolean(this.app.keystore),
      detail: this.app.keystore ? `active v${this.app.keystore.activeVersion}, fp=${this.app.keystore.fingerprint}` : '未初始化',
      suggestion: this.app.keystore ? undefined : '调用 initSecurity()',
    });
    checks.push({
      name: '离线设备',
      ok: devices.every((d) => d.online || d.category === 'sensor'),
      detail: devices.filter((d) => !d.online).map((d) => d.name).join(', ') || '无',
    });

    return { at: this.app.now(), checks };
  }
}

function codeOfReason(reason) {
  switch (reason) {
    case 'offline':
      return ErrorCode.OFFLINE;
    case 'timeout':
      return ErrorCode.TIMEOUT;
    case 'unsupported':
      return ErrorCode.UNSUPPORTED;
    case 'forbidden':
      return ErrorCode.FORBIDDEN;
    default:
      return ErrorCode.INTERNAL;
  }
}
