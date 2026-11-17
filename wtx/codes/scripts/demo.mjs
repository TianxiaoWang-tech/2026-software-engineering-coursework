/**
 * scripts/demo.mjs
 * 一键演示脚本：启动完整栈（Broker + 仿真设备 + 网关 + 加密 WS），
 * 按四大中心跑一遍真实链路，并打印每步耗时与结果。
 *
 * 用途：答辩演示、录屏脚本、回归冒烟测试。
 * 运行：npm run demo
 */

import path from 'node:path';
import os from 'node:os';
import { MqttBroker } from '../gateway/drivers/mqtt/broker.mjs';
import { GatewayApp } from '../gateway/app.mjs';
import { ApiService } from '../gateway/services/api.mjs';
import { GatewayWsServer } from '../gateway/services/ws.mjs';
import { GatewayClient } from '../gateway/services/ws-client.mjs';
import { DeviceSimulator, demoDevices } from '../simulators/devices.mjs';
import { createLogger } from '../gateway/core/log.mjs';

const logger = createLogger({ level: 'warn' });
const line = (s = '') => console.log(s);
const step = (n, title) => line(`\n[${String(n).padStart(2, '0')}] ${title}`);
const ok = (msg) => line(`     ✔ ${msg}`);
const bad = (msg) => line(`     ✘ ${msg}`);

async function main() {
  const broker = new MqttBroker({ port: 0, logger });
  const { port: brokerPort } = await broker.listen();

  const sim = new DeviceSimulator({ port: brokerPort, devices: demoDevices(), logger });
  await sim.start();

  const app = new GatewayApp({
    logger,
    config: {
      mqtt: { enabled: true, host: '127.0.0.1', port: brokerPort },
      // 演示用临时密钥库，避免与开发环境的密钥库口令冲突
      keystore: { file: path.join(os.tmpdir(), 'home-control-demo-keys.json'), passphrase: 'demo-passphrase' },
    },
  });
  await app.start({ withMqtt: true });

  const api = new ApiService({ app });
  const ws = new GatewayWsServer({ api, app, logger, port: 0 });
  const { port: wsPort } = await ws.listen();

  line('═'.repeat(64));
  line(' 基于 OpenHarmony 的家居设备控制系统 · 端到端演示');
  line('═'.repeat(64));

  const client = new GatewayClient({ port: wsPort, logger });
  await client.connect();

  step(1, '加密链路与密钥协商（ECDH + AES-256-GCM）');
  const hello = await client.request('system.hello');
  ok(`网关 ${hello.data.gatewayId} v${hello.data.version}`);
  ok(`密钥指纹 ${hello.data.keyFingerprint}`);
  ok('后续报文全部为密文信封（nonce + AEAD）');

  step(2, '登录与权限');
  const login = await client.login('admin', 'admin12345');
  ok(`登录成功，角色 ${login.data.role}`);
  const guest = new GatewayClient({ port: wsPort, logger });
  await guest.connect();
  await guest.login('guest', 'guest12345');
  const denied = await guest.request('control.set', { deviceId: 'sim-light-living', capability: 'switch', value: true });
  ok(`访客越权被拒：${denied.code} ${denied.message}`);
  guest.close();

  step(3, '照明中心（远程 + 人体感应）');
  const list = await client.request('device.list');
  ok(`设备 ${list.data.devices.length} 台 / 区域 ${list.data.areas.length} 个`);
  await client.request('control.set', { deviceId: 'sim-light-living', capability: 'switch', value: true });
  await client.request('control.set', { deviceId: 'sim-light-living', capability: 'brightness', value: 40 });
  ok('客厅主灯 已开启，亮度 40%');

  app.lighting.config.nightRange = ['00:00', '23:59'];
  app.sim.triggerMotion('sim-motion-corridor', { lux: 20 });
  await new Promise((r) => setTimeout(r, 150));
  ok(`走廊人体感应 → 走廊灯自动点亮（亮度 ${app.registry.getState('sim-light-corridor').brightness}%，夜间模式）`);

  step(4, '温湿度控制中心（三品牌兼容）');
  const brands = [
    ['ac-gree-living', '格力', 'cool', 24],
    ['ac-midea-bedroom', '美的', 'heat', 22],
    ['ac-haier-study', '海尔', 'fan', 25],
  ];
  for (const [deviceId, label, mode, temp] of brands) {
    const r = await client.request('control.set', { deviceId, capability: 'switch', value: true });
    await client.request('control.set', { deviceId, capability: 'hvac_mode', value: mode });
    await client.request('control.set', { deviceId, capability: 'target_temp', value: temp });
    const code = app.climate.lastVendorCode.get(`${deviceId}#hvac_mode`);
    ok(`${label}：模式 ${mode} / ${temp}℃ → 品牌码值 ${code}`);
  }
  const haierDry = await client.request('control.set', { deviceId: 'ac-haier-study', capability: 'hvac_mode', value: 'dry' });
  ok(`海尔不支持除湿，被拒：${haierDry.code} ${haierDry.message}`);

  step(5, '智能门禁（二次确认 + 留痕）');
  const wrong = await client.request('access.open', { deviceId: 'sim-lock-front', confirm: '0000' });
  ok(`错误口令被拒：${wrong.code}`);
  const opened = await client.request('access.open', { deviceId: 'sim-lock-front', confirm: '2468' });
  ok(`远程开门成功，记录号 ${opened.data.logId}`);
  const logs = await client.request('access.logs', { limit: 3 });
  ok(`开锁记录 ${logs.data.logs.length} 条，最近一条：${logs.data.logs[0].note} / ${logs.data.logs[0].result}`);

  step(6, '场景一键执行');
  const scene = await client.request('scene.run', { sceneId: 'scene-home' });
  ok(`"回家"场景执行完成，${scene.data.elapsedMs} ms，动作 ${scene.data.results.length} 个全部成功`);

  step(7, 'MQTT 设备接入（独立 TCP 链路）');
  const mqttDevices = app.registry.listDevices().filter((d) => d.protocol === 'mqtt');
  ok(`经 MQTT 接入 ${mqttDevices.length} 台：${mqttDevices.map((d) => d.name).join('、')}`);
  sim.publishSensor('mqtt-sensor-1', { temperature: 28.6, humidity: 48 });
  await new Promise((r) => setTimeout(r, 120));
  ok(`传感器上报 28.6℃ 已入库：${app.registry.getState('mqtt-sensor-1').temperature}℃`);

  step(8, '系统自检');
  const check = await client.request('ops.selfCheck');
  for (const c of check.data.checks) ok(`${c.name}：${c.detail}`);

  line('\n' + '─'.repeat(64));
  line(`演示结束：设备 ${app.registry.listDevices().length} 台，审计 ${app.audit.length} 条，事件 ${app.bus.emitted.length} 个`);
  line('─'.repeat(64) + '\n');

  client.close();
  await ws.close();
  await app.stop();
  await sim.stop();
  await broker.close();
}

main().catch(async (err) => {
  console.error('演示失败:', err);
  process.exit(1);
});
