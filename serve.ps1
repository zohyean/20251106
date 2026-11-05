# serve.ps1 —— 手势控制打砖块 内置静态文件服务器
# 基于 .NET System.Net.HttpListener（Windows 自带），无需安装 Python / Node。
# 只监听 http://localhost:端口/ ，不监听局域网，也不需要管理员权限。
# 本文件保存为「UTF-8 with BOM」，确保 Windows 自带 PowerShell 5.1 能正确显示中文。

# 让 PowerShell 按 UTF-8 输出，避免中文提示乱码

# 命令行参数：-NoBrowser 表示只启动服务，不自动打开浏览器
param(
  [switch]$NoBrowser
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'

# 项目根目录 = 本脚本所在目录
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = [System.IO.Path]::GetFullPath($root)

# MIME 类型映射
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.task' = 'application/octet-stream'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.mp3'  = 'audio/mpeg'
  '.wav'  = 'audio/wav'
  '.txt'  = 'text/plain; charset=utf-8'
  '.map'  = 'application/json'
}

function Get-ContentType([string]$path) {
  $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($mime.ContainsKey($ext)) { return $mime[$ext] }
  return 'application/octet-stream'
}

function Send-Response($res, [int]$status, [string]$contentType, [byte[]]$body) {
  try {
    $res.StatusCode = $status
    $res.ContentType = $contentType
    $res.Headers.Add('Cache-Control', 'no-store')   # 禁用缓存，改代码后立即生效
    $res.ContentLength64 = $body.Length
    $res.OutputStream.Write($body, 0, $body.Length)
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}

# 从 8000 开始找可用端口，被占用就 +1 重试，最多 20 个
$listener = $null
$port = 0
for ($i = 0; $i -lt 20; $i++) {
  $tryPort = 8000 + $i
  $l = New-Object System.Net.HttpListener
  try {
    $l.Prefixes.Add("http://localhost:$tryPort/")   # 只监听 localhost，无需 URL ACL、无需管理员
    $l.Start()
    $listener = $l
    $port = $tryPort
    break
  } catch {
    try { $l.Close() } catch {}
  }
}

if ($null -eq $listener) {
  Write-Host '错误：8000~8019 端口全部被占用。'
  Write-Host '请关闭占用这些端口的程序后，重新双击 start.bat。'
  exit 1
}

Write-Host "服务已启动：http://localhost:$port/"
Write-Host '请不要关闭本窗口，关闭窗口即停止服务。'
Write-Host '按 Ctrl+C 可停止服务。'

# 用默认浏览器打开实际端口（传入 -NoBrowser 时跳过）
if (-not $NoBrowser) {
  try { Start-Process "http://localhost:$port/" } catch {}
}

# 请求处理主循环
while ($listener.IsListening) {
  $res = $null
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $req = $ctx.Request
    $urlPath = $req.Url.AbsolutePath
    if ([string]::IsNullOrEmpty($urlPath) -or $urlPath -eq '/') {
      $rel = 'index.html'
    } else {
      $rel = $urlPath.TrimStart('/')
    }

    $relNorm = $rel -replace '/', '\'
    # GetFullPath 会折叠 ".."，得到绝对路径
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $relNorm))

    $rootTrim = $root.TrimEnd('\')
    $inRoot = $full.StartsWith($rootTrim + '\', [System.StringComparison]::OrdinalIgnoreCase) -or ($full -eq $rootTrim)
    if (-not $inRoot) {
      Send-Response $res 404 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404 Not Found'))
      continue
    }

    # 目录请求 → 返回其 index.html
    if (Test-Path -LiteralPath $full -PathType Container) {
      $full = Join-Path $full 'index.html'
    }

    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Send-Response $res 404 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404 Not Found'))
      continue
    }

    $bytes = [System.IO.File]::ReadAllBytes($full)
    Send-Response $res 200 (Get-ContentType $full) $bytes
  } catch {
    if (-not $listener.IsListening) { break }
    if ($res) {
      try {
        $res.StatusCode = 404
        $res.Headers.Add('Cache-Control', 'no-store')
      } catch {}
      try { $res.OutputStream.Close() } catch {}
    }
  }
}