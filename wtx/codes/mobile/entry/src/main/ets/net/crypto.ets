/**
 * mobile/entry/src/main/ets/net/crypto.ets
 * 客户端加密原语：X25519 协商 + HKDF 派生 + AES-256-GCM 信封。
 *
 * 实测踩坑（API 26 / OpenHarmony 7.0 模拟器）：
 *   - Key.getEncodedDer(format) 只支持 EC / RSA / ML-DSA / ML-KEM，**对 X25519 会报
 *     "getEncodedDer fail"**。因此 X25519 不能走 DER 编解码，必须用 AsyKeySpec
 *     直接读写 32 字节原始标量（getAsyKeySpec / createAsyKeyGeneratorBySpec）。
 *   - Base64Helper 是类，必须实例化后调用。
 *   - GcmParamsSpec 的 iv/aad/authTag 是 DataBlob（{ data: Uint8Array }）。
 */

import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

const BASE64: util.Base64Helper = new util.Base64Helper();
const TEXT_ENCODER: util.TextEncoder = new util.TextEncoder();

const BYTE_MASK: bigint = BigInt(0xff);
const BYTE_BITS: bigint = BigInt(8);
const ZERO: bigint = BigInt(0);

/** X25519 标量与公钥的字节长度 */
const X25519_LEN: number = 32;

export function base64ToBytes(b64: string): Uint8Array {
  return BASE64.decodeSync(b64);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return BASE64.encodeToStringSync(bytes);
}

/**
 * bigint -> 32 字节原始值（**小端**）。
 * RFC 7748：X25519 的 u 坐标按小端序列化；JWK 的 x 字段就是这串原始字节。
 * 早期版本按大端编码，网关侧 GCM 校验直接失败（unable to authenticate data）。
 */
function bigintToRaw(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x: bigint = v;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & BYTE_MASK);
    x = x >> BYTE_BITS;
  }
  return out;
}

/** 32 字节原始值（小端）-> bigint */
function rawToBigint(b: Uint8Array): bigint {
  let v: bigint = ZERO;
  for (let i = b.length - 1; i >= 0; i--) {
    v = (v << BYTE_BITS) | BigInt(b[i]);
  }
  return v;
}

export interface ClientKeyPair {
  /** 32 字节原始公钥，直接以 base64 发给网关 */
  pubRaw: Uint8Array;
  /** 私有标量，仅留在内存，不出现在报文中 */
  sk: bigint;
}

/** 生成 X25519 密钥对，导出"32 字节原始公钥" */
export async function generateX25519(): Promise<ClientKeyPair> {
  const gen = cryptoFramework.createAsyKeyGenerator('X25519');
  const keyPair = await gen.generateKeyPair();
  const pk = keyPair.pubKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.X25519_PK_BN) as bigint;
  const sk = keyPair.priKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.X25519_SK_BN) as bigint;
  const pair: ClientKeyPair = { pubRaw: bigintToRaw(pk, X25519_LEN), sk: sk };
  return pair;
}

/**
 * 用本端私有标量与对端 32 字节原始公钥计算共享密钥。
 * 两端都不经过 DER/PEM，直接以标量构造 Key 对象。
 */
export async function deriveSecret(sk: bigint, peerPubRaw: Uint8Array): Promise<Uint8Array> {
  const priSpec: cryptoFramework.X25519PriKeySpec = {
    algName: 'X25519',
    specType: cryptoFramework.AsyKeySpecType.PRIVATE_KEY_SPEC,
    sk: sk,
  };
  const priKey = await cryptoFramework.createAsyKeyGeneratorBySpec(priSpec).generatePriKey();

  const pubSpec: cryptoFramework.X25519PubKeySpec = {
    algName: 'X25519',
    specType: cryptoFramework.AsyKeySpecType.PUBLIC_KEY_SPEC,
    pk: rawToBigint(peerPubRaw),
  };
  const peerPub = await cryptoFramework.createAsyKeyGeneratorBySpec(pubSpec).generatePubKey();

  const agreement = cryptoFramework.createKeyAgreement('X25519');
  const secretBlob = await agreement.generateSecret(priKey, peerPub);
  return secretBlob.data;
}

/** HKDF-SHA256 派生 32 字节会话密钥（与网关 deriveSessionKey 对齐） */
export async function deriveSessionKey(secret: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const kdf = cryptoFramework.createKdf('HKDF|SHA256|EXTRACT_AND_EXPAND');
  const spec: cryptoFramework.HKDFSpec = {
    algName: 'HKDF',
    key: secret,
    salt: salt,
    info: TEXT_ENCODER.encodeInto('gw-session-v1'),
    keySize: 32,
  };
  const key = await kdf.generateSecret(spec);
  return key.data;
}

export interface Sealed {
  nonce: Uint8Array;
  payload: Uint8Array;
}

/** AES-256-GCM 加密；AAD 绑定报文 id 与 seq，防重放与搬移 */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  const rand = cryptoFramework.createRandom();
  const nonce = (await rand.generateRandom(12)).data;

  const keyBlob: cryptoFramework.DataBlob = { data: key };
  const symKey = await cryptoFramework.createSymKeyGenerator('AES256').convertKey(keyBlob);
  const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
  const params: cryptoFramework.GcmParamsSpec = {
    algName: 'GcmParamsSpec',
    iv: { data: nonce },
    aad: { data: aad },
    authTag: { data: new Uint8Array(16) },
  };
  await cipher.init(cryptoFramework.CryptoMode.ENCRYPT_MODE, symKey, params);
  const out = await cipher.doFinal({ data: plaintext });

  // 密文 || GCM tag(16B)，与网关实现保持一致
  return { nonce: nonce, payload: out.data };
}

/** 解密；任何篡改都会抛错 */
export async function open(key: Uint8Array, sealed: Sealed, aad: Uint8Array): Promise<Uint8Array> {
  const payload = sealed.payload;
  const cipherText = payload.slice(0, payload.length - 16);
  const tag = payload.slice(payload.length - 16);

  const keyBlob: cryptoFramework.DataBlob = { data: key };
  const symKey = await cryptoFramework.createSymKeyGenerator('AES256').convertKey(keyBlob);
  const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
  const params: cryptoFramework.GcmParamsSpec = {
    algName: 'GcmParamsSpec',
    iv: { data: sealed.nonce },
    aad: { data: aad },
    authTag: { data: tag },
  };
  await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE, symKey, params);
  const out = await cipher.doFinal({ data: cipherText });
  return out.data;
}
