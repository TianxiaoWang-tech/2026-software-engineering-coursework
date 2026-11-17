/**
 * simulators/run.mjs
 * 独立运行设备仿真器（配合 `npm start` 的网关联调）。
 *
 * 用法：
 *   node simulators/run.mjs --port 1883
 * 依赖一个可用的 MQTT Broker（可用 `node gateway/main.mjs --broker` 自带）。
 */

import { DeviceSimulator, demoDevices } from './devices.mjs';
import { createLogger } from '../gateway/core/log.mjs';

const args = { host: '127.0.0.1', port: 1883 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--host') args.host = argv[++i];
  else if (argv[i] === '--port') args.port = Number(argv[++i]);
  else if (argv[i] === '--help') {
    console.log('用法: node simulators/run.mjs [--host 127.0.0.1] [--port 1883]');
    process.exit(0);
  }
}

const logger = createLogger({ level: 'info', scope: 'sim' });
const sim = new DeviceSimulator({ host: args.host, port: args.port, devices: demoDevices(), logger });

await sim.start();
console.log(`\n设备仿真器已启动：${[...sim.devices.keys()].join(', ')}`);
console.log(`Broker: mqtt://${args.host}:${args.port}\n`);

const shutdown = async () => {
  await sim.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
