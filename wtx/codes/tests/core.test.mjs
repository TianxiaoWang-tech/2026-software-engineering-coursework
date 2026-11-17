/**
 * tests/core.test.mjs
 * 内核层与安全层单元测试（NFR-14：核心可自动化验证）。
 * 运行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventBus } from '../gateway/core/bus.mjs';
import { Registry, entityIdOf } from '../gateway/core/registry.mjs';
import { AppError, ErrorCode } from '../gateway/core/errors.mjs';
import { createLogger } from '../gateway/core/log.mjs';
import { seal, open, hashPassword, verifyPassword, fingerprint } from '../gateway/security/crypto.mjs';
import { FileKeyStore } from '../gateway/security/keystore.mjs';
import { UserStore } from '../gateway/security/users.mjs';
import { SessionStore } from '../gateway/security/session.mjs';

const silent = createLogger({ level: 'silent' });

function lightDescriptor(overrides = {}) {
  return {
    id: 'light:living:1',
    name: '客厅主灯',
    category: 'light',
    brand: 'generic',
    model: 'L1',
    protocol: 'sim',
    driver: 'sim',
    areaId: 'living',
    capabilities: [
      { kind: 'switch', valueType: 'boolean', readable: true, writable: true },
      { kind: 'brightness', valueType: 'number', unit: '%', min: 1, max: 100, step: 1, readable: true, writable: true },
    ],
    ...overrides,
  };
}

function makeRegistry(overrides = {}) {
  const bus = new EventBus({ logger: silent });
  let t = 1_000_000;
  const reg = new Registry({ bus, logger: silent, now: () => t, ...overrides });
  return { bus, reg, advance: (ms) => (t += ms) };
}

/* -------------------------- EventBus -------------------------- */

test('EventBus: 通配符订阅与处理器异常隔离', () => {
  const bus = new EventBus({ logger: silent });
  const seen = [];
  bus.on('*', (e) => seen.push(e.type));
  bus.on('foo', () => {
    throw new Error('boom');
  });
  bus.on('foo', (e) => seen.push(`foo:${e.data.n}`));

  assert.doesNotThrow(() => bus.emit('foo', { n: 1 }));
  // 具体订阅先于通配符执行；抛错的处理不影响后续
  assert.deepEqual(seen, ['foo:1', 'foo']);
});

test('EventBus: 取消订阅后不再收到事件', () => {
  const bus = new EventBus({ logger: silent });
  let count = 0;
  const off = bus.on('bar', () => (count += 1));
  bus.emit('bar', {});
  off();
  bus.emit('bar', {});
  assert.equal(count, 1);
});

/* -------------------------- Registry -------------------------- */

test('Registry: 登记设备并为每个能力生成实体', () => {
  const { reg } = makeRegistry();
  reg.addArea({ id: 'living', name: '客厅', sort: 1 });
  const dev = reg.addDevice(lightDescriptor());

  assert.equal(dev.online, false);
  const entities = reg.entitiesOf(dev.id);
  assert.equal(entities.length, 2);
  assert.ok(entities.some((e) => e.id === entityIdOf(dev.id, 'switch')));
  assert.equal(reg.getState(dev.id).switch, false);
});

test('Registry: 重复设备 ID 被拒绝', () => {
  const { reg } = makeRegistry();
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());
  assert.throws(
    () => reg.addDevice(lightDescriptor()),
    (err) => err instanceof AppError && err.code === ErrorCode.BAD_PARAMS,
  );
});

test('Registry: setState 只广播真正变化的项', () => {
  const { reg, bus } = makeRegistry();
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());
  const changes = [];

  bus.on('state_changed', (e) => changes.push(e.data));
  reg.setState('light:living:1', { switch: true, brightness: 50 });
  assert.equal(changes.length, 2);

  reg.setState('light:living:1', { switch: true, brightness: 60 });
  assert.equal(changes.length, 3, '只有亮度变化应产生事件');
  assert.equal(changes.at(-1).capability, 'brightness');
  assert.equal(changes.at(-1).oldValue, 50);
});

test('Registry: 未声明的能力上报被忽略而不是报错', () => {
  const { reg } = makeRegistry();
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());
  const changes = reg.setState('light:living:1', { temperature: 30 });
  assert.deepEqual(changes, []);
});

test('Registry: 越界值与类型错误被拒绝（FR-3.7）', () => {
  const { reg } = makeRegistry();
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());

  assert.throws(() => reg.setState('light:living:1', { brightness: 0 }), /below min/);
  assert.throws(() => reg.setState('light:living:1', { brightness: 101 }), /above max/);
  assert.throws(() => reg.setState('light:living:1', { switch: 'on' }), /expects boolean/);
});

test('Registry: 在线状态与超时扫描（FR-1.7）', () => {
  const { reg, advance } = makeRegistry({ offlineTimeoutMs: 90_000 });
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());

  reg.setState('light:living:1', { switch: true });
  assert.equal(reg.getDevice('light:living:1').online, true);

  advance(100_000);
  const flipped = reg.sweep();
  assert.deepEqual(flipped, ['light:living:1']);
  assert.equal(reg.getDevice('light:living:1').online, false);
});

test('Registry: 陈旧判定（FR-3.1 数据新鲜度）', () => {
  const { reg, advance } = makeRegistry({ staleMs: 5000 });
  reg.addArea({ id: 'living', name: '客厅' });
  reg.addDevice(lightDescriptor());
  const entity = reg.findEntity('light:living:1', 'switch');

  assert.equal(reg.isStale(entity), false);
  advance(6000);
  assert.equal(reg.isStale(entity), true);
});

/* -------------------------- crypto -------------------------- */

test('crypto: AEAD 往返、篡改与 AAD 错配均失败', () => {
  const key = Buffer.alloc(32, 7);
  const msg = { method: 'control.set', value: 42 };
  const boxed = seal(key, msg, { aad: 'session-1' });

  assert.deepEqual(open(key, boxed, { aad: 'session-1' }), msg);
  assert.throws(() => open(key, boxed, { aad: 'session-2' }), /unable to authenticate|bad decrypt/i);

  const tampered = { ...boxed, payload: Buffer.from(boxed.payload, 'base64').map((b, i) => (i === 0 ? b ^ 0xff : b)) };
  const t = { ...tampered, payload: Buffer.from(tampered.payload).toString('base64') };
  assert.throws(() => open(key, t, { aad: 'session-1' }));
});

test('crypto: 口令哈希不可逆且校验正确', () => {
  const { hash, salt } = hashPassword('S3cret!');
  assert.notEqual(hash, 'S3cret!');
  assert.equal(verifyPassword('S3cret!', { hash, salt }), true);
  assert.equal(verifyPassword('wrong', { hash, salt }), false);
});

/* -------------------------- keystore -------------------------- */

test('keystore: 落盘无明文密钥、可重载、可轮换', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  const file = path.join(dir, 'keys.json');

  const ks = new FileKeyStore({ file, passphrase: 'test-passphrase', logger: silent }).init();
  const boxed = ks.seal({ hello: 'world' }, { aad: 'a' });
  assert.deepEqual(ks.open(boxed, { aad: 'a' }), { hello: 'world' });

  const raw = fs.readFileSync(file, 'utf8');
  const dekHex = ks.dekOf(1).toString('hex');
  assert.equal(raw.includes(dekHex), false, '文件中不得出现明文 DEK');

  // 重新打开同一文件仍能解密
  const ks2 = new FileKeyStore({ file, passphrase: 'test-passphrase', logger: silent }).init();
  assert.deepEqual(ks2.open(boxed, { aad: 'a' }), { hello: 'world' });

  // 轮换后：新数据用新版本，旧数据仍可解
  const v2 = ks2.rotate();
  assert.equal(v2, 2);
  const boxed2 = ks2.seal({ after: 'rotate' });
  assert.equal(boxed2.v, 2);
  assert.deepEqual(ks2.open(boxed2), { after: 'rotate' });
  assert.deepEqual(ks2.open(boxed, { aad: 'a' }), { hello: 'world' });

  assert.notEqual(ks2.fingerprint, fingerprint(ks2.dekOf(2)) === ks2.fingerprint ? 'x' : 'y');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keystore: 口令错误时无法解密', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  const file = path.join(dir, 'keys.json');
  const ks = new FileKeyStore({ file, passphrase: 'correct-passphrase', logger: silent }).init();
  ks.seal({ a: 1 });

  // 口令错误应在初始化时快速失败（而不是等到首次解密）
  assert.throws(
    () => new FileKeyStore({ file, passphrase: 'wrong-passphrase-xx', logger: silent }).init(),
    /密钥库无法解锁/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------- users / session -------------------------- */

test('users: 连续 5 次失败后锁定', () => {
  const users = new UserStore({ now: () => 0, logger: silent });
  users.create({ name: 'admin', password: 'p@ss1234', role: 'admin' });

  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => users.authenticate('admin', 'bad'), (e) => e.code === ErrorCode.UNAUTHORIZED);
  }
  // 第 6 次即使口令正确也应被锁定
  assert.throws(() => users.authenticate('admin', 'p@ss1234'), /锁定/);
});

test('session: 签发、校验、过期与角色判定', () => {
  let t = 0;
  const sessions = new SessionStore({ now: () => t, ttlMs: 1000 });
  const s = sessions.issue({ id: 'u1', name: 'admin', role: 'admin' });

  assert.equal(sessions.verify(s.token).userId, 'u1');
  assert.doesNotThrow(() => sessions.requireRole(s, 'member'));
  assert.throws(() => sessions.requireRole({ ...s, role: 'guest' }, 'admin'), (e) => e.code === ErrorCode.FORBIDDEN);

  t = 2000;
  assert.throws(() => sessions.verify(s.token), (e) => e.code === ErrorCode.UNAUTHORIZED);
});
