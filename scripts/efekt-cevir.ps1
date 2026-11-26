<#
.SYNOPSIS
  Kanka Chat Efekt Dönüştürücü — Yeşil/siyah arka planlı ham videoyu şeffaf VP9+Alpha (.webm) profil efektine
  veya hareketli şeffaf Animated WebP (.webp) avatar çerçevesine çevirir.

.EXAMPLE
  # Yeşil perde (.mp4) -> Şeffaf VP9+Alpha profil efekti (450x880):
  .\scripts\efekt-cevir.ps1 -InputFile .\ejderha.mp4 -OutputFile .\public\effects\ejderha.webm -Type profile -Key green

  # Yeşil perde (.mp4) -> Hareketli şeffaf avatar çerçevesi (288x288 .webp):
  .\scripts\efekt-cevir.ps1 -InputFile .\kedi_kulak.mp4 -OutputFile .\public\effects\kedi_cerceve.webp -Type frame -Key green

  # Yeşil perde (.mp4) -> Şeffaf isim plakası (640x140 .webm):
  .\scripts\efekt-cevir.ps1 -InputFile .\plaka.mp4 -OutputFile .\public\effects\plaka.webm -Type nameplate -Key green
#>
param(
  [Parameter(Mandatory=$true)][string]$InputFile,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [ValidateSet('profile','frame','nameplate')][string]$Type = 'profile',
  [ValidateSet('green','black','none')][string]$Key = 'green',
  [double]$Similarity = 0.24,
  [double]$Blend = 0.10
)

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Error "ffmpeg bulunamadi. 'winget install Gyan.FFmpeg' ile kurup tekrar dene."
  exit 1
}

$filters = @()
if ($Key -eq 'green') {
  $filters += "colorkey=0x00FF00:${Similarity}:${Blend},despill=type=green"
} elseif ($Key -eq 'black') {
  $filters += "colorkey=0x000000:${Similarity}:${Blend}"
}

if ($Type -eq 'profile') {
  $filters += "scale=450:880:force_original_aspect_ratio=decrease,fps=30"
  $vf = $filters -join ','
  & ffmpeg -y -i $InputFile -vf $vf -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 900k -an $OutputFile
} elseif ($Type -eq 'nameplate') {
  $filters += "scale=640:160:force_original_aspect_ratio=decrease,fps=30"
  $vf = $filters -join ','
  & ffmpeg -y -i $InputFile -vf $vf -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 500k -an $OutputFile
} else {
  $filters += "scale=288:288:force_original_aspect_ratio=decrease,fps=24"
  $vf = $filters -join ','
  & ffmpeg -y -i $InputFile -vf $vf -c:v libwebp -lossless 0 -q:v 78 -loop 0 -an $OutputFile
}

if ($LASTEXITCODE -eq 0) {
  $kb = [Math]::Round((Get-Item $OutputFile).Length / 1KB, 1)
  Write-Host "TAMAM: $OutputFile ($kb KB)" -ForegroundColor Green
}
