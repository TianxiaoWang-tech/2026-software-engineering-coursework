/**
 * tests/e2e-mqtt.test.mjs
 * 全链路测试：内置 Broker + 设备仿真器 + 网关（MQTT 驱动）。
 * 验证 FR-1.1（发现）/ FR-1.7（离线）/ FR-3.4（回执）在真实 TCP 上成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MqttBroker } from '../gateway/drivers/mqtt/broker.mjs';
import { GatewayApp } from '../gateway/app.mjs';
import { DeviceSimulator, demoDevices } from '../simulators/devices.mjs';
import { createLogger } from '../gateway/core/log.mjs';

const silent = createLogger({ level: 'silent' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 3000, stepMs = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await delay(stepMs);
  }
}

test('e2e: 设备经 MQTT 自动发现并被网关接管（FR-1.1）', async () => {
  const broker = new MqttBroker({ port: 0 });
  const { port } = await broker.listen();
  const sim = new DeviceSimulator({ port, devices: demoDevices() });
  let app = null;
  try {
    await sim.start();

    app = new GatewayApp({
      logger: silent,
      config: { mqtt: { enabled: true, host: '127.0.0.1', port } },
    });
    await app.start({ withMqtt: true });

    const discovered = await waitFor(() => app.registry.hasDevice('mqtt-light-1') && app.registry.hasDevice('mqtt-ac-1'));
    assert.equal(discovered, true, 'MQTT 设备应被自动发现并接入');

    const device = app.registry.getDevice('mqtt-light-1');
    assert.equal(device.name, '书房台灯');
    assert.equal(device.protocol, 'mqtt');
    assert.ok(device.capabilities.some((c) => c.kind === 'brightness'));
  } finally {
    await app?.stop();
    await sim.stop();
    await broker.close();
  }
});

test('e2e: 通过 MQTT 控制设备并收到回执（FR-3.4）', async () => {
  const broker = new MqttBroker({ port: 0 });
  const { port } = await broker.listen();
  const sim = new DeviceSimulator({ port, devices: demoDevices() });
  let app = null;
  try {
    await sim.start();
    app = new GatewayApp({ logger: silent, config: { mqtt: { enabled: true, host: '127.0.0.1', port } } });
    await app.start({ withMqtt: true });
    await waitFor(() => app.registry.hasDevice('mqtt-light-1'));

    const result = await app.control.control({ deviceId: 'mqtt-light-1', capability: 'switch', value: true });
    assert.equal(result.ok, true);

    const reflected = await waitFor(() => app.registry.getState('mqtt-light-1').switch === true);
    assert.equal(reflected, true, '设备状态应回流到注册表');
    assert.equal(sim.stateOf('mqtt-light-1').switch, true, '仿真设备应真的收到指令');
  } finally {
    await app?.stop();
    await sim.stop();
    await broker.close();
  }
});

test('e2e: 设备掉线后网关在超时内标记离线（FR-1.7）', async () => {
  const broker = new MqttBroker({ port: 0 });
  const { port } = await broker.listen();
  const sim = new DeviceSimulator({ port, devices: demoDevices() });
  let app = null;
  try {
    await sim.start();
    app = new GatewayApp({ logger: silent, config: { mqtt: { enabled: true, host: '127.0.0.1', port } } });
    await app.start({ withMqtt: true });
    await waitFor(() => app.registry.hasDevice('mqtt-light-1'));
    assert.equal(app.registry.getDevice('mqtt-light-1').online, true);

    sim.dropDevice('mqtt-light-1');
    const offline = await waitFor(() => app.registry.getDevice('mqtt-light-1').online === false, { timeoutMs: 2000 });
    assert.equal(offline, true, 'LWT 应使设备在 90s 内变离线（此处立即）');
  } finally {
    await app?.stop();
    await sim.stop();
    await broker.close();
  }
});

test('e2e: 指令下发到不支持的设备能力被拒绝', async () => {
  const broker = new MqttBroker({ port: 0 });
  const { port } = await broker.listen();
  const sim = new DeviceSimulator({ port, devices: demoDevices() });
  let app = null;
  try {
    await sim.start();
    app = new GatewayApp({ logger: silent, config: { mqtt: { enabled: true, host: '127.0.0.1', port } } });
    await app.start({ withMqtt: true });
    await waitFor(() => app.registry.hasDevice('mqtt-sensor-1'));

    const r = await app.control.control({ deviceId: 'mqtt-sensor-1', capability: 'switch', value: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unsupported');
  } finally {
    await app?.stop();
    await sim.stop();
    await broker.close();
  }
});
