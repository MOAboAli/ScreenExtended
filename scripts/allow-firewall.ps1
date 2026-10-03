# Allow Mac/LAN clients to reach ScreenExtended (TCP 4789) on Private networks
$ErrorActionPreference = 'Stop'
$existing = Get-NetFirewallRule -DisplayName 'ScreenExtended' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'Firewall rule ScreenExtended already exists.'
} else {
  New-NetFirewallRule -DisplayName 'ScreenExtended' -Direction Inbound -Protocol TCP -LocalPort 4789 -Action Allow -Profile Private | Out-Null
  Write-Host 'Created firewall rule ScreenExtended (TCP 4789, Private).'
}
