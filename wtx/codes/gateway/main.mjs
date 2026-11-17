#!/usr/bin/env node
/**
 * gateway/main.mjs
 * 网关进程入口。
 *
 * 用法：
 *   node gateway/main.mjs                       # 仿真设备 + WS 服务（默认 8765）
 *   node gateway/main.mjs --broker --mqtt       # 同时启动内置 MQTT Broker 与 MQTT 驱动
 *   node gateway/main.mjs --port 9000 --log debug
 */

import { GatewayApp } from './app.mjs';
import { ApiService } from './services/api.mjs';
import { GatewayWsServer } from './services/ws.mjs';
import { MqttBroker } from './drivers/mqtt/broker.mjs';
import { createLogger } from './core/log.mjs';

function parseArgs(argv) {
  const args = { port: 8765, host: '127.0.0.1', broker: false, brokerPort: 1883, mqtt: false, log: 'info' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--host':
        args.host = argv[++i];
        break;
      case '--broker':
        args.broker = true;
        break;
      case '--broker-port':
        args.brokerPort = Number(argv[++i]);
        break;
      case '--mqtt':
        args.mqtt = true;
        break;
      case '--log':
        args.log = argv[++i];
        break;
      case '--help':
      case '-h':
        console.log('用法: node gateway/main.mjs [--port 8765] [--mqtt] [--broker] [--broker-port 1883] [--log info]');
        process.exit(0);
        break;
      default:
        break;
    }
  }
  if (args.broker) args.mqtt = true;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ level: args.log, scope: 'main' });

  let broker = null;
  if (args.broker) {
    broker = new MqttBroker({ port: args.brokerPort, logger: logger.child('broker') });
    const info = await broker.listen();
    logger.info(`built-in MQTT broker on ${info.host}:${info.port}`);
    args.brokerPort = info.port;
  }

  const app = new GatewayApp({
    logger,
    config: {
      logLevel: args.log,
      gatewayId: 'gateway-001',
      mqtt: { enabled: args.mqtt, host: '127.0.0.1', port: args.brokerPort },
      keystore: { file: `${process.cwd()}/.runtime/keys.json`, passphrase: 'home-control-dev' },
    },
  });

  await app.start({ withMqtt: args.mqtt });

  const api = new ApiService({ app });
  const ws = new GatewayWsServer({ api, app, logger: logger.child('ws'), host: args.host, port: args.port });
  const info = await ws.listen();

  console.log('');
  console.log('  家居设备控制系统 · OpenHarmony 网关');
  console.log(`  设备 ${app.registry.listDevices().length} 台 / 区域 ${app.registry.listAreas().length} 个 / 适配器 ${app.adapters.list().length} 个`);
  console.log(`  WebSocket : ws://${info.host}:${info.port}${args.broker ? `  MQTT: ${args.brokerPort}` : ''}`);
  console.log('  账户      : admin/admin12345 · member/member12345 · guest/guest12345');
  console.log('  契约指纹  :', app.keystore?.fingerprint);
  console.log('');

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭…`);
    await ws.close();
    await app.stop();
    await broker?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
