# Kanka Chat güncelleyici onarımı (VDS'te yönetici PowerShell'e tek satır):
#   irm https://raw.githubusercontent.com/Reuskilled/kanka-chat/main/vds/onar.ps1 | iex
# Takılan güncelleyiciyi durdurur, en yeni sürümünü indirir, paketleri kurar ve yeniden başlatır.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Dst = 'C:\KankaChat'
function Adim($t) { Write-Host "  > $t" -ForegroundColor Yellow }
Write-Host ''
Write-Host '  Kanka Chat guncelleyici onariliyor...' -ForegroundColor Cyan
try {
  if (-not (Test-Path "$Dst\server.js")) { throw 'C:\KankaChat bulunamadi' }
  New-Item -ItemType Directory -Force -Path "$Dst\kayitlar", "$Dst\veri" | Out-Null

  if (Test-Path "$Dst\kayitlar\guncelleme.log") {
    Write-Host '  Onceki son kayitlar:' -ForegroundColor DarkGray
    Get-Content "$Dst\kayitlar\guncelleme.log" -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }

  Adim 'Eski guncelleyici durduruluyor'
  Stop-ScheduledTask -TaskName 'KankaChat-Guncelleyici' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*guncelleyici.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Adim 'Yeni guncelleyici indiriliyor'
  Invoke-WebRequest "https://raw.githubusercontent.com/Reuskilled/kanka-chat/main/vds/guncelleyici.js?t=$(Get-Random)" -OutFile "$Dst\guncelleyici.js" -UseBasicParsing

  Adim 'Paketler kuruluyor (1-2 dakika surebilir)'
  $npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  if (-not (Test-Path $npm)) { $npm = 'npm' }
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"`"$npm`" install --omit=dev --no-audit --no-fund`"" -WorkingDirectory $Dst -Wait -NoNewWindow -RedirectStandardOutput "$Dst\kayitlar\npm.log" -RedirectStandardError "$Dst\kayitlar\npm-hata.log"
  if (Test-Path "$Dst\node_modules\qrcode") { Write-Host '    Paketler tamam' -ForegroundColor Green }
  else { Write-Host '    qrcode paketi kurulamadi (sorun degil, 2FA QR yerine kodla calisir)' -ForegroundColor DarkYellow; Get-Content "$Dst\kayitlar\npm-hata.log" -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }

  $state = "$Dst\veri\guncelleme.json"
  if (Test-Path $state) {
    $j = Get-Content $state -Raw | ConvertFrom-Json
    $j | Add-Member -NotePropertyName needNpm -NotePropertyValue $false -Force
    $j | ConvertTo-Json | Set-Content -Encoding UTF8 $state
  }

  Adim 'Guncelleyici yeniden baslatiliyor'
  Start-ScheduledTask -TaskName 'KankaChat-Guncelleyici'
  Write-Host '    Yeni surum cekiliyor, 30 saniye bekleniyor...' -ForegroundColor DarkGray
  Start-Sleep 30
  Write-Host ''
  Write-Host '  Son kayitlar:' -ForegroundColor Yellow
  Get-Content "$Dst\kayitlar\guncelleme.log" -Tail 6 | ForEach-Object { Write-Host "    $_" }
  Write-Host ''
  Write-Host '  TAMAM! Siteyi yenileyip bak.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "  HATA: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Bu pencerenin ekran goruntusunu Claude''a gonder.' -ForegroundColor Red
}
Write-Host ''
