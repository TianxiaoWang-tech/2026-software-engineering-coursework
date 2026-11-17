/**
 * gateway/domains/rules/rules.mjs
 * 场景与自动化（SRS M5 / FR-5.1 ~ FR-5.6）
 *
 *   SceneService       —— 一键场景：多个动作按序执行（FR-5.1）
 *   AutomationEngine   —— 定时触发 + 状态触发 + 条件判断 + 冷却防抖（FR-5.2/5.3）
 */

import { randomId } from '../../security/crypto.mjs';

/* ------------------------------ 场景 ------------------------------ */

export class SceneService {
  constructor({ bus, control, logger = null, now = () => Date.now() }) {
    this.bus = bus;
    this.control = control;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, any>} */
    this.scenes = new Map();
    /** 最近执行记录（FR-5.5） */
    this.executions = [];
  }

  save(scene) {
    const record = { id: scene.id ?? randomId('scene_'), enabled: true, ...scene };
    this.scenes.set(record.id, record);
    return record;
  }

  list() {
    return [...this.scenes.values()];
  }

  get(sceneId) {
    return this.scenes.get(sceneId);
  }

  /** 一键执行：动作带 delayMs 时按序等待 */
  async run(sceneId, { actor = 'user' } = {}) {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`scene not found: ${sceneId}`);

    const startedAt = this.now();
    const results = await this.control.controlMany(scene.actions, actor);
    const ok = results.every((r) => r.ok);
    const record = {
      id: randomId('exec_'),
      sceneId,
      sceneName: scene.name,
      ok,
      at: startedAt,
      elapsedMs: this.now() - startedAt,
      results,
    };
    this.executions.push(record);
    this.bus.emit('scene_executed', record);
    return record;
  }
}

/* ---------------------------- 自动化引擎 ---------------------------- */

export const DEFAULT_RULES_CONFIG = { tickMs: 1000 };

export class AutomationEngine {
  constructor({ registry, bus, control, logger = null, now = () => Date.now(), config = {} }) {
    this.registry = registry;
    this.bus = bus;
    this.control = control;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_RULES_CONFIG, ...config };

    /** @type {Map<string, any>} */
    this.automations = new Map();
    /** 每个自动化上次触发所在分钟，避免同一分钟重复触发 */
    this.firedMinute = new Map();
    this.executions = [];
    this.timer = null;
    this.unsubscribers = [bus.on('state_changed', (evt) => this.onStateChanged(evt.data))];
  }

  save(automation) {
    const record = { id: automation.id ?? randomId('auto_'), enabled: true, conditions: [], actions: [], ...automation };
    this.automations.set(record.id, record);
    return record;
  }

  list() {
    return [...this.automations.values()];
  }

  get(id) {
    return this.automations.get(id);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubscribers) off();
  }

  /** 定时触发检查（每秒一次，命中同一分钟只触发一次） */
  tick(at = this.now()) {
    const d = new Date(at);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const weekday = d.getDay() === 0 ? 7 : d.getDay();

    for (const automation of this.automations.values()) {
      if (!automation.enabled || automation.trigger?.kind !== 'time') continue;
      const t = automation.trigger;
      if (!timeMatches(t, hhmm, weekday)) continue;
      if (this.firedMinute.get(automation.id) === `${hhmm}@${d.toDateString()}`) continue;
      this.firedMinute.set(automation.id, `${hhmm}@${d.toDateString()}`);
      this.fire(automation, { reason: `定时 ${hhmm}` });
    }
  }

  /** 状态触发检查（FR-5.3） */
  onStateChanged({ entityId, capability, newValue, oldValue }) {
    for (const automation of this.automations.values()) {
      if (!automation.enabled || automation.trigger?.kind !== 'state') continue;
      const t = automation.trigger;
      if (t.entity !== entityId) continue;

      const hit = stateMatches(t.on, t.value, newValue, oldValue);
      if (!hit) continue;
      this.fire(automation, { reason: `状态 ${entityId}=${newValue}` });
    }
  }

  /** 条件判断：全部满足才执行（"触发—条件—动作"） */
  conditionsMet(automation, at = new Date(this.now())) {
    for (const cond of automation.conditions ?? []) {
      const entity = this.registry.entities.get(cond.entity);
      if (!entity) return false;
      const value = entity.value;
      if (!compare(value, cond.op, cond.value, cond.value2)) return false;
      if (cond.timeRange && !inTimeRange(at, cond.timeRange)) return false;
    }
    return true;
  }

  async fire(automation, { reason = '' } = {}) {
    const now = this.now();
    if (automation.cooldownMs && automation.lastFiredAt && now - automation.lastFiredAt < automation.cooldownMs) {
      this.logger?.debug(`automation ${automation.id} in cooldown, skip`);
      return null;
    }
    if (!this.conditionsMet(automation)) {
      this.bus.emit('automation_skipped', { automationId: automation.id, reason: 'conditions not met' });
      return null;
    }

    automation.lastFiredAt = now;
    const results = await this.control.controlMany(automation.actions ?? [], `automation:${automation.id}`);
    const record = { automationId: automation.id, name: automation.name, reason, at: now, results, ok: results.every((r) => r.ok) };
    this.executions.push(record);
    this.bus.emit('automation_fired', record);
    return record;
  }
}

/* ------------------------------ 工具 ------------------------------ */

export function timeMatches(trigger, hhmm, weekday) {
  if (trigger.at !== hhmm) return false;
  if (trigger.weekdays?.length && !trigger.weekdays.includes(weekday)) return false;
  return true;
}

export function stateMatches(on, expected, newValue, oldValue) {
  switch (on) {
    case 'change':
      return newValue !== oldValue;
    case 'above':
      return typeof newValue === 'number' && newValue > expected;
    case 'below':
      return typeof newValue === 'number' && newValue < expected;
    case 'equals':
      return newValue === expected;
    default:
      return false;
  }
}

export function compare(value, op, expected, expected2) {
  switch (op) {
    case 'eq':
      return value === expected;
    case 'ne':
      return value !== expected;
    case 'gt':
      return value > expected;
    case 'lt':
      return value < expected;
    case 'between':
      return value >= expected && value <= expected2;
    default:
      return false;
  }
}

export function inTimeRange(date, range) {
  const [start, end] = range.split('-');
  const minutes = date.getHours() * 60 + date.getMinutes();
  const toMin = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}
