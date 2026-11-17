---
id: B-20261101-01
owner: B
date: 2026-11-01
requirement: [FR-3.3, FR-3.4, FR-3.5]
module: gateway/adapters/
model: deepseek
round: 1
status: adopted
---

## 意图
实现格力/美的/海尔三个品牌适配器，证明"统一能力 → 品牌码值"的映射可以让上层零改动。

## 上下文（粘贴给 AI 的契约片段）
```ts
// contracts/ac-adapter.d.ts（节选）
export interface AcCapabilityProfile {
  brand: string; transport: AcTransportKind;
  modes: Array<'cool'|'heat'|'fan'|'dry'|'auto'>;
  fanSpeeds: Array<'auto'|'low'|'medium'|'high'>;
  swing: boolean; minTemp: number; maxTemp: number; tempStep: number;
}
export interface AcAdapter { brand: string; profile(deviceId): AcCapabilityProfile; set(deviceId, cmd): Promise<AcResult>; }
```

## 提示词原文
```text
【角色】你是业务模块开发者。
【约束】只能新增 gateway/adapters/ac-<brand>/adapter.mjs 与注册一行；
        必须继承 BaseAcAdapter，只实现 profileDef 与 encode()；
        不得修改 domains/climate 与界面代码；不得引入品牌判断分支到上层。
【任务】按以下能力子集实现三个品牌：
        格力: modes=cool/heat/dry/fan, fan=auto/low/medium/high, swing=true, 16–30℃
        美的: modes=cool/heat/dry,     fan=auto/low/high,        swing=true, 17–30℃
        海尔: modes=cool/heat/fan,     fan=auto/low/medium,      swing=false, 16–30℃
        encode() 返回可读的厂商码值字符串，便于演示与排查。
【输出】三个文件 + 注册代码 3 行。
```

## 输出与人工修改
- **采纳**：三份 `profileDef` 与 `encode()` 码表结构（`GREE:MODE:0x01` 这类可读格式便于现场讲解）
- **修改**：AI 在 `ClimateService` 里加了 `if (brand === 'haier')` 特判 → 删除，改由 `profile.modes` 驱动校验与置灰（FR-3.5 的核心）
- **补充人工设计**：把"品牌不支持"统一成 `AppError(code=UNSUPPORTED)`，让界面拿到可区分的失败原因（FR-3.3）

## 证据
- 文件：gateway/adapters/ac-gree/adapter.mjs、ac-midea/adapter.mjs、ac-haier/adapter.mjs
- 测试：`tests/app.test.mjs` → "三品牌独立控制，码值映射正确"、"不支持的能力按品牌拒绝"
- 实测：`GREE:MODE:0x01` / `MIDEA:MODE:0x02` / `HAIER:MODE:0x12`
