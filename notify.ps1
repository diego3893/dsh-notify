<#
.SYNOPSIS
  dsh-notify resident notification channel: one long-lived process owning a
  single tray icon, showing queued notifications one after another.

.DESCRIPTION
  Start it once; it stays alive and drains a queue DIRECTORY. Every *.json file
  in that directory is one notification:
      {"title":"...","body":"...","sound":true}
  Files appear whenever a producer writes one; the channel picks them up within a
  few hundred milliseconds, shows them in file order, deletes each shown file,
  and exits after IdleExitSeconds of an empty queue.

  One file per notification, instead of one append-only file: concurrent
  producers and the reader then never contend on the same handle, so no write is
  ever lost to a sharing violation.

  Why one resident process instead of one process per notification: Windows
  treats a balloon from a *new* NotifyIcon instance of the same application as a
  duplicate of the one already on screen and silently drops it. Reusing a single
  icon instance is what lets notifications 2..n actually appear. (Measured: four
  separate processes produced four "displayed" logs and exactly one visible
  balloon; one resident process produced all of them.)

  Why a tray balloon instead of a native Windows toast: a PowerShell process has
  no package identity, so WinRT ToastNotificationManager fails with 0x80073D54.
  NotifyIcon balloons render as notification banners on Windows 10/11 and need
  no package identity.

  This file is intentionally ASCII-only: PowerShell 5.1 reads a BOM-less .ps1 as
  ANSI, so non-ASCII text inside a script can break parsing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$QueueDir,
    [int]$Seconds = 8,
    [int]$PollMs = 300,
    [int]$IdleExitSeconds = 1800,
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-Note {
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($LogFile)) { return }
    try {
        Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format 'HH:mm:ss') $Message" -Encoding UTF8
    }
    catch { }
}

if (-not (Test-Path -LiteralPath $QueueDir)) {
    New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Text = 'DeepSeek Harness'
$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$icon.Visible = $true

$handledAny = $false
$lastActivity = Get-Date

function Drain-Queue {
    $files = @()
    try {
        $files = @(Get-ChildItem -LiteralPath $QueueDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
    }
    catch {
        return
    }
    foreach ($file in $files) {
        $json = $null
        try {
            # Read as UTF-8 explicitly: the queue holds non-ASCII notification text.
            $json = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        }
        catch {
            # A producer may still be writing this instant; retry on the next poll.
            Write-Note "read retry: $($file.Name)"
            continue
        }
        try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop } catch { }
        if ([string]::IsNullOrWhiteSpace($json)) { continue }
        try {
            $item = $json | ConvertFrom-Json
        }
        catch {
            Write-Note "skipped malformed item: $($file.Name)"
            continue
        }
        $title = [string]$item.title
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        if ($item.sound -ne $false) { [System.Media.SystemSounds]::Exclamation.Play() }
        $icon.BalloonTipTitle = $title
        $icon.BalloonTipText = [string]$item.body
        $icon.ShowBalloonTip([Math]::Max(3000, $Seconds * 1000))
        $script:handledAny = $true
        $script:lastActivity = Get-Date
        Write-Note "shown: $title"
        Start-Sleep -Seconds $Seconds
    }
}

try {
    Drain-Queue
    if ($handledAny) { Write-Note 'drained the initial queue' }

    while ($true) {
        Start-Sleep -Milliseconds $PollMs
        Drain-Queue
        $idle = (Get-Date) - $lastActivity
        if ($idle.TotalSeconds -ge $IdleExitSeconds) {
            Write-Note "idle for $IdleExitSeconds s; exiting"
            break
        }
    }
}
finally {
    $icon.Visible = $false
    $icon.Dispose()
    Write-Note 'channel stopped'
}
