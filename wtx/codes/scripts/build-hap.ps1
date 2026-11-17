# scripts/build-hap.ps1
# 从命令行构建 HAP：处理 ASCII 路径、插件 shim、SDK 环境变量。
# 详细背景见 docs/08-build-guide.md
#
# 用法（需完全访问权限，因为 hvigor 要 spawn cmd.exe）：
#   pwsh -File scripts\build-hap.ps1 -BuildDir D:\homecontrol
#
# 参数：
#   -BuildDir   纯 ASCII 构建目录（默认 D:\homecontrol）
#   -Version    compatibleSdkVersion 写法（默认 26.0.0(26)，若报 00303312 需换成 IDE 生成的值）
#   -Keep       构建后保留中间产物（默认保留）

param(
  [string]$BuildDir = 'D:\homecontrol',
  # 实测结论：API 26+ 用 '26.0.0'（不能带括号），见 docs/08-build-guide.md
  [string]$Version  = '26.0.0',
  [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'
$repo   = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $repo 'mobile'
$devEco = 'D:\Huawei\DevEco Studio'
$sdk    = Join-Path $devEco 'sdk'          # 注意：指向 sdk 父目录，不是 sdk\default
$sdkDefault = Join-Path $sdk 'default'
$node   = Join-Path $devEco 'tools\node\node.exe'
$shim   = Join-Path $BuildDir 'shim\node_modules'
$proj   = Join-Path $BuildDir 'mobile'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 0. 前置检查
if ($BuildDir -match '[^\x00-\x7F]') {
  throw "构建目录必须是纯 ASCII：$BuildDir"
}
if (-not (Test-Path $devEco)) { throw "未找到 DevEco Studio：$devEco" }
if (-not (Test-Path $node))   { throw "未找到内置 node：$node" }

# 1. 同步工程到 ASCII 路径
if (-not $SkipSync) {
  Write-Step "同步工程到 $proj"
  New-Item -ItemType Directory -Path $proj -Force | Out-Null
  robocopy $mobile $proj /E /XD node_modules .hvigor build oh_modules /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败：$LASTEXITCODE" }
}

# 2. 准备插件 shim（优先联接，失败则复制）
Write-Step "准备 hvigor shim"
New-Item -ItemType Directory -Path (Join-Path $shim '@ohos') -Force | Out-Null
$pairs = @(
  @{ Link = Join-Path $shim '@ohos\hvigor';             Target = Join-Path $devEco 'tools\hvigor\hvigor' },
  @{ Link = Join-Path $shim '@ohos\hvigor-ohos-plugin'; Target = Join-Path $devEco 'tools\hvigor\hvigor-ohos-plugin' }
)
foreach ($p in $pairs) {
  if (Test-Path (Join-Path $p.Link 'package.json')) { continue }
  if (Test-Path $p.Link) { Remove-Item $p.Link -Recurse -Force }
  cmd /c mklink /J "$($p.Link)" "$($p.Target)" 2>$null | Out-Null
  if (-not (Test-Path (Join-Path $p.Link 'package.json'))) {
    Write-Host "    联接失败，改为复制（约 225 MB）…"
    Copy-Item -Recurse -Force $p.Target $p.Link
  }
}

# 3. 写工程配置（版本号是唯一的易变项）
Write-Step "写入 build-profile.json5（compatibleSdkVersion=$Version）"
$profile = @"
{
  "app": {
    "signingConfigs": [],
    "products": [ { "name": "default", "compatibleSdkVersion": "$Version", "targetSdkVersion": "$Version", "runtimeOS": "HarmonyOS" } ],
    "buildModeSet": [ { "name": "debug" }, { "name": "release" } ]
  },
  "modules": [ { "name": "entry", "srcPath": "./entry", "targets": [ { "name": "default", "applyToProducts": ["default"] } ] } ]
}
"@
Set-Content -LiteralPath (Join-Path $proj 'build-profile.json5') -Value $profile -Encoding utf8
Set-Content -LiteralPath (Join-Path $proj 'local.properties') -Value ("sdk.dir=" + $sdk.Replace('\', '/')) -Encoding utf8

# 4. 构建
Write-Step "hvigor assembleHap"
$env:NODE_PATH        = $shim
$env:NODE_HOME        = Join-Path $devEco 'tools\node'
$env:DEVECO_SDK_HOME  = $sdk
$env:PATH = "$env:NODE_HOME;$(Join-Path $devEco 'tools\ohpm\bin');$(Join-Path $sdkDefault 'openharmony\toolchains');$env:PATH"

Push-Location $proj
try {
  $out = & $node (Join-Path $shim '@ohos\hvigor\bin\hvigor.js') --no-daemon assembleHap 2>&1 | Out-String
} finally {
  Pop-Location
}
$clean = $out -replace '\x1b\[[0-9;]*m', ''
($clean -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 12) | ForEach-Object { Write-Host "    $_" }

# 5. 产物回拷
$haps = Get-ChildItem $proj -Recurse -Include '*.hap' -ErrorAction SilentlyContinue
if ($haps.Count -eq 0) {
  Write-Host ""
  Write-Host "未产出 HAP。常见原因：" -ForegroundColor Yellow
  Write-Host "  - 00303312：SDK 版本写法不对（见 docs/08-build-guide.md 第 4 节）"
  Write-Host "  - 00308018 + spawn EPERM：未用完全访问权限运行"
  exit 1
}

$outDir = Join-Path $repo 'build-output'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
foreach ($h in $haps) {
  Copy-Item $h.FullName (Join-Path $outDir $h.Name) -Force
  Write-Step ("产出: " + (Join-Path $outDir $h.Name) + "  (" + [math]::Round($h.Length/1KB,1) + " KB)")
}
