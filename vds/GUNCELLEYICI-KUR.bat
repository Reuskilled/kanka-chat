@echo off
chcp 65001 >nul
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~f0', [Text.Encoding]::UTF8); $i = $s.IndexOf('#PS-' + 'START'); Invoke-Expression $s.Substring($i)"
pause
exit /b
#PS-START
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Dst = 'C:\KankaChat'
$Host.UI.RawUI.WindowTitle = 'Kanka Chat otomatik guncelleyici kurulumu'
Write-Host ''
Write-Host '  Kanka Chat otomatik guncelleyici kuruluyor...' -ForegroundColor Yellow
try {
  if (-not (Test-Path "$Dst\server.js")) { throw 'C:\KankaChat bulunamadi. Once KUR.bat ile sunucuyu kur.' }
  New-Item -ItemType Directory -Force -Path "$Dst\kayitlar", "$Dst\veri" | Out-Null
  Invoke-WebRequest 'https://raw.githubusercontent.com/Reuskilled/kanka-chat/main/vds/guncelleyici.js' -OutFile "$Dst\guncelleyici.js" -UseBasicParsing
  Write-Host '        Guncelleyici indirildi' -ForegroundColor Green
  $node = "$env:ProgramFiles\nodejs\node.exe"
  @"
@echo off
cd /d $Dst
:dongu
"$node" guncelleyici.js >> "$Dst\kayitlar\guncelleyici-cikti.log" 2>&1
timeout /t 5 /nobreak >nul
goto dongu
"@ | Set-Content -Encoding ASCII "$Dst\calistir-guncelleyici.cmd"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$Dst\calistir-guncelleyici.cmd`"" -WorkingDirectory $Dst
  Stop-ScheduledTask -TaskName 'KankaChat-Guncelleyici' -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName 'KankaChat-Guncelleyici' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'KankaChat-Guncelleyici'
  Write-Host '        Arka planda calismaya basladi' -ForegroundColor Green
  Start-Sleep 8
  Write-Host ''
  if (Test-Path "$Dst\kayitlar\guncelleme.log") { Write-Host '  Son kayitlar:' -ForegroundColor Yellow; Get-Content "$Dst\kayitlar\guncelleme.log" -Tail 6 | ForEach-Object { Write-Host "   $_" } }
  Write-Host ''
  Write-Host '  ==========================================' -ForegroundColor Green
  Write-Host '     TAMAM! Artik guncellemeler kendiliginden gelecek.' -ForegroundColor Green
  Write-Host '  ==========================================' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "  HATA: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Bu pencerenin ekran goruntusunu Claude''a gonder.' -ForegroundColor Red
}
Write-Host ''
