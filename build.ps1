# 肥牛漫画 fpk 打包助手（Windows / PowerShell）
# 流程：校验前端产物 -> 交叉编译 Go 服务端（linux/amd64）-> 组装干净打包目录 .build/fpk -> fnpack build
#
# 服务端只有「一个静态二进制 + 前端 dist」，镜像构建在 NAS 上是两次 COPY（1~2 秒、零联网）。
#
# 参数：
#   -SkipWebBuild   跳过前端构建（已有 app/web/dist 时用）
#   -GoExe <path>   指定 go 可执行文件（缺省取 $env:GO_EXE，再缺省从 PATH 找）
#   -Goproxy <url>  模块代理（缺省阿里云镜像：本机网络环境仅该源可达）
param(
    [switch]$SkipWebBuild,
    [string]$GoExe = "",
    [string]$Goproxy = "https://mirrors.aliyun.com/goproxy/,direct"
)

$ErrorActionPreference = "Stop"

# 统一失败出口：所有错误分支都走这里，打印红字并以 1 退出。
# 不用 Write-Error：它在 $ErrorActionPreference=Stop 下抛的是终止错误，
# 但经 powershell -File 调用时进程退出码会受脚本内最后一个原生命令影响，
# 出现过「明明打包成功、退出码却是 1」的误报。显式 exit 才是确定的。
function Fail {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

$root = $PSScriptRoot
$toolDir = Join-Path $root ".toolchain"
$fnpack = Join-Path $toolDir "fnpack.exe"
$stage = Join-Path $root ".build\fpk"
$serverGo = Join-Path $root "app\server-go"
$binDir = Join-Path $serverGo "bin"

# ---------- 1. 版本（单一真源：manifest） ----------
$manifestPath = Join-Path $root "manifest"
# Matches 可能为空（manifest 里没有 version 行），直接取 [0] 会抛终止错误且信息不明
$match = (Select-String -Path $manifestPath -Pattern '^\s*version\s*=\s*(\S+)').Matches
if (-not $match -or $match.Count -eq 0) { Fail "无法从 manifest 读取 version" }
$version = $match[0].Groups[1].Value
Write-Host "版本: $version"

# ---------- 2. 前端产物 ----------
$webDist = Join-Path $root "app\web\dist"
if (-not $SkipWebBuild) {
    Write-Host "构建前端 ..."
    Push-Location (Join-Path $root "app\web")
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { Fail "前端构建失败" }
    } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $webDist "index.html"))) {
    Fail "app/web/dist/index.html 不存在。请先在 app/web 执行: npm run build"
}

# ---------- 3. 交叉编译 Go 服务端 ----------
if (-not $GoExe) {
    if ($env:GO_EXE) { $GoExe = $env:GO_EXE }
    else {
        $cmd = Get-Command go -ErrorAction SilentlyContinue
        if ($cmd) { $GoExe = $cmd.Source }
    }
}
if (-not $GoExe -or -not (Test-Path $GoExe)) {
    Fail "找不到 go（用 -GoExe 指定，例如 -GoExe C:\Go\bin\go.exe）"
}
Write-Host "Go: $GoExe"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$outBin = Join-Path $binDir "fakenews-comics-server-linux-amd64"

# CGO_ENABLED=0：纯 Go（modernc sqlite / x/image / wazero PDFium），
# 产物是静态 ELF，可直接跑在 scratch 镜像里，也天然支持交叉编译。
$env:CGO_ENABLED = "0"
$env:GOOS = "linux"
$env:GOARCH = "amd64"
$env:GOPROXY = $Goproxy
$env:GOSUMDB = "off"
$env:GOTOOLCHAIN = "local"
$env:GOFLAGS = "-buildvcs=false"

Write-Host "交叉编译 linux/amd64 ..."
Push-Location $serverGo
try {
    & $GoExe build -trimpath `
        -ldflags "-s -w -X fakenews-comics/internal/version.AppVersion=$version" `
        -o $outBin .
    if ($LASTEXITCODE -ne 0) { Fail "Go 交叉编译失败" }
    if (-not (Test-Path $outBin)) { Fail "Go 交叉编译未产出 $outBin" }
} finally { Pop-Location }

$binSize = [math]::Round((Get-Item $outBin).Length / 1MB, 1)
Write-Host "二进制: $outBin ($binSize MB)"

# ---------- 4. 组装打包目录（只含 fpk 需要的文件） ----------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $root "manifest") $stage
Copy-Item (Join-Path $root "ICON.PNG") $stage
Copy-Item (Join-Path $root "ICON_256.PNG") $stage
Copy-Item (Join-Path $root "cmd") -Destination "$stage\cmd" -Recurse
Copy-Item (Join-Path $root "config") -Destination "$stage\config" -Recurse
Copy-Item (Join-Path $root "wizard") -Destination "$stage\wizard" -Recurse

New-Item -ItemType Directory -Force -Path "$stage\app" | Out-Null
Copy-Item (Join-Path $root "app\ui") -Destination "$stage\app\ui" -Recurse
Copy-Item (Join-Path $root "app\docker") -Destination "$stage\app\docker" -Recurse

# 服务端：Dockerfile + bin/ + web-dist/（compose 的 build context 就是这里）
$serverStage = "$stage\app\server-go"
New-Item -ItemType Directory -Force -Path "$serverStage\bin" | Out-Null
Copy-Item (Join-Path $serverGo "Dockerfile") $serverStage
Copy-Item $outBin "$serverStage\bin\"
Copy-Item $webDist "$serverStage\web-dist" -Recurse

Write-Host "Staged package tree:"
Get-ChildItem $stage -Recurse -File | ForEach-Object { Write-Host "  $($_.FullName.Substring($stage.Length + 1))" }

# ---------- 5. fnpack ----------
if (-not (Test-Path $fnpack)) {
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    Write-Host "Downloading fnpack 1.2.3 (windows-amd64) ..."
    Invoke-WebRequest -Uri "https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64" -OutFile $fnpack
}

Write-Host "Packing fakenews-comics ..."
# fnpack 将产物写入「进程工作目录」而非 --directory，故先切到 staging 目录
Push-Location $stage
try {
    & $fnpack build --directory $stage
    $packExit = $LASTEXITCODE
} finally {
    Pop-Location
}

# fnpack 退出码不可靠：成功一般返回 0，个别失败场景也返回 0，因此以产物文件为准；
# 退出码仅作为诊断信息打印，不作为成败判据。
$fpk = Join-Path $stage "fakenews-comics.fpk"
if (-not (Test-Path $fpk)) {
    Fail "fakenews-comics.fpk 未生成（fnpack 退出码 $packExit，产物应落在 $stage）。请查看上面的 fnpack 输出。"
}
# 产物名带版本：多版本共存时不会互相覆盖，也便于在 NAS 上分辨装的是哪版
$target = Join-Path $root "fakenews-comics-$version.fpk"
Move-Item $fpk $target -Force
$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "OK -> $target ($size MB, 版本 $version)"
exit 0
