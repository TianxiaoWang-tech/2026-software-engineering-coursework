/**
 * tests/app.test.mjs
 * 端到端业务测试：装配真实 app（仿真驱动 + 三品牌适配器 + 业务服务）。
 * 覆盖 SRS 的四大中心核心链路。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayApp } from '../gateway/app.mjs';
import { createLogger } from '../gateway/core/log.mjs';

const silent = createLogger({ level: 'silent' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeApp(opts = {}) {
  const app = new GatewayApp({ logger: silent, config: { ...opts } });
  await app.start({ withMqtt: false });
  return app;
}

const state = (app, id) => app.registry.getState(id);

test('app: 启动后完成区域与设备装配', async () => {
  const app = await makeApp();
  try {
    assert.equal(app.registry.listAreas().length, 5);
    const devices = app.registry.listDevices();
    assert.ok(devices.length >= 9, `期望 >=9 台设备，实际 ${devices.length}`);
    assert.equal(devices.filter((d) => d.category === 'ac').length, 3);
    assert.equal(devices.filter((d) => d.category === 'light').length, 3);
  } finally {
    await app.stop();
  }
});

test('照明中心: 远程开关与调光，越界钳制（FR-2.1/2.2/2.3）', async () => {
  const app = await makeApp();
  try {
    const r1 = await app.lighting.setSwitch('sim-light-living', true);
    assert.equal(r1.ok, true);
    await delay(40);
    assert.equal(state(app, 'sim-light-living').switch, true);

    await app.lighting.setBrightness('sim-light-living', 250);
    await delay(40);
    assert.equal(state(app, 'sim-light-living').brightness, 100, '越界应钳制到 100');

    await app.lighting.setColorTemp('sim-light-living', 9999);
    await delay(40);
    assert.equal(state(app, 'sim-light-living').color_temp, 6500);
  } finally {
    await app.stop();
  }
});

test('照明中心: 人体感应自动开灯 + 无人自动关灯（FR-2.4/2.5）', async () => {
  const app = await makeApp();
  try {
    app.lighting.config.nightRange = ['00:00', '23:59']; // 固定为"夜间"以便断言亮度
    app.lighting.config.nightBrightness = 10;
    app.lighting.config.noMotionTimeoutMs = 60;

    app.sim.triggerMotion('sim-motion-corridor', { lux: 20 });
    await delay(80);

    assert.equal(state(app, 'sim-light-corridor').switch, true, '应有灯被自动点亮');
    assert.equal(state(app, 'sim-light-corridor').brightness, 10, '夜间应以低亮度点亮');

    await delay(250); // 等过 motion=false 与 60ms 延时关灯
    await delay(400);
    assert.equal(state(app, 'sim-light-corridor').switch, false, '无人后应自动关闭');
  } finally {
    await app.stop();
  }
});

test('照明中心: 环境光充足时不自动开灯（FR-2.4）', async () => {
  const app = await makeApp();
  try {
    app.sim.triggerMotion('sim-motion-corridor', { lux: 800 });
    await delay(80);
    assert.equal(state(app, 'sim-light-corridor').switch, false);
  } finally {
    await app.stop();
  }
});

test('空调中心: 三品牌独立控制，码值映射正确（FR-3.4/3.5）', async () => {
  const app = await makeApp();
  try {
    await app.climate.setSwitch('ac-gree-living', true);
    await app.climate.setMode('ac-gree-living', 'cool');
    await app.climate.setTemperature('ac-gree-living', 24);
    await app.climate.setSwitch('ac-midea-bedroom', true);
    await app.climate.setMode('ac-midea-bedroom', 'heat');
    await app.climate.setSwitch('ac-haier-study', true);
    await app.climate.setMode('ac-haier-study', 'fan');
    await delay(60);

    assert.equal(state(app, 'ac-gree-living').hvac_mode, 'cool');
    assert.equal(state(app, 'ac-midea-bedroom').hvac_mode, 'heat');
    assert.equal(state(app, 'ac-haier-study').hvac_mode, 'fan');

    // 品牌码值确实不同 —— 证明适配器真的在做映射
    assert.equal(app.climate.lastVendorCode.get('ac-gree-living#hvac_mode'), 'GREE:MODE:0x01');
    assert.equal(app.climate.lastVendorCode.get('ac-gree-living#target_temp'), 'GREE:TEMP:0x18');
    assert.equal(app.climate.lastVendorCode.get('ac-midea-bedroom#hvac_mode'), 'MIDEA:MODE:0x02');
    assert.equal(app.climate.lastVendorCode.get('ac-haier-study#hvac_mode'), 'HAIER:MODE:0x12');
  } finally {
    await app.stop();
  }
});

test('空调中心: 不支持的能力按品牌拒绝（FR-3.3）', async () => {
  const app = await makeApp();
  try {
    // 海尔不支持除湿
    const r1 = await app.climate.setMode('ac-haier-study', 'dry');
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'unsupported');

    // 海尔不支持摆风
    const r2 = await app.climate.setSwing('ac-haier-study', true);
    assert.equal(r2.ok, false);

    // 美的温度下限为 17℃，16 应被拒
    const r3 = await app.climate.setTemperature('ac-midea-bedroom', 16);
    assert.equal(r3.ok, false);

    // 能力子集供界面置灰
    const caps = app.climate.capabilitiesFor('ac-midea-bedroom');
    assert.deepEqual(caps.modes, ['cool', 'heat', 'dry']);
    assert.deepEqual(caps.fanSpeeds, ['auto', 'low', 'high']);
  } finally {
    await app.stop();
  }
});

test('温湿度中心: 湿度过高自动除湿（FR-3.6）', async () => {
  const app = await makeApp();
  try {
    app.climate.config.cooldownMs = 0;
    await app.climate.setSwitch('ac-gree-living', true);
    await delay(30);

    app.sim.setClimate('sim-sensor-living', { humidity: 85 });
    await delay(120);

    assert.equal(state(app, 'ac-gree-living').hvac_mode, 'dry', '应自动切到除湿模式');
  } finally {
    await app.stop();
  }
});

test('门禁: 二次确认、权限与留痕（FR-4.1/4.3）', async () => {
  const app = await makeApp();
  try {
    // 错误口径 → 拒绝并留痕
    await assert.rejects(
      () => app.access.open({ deviceId: 'sim-lock-front', userId: 'u_admin', method: 'app', confirm: '0000', role: 'admin' }),
      (e) => e.code === 'FORBIDDEN',
    );
    assert.equal(app.access.logs.at(-1).result, 'failure');

    // 访客 → 拒绝
    await assert.rejects(
      () => app.access.open({ deviceId: 'sim-lock-front', userId: 'u_guest', method: 'app', confirm: app.access.config.pin, role: 'guest' }),
      (e) => e.code === 'FORBIDDEN',
    );

    // 正确 → 成功并留痕
    const r = await app.access.open({ deviceId: 'sim-lock-front', userId: 'u_admin', method: 'app', confirm: app.access.config.pin, role: 'admin' });
    assert.equal(r.ok, true);
    assert.ok(r.logId);
    await delay(40);
    assert.equal(state(app, 'sim-lock-front').lock_state, 'unlocked');

    const logs = app.access.listLogs();
    assert.equal(logs[0].result, 'success');
    assert.ok(logs.length >= 3);
  } finally {
    await app.stop();
  }
});

test('场景: 一键执行多个动作（FR-5.1）', async () => {
  const app = await makeApp();
  try {
    const exec = await app.scenes.run('scene-home');
    await delay(60);
    assert.equal(exec.ok, true);
    assert.equal(state(app, 'sim-light-living').switch, true);
    assert.equal(state(app, 'sim-light-living').brightness, 80);
    assert.equal(state(app, 'ac-gree-living').switch, true);
    assert.equal(state(app, 'ac-gree-living').target_temp, 24);
  } finally {
    await app.stop();
  }
});

test('离线设备: 控制失败原因可区分（FR-3.5）', async () => {
  const app = await makeApp();
  try {
    app.sim.setAvailability('sim-light-living', false);
    const r = await app.lighting.setSwitch('sim-light-living', true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'offline');

    const r2 = await app.control.control({ deviceId: 'sim-light-living', capability: 'nonexistent', value: 1 });
    assert.equal(r2.reason, 'unsupported');
  } finally {
    await app.stop();
  }
});

test('自动化: 定时触发条件判断（FR-5.2/5.3）', async () => {
  const app = await makeApp();
  try {
    const auto = app.automations.get('auto-humidity');
    assert.ok(auto);

    // 条件不满足：湿度未超阈值
    app.sim.setClimate('sim-sensor-living', { humidity: 40 });
    await delay(50);
    const before = app.automations.executions.length;

    app.sim.setClimate('sim-sensor-living', { humidity: 80 });
    await delay(120);
    assert.ok(app.automations.executions.length > before, '湿度超阈值应触发自动化');
  } finally {
    await app.stop();
  }
});
