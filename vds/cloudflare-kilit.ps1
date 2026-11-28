# Kanka: web portlarını (80/443) sadece Cloudflare'e aç.
# Cloudflare'e geçip site Cloudflare üzerinden açıldıktan SONRA çalıştır. Önce çalıştırırsan site herkese kapanır.
# Yönetici PowerShell'de:  powershell -ExecutionPolicy Bypass -File cloudflare-kilit.ps1
# Geri almak için:          powershell -ExecutionPolicy Bypass -File cloudflare-kilit.ps1 -GeriAl
param([switch]$GeriAl)

$ad = 'Kanka Web (sadece Cloudflare)'
# Kaynak: https://www.cloudflare.com/ips/ (son değişiklik Eylül 2023). Liste değişirse buraya ekle.
$cf = @(
  '173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18',
  '190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13',
  '104.24.0.0/14','172.64.0.0/13','131.0.72.0/22',
  '2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32'
)

if ($GeriAl) {
  Get-NetFirewallRule -DisplayName $ad -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Get-NetFirewallRule -DisplayName 'Kanka devre disi: *' -ErrorAction SilentlyContinue | ForEach-Object {
    Enable-NetFirewallRule -Name $_.Name; Set-NetFirewallRule -Name $_.Name -NewDisplayName ($_.DisplayName -replace '^Kanka devre disi: ', '')
  }
  Write-Host 'Geri alındı: 80/443 eskisi gibi herkese açık.' -ForegroundColor Yellow
  exit
}

# 80/443'ü herkese açan mevcut kuralları bul (Caddy kurulurken eklenmiş olabilir)
$acik = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | Where-Object {
  $p = $_ | Get-NetFirewallPortFilter
  $a = $_ | Get-NetFirewallAddressFilter
  ($p.LocalPort -contains '80' -or $p.LocalPort -contains '443' -or $p.LocalPort -eq 'Any') -and $a.RemoteAddress -contains 'Any' -and $_.DisplayName -notlike '*TURN*' -and $_.DisplayName -notlike '*Uzak Masa*' -and $_.DisplayName -notlike '*Remote Desktop*'
} | Where-Object { ($_ | Get-NetFirewallPortFilter).Protocol -eq 'TCP' }

Write-Host "80/443'ü herkese açan kurallar:" -ForegroundColor Cyan
$acik | ForEach-Object { Write-Host ('  - ' + $_.DisplayName) }
$c = Read-Host "Bunlar kapatılıp 80/443 sadece Cloudflare'e açılsın mı? (evet/hayır)"
if ($c -ne 'evet') { Write-Host 'Vazgeçildi.'; exit }

Get-NetFirewallRule -DisplayName $ad -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ad -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80,443 -RemoteAddress $cf | Out-Null
foreach ($r in $acik) { Disable-NetFirewallRule -Name $r.Name; Set-NetFirewallRule -Name $r.Name -NewDisplayName ('Kanka devre disi: ' + $r.DisplayName) }
Write-Host 'Tamam: 80/443 artık sadece Cloudflare''den gelen bağlantılara açık. Sesli sohbet (TURN 3478 + 50000-50999 UDP) etkilenmez.' -ForegroundColor Green
