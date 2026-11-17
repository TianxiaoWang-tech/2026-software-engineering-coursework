/**
 * gateway/security/crypto.mjs
 * 三层加密中"数据层"与"密钥层"的基础原语。
 *
 * 传输层（TLS）由 ws 服务负责；本文件负责：
 *   - 业务载荷的 AEAD 加解密（AES-256-GCM，含 nonce 与 AAD 防重放）
 *   - 口令加盐哈希（scrypt）
 *   - 密钥派生（HKDF）与指纹
 */

import crypto from 'node:crypto';

export const AEAD_ALGO = 'aes-256-gcm';
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

/** 口令加盐哈希：scrypt，返回可直接入库的字符串与盐 */
export function hashPassword(password, { salt = crypto.randomBytes(16).toString('base64'), cost = 16384 } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('password required');
  const hash = crypto.scryptSync(password, salt, 32, { N: cost, r: 8, p: 1 }).toString('base64');
  return { hash, salt, algo: 'scrypt', cost };
}

/** 恒定时间比较，避免时序侧信道 */
export function verifyPassword(password, stored) {
  const { hash, salt, cost = 16384 } = stored;
  const candidate = crypto.scryptSync(password, salt, 32, { N: cost, r: 8, p: 1 }).toString('base64');
  const a = Buffer.from(candidate, 'base64');
  const b = Buffer.from(hash, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * AEAD 加密：返回 nonce 与密文（base64）。
 * AAD 绑定外部上下文（会话 ID + 序号），使密文无法被搬到别处复用。
 * 传入 Buffer 时按二进制处理（密钥包裹用），对象则序列化为 JSON。
 */
export function seal(key, plaintextObject, { aad = '' } = {}) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(AEAD_ALGO, key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.isBuffer(plaintextObject)
    ? plaintextObject
    : Buffer.from(JSON.stringify(plaintextObject), 'utf8');
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64'),
    // 密文与认证标签拼接，避免额外字段
    payload: Buffer.concat([enc, tag]).toString('base64'),
  };
}

/** AEAD 解密：任何篡改/错配都会抛错（调用方转成 REPLAY / BAD_PARAMS） */
export function open(key, { nonce, payload }, { aad = '', raw = false } = {}) {
  const rawBuf = Buffer.from(payload, 'base64');
  if (rawBuf.length <= 16) throw new Error('ciphertext too short');
  const tag = rawBuf.subarray(rawBuf.length - 16);
  const enc = rawBuf.subarray(0, rawBuf.length - 16);
  const decipher = crypto.createDecipheriv(AEAD_ALGO, key, Buffer.from(nonce, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return raw ? out : JSON.parse(out.toString('utf8'));
}

/** HKDF 派生：把一把主密钥派生成多个用途的子密钥 */
export function deriveKey(masterKey, info, { length = KEY_BYTES } = {}) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), length));
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 密钥指纹：用于 system.hello 让客户端校验服务端身份（密钥层保护的一环） */
export function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function randomId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}
