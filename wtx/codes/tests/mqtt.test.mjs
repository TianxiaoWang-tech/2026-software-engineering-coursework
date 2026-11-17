/**
 * tests/mqtt.test.mjs
 * MQTT 协议栈（自研 broker + client）测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MqttBroker } from '../gateway/drivers/mqtt/broker.mjs';
import { MqttClient } from '../gateway/drivers/mqtt/client.mjs';
import { topicMatches, encodeLength, PacketParser, buildPublish } from '../gateway/drivers/mqtt/packet.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBroker(fn) {
  const broker = new MqttBroker({ port: 0 });
  const { port } = await broker.listen();
  try {
    await fn({ broker, port });
  } finally {
    await broker.close();
  }
}

test('packet: 剩余长度编码与通配符匹配', () => {
  assert.deepEqual([...encodeLength(0)], [0]);
  assert.deepEqual([...encodeLength(127)], [127]);
  assert.deepEqual([...encodeLength(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeLength(16383)], [0xff, 0x7f]);

  assert.equal(topicMatches('a/b/c', 'a/b/c'), true);
  assert.equal(topicMatches('a/+/c', 'a/b/c'), true);
  assert.equal(topicMatches('a/+/c', 'a/b/d'), false);
  assert.equal(topicMatches('a/#', 'a/b/c'), true);
  assert.equal(topicMatches('#', 'x/y'), true);
  assert.equal(topicMatches('a/b', 'a/b/c'), false);
});

test('packet: 解析器能处理粘包与半包', () => {
  const parser = new PacketParser();
  const one = buildPublish({ topic: 't/1', payload: 'hello' });
  const two = buildPublish({ topic: 't/2', payload: 'world' });

  // 半包：先给一半，不应解析出结果
  assert.equal(parser.push(one.subarray(0, 3)).length, 0);
  // 补齐第一包 + 第二包（粘包）
  const packets = parser.push(Buffer.concat([one.subarray(3), two]));
  assert.equal(packets.length, 2);
});

test('mqtt: 订阅与发布（通配符 + QoS1）', async () => {
  await withBroker(async ({ port }) => {
    const sub = new MqttClient({ port, clientId: 'sub' });
    const pub = new MqttClient({ port, clientId: 'pub' });
    await sub.connect();
    await pub.connect();

    const received = [];
    sub.on('message', (m) => received.push({ topic: m.topic, payload: m.payload.toString() }));
    await sub.subscribe('home/+/state', 1);

    await pub.publish('home/light1/state', '{"switch":true}', { qos: 1 });
    await delay(80);

    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'home/light1/state');
    assert.equal(received[0].payload, '{"switch":true}');

    sub.end();
    pub.end();
  });
});

test('mqtt: 遗嘱消息在异常断开时发布（FR-1.7 离线检测）', async () => {
  await withBroker(async ({ port }) => {
    const watcher = new MqttClient({ port, clientId: 'watcher' });
    await watcher.connect();
    const wills = [];
    watcher.on('message', (m) => wills.push(m.payload.toString()));
    await watcher.subscribe('home/dev1/availability', 1);

    const device = new MqttClient({
      port,
      clientId: 'dev1',
      will: { topic: 'home/dev1/availability', payload: 'offline', qos: 1, retain: false },
    });
    await device.connect();
    await device.publish('home/dev1/availability', 'online', { qos: 1 });
    await delay(60);
    assert.deepEqual(wills, ['online']);

    device.destroy(); // 模拟掉线
    await delay(120);
    assert.deepEqual(wills, ['online', 'offline']);

    watcher.end();
  });
});

test('mqtt: 正常断开不触发遗嘱', async () => {
  await withBroker(async ({ port }) => {
    const watcher = new MqttClient({ port, clientId: 'w2' });
    await watcher.connect();
    const msgs = [];
    watcher.on('message', (m) => msgs.push(m.payload.toString()));
    await watcher.subscribe('x/availability', 1);

    const dev = new MqttClient({
      port,
      clientId: 'd2',
      will: { topic: 'x/availability', payload: 'offline', qos: 0 },
    });
    await dev.connect();
    dev.end();
    await delay(120);

    assert.deepEqual(msgs, []);
    watcher.end();
  });
});

test('mqtt: 保留消息在订阅时补发', async () => {
  await withBroker(async ({ port }) => {
    const pub = new MqttClient({ port, clientId: 'p3' });
    await pub.connect();
    await pub.publish('home/discovery', '{"id":"dev9"}', { qos: 1, retain: true });
    await delay(50);

    const late = new MqttClient({ port, clientId: 'late' });
    await late.connect();
    const got = [];
    late.on('message', (m) => got.push(m.payload.toString()));
    await late.subscribe('home/discovery', 1);
    await delay(80);

    assert.deepEqual(got, ['{"id":"dev9"}']);
    late.end();
    pub.end();
  });
});
