/**
 * gateway/security/x25519.mjs
 * X25519 密钥协商封装。
 *
 * 选 X25519 而不是 P-256 的原因：
 *   1. 公钥是 32 字节原始值，无需 DER/ASN.1 解析；
 *   2. HarmonyOS cryptoFramework 的 X25519 直接产出原始公钥，
 *      双端（ArkTS / Node）表示完全一致，减少一层格式转换的出错面。
 *
 * Node 的 crypto.createECDH 不支持 x25519，需使用 generateKeyPairSync
 * + diffieHellman(KeyObject)，故在此封装。
 */

import crypto from 'node:crypto';

const CURVE = 'x25519';

/** 生成一次性密钥对；公钥为 32 字节原始值 */
export function generateX25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(CURVE);
  return { publicKeyRaw: rawPublicKey(publicKey), privateKey };
}

/** 从 KeyObject 取出 32 字节原始公钥（JWK 的 x 字段） */
export function rawPublicKey(publicKeyObject) {
  const jwk = publicKeyObject.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

/** 由 32 字节原始公钥还原为 KeyObject */
export function publicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new Error(`X25519 公钥必须是 32 字节，收到 ${raw.length}`);
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

/** 计算共享密钥（32 字节） */
export function deriveX25519Secret(privateKey, peerPublicKeyRaw) {
  return crypto.diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublicKeyRaw) });
}

/** HKDF 派生会话密钥 */
export function deriveSessionKey(secret, salt, info = 'gw-session-v1') {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(info, 'utf8'), 32));
}
