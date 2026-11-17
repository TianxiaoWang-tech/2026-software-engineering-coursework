<#
.SYNOPSIS
    模拟器调试公共库：hdc / uitest 的薄封装，全部按控件文本或类型定位，不写死坐标。

.DESCRIPTION
    被 scripts/emu.ps1（登录）与 scripts/emu-tour.ps1（四中心巡演）共用。
    HarmonyOS 模拟器走 QEMU 用户态网络：宿主机 = 10.0.2.2，所以网关要监听 0.0.0.0。

    注意：Toggle / Slider 对 uitest 的合成 click 不产生 onChange，
    必须用 0 距离 swipe（Touch-Point）触发真实的 down→up 序列。
#>

$script:HDC = 'D:\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$script:Device = '127.0.0.1:5555'
$script:ShotDir = 'C:\hcb\shots'
$script:Bundle = 'com.example.homecontrol'
$script:Ability = 'EntryAbility'
$script:LayoutTmp = 'C:\hcb\layout-tmp.json'

function Set-EmuTarget {
    param([string]$Device, [string]$ShotDir)
    if ($Device) { $script:Device = $Device }
    if ($ShotDir) { $script:ShotDir = $ShotDir }
}

function Hdc { param([string]$Cmd) return (& $script:HDC -t $script:Device shell $Cmd 2>&1) }

function Get-Layout {
    & $script:HDC -t $script:Device shell uitest dumpLayout -p /data/local/tmp/emu.json 2>&1 | Out-Null
    & $script:HDC -t $script:Device file recv /data/local/tmp/emu.json $script:LayoutTmp 2>&1 | Out-Null
    return Get-Content $script:LayoutTmp -Raw | ConvertFrom-Json
}

# 摊平控件树：返回 type / text / x / y（控件中心点）
function Get-Nodes {
    param($Node = $null)
    if (-not $Node) { $Node = Get-Layout }
    $acc = New-Object System.Collections.ArrayList
    function Walk($n, $d) {
        if ($d -gt 12) { return }
        $a = $n.attributes
        if ($a -and $a.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
            $cx = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
            $cy = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
            [void]$acc.Add([pscustomobject]@{ type = "$($a.type)"; text = "$($a.text)"; x = $cx; y = $cy })
        }
        foreach ($c in $n.children) { Walk $c ($d + 1) }
    }
    Walk $Node 0
    return $acc
}

function Find-Node {
    param([string]$Type, [string]$Text, [int]$Index = 0, $Nodes = $null)
    if (-not $Nodes) { $Nodes = Get-Nodes }
    $hit = @($Nodes | Where-Object {
            ((-not $Type) -or $_.type -eq $Type) -and ((-not $Text) -or $_.text -like "*$Text*")
        })
    if ($hit.Count -le $Index) { throw "界面上找不到控件 Type='$Type' Text='$Text' #$Index" }
    return $hit[$Index]
}

function Tap-Point { param([int]$X, [int]$Y) & $script:HDC -t $script:Device shell uitest uiInput click $X $Y 2>&1 | Out-Null; Start-Sleep -Milliseconds 450 }

function Touch-Point { param([int]$X, [int]$Y) & $script:HDC -t $script:Device shell uitest uiInput swipe $X $Y $X $Y 80 2>&1 | Out-Null; Start-Sleep -Milliseconds 600 }

function Tap-Text {
    param([string]$Text, [int]$Index = 0, [int]$WaitMs = 1500)
    $n = Find-Node -Text $Text -Index $Index
    Write-Host "[tap] $Text -> ($($n.x),$($n.y))"
    Tap-Point $n.x $n.y
    Start-Sleep -Milliseconds $WaitMs
}

function Tap-Type {
    param([string]$Type, [int]$Index = 0, [int]$WaitMs = 400)
    $n = Find-Node -Type $Type -Index $Index
    Write-Host "[tap] $Type#$Index -> ($($n.x),$($n.y))"
    Tap-Point $n.x $n.y
    Start-Sleep -Milliseconds $WaitMs
    return $n
}

function Type-At { param([int]$X, [int]$Y, [string]$Text) & $script:HDC -t $script:Device shell uitest uiInput inputText $X $Y $Text 2>&1 | Out-Null; Start-Sleep -Milliseconds 500 }

function KeyDel { param([int]$Times = 1) 1..$Times | ForEach-Object { & $script:HDC -t $script:Device shell uitest uiInput keyEvent 2055 2>&1 | Out-Null; Start-Sleep -Milliseconds 100 } }

# 清空第 N 个输入框再填入新值
function Set-Field {
    param([int]$Index, [string]$Value, [int]$Rounds = 4)
    for ($i = 0; $i -lt $Rounds; $i++) {
        $n = Find-Node -Type 'TextInput' -Index $Index
        Tap-Point $n.x $n.y
        KeyDel 20
        $node = Find-Node -Type 'TextInput' -Index $Index
        if ($node.text -eq '') { break }
    }
    $n = Find-Node -Type 'TextInput' -Index $Index
    Type-At $n.x $n.y $Value
    return (Find-Node -Type 'TextInput' -Index $Index).text
}

function Shot {
    param([string]$Name)
    if (-not (Test-Path $script:ShotDir)) { New-Item -ItemType Directory -Path $script:ShotDir -Force | Out-Null }
    $remote = "/data/local/tmp/$Name.jpeg"
    & $script:HDC -t $script:Device shell snapshot_display -f $remote 2>&1 | Out-Null
    & $script:HDC -t $script:Device file recv $remote (Join-Path $script:ShotDir "$Name.jpeg") 2>&1 | Out-Null
    Write-Host "[shot] $Name"
}

function Back { & $script:HDC -t $script:Device shell uitest uiInput keyEvent 2 2>&1 | Out-Null; Start-Sleep -Milliseconds 1400 }

# 当前页面所有可见文本，用 ' | ' 连接（用于断言跳到哪一页）
function Get-ScreenText {
    $nodes = Get-Nodes
    $texts = @($nodes | Where-Object { $_.text -ne '' } | ForEach-Object { $_.text })
    return ($texts -join ' | ')
}

function Test-OnHome { return [bool](@((Get-Nodes) | Where-Object { $_.text -like '*我的家*' }).Count -gt 0) }
