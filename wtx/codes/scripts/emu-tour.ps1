<#
.SYNOPSIS
    在模拟器上跑一遍"四中心"演示并截图（答辩视频 / 使用手册配图）。

.DESCRIPTION
    前置：
      1. 网关监听 0.0.0.0:8765
      2. 已用 scripts/emu.ps1 登录，App 停在首页（脚本自带守卫，必要时会重新登录）

    所有控件按文本/类型反查，不写死坐标。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/emu-tour.ps1
#>
param(
    [string]$Device = '127.0.0.1:5555',
    [string]$Pin = '2468',
    [string]$ShotDir = 'C:\hcb\shots'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'emu-lib.ps1')
Set-EmuTarget -Device $Device -ShotDir $ShotDir

# 起点守卫：必须停在首页。不在首页先返回一次；仍不在则重新登录。
# （不能在首页盲目按 Back——那会直接退出应用）
if (-not (Test-OnHome)) {
    Back
    if (-not (Test-OnHome)) {
        Write-Host '[guard] 不在首页，重新登录'
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'emu.ps1') -SkipInstall
    }
}
Shot '01-home'

# ---- 照明中心：开灯 + 拖亮度 ----
Tap-Text '照明中心' -WaitMs 2000
$tg = Find-Node -Type 'Toggle' -Index 0
Touch-Point $tg.x $tg.y
Start-Sleep -Milliseconds 1200
$slider = Find-Node -Type 'Slider' -Index 0
Touch-Point ([int]($slider.x * 1.4)) $slider.y
Start-Sleep -Milliseconds 1800
Shot '02-lighting'
Back
Start-Sleep -Milliseconds 1500
Shot '03-home-light-on'

# ---- 温湿度中心：格力（全能力） vs 海尔（无摆风） ----
Tap-Text '温湿度中心' -WaitMs 2500
Shot '04-climate-gree'
Tap-Text '海尔' -WaitMs 1800
Shot '05-climate-haier'
Back
Start-Sleep -Milliseconds 1200

# ---- 场景：执行"回家" ----
Tap-Text '场景' -WaitMs 2200
Shot '06-scenes'
Tap-Text '执行' -WaitMs 2800
Shot '07-scene-done'
Back
Start-Sleep -Milliseconds 1200

# ---- 门禁：PIN 二次确认后远程开门 ----
Tap-Text '智能门禁' -WaitMs 2200
$pinField = Find-Node -Type 'TextInput' -Index 0
Tap-Point $pinField.x $pinField.y
Type-At $pinField.x $pinField.y $Pin
Start-Sleep -Milliseconds 800
Shot '08-access-before'
Tap-Text '确认开门' -WaitMs 2800
Shot '09-access-unlocked'

Write-Host "[done] 截图目录：$ShotDir"
