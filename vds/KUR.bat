@echo off
chcp 65001 >nul
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
set "KANKA_SRC=%~dp0."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~f0', [Text.Encoding]::UTF8); $i = $s.IndexOf('#PS-' + 'START'); Invoke-Expression $s.Substring($i)"
pause
exit /b
#PS-START
# Kanka Chat sunucu kurulumu (Windows Server)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Domain = '185-208-172-60.sslip.io'
$Src = $env:KANKA_SRC
$Dst = 'C:\KankaChat'
$Host.UI.RawUI.WindowTitle = 'Kanka Chat kurulumu'
function Adim($n, $t) { Write-Host ''; Write-Host "  [$n/7] $t" -ForegroundColor Yellow }
function Tamam($t) { Write-Host "        $t" -ForegroundColor Green }
Write-Host ''
Write-Host '  ==========================================' -ForegroundColor DarkYellow
Write-Host '     Kanka Chat sunucusu kuruluyor' -ForegroundColor White
Write-Host "     https://$Domain" -ForegroundColor Gray
Write-Host '  ==========================================' -ForegroundColor DarkYellow
try {
  # 1) Node.js
  Adim 1 'Node.js kontrol ediliyor'
  $nodeExe = "$env:ProgramFiles\nodejs\node.exe"
  $needNode = $true
  if (Test-Path $nodeExe) { $v = (& $nodeExe -v) -replace 'v', ''; if ([int]($v.Split('.')[0]) -ge 20) { $needNode = $false; Tamam "Node.js v$v zaten kurulu" } }
  if ($needNode) {
    $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $ver = ($idx | Where-Object { $_.lts -and $_.files -contains 'win-x64-msi' } | Select-Object -First 1).version
    Write-Host "        Node.js $ver indiriliyor..."
    $msi = "$env:TEMP\node-$ver-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-x64.msi" -OutFile $msi -UseBasicParsing
    Write-Host '        Kuruluyor...'
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    if (-not (Test-Path $nodeExe)) { throw 'Node.js kurulamadi' }
    Tamam "Node.js $ver kuruldu"
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $env:Path

  # 2) Eski kurulumu durdur
  Adim 2 'Calisan eski surum varsa durduruluyor'
  foreach ($t in 'KankaChat-Uygulama', 'KankaChat-Https') { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
  Get-Process node, caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dst*" -or $_.Path -like "$env:ProgramFiles\nodejs*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Tamam 'Tamam'

  # 3) Dosyalari kopyala (veriler korunur)
  Adim 3 "Uygulama $Dst klasorune kopyalaniyor"
  New-Item -ItemType Directory -Force -Path $Dst, "$Dst\veri", "$Dst\kayitlar", "$Dst\indir" | Out-Null
  robocopy "$Src\uygulama" $Dst /E /NFL /NDL /NJH /NJS /NP /XD node_modules veri | Out-Null
  robocopy "$Src\indir" "$Dst\indir" /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Tamam 'Kopyalandi'

  # 4) Paketler
  Adim 4 'Paketler kuruluyor (npm install)'
  Push-Location $Dst
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm install --omit=dev --no-audit --no-fund' -WorkingDirectory $Dst -Wait -NoNewWindow -RedirectStandardOutput "$Dst\kayitlar\npm.log" -RedirectStandardError "$Dst\kayitlar\npm-hata.log"
  Pop-Location
  if (-not (Test-Path "$Dst\node_modules\socket.io")) { throw 'npm install basarisiz' }
  Tamam 'Paketler kuruldu'

  # 5) Caddy (otomatik ucretsiz https)
  Adim 5 'Https icin Caddy hazirlaniyor'
  if (-not (Test-Path "$Dst\caddy.exe")) {
    Invoke-WebRequest 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile "$Dst\caddy.exe" -UseBasicParsing
  }
  @"
$Domain {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
http://185.208.172.60 {
	redir https://$Domain{uri}
}
"@ | Set-Content -Encoding ASCII "$Dst\Caddyfile"
  Tamam 'Caddy hazir'

  # 6) Arka planda surekli calissin (bilgisayar acilinca da)
  Adim 6 'Uygulama surekli calisacak sekilde ayarlaniyor'
  @"
@echo off
cd /d $Dst
set DATA_DIR=$Dst\veri
set PORT=3000
:dongu
"$nodeExe" server.js >> "$Dst\kayitlar\uygulama.log" 2>&1
timeout /t 3 /nobreak >nul
goto dongu
"@ | Set-Content -Encoding ASCII "$Dst\calistir-uygulama.cmd"
  @"
@echo off
cd /d $Dst
set XDG_DATA_HOME=$Dst\caddy-veri
set XDG_CONFIG_HOME=$Dst\caddy-veri
:dongu
"$Dst\caddy.exe" run --config "$Dst\Caddyfile" --adapter caddyfile >> "$Dst\kayitlar\https.log" 2>&1
timeout /t 5 /nobreak >nul
goto dongu
"@ | Set-Content -Encoding ASCII "$Dst\calistir-https.cmd"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $trigger = New-ScheduledTaskTrigger -AtStartup
  foreach ($p in @(@('KankaChat-Uygulama', 'calistir-uygulama.cmd'), @('KankaChat-Https', 'calistir-https.cmd'))) {
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$Dst\$($p[1])`"" -WorkingDirectory $Dst
    Register-ScheduledTask -TaskName $p[0] -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $p[0]
  }
  Tamam 'Servisler baslatildi (sunucu yeniden baslasa da kendiliginden acilir)'

  # 7) Guvenlik duvari
  Adim 7 'Guvenlik duvarinda 80 ve 443 aciliyor'
  if (-not (Get-NetFirewallRule -DisplayName 'Kanka Chat (web)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Kanka Chat (web)' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
  }
  Tamam 'Acildi'

  # Kontrol
  Write-Host ''
  Write-Host '  Kontrol ediliyor...' -ForegroundColor Yellow
  $ok = $false
  for ($i = 0; $i -lt 20 -and -not $ok; $i++) { Start-Sleep 2; try { $ok = (Invoke-WebRequest 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {} }
  if (-not $ok) { throw "Uygulama baslamadi. Kayit: $Dst\kayitlar\uygulama.log" }
  Tamam 'Uygulama calisiyor'
  Write-Host '        Https sertifikasi aliniyor (ilk seferde 1 dakika surebilir)...'
  $https = $false
  for ($i = 0; $i -lt 30 -and -not $https; $i++) { Start-Sleep 3; try { $https = (Invoke-WebRequest "https://$Domain" -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200 } catch {} }
  Write-Host ''
  if ($https) {
    Write-Host '  ==========================================' -ForegroundColor Green
    Write-Host '     KURULUM TAMAM!' -ForegroundColor Green
    Write-Host "     https://$Domain" -ForegroundColor White
    Write-Host '  ==========================================' -ForegroundColor Green
    Start-Process "https://$Domain"
  } else {
    Write-Host '  Uygulama calisiyor ama https henuz hazir degil.' -ForegroundColor Yellow
    Write-Host '  Saglayicinin panelinde 80 ve 443 portlarinin acik oldugundan emin ol.' -ForegroundColor Yellow
    Write-Host "  Ayrinti: $Dst\kayitlar\https.log" -ForegroundColor Yellow
  }
} catch {
  Write-Host ''
  Write-Host "  HATA: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Bu pencerenin ekran goruntusunu Claude''a gonder.' -ForegroundColor Red
}
Write-Host ''
