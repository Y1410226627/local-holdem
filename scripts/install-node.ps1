# 本地人机德州扑克 · Node.js 一键安装器（Windows）
#
# 一般由「一键安装.bat」/「启动德州扑克.bat」自动调用，也可手动运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-node.ps1 -Mode Ask
#   -Mode Ask    检测不到 Node.js 时询问后再安装（双击启动器时的默认行为）
#   -Mode Auto   不询问，直接安装（对应 --install-node 参数）
#   -Mode Check  只检查/输出安装计划，不下载、不安装（用于诊断）
#
# 安装方式：从 nodejs.org 下载官方 LTS MSI，用 msiexec 静默安装（会弹出 UAC 管理员授权）。
# 退出码：0 = Node.js 已可用 / 安装成功；1 = 不可用 / 安装失败 / 用户取消。

[CmdletBinding()]
param(
  [ValidateSet('Ask', 'Auto', 'Check')]
  [string]$Mode = 'Ask'
)

$ErrorActionPreference = 'Stop'

function Get-NodeVersion {
  try {
    $raw = & node -v 2>$null
    if ($LASTEXITCODE -eq 0 -and $raw) {
      return ([string]($raw | Select-Object -First 1)).Trim()
    }
  } catch {
    # 忽略：后面再尝试标准安装目录
  }
  # 已安装但不在当前 PATH（例如刚装完还没刷新环境变量）
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      try {
        return ((& $candidate -v) | Select-Object -First 1).Trim()
      } catch {
        # 忽略，继续尝试下一个
      }
    }
  }
  return $null
}

function Get-LatestLtsVersion {
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
  $entry = $index | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $entry) {
    throw '无法从 nodejs.org 解析 Node.js LTS 版本'
  }
  return [string]$entry.version
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$existing = Get-NodeVersion
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$version = $null
$url = $null
try {
  $version = Get-LatestLtsVersion
  $url = "https://nodejs.org/dist/$version/node-$version-$arch.msi"
} catch {
  if ($Mode -ne 'Check') {
    Write-Host "[错误] 获取 Node.js 官方 LTS 版本失败：$($_.Exception.Message)"
  }
}

if ($Mode -eq 'Check') {
  Write-Host "[check] 已安装的 Node.js：$(if ($existing) { $existing } else { '未检测到' })"
  Write-Host "[check] 系统架构：$arch"
  Write-Host "[check] 官方 LTS 版本：$(if ($version) { $version } else { '获取失败' })"
  if ($url) {
    Write-Host "[check] 安装包地址：$url"
    try {
      $head = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30
      $sizeMb = [math]::Round([double]$head.Headers['Content-Length'] / 1MB, 1)
      Write-Host "[check] 安装包可访问：HTTP $($head.StatusCode)，约 $sizeMb MB"
    } catch {
      Write-Host "[check] 安装包 HEAD 检查失败：$($_.Exception.Message)"
    }
  }
  Write-Host "[check] 当前是否管理员：$(Test-Admin)"
  exit 0
}

if ($existing) {
  Write-Host "[Node.js] 已检测到 Node.js $existing"
  exit 0
}

if (-not $version) {
  Write-Host '[错误] 无法获取 Node.js 官方 LTS 版本，请检查网络后重试。'
  exit 1
}

if ($Mode -eq 'Ask') {
  $answer = Read-Host "未检测到 Node.js。是否自动下载并安装官方 LTS（$version，$arch）？需要联网，安装时会弹出管理员授权 [Y/n]"
  if ($answer -match '^\s*(n|no)\s*$') {
    Write-Host '[取消] 已跳过自动安装。'
    exit 1
  }
}

Write-Host "[下载] $url"
$msi = Join-Path $env:TEMP "node-$version-$arch.msi"
try {
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 600
} catch {
  Write-Host "[错误] 下载 Node.js 安装包失败：$($_.Exception.Message)"
  exit 1
}

Write-Host "[安装] 正在安装 Node.js $version（如弹出管理员授权，请点击“是”）..."
$msiArgs = "/i `"$msi`" /qn /norestart"
$process = $null
try {
  if (Test-Admin) {
    $process = Start-Process -FilePath msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
  } else {
    $process = Start-Process -FilePath msiexec.exe -ArgumentList $msiArgs -Wait -PassThru -Verb RunAs
  }
} catch {
  Write-Host "[错误] 安装未完成：$($_.Exception.Message)"
  if (Test-Path $msi) { Remove-Item -Force $msi -ErrorAction SilentlyContinue }
  exit 1
}

$exitCode = if ($process) { $process.ExitCode } else { 1 }
if ($exitCode -ne 0 -and $exitCode -ne 3010) {
  Write-Host "[错误] Node.js 安装程序退出码：$exitCode"
  if (Test-Path $msi) { Remove-Item -Force $msi -ErrorAction SilentlyContinue }
  exit 1
}

$installed = Get-NodeVersion
if ($installed) {
  Remove-Item -Force $msi -ErrorAction SilentlyContinue
  Write-Host "[完成] Node.js 已安装：$installed"
  exit 0
}

Write-Host '[错误] 安装结束但仍找不到 node.exe，请手动安装 Node.js 后重试。'
if (Test-Path $msi) { Remove-Item -Force $msi -ErrorAction SilentlyContinue }
exit 1
