<#
.SYNOPSIS
    安装 HAP 并在模拟器上完成登录，停在首页。

.DESCRIPTION
    前置：网关在宿主机监听 0.0.0.0:8765
            node gateway/main.mjs --host 0.0.0.0

    模拟器（QEMU 用户态网络）里宿主机是 10.0.2.2，因此网关地址填 10.0.2.2。
    控件全部按类型/文本定位，版式变动不用改脚本。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/emu.ps1
#>
param(
    [string]$Device = '127.0.0.1:5555',
    [string]$HostIp = '10.0.2.2',
    [string]$User = 'admin',
    [string]$Password = 'admin12345',
    [string]$Hap = 'C:\hcb\mobile\entry\build\default\outputs\default\entry-default-signed.hap',
    [string]$ShotDir = 'C:\hcb\shots',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'emu-lib.ps1')
Set-EmuTarget -Device $Device -ShotDir $ShotDir

if (-not $SkipInstall) {
    if (-not (Test-Path $Hap)) { throw "找不到 HAP：$Hap" }
    $r = & $script:HDC -t $script:Device install -r $Hap 2>&1
    if ($r -match 'fail') { throw "安装失败：$r" }
    Write-Host '[install] ok'
}

Hdc "aa force-stop $($script:Bundle)" | Out-Null
Start-Sleep -Milliseconds 800
Hdc "aa start -a $($script:Ability) -b $($script:Bundle)" | Out-Null
Start-Sleep -Seconds 3

# 登录页：输入框顺序 = 网关地址 / 端口 / 用户名 / 口令
$hostText = Set-Field -Index 0 -Value $HostIp
$pwdText = Set-Field -Index 3 -Value $Password
Write-Host "[form] host='$hostText' pwd='$pwdText'"

Tap-Text '连接并登录' -WaitMs 3500
Start-Sleep -Seconds 2
Shot 'after-login'
Write-Host "[screen] $(Get-ScreenText)"
