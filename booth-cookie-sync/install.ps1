# Register booth-cookie-sync native messaging host for Chrome / Edge.
# Generates the host manifest with absolute paths for THIS machine, then registers it.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$template = Join-Path $here "host\com.quolabo.booth_cookie_sync.json.template"
$manifest = Join-Path $here "host\com.quolabo.booth_cookie_sync.json"
$bat = Join-Path $here "host\run-host.bat"
$hostName = "com.quolabo.booth_cookie_sync"

if (-not (Test-Path $template)) { throw "Template not found: $template" }
if (-not (Test-Path $bat)) { throw "Host launcher not found: $bat" }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Warning "node not found in PATH. Chrome may fail to launch the host." }

# Generate the machine-specific manifest (JSON needs escaped backslashes).
$escaped = $bat -replace '\\', '\\'
(Get-Content $template -Raw) -replace '__HOST_BAT_PATH__', $escaped |
  Set-Content -Path $manifest -Encoding utf8
Write-Host "Generated: $manifest"

$targets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

foreach ($key in $targets) {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $manifest
  Write-Host "Registered: $key"
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Open chrome://extensions and enable Developer mode"
Write-Host "  2. 'Load unpacked' -> select $here\extension"
Write-Host "  3. Confirm extension ID is lolkadambhklnhfambjfndlcnhmjjffb"
Write-Host "  4. Log in at manage.booth.pm, then RESTART Chrome completely"
Write-Host "     (Chrome only picks up native hosts at startup)"
Write-Host "  5. Check booth-cookie-sync\host\sync.log and booth-mcp\.cookie"
