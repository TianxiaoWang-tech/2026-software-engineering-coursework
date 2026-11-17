# HAP 构建指南（DevEco / hvigor 实测记录）

**文档编号：** BLD-HOME-OH-001
**版本：** V1.0
**日期：** 2026-11-10
**适用：** DevEco Studio 26.0（SDK API 26 / HarmonyOS 26.0.0）

> 本文记录在本机**实测得出**的构建结论，不是官方文档的复述。每一个坑都对应一条真实报错。

---

## 1. 环境事实

| 项 | 路径 / 版本 |
|---|---|
| DevEco 安装目录 | `D:\Huawei\DevEco Studio` |
| 用户配置目录 | `C:\Users\<用户>\AppData\Local\Huawei\DevEcoStudio26.0` |
| SDK | `D:\Huawei\DevEco Studio\sdk\default`（openharmony + hms，约 3.8 GB） |
| SDK 版本 | apiVersion **26**，platformVersion **26.0.0**，version 26.0.0.105 |
| hvigor | `D:\Huawei\DevEco Studio\tools\hvigor`（6.26.8） |
| ohpm | `D:\Huawei\DevEco Studio\tools\ohpm\bin\ohpm.bat` |
| hdc | `D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe` |
| 内置 node | `D:\Huawei\DevEco Studio\tools\node\node.exe` |
| 模拟器 | `D:\Huawei\DevEco Studio\tools\emulator\Emulator.exe`（**系统镜像未下载**，`%LOCALAPPDATA%\Huawei\Emulator\deployed` 为空） |

---

## 2. 三个必须先知道的坑

### 坑 1：工程路径不能含中文（致命）

```
ERROR 00306003 Specification Limit Violation
Invalid project path. Current path does not match: D:\...\05软件工程\进展\进展1\mobile
```

hvigor 只接受字母、数字、`-` `_` `.` 空格和 `@`。

**结论：** 本项目仓库路径含中文，**必须把 `mobile/` 同步到 ASCII 路径再编译**，例如 `D:\homecontrol\mobile`。
产物再拷回仓库。这不影响仓库结构，但影响所有构建命令。

### 坑 2：命令行方式下缺 `@ohos/hvigor-ohos-plugin`

DevEco 是"全家桶"模式，插件不随工程走。直接用 `node .../hvigor.js` 会报 `MODULE_NOT_FOUND`。

**解法：** 建一个 shim 目录，把两个包挂/拷进去，然后用 `NODE_PATH` 指过去：

```
<hb>\shim\node_modules\@ohos\hvigor                → DevEco\tools\hvigor\hvigor
<hb>\shim\node_modules\@ohos\hvigor-ohos-plugin    → DevEco\tools\hvigor\hvigor-ohos-plugin
```

优先用 `mklink /J`（目录联接，秒完成）；若受限则复制（合计约 225 MB）。

**必须从 shim 里的 hvigor 启动**，否则会出现双实例，报
`00302013: The root node is not yet available for build`。

### 坑 3：沙箱会拦截工具链的子进程

```
Error Code: 00308018 Unknown Error
spawnSync C:\WINDOWS\system32\cmd.exe EPERM
```

hvigor 构建链路要 `spawn cmd.exe`。在受限沙箱里会被拒绝，**必须用完全访问权限**执行构建。

---

## 3. 标准构建流程

```powershell
# 1) 以完全访问权限运行（需要 cmd.exe 子进程）
pwsh -File scripts/build-hap.ps1 -BuildDir D:\homecontrol

# 2) 脚本做四件事：
#    a. 把 mobile/ 同步到 ASCII 路径
#    b. 建 shim（联接优先，失败则复制）
#    c. 设置 NODE_PATH / DEVECO_SDK_HOME / PATH
#    d. 执行 hvigor assembleHap，产物拷回 build-output/
```

核心命令等价于：

```powershell
$env:NODE_PATH   = "<hb>\shim\node_modules"
$env:DEVECO_SDK_HOME = "D:\Huawei\DevEco Studio\sdk\default"
$env:NODE_HOME   = "D:\Huawei\DevEco Studio\tools\node"
$env:PATH = "D:\Huawei\DevEco Studio\tools\node;D:\Huawei\DevEco Studio\tools\ohpm\bin;" +
            "D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains;" + $env:PATH

node "<hb>\shim\node_modules\@ohos\hvigor\bin\hvigor.js" --no-daemon assembleHap
```

---

## 4. 已破解：SDK 版本号与 SDK 路径（2026-11-10 实测）

**结论（可用配置）：**

```json5
products: [{
  "name": "default",
  "compatibleSdkVersion": "26.0.0",   // 注意：API 26+ 不带括号
  "targetSdkVersion": "26.0.0",
  "runtimeOS": "HarmonyOS"
}]
```

```powershell
$env:DEVECO_SDK_HOME = "D:\Huawei\DevEco Studio\sdk"   # 父目录！不是 sdk\default
```

两个关键点：

1. **API 26 及以上版本串不带括号**。hvigor 的提示原文：
   > For API version 26 and later, the value of compatibleSdkVersion/targetSdkVersion must be a string (for example, '26.0.0').

2. **`DEVECO_SDK_HOME` 要指向 `sdk` 父目录**。指向 `sdk\default` 会在 `PreBuild` 之后报
   `00303312 Cannot find the corresponding SDK version ... SDK path: .../sdk/default`。

改成上面两项后，构建从"校验失败"变成**真正执行 26 个任务**（PreBuild → CompileResource → CompileArkTS → …）。

### 4.1 顺带确认的两件事

| 目标 | 结果 |
|---|---|
| `runtimeOS: OpenHarmony` | ❌ 需要独立的 OpenHarmony SDK，本机只有 HarmonyOS 一体包，报 `The SDK management mode has changed` |
| 模拟器实际系统 | `OpenHarmony-7.0.0.105` / `const.ohos.apiversion = 26`（与 SDK API 26 对齐） |

### 4.2 剩余工作：ArkTS 严格模式移植

`CompileArkTS` 提出了 36 类、约 40 处诊断，主要是 ArkTS 相对 TypeScript 的额外限制：

| 规则 | 触发点 | 处理 |
|---|---|---|
| `arkts-no-untyped-obj-literals` | `Record<string, X> = {a:1}`、参数传裸字面量 | 改用 `Map` 或显式 `interface` |
| `arkts-no-obj-literals-as-types` | `type X = { ... }` | 改 `interface` |
| `arkts-no-any-unknown` | `JSON.parse(...) as Record<...>`、`as unknown as` | 显式接口 + 直接断言 |
| `arkts-no-structural-typing` | 结构相同的两个接口互相赋值 | 显式声明同一接口 |
| `arkts-no-standalone-this` | 独立函数里用 `this` | 改成类方法 |
| `arkts-no-implicit-return-types` | 箭头函数返回值推断 | 补返回类型 |

已修复并验证推进到下一轮：`DataBlob` 包装（`getEncodedDer`/`GcmParamsSpec` 字段都要 `{data: ...}`）、`Base64Helper` 需实例化、`Slider` 无 `onEnd`（用 `onChange(value, mode)`）、`webSocket.on('message')` 回调形态、`TextEncoder` 来自 `@kit.ArkTS`。

---

## 5. 模拟器使用（需 GUI + 账号）

| 步骤 | 位置 | 说明 |
|---|---|---|
| 1. 下载系统镜像 | Device Manager → Local Emulator | 需登录华为账号；镜像存于 `%LOCALAPPDATA%\Huawei\Emulator` |
| 2. 创建虚拟设备 | 同上，选 Phone + API 版本 | 会生成 AVD 配置 |
| 3. 启动 | 同上或 `Emulator.exe` | 首次启动较慢 |
| 4. 自动签名 | File → Project Structure → Signing Configs → Automatically generate signature | **需要登录账号**，否则 HAP 装不上 |
| 5. 安装 | `hdc install <路径>.hap` | 用完整路径的 hdc.exe |
| 6. 查看设备 | `hdc list targets` | 空列表表示没有可用设备/模拟器未启动 |
| 7. 拉起应用 | `hdc shell aa start -a EntryAbility -b com.example.homecontrol` | bundleName 见 AppScope/app.json5 |

---

## 6. 已验证的 ArkTS API（按 API 26 d.ts 静态核对）

| 用法 | 结论 |
|---|---|
| `cryptoFramework.createAsyKeyGenerator('X25519')` | ✅ 支持（ECDH/X25519/DH） |
| `AsyKeyGenerator.convertKey(pubKey, priKey)` | ⚠️ **参数顺序是公钥在前**，只转私钥时第一个传 null（已修） |
| `Kdf.generateSecret(params: KdfSpec)` | ⚠️ **只有一个参数**，共享密钥放 `HKDFSpec.key`（已修） |
| `HKDFSpec { algName, key, salt, info, keySize }` | ✅ 字段齐全 |
| `KeyAgreement.generateSecret(priKey, pubKey)` | ✅ |
| `webSocket.on('message', AsyncCallback<string｜ArrayBuffer>)` | ⚠️ 回调是 `(err, data)`，不是 `MessageEvent`（已修） |
| `Base64Helper.encodeToStringSync / decodeSync` | ✅ |
| `util.TextEncoder / TextDecoder` | ✅ |

> 这三处修正是通过静态核对发现的，说明"未编译"的代码确实存在 API 偏差——这也是必须上真机验证的理由。

---

## 7. 排查速查

| 报错 | 含义 | 处理 |
|---|---|---|
| 00306003 | 路径不合法 | 换 ASCII 路径 |
| 00302013 | hvigor 双实例 | 从 shim 里的 hvigor 启动 |
| 00308018 + `spawnSync ... EPERM` | 沙箱子进程被拒 | 用完全访问权限 |
| 00303312 | SDK 版本不匹配 | 见第 4 节 |
| 00303313 | compileSdkVersion 与 IDE 不符 | 删掉该字段（HarmonyOS 工程不需要） |
| `MODULE_NOT_FOUND @ohos/hvigor-ohos-plugin` | 插件未挂载 | 见第 2 节坑 2 |

---

## 8. 完整可复现流程（模拟器，2026-11-10 实测通过）

这一节是从"什么都没有"到"模拟器上跑起来"的完整步骤，命令可原样执行。

### 8.1 一次性准备

```powershell
# 1) 代码同步到纯 ASCII 路径（hvigor 拒绝中文路径）
powershell -ExecutionPolicy Bypass -File scripts/sync-build.ps1     # 默认同步到 C:\hcb\mobile

# 2) DevEco 里开自动签名（需要登录华为账号）
#    File → Project Structure → Signing Configs → ☑ Automatically generate signature
#    生成的签名串存进 mobile/signing.local.json5（已 gitignore，不入库），
#    sync-build.ps1 每次同步后会自动注入到目标工程的 build-profile.json5

# 3) 确认模拟器在线
hdc list targets        # 期望输出 127.0.0.1:5555
```

### 8.2 构建

```powershell
$root = 'C:\hcb'
$env:NODE_PATH      = "$root\shim\node_modules"
$env:DEVECO_SDK_HOME = 'D:\Huawei\DevEco Studio\sdk'   # 注意是 sdk 根目录，不是 sdk\default
Set-Location "$root\mobile"
node "$root\shim\node_modules\@ohos\hvigor\bin\hvigor.js" --no-daemon assembleHap
```

产物：`entry\build\default\outputs\default\entry-default-signed.hap`（约 244 KB）

### 8.3 部署与演示

```powershell
# 网关必须监听 0.0.0.0，否则模拟器连不上
node gateway/main.mjs --host 0.0.0.0

# 另开一个窗口：安装 + 登录（网关地址自动填 10.0.2.2）
powershell -ExecutionPolicy Bypass -File scripts/emu.ps1

# 四中心巡演并截图（答辩视频素材）
powershell -ExecutionPolicy Bypass -File scripts/emu-tour.ps1
```

### 8.4 本阶段新增的三个坑（都有真实报错）

| 现象 | 根因 | 处理 |
|---|---|---|
| 构建成功但 `WARN: No signingConfig found for product default` | `app.signingConfigs` 有了，`products[]` 没引用 | 给 `products[0]` 加 `"signingConfig": "default"` |
| ArkTS 报 `getEncodedDer fail`，登录卡在"密钥协商完成" | `Key.getEncodedDer()` 只支持 EC/RSA/ML-DSA/ML-KEM，**不支持 X25519** | 改用 `getAsyKeySpec(X25519_PK_BN/SK_BN)` + `createAsyKeyGeneratorBySpec` 直接处理 32 字节标量 |
| 网关 `unable to authenticate data` | bigint ↔ 字节串按大端转换，而 RFC 7748 的 X25519 公钥是小端 | 转换函数改小端 |
| `uitest uiInput click` 点 `Toggle`/`Slider` 没反应 | 合成 click 不产生 `onChange` | 改用 `uitest uiInput swipe x y x y 80`（0 距离滑动，产生真实 down→up） |

