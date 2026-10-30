# 本地打 release 包并覆盖安装到已连接设备（保留 App 数据）
#
# 用途：debug 包脱离 Metro 无法启动，release 包可独立运行。
#       写代码时用 debug（npx react-native run-android，走 Metro 热更新），
#       平时打开用 release。
#
# 包名与签名（2026-10-30 起，与 iWorkDaily 的做法一致）：
#   debug 与 release **同包名 com.acstd.tgimagesdownloader.release + 同正式签名**，
#   所以两者互相覆盖安装都会保留 App 数据（下载记录库 / 设置）。
#   代价：同一时间只能装一个，装 release 会替换掉 debug，反之亦然。
#   ⚠️ 绝不要为了调试把 debug 改回 debug.keystore —— 签名一变就只能卸载重装，
#      会清空全部下载记录。
#
# 用法：
#   pwsh scripts/build-local.ps1                # 打 release 并用 adb 覆盖安装
#   pwsh scripts/build-local.ps1 -Abi arm64-v8a # 只打指定 ABI（默认打全部，较慢）
#   pwsh scripts/build-local.ps1 -NoInstall     # 只打包不安装
#   pwsh scripts/build-local.ps1 -Clean         # 先 clean 再打（改了原生依赖时用）
#
# 对应 npm 脚本：npm run apk:local
param(
  [string]$Abi        = '',
  [switch]$NoInstall,
  [switch]$Clean,
  [string]$DeviceId   = ''
)

$ErrorActionPreference = 'Stop'

# 确保中文输出不乱码（尤其输出被重定向/管道时）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..')
$androidDir = Join-Path $repoRoot 'android'
$apkDir     = Join-Path $androidDir 'app\build\outputs\apk\release'
$gradlew    = Join-Path $androidDir 'gradlew.bat'

if (-not (Test-Path $gradlew)) { throw "找不到 gradlew: $gradlew" }

Push-Location $androidDir
try {
  # OpenCode 沙箱里机器级 GRADLE_USER_HOME 可能读不到，显式指定避免它回落去下载
  if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = 'D:\Android\.gradle' }

  if ($Clean) {
    Write-Host '==> clean' -ForegroundColor Cyan
    & $gradlew clean
    if ($LASTEXITCODE -ne 0) { throw 'gradlew clean 失败' }
  }

  Write-Host '==> assembleRelease' -ForegroundColor Cyan
  $gradleArgs = @('assembleRelease')
  if ($Abi) { $gradleArgs += "-PreactNativeArchitectures=$Abi" }
  & $gradlew @gradleArgs
  if ($LASTEXITCODE -ne 0) { throw 'gradlew assembleRelease 失败' }
}
finally {
  Pop-Location
}

# 收集产物（abi split 会出多个 apk，取 arm64 优先）
$apks = Get-ChildItem -Path $apkDir -Filter *.apk -ErrorAction SilentlyContinue
if (-not $apks -or $apks.Count -eq 0) { throw "未找到 APK：$apkDir" }

$apk = $apks |
  Sort-Object { if ($_.Name -match 'arm64') { 0 } elseif ($_.Name -match 'armeabi') { 1 } else { 2 } } |
  Select-Object -First 1

Write-Host "==> 产物: $($apk.FullName)" -ForegroundColor Green
Write-Host ("    大小: {0:N1} MB" -f ($apk.Length / 1MB))

if ($NoInstall) {
  Write-Host '==> -NoInstall：跳过安装。' -ForegroundColor Yellow
  exit 0
}

# 覆盖安装（-r 保留数据）
Write-Host '==> adb install -r（覆盖安装，保留数据）' -ForegroundColor Cyan
$adbArgs = @()
if ($DeviceId) { $adbArgs += @('-s', $DeviceId) }
$adbArgs += @('install', '-r', $apk.FullName)

$installOut = & adb @adbArgs 2>&1
$installOut | Write-Host
if ($LASTEXITCODE -ne 0 -or ($installOut -join "`n") -match 'FAILED') {
  Write-Host ''
  Write-Host '[失败] 覆盖安装被拒绝。最常见原因是签名不一致：' -ForegroundColor Red
  Write-Host '  Android 要求「同包名 + 同签名」才能覆盖安装。' -ForegroundColor Red
  Write-Host '  正常配置下 debug / release 都用正式签名（见 android/app/build.gradle），' -ForegroundColor Red
  Write-Host '  出现本错误说明签名或包名被改过，先检查 gradle 配置，别急着卸载。' -ForegroundColor Red
  Write-Host '  （卸载会清空全部下载记录，确认无救才可执行下面这条）' -ForegroundColor Red
  Write-Host '    adb uninstall com.acstd.tgimagesdownloader.release' -ForegroundColor Yellow
  exit 1
}

Write-Host ''
Write-Host '完成。release 包已覆盖安装，App 数据（下载记录 / 本地库）保持不变。' -ForegroundColor Green
