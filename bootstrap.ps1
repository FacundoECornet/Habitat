#Requires -Version 5.1
<#
  bootstrap.ps1 - Windows-native Habitat bootstrap (PowerShell + Node + Git).

  Runs with the Windows PowerShell that ships with Windows: no WSL, no Bash and
  no rsync are required. Restore and install now run on the cross-platform Node
  engine (tools/restore.mjs), so a plain Windows box is enough.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1
    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -WithDeps -WithGsd
#>
[CmdletBinding()]
param(
  [string]$Repo = $PSScriptRoot,
  [string]$TargetHome = $env:USERPROFILE,
  [switch]$WithDeps,
  [switch]$WithGsd
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host "bootstrap: $Message" -ForegroundColor Red
  exit 1
}

# --- 1. Prerequisites: Node, npm and Git must be on PATH ---------------------
foreach ($tool in @('node', 'npm', 'git')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "falta '$tool' en PATH. Instalalo (node: https://nodejs.org) y reabri la terminal."
  }
}

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -notin @(22, 24, 26)) {
  Write-Host "bootstrap: aviso - Node $nodeVersion detectado; Habitat espera 22.22.2+, 24.15+ o 26+." -ForegroundColor Yellow
}
Write-Host "bootstrap: node $nodeVersion - repo $Repo - home $TargetHome"

# --- 2. Install: copy tools, jev.env, restore and (optionally) deps/GSD ------
$installArgs = @((Join-Path $Repo 'tools\install.mjs'), '--home', $TargetHome, '--repo', $Repo)
if ($WithDeps) { $installArgs += '--with-deps' }
if ($WithGsd) { $installArgs += '--with-gsd' }

& node @installArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 3. Make the installed bin directory reachable across shells -------------
$binDir = Join-Path $TargetHome 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  $env:Path = "$env:Path;$binDir"
  Write-Host "bootstrap: $binDir agregado al PATH de usuario; reabri la terminal para que tome efecto."
}

Write-Host "bootstrap: listo. Autentica OpenCode (opencode auth login) y corre: node tools/verify.mjs"
