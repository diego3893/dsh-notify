#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Idempotent launcher for the resident dsh-notify channel.

.DESCRIPTION
  Ensures exactly one resident notification channel (notify.ps1) is running for a
  queue directory, then exits.

  Why a launcher instead of starting notify.ps1 directly from Node: on Windows,
  spawn(..., { detached: true }) from Node kills the PowerShell child before it
  runs a single statement (no error event, no stderr, no output file). Start-Process
  detaches the channel from this console properly, so the channel outlives this
  launcher and the plugin process that asked for it.

  This file is intentionally ASCII-only: PowerShell 5.1 reads a BOM-less .ps1 as
  ANSI, so non-ASCII text inside a script can break parsing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$QueueDir,
    [int]$Seconds = 8,
    [int]$IdleExitSeconds = 1800,
    [string]$LogFile = (Join-Path $QueueDir 'notifier.log'),
    [string]$PidFile = (Join-Path $QueueDir 'notifier.pid')
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$notifier = Join-Path $here 'notify.ps1'

if (-not (Test-Path -LiteralPath $notifier)) { throw "notify.ps1 not found next to this launcher: $notifier" }
if (-not (Test-Path -LiteralPath $QueueDir)) { New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null }

# Already running? Nothing to do.
$running = @()
try {
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -like "*notify.ps1*" -and $_.CommandLine -like "*$QueueDir*" })
}
catch {
    Write-Host "channel check failed: $($_.Exception.Message)"
}
if ($running.Count -gt 0) {
    Write-Host "channel already running (pid $($running[0].ProcessId))"
    return
}

$process = Start-Process -FilePath 'powershell.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $notifier,
    '-QueueDir', $QueueDir, '-Seconds', "$Seconds",
    '-IdleExitSeconds', "$IdleExitSeconds", '-LogFile', $LogFile
)
$process.Id | Set-Content -LiteralPath $PidFile -Encoding utf8
Write-Host "channel started (pid $($process.Id))"
