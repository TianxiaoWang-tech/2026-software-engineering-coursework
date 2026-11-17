---
id: C-20261101-01
owner: C
date: 2026-11-01
requirement: [FR-6.3, FR-7.4]
module: mobile/entry/src/main/ets/net/
model: deepseek
round: 1
status: modified
---

## 意图
实现 HarmonyOS 客户端：WebSocket 连接 + X25519 协商 + AES-GCM 信封，与网关侧协议完全对称。

## 上下文（粘贴给 AI 的契约片段）
```text
握手：C→S {type:'hello', pubKey} / S→C {type:'hello_ack', pubKey, salt, fingerprint}
信封：{v:1, id, seq, kind, nonce, payload}，AAD = `${id}:${seq}`
密钥：HKDF-SHA256(sharedSecret, salt, 'gw-session-v1') → 32B
公钥格式：X25519 原始 32 字节（非 DER）
```

## 提示词原文
```text
【角色】你是 HarmonyOS（API 12）客户端开发者。
【约束】只用 @kit.CryptoArchitectureKit 与 @kit.NetworkKit；不得引入第三方库；
        必须与给定的握手与信封格式逐字节兼容；解密失败要静默丢弃而不是崩溃。
【任务】实现 GatewayClient.ets：connect/request/login/close，以及推送 onEvent 回调。
        crypto.ets 里实现 X25519 生成与协商、HKDF、AES-256-GCM 加解密。
【输出】只给两个文件的完整内容。
```

## 输出与人工修改
- **采纳**：webSocket 生命周期写法、信封序列化结构、`onEvent` 推送分发
- **修改**：AI 用了 `createECDH`（不存在于 ArkTS）→ 改为 `createAsyKeyGenerator('X25519')` + `KeyAgreement`
- **修改**：AI 直接使用 `getEncodedDer()` 的返回值当公钥 → 网关侧只认 32 字节原始值，
  改为剥离 X25519 SPKI 固定前缀（12 字节），并在代码中标注 `[需验证]`
- **人工补充**：解密异常必须静默丢弃（否则一个坏包会让页面崩溃）；超时统一 8s

## 证据
- 文件：mobile/entry/src/main/ets/net/GatewayClient.ets、net/crypto.ets
- 对端协议由 `tests/api.test.mjs`("ws: 握手 + 加密请求 + 业务调用") 在同构实现上验证
- **未验证项**：ArkTS 文件未在真机编译（缺 SDK/设备），已在文件头列出三个待确认点
