# 本地开发一键启动（PowerShell / Windows）
#
#   .\dev.ps1                                   # 默认：后端 13800，前端 127.0.0.1:5173
#   .\dev.ps1 -ComicRoot D:\comics
#   .\dev.ps1 -AppPort 13900 -WebPort 5273
#
# 流程：确保依赖与二进制就绪 -> 后台起 Go 后端（日志落 .dev-data\server.log）-> 前台跑 vite。
# 关掉本窗口或 Ctrl-C 即可结束（后端会在 finally 里被停掉）。

param(
  [int]$AppPort = 13800,
  [int]$WebPort = 5173,
  [string]$ComicRoot = "",
  [string]$DataDir = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ([string]::IsNullOrEmpty($ComicRoot)) { $ComicRoot = Join-Path $root '.dev-comics' }
if ([string]::IsNullOrEmpty($DataDir)) { $DataDir = Join-Path $root 'app\server-go\.dev-data' }
$webDist = Join-Path $root 'app\web\dist'
$serverLog = Join-Path $DataDir 'server.log'

# ---- go 可用性 ----
$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go) {
  $candidates = @()
  if ($env:GO_EXE) { $candidates += $env:GO_EXE }
  $candidates += 'C:\Program Files\Go\bin\go.exe'
  $hit = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($hit) { $env:Path = (Split-Path $hit) + ';' + $env:Path }
  $go = Get-Command go -ErrorAction SilentlyContinue
}
if (-not $go) { throw '未找到 go，请安装 Go >= 1.26 并确保在 PATH 上（或用 GO_EXE 指定）' }
Write-Output ("[dev] " + (& go version))

# 国内网络下官方代理常不可达，未显式指定时走镜像（可先设 $env:GOPROXY 覆盖）
if (-not $env:GOPROXY) { $env:GOPROXY = 'https://mirrors.aliyun.com/goproxy/,direct' }
if (-not $env:GOSUMDB) { $env:GOSUMDB = 'off' }
if (-not $env:GOFLAGS) { $env:GOFLAGS = '-buildvcs=false' }

# ---- 漫画库 ----
if (-not (Test-Path $ComicRoot)) {
  New-Item -ItemType Directory -Path $ComicRoot -Force | Out-Null
  Write-Output "[dev] COMIC_ROOT=$ComicRoot 为空目录"
  Write-Output "[dev] 想快速有内容：python tools\make_test_data.py，然后 -ComicRoot \"$env:TEMP\fakenews-comics\""
}

# ---- 前端依赖与产物 ----
if (-not (Test-Path (Join-Path $root 'app\web\node_modules'))) {
  Write-Output '[dev] 安装前端依赖…'
  Push-Location (Join-Path $root 'app\web'); npm install --no-fund --no-audit; Pop-Location
}
if (-not (Test-Path $webDist)) {
  Write-Output '[dev] 首次构建前端产物（后端静态伺服用）…'
  Push-Location (Join-Path $root 'app\web'); npm run build; Pop-Location
}

# ---- 后端：增量编译后后台启动 ----
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'app\server-go\bin') -Force | Out-Null

Write-Output '[dev] 编译 Go 后端…'
Push-Location (Join-Path $root 'app\server-go')
$env:CGO_ENABLED = '0'
& go build -o bin\server.exe .
Pop-Location

$serverExe = Join-Path $root 'app\server-go\bin\server.exe'
$env:APP_PORT = "$AppPort"
$env:HOST = '127.0.0.1'
$env:COMIC_ROOT = $ComicRoot
$env:DATA_DIR = $DataDir
$env:WEB_DIST = $webDist

$proc = Start-Process -FilePath $serverExe -WorkingDirectory (Join-Path $root 'app\server-go') `
  -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $DataDir 'server.err.log') `
  -PassThru -WindowStyle Hidden

try {
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/api/health" -TimeoutSec 1 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ok) {
    Write-Output "[dev] 后端未就绪，日志尾部："
    if (Test-Path $serverLog) { Get-Content $serverLog -Tail 20 }
    throw "后端启动失败（端口 $AppPort 是否被占用？）"
  }
  Write-Output "[dev] 后端就绪 http://127.0.0.1:$AppPort  (日志: $serverLog)"
  Write-Output "[dev] 前端 http://127.0.0.1:$WebPort   (Ctrl-C 一并停止后端)"

  Push-Location (Join-Path $root 'app\web')
  npm run dev -- --host 127.0.0.1 --port $WebPort --strictPort
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if ($proc -and -not $proc.HasExited) {
    Write-Output '[dev] 停止后端…'
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
