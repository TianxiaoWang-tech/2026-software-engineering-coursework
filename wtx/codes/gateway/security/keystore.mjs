/**
 * gateway/security/keystore.mjs
 * 密钥层（FR-7.5）。
 *
 * 设计：KEK / DEK 双层。
 *   - DEK（数据密钥）用于加密业务载荷，随机生成，可轮换；
 *   - KEK（密钥加密密钥）由设备侧口令经 scrypt 派生，只用于包裹 DEK；
 *   - 落盘文件里只有被 KEK 包裹的 DEK，没有明文密钥。
 *
 * 在 HarmonyOS 上，本类由 HUKS 实现替换：
 *   密钥生成/使用在安全区内完成，应用只能拿到密文与句柄。
 * 参考实现保留了同样的边界——对外只暴露 seal/open/rotate，
 * 没有任何方法能取走密钥原文。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seal, open, fingerprint, deriveKey } from './crypto.mjs';

const WRAP_ALGO = 'aes-256-gcm';
const SCRYPT_N = 16384;

export class FileKeyStore {
  /**
   * @param {{file: string, passphrase: string, logger?: any}} opts
   */
  constructor({ file, passphrase, logger = null }) {
    if (!passphrase || passphrase.length < 8) throw new Error('keystore passphrase must be at least 8 chars');
    this.file = file;
    this.passphrase = passphrase;
    this.logger = logger;
    /** @type {{version:number, keys:Array<{v:number, wrapped:string, nonce:string, salt:string, createdAt:number}>, active:number}|null} */
    this.blob = null;
    /** 已解包的 DEK 缓存：v -> Buffer（仅内存） */
    this.dekCache = new Map();
  }

  init() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.blob = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 快速失败：口令错误或文件损坏时不等到首次解密才暴露
      try {
        this.dekOf(this.blob.active);
      } catch (err) {
        throw new Error(`密钥库无法解锁（口令错误或文件损坏）: ${this.file}`);
      }
      this.logger?.info(`keystore loaded (v${this.blob.active})`);
    } else {
      this.blob = { version: 1, keys: [], active: 1 };
      this.createKeyVersion(1);
      this.persist();
      this.logger?.info('keystore created');
    }
    return this;
  }

  createKeyVersion(v) {
    const dek = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16).toString('base64');
    const kek = crypto.scryptSync(this.passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
    const { nonce, payload } = seal(kek, dek, { raw: true });
    this.blob.keys.push({ v, wrapped: payload, nonce, salt, createdAt: Date.now() });
    this.dekCache.set(v, dek);
  }

  persist() {
    fs.writeFileSync(this.file, JSON.stringify(this.blob, null, 2), { mode: 0o600 });
  }

  /** 取出指定版本的 DEK（仅内存使用，不对外暴露） */
  dekOf(v) {
    if (this.dekCache.has(v)) return this.dekCache.get(v);
    const entry = this.blob.keys.find((k) => k.v === v);
    if (!entry) throw new Error(`unknown key version ${v}`);
    const kek = crypto.scryptSync(this.passphrase, entry.salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
    const dek = open(kek, { nonce: entry.nonce, payload: entry.wrapped }, { raw: true });
    this.dekCache.set(v, dek);
    return dek;
  }

  get activeVersion() {
    return this.blob.active;
  }

  /** 当前服务端密钥指纹（system.hello 用） */
  get fingerprint() {
    return fingerprint(this.dekOf(this.blob.active));
  }

  /** 用当前 DEK 加密业务载荷；v 一并返回，便于轮换后解密旧数据 */
  seal(obj, { aad = '' } = {}) {
    const v = this.blob.active;
    return { v, ...seal(this.dekOf(v), obj, { aad }) };
  }

  /** 解密：按报文里的 v 找对应 DEK，支持旧版本数据 */
  open({ v, nonce, payload }, { aad = '' } = {}) {
    return open(this.dekOf(v ?? this.blob.active), { nonce, payload }, { aad });
  }

  /**
   * 轮换：生成 v+1 并设为 active。
   * 旧版本数据仍可用旧 DEK 解密（保留历史），但新数据一律用新密钥。
   */
  rotate() {
    const next = this.blob.active + 1;
    this.createKeyVersion(next);
    this.blob.active = next;
    this.persist();
    this.logger?.info(`keystore rotated to v${next}`);
    return next;
  }

  /** 会话子密钥：同一 DEK 派生不同用途，避免密钥复用 */
  subKey(info) {
    return deriveKey(this.dekOf(this.blob.active), info);
  }
}

export { WRAP_ALGO };
