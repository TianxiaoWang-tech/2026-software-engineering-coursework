/**
 * tests/api.test.mjs
 * 业务 API 与加密通信层测试（含端到端 WebSocket 链路）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

import { GatewayApp } from '../gateway/app.mjs';
import { ApiService } from '../gateway/services/api.mjs';
import { GatewayWsServer, encodeText, decodeFrame } from '../gateway/services/ws.mjs';
import { GatewayClient } from '../gateway/services/ws-client.mjs';
import { createLogger } from '../gateway/core/log.mjs';

const silent = createLogger({ level: 'silent' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeStack() {
  const app = new GatewayApp({ logger: silent });
  // 测试用内存密钥库（避免污染工作目录）
  await app.start({ withMqtt: false });
  const api = new ApiService({ app });
  return { app, api };
}

/* ------------------------------ API 层 ------------------------------ */

test('api: 登录失败与令牌校验', async () => {
  const { app, api } = await makeStack();
  try {
    await assert.rejects(() => api.call({ method: 'auth.login', params: { name: 'admin', password: 'bad' } }), (e) => e.code === 'UNAUTHORIZED');
    await assert.rejects(() => api.call({ method: 'device.list', params: {} }), (e) => e.code === 'UNAUTHORIZED');

    const res = await api.call({ method: 'auth.login', params: { name: 'admin', password: 'admin12345' } });
    assert.equal(res.ok, true);
    assert.ok(res.data.token);
    assert.equal(res.data.role, 'admin');
  } finally {
    await app.stop();
  }
});

test('api: 读取设备清单与控制', async () => {
  const { app, api } = await makeStack();
  try {
    const login = await api.call({ method: 'auth.login', params: { name: 'admin', password: 'admin12345' } });
    const token = login.data.token;

    const list = await api.call({ method: 'device.list', token });
    assert.ok(list.data.devices.length >= 9);
    assert.ok(list.data.areas.length === 5);
    assert.ok(list.data.states['sim-light-living']);

    const ctrl = await api.call({
      method: 'control.set',
      token,
      params: { deviceId: 'sim-light-living', capability: 'switch', value: true },
    });
    await delay(40);
    assert.equal(ctrl.ok, true);
    assert.equal(app.registry.getState('sim-light-living').switch, true);
  } finally {
    await app.stop();
  }
});

test('api: 权限分级与越权拦截（FR-4.5 / FR-7.2）', async () => {
  const { app, api } = await makeStack();
  try {
    const guest = await api.call({ method: 'auth.login', params: { name: 'guest', password: 'guest12345' } });
    const member = await api.call({ method: 'auth.login', params: { name: 'member', password: 'member12345' } });

    // 访客只读：可以看，不能控
    const list = await api.call({ method: 'device.list', token: guest.data.token });
    assert.ok(list.ok);
    await assert.rejects(
      () => api.call({ method: 'control.set', token: guest.data.token, params: { deviceId: 'sim-light-living', capability: 'switch', value: true } }),
      (e) => e.code === 'FORBIDDEN',
    );

    // 普通成员不能加设备
    await assert.rejects(
      () => api.call({ method: 'device.add', token: member.data.token, params: { descriptor: {} } }),
      (e) => e.code === 'FORBIDDEN',
    );

    // 审计留痕
    assert.ok(app.audit.length > 0);
  } finally {
    await app.stop();
  }
});

test('api: 门禁必须走 access.open，控制接口被拒（FR-4.1）', async () => {
  const { app, api } = await makeStack();
  try {
    const login = await api.call({ method: 'auth.login', params: { name: 'admin', password: 'admin12345' } });
    const token = login.data.token;

    await assert.rejects(
      () => api.call({ method: 'control.set', token, params: { deviceId: 'sim-lock-front', capability: 'lock', value: true } }),
      (e) => e.code === 'FORBIDDEN',
    );

    const open = await api.call({ method: 'access.open', token, params: { deviceId: 'sim-lock-front', confirm: '2468' } });
    assert.equal(open.data.ok, true);

    const logs = await api.call({ method: 'access.logs', token });
    assert.equal(logs.data.logs[0].result, 'success');
  } finally {
    await app.stop();
  }
});

test('api: 品牌能力子集供界面置灰（FR-3.3）', async () => {
  const { app, api } = await makeStack();
  try {
    const login = await api.call({ method: 'auth.login', params: { name: 'admin', password: 'admin12345' } });
    const token = login.data.token;

    const gree = await api.call({ method: 'climate.profile', token, params: { deviceId: 'ac-gree-living' } });
    assert.equal(gree.data.brand, 'gree');
    assert.ok(gree.data.modes.includes('fan'));
    assert.equal(gree.data.swing, true);

    const haier = await api.call({ method: 'climate.profile', token, params: { deviceId: 'ac-haier-study' } });
    assert.deepEqual(haier.data.modes, ['cool', 'heat', 'fan']);
    assert.equal(haier.data.swing, false);
  } finally {
    await app.stop();
  }
});

test('api: 自检返回各项状态（FR-8.1）', async () => {
  const { app, api } = await makeStack();
  try {
    const login = await api.call({ method: 'auth.login', params: { name: 'admin', password: 'admin12345' } });
    const res = await api.call({ method: 'ops.selfCheck', token: login.data.token });
    assert.ok(res.data.checks.length >= 5);
    assert.ok(res.data.checks.find((c) => c.name === '品牌适配器').detail.includes('gree'));
  } finally {
    await app.stop();
  }
});

/* --------------------------- WebSocket 链路 --------------------------- */

test('ws: 握手 + 加密请求 + 业务调用', async () => {
  const { app, api } = await makeStack();
  const ws = new GatewayWsServer({ api, app, logger: silent, port: 0 });
  const info = await ws.listen();
  const client = new GatewayClient({ port: info.port });
  try {
    const ready = await client.connect();
    assert.ok(ready.fingerprint, '应返回密钥指纹');

    const login = await client.login('admin', 'admin12345');
    assert.equal(login.ok, true);

    const list = await client.request('device.list');
    assert.ok(list.ok);
    assert.ok(list.data.devices.length >= 9);

    const ctrl = await client.request('control.set', { deviceId: 'sim-light-living', capability: 'brightness', value: 66 });
    assert.equal(ctrl.ok, true);
    await delay(50);
    assert.equal(app.registry.getState('sim-light-living').brightness, 66);
  } finally {
    client.close();
    await ws.close();
    await app.stop();
  }
});

test('ws: 客户端收到状态推送事件', async () => {
  const { app, api } = await makeStack();
  const ws = new GatewayWsServer({ api, app, logger: silent, port: 0 });
  const info = await ws.listen();
  const client = new GatewayClient({ port: info.port });
  try {
    await client.connect();
    await client.login('admin', 'admin12345');
    const events = [];
    client.on('event', (e) => events.push(e));

    await client.request('control.set', { deviceId: 'sim-light-living', capability: 'switch', value: true });
    await delay(120);

    assert.ok(events.length > 0, '应收到推送');
    assert.equal(events[0].event, 'state.changed');
  } finally {
    client.close();
    await ws.close();
    await app.stop();
  }
});

test('ws: 报文被篡改时解密失败并被拒绝（FR-7.4）', async () => {
  const { app, api } = await makeStack();
  const ws = new GatewayWsServer({ api, app, logger: silent, port: 0 });
  const info = await ws.listen();

  // 手工建连，绕过客户端封装
  const socket = net.createConnection({ host: '127.0.0.1', port: info.port });
  try {
    await new Promise((r) => socket.once('connect', r));
    const wsKey = crypto.randomBytes(16).toString('base64');
    socket.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await delay(80);

    // 发送伪造信封（未握手密钥，直接发重放报文）
    const bogus = { v: 1, id: 'x1', seq: 1, kind: 'req', nonce: Buffer.alloc(12).toString('base64'), payload: Buffer.alloc(32).toString('base64') };
    const masked = maskClientFrame(JSON.stringify(bogus));
    socket.write(masked);
    await delay(120);

    // 服务端不应崩溃，且后续连接仍可用
    const probe = new GatewayClient({ port: info.port });
    await probe.connect();
    const login = await probe.login('admin', 'admin12345');
    assert.equal(login.ok, true);
    probe.close();
  } finally {
    socket.destroy();
    await ws.close();
    await app.stop();
  }
});

/** 构造带掩码的客户端文本帧（测试用） */
function maskClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | payload.length;
  return Buffer.concat([header, mask, masked]);
}

test('ws: 帧编解码往返', () => {
  const frame = encodeText('hello');
  assert.equal(frame[0] & 0x0f, 0x01);
  const masked = maskClientFrame('world');
  const decoded = decodeFrame(masked);
  assert.equal(decoded.payload.toString(), 'world');
});
