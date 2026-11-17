<#
.SYNOPSIS
    将 mobile/ 同步到 ASCII 构建目录，并注入本机签名配置。

.DESCRIPTION
    hvigor 不接受含中文的工程路径（错误 00306003 Invalid project path），
    因此仓库中的 mobile/ 需要镜像到纯 ASCII 目录后再构建。

    签名材料由 DevEco「自动生成签名」在本机产生，路径指向 %USERPROFILE%\.ohos\config\，
    属于个人凭据，不入库；本脚本在同步完成后把它注入到目标工程的 build-profile.json5。

.PARAMETER Target
    ASCII 构建目录，默认 C:\hcb\mobile

.EXAMPLE
    pwsh -File scripts/sync-build.ps1
#>
param(
    [string]$Target = 'C:\hcb\mobile'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'mobile'

if (-not (Test-Path $src)) { throw "源目录不存在：$src" }
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }

# /MIR 镜像同步：目标端多余文件会被清理，保证构建用的是仓库最新代码
# 保留 local.properties（IDE 的 SDK 指向，仓库不收录）
$excludeDirs = @('node_modules', 'oh_modules', '.hvigor', 'build', '.git')
robocopy $src $Target /MIR /XD @excludeDirs /XF '*.hap' 'local.properties' /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 同步失败，退出码 $LASTEXITCODE" }

# 注入签名配置
$signingFile = Join-Path $src 'signing.local.json5'
$bp          = Join-Path $Target 'build-profile.json5'

if (Test-Path $signingFile) {
    $sign = (Get-Content $signingFile -Raw).Trim()
    $text = Get-Content $bp -Raw
    $text = [regex]::Replace($text, '"signingConfigs"\s*:\s*\[\s*\]', ('"signingConfigs": ' + $sign.Replace('$', '$$')))
    Set-Content -Path $bp -Value $text -Encoding utf8 -NoNewline
    Write-Host "[sync] 已注入签名配置"
}
else {
    Write-Host "[sync] 未找到 mobile/signing.local.json5，构建产物将不带签名"
}

Write-Host "[sync] 完成：$src -> $Target"
