<#
  Instala o Servidor Fiscal como SERVIÇO do Windows (sobe sozinho no boot,
  reinicia se cair). Usa NSSM, que é o jeito mais estável de transformar um
  processo Node em serviço.

  Execute em um PowerShell ABERTO COMO ADMINISTRADOR:
    powershell -ExecutionPolicy Bypass -File .\install-service.ps1

  Para remover depois:
    nssm remove BastionFiscal confirm
#>

$ErrorActionPreference = "Stop"

# Exige elevação: criar serviço é operação administrativa.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Abra o PowerShell como Administrador e rode novamente." -ForegroundColor Red
  exit 1
}

$Root = Split-Path -Parent $PSScriptRoot
$ServiceName = "BastionFiscal"
$Port = 3737

# 1) NSSM disponivel?
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)?.Source
if (-not $nssm) {
  Write-Host "NSSM nao encontrado. Baixando..." -ForegroundColor Yellow
  $tmp = Join-Path $env:TEMP "nssm.zip"
  $dest = Join-Path $env:ProgramData "nssm"
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $tmp -UseBasicParsing
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
  $nssm = Join-Path $dest "nssm-2.24\$arch\nssm.exe"
  if (-not (Test-Path $nssm)) { throw "Falha ao extrair o NSSM." }
}
Write-Host "NSSM: $nssm" -ForegroundColor Green

# 2) Dependencias instaladas
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Push-Location $Root
  npm install --omit=dev
  Pop-Location
}

$node = (Get-Command node).Source

# 3) (Re)cria o servico
& $nssm stop $ServiceName 2>$null | Out-Null
& $nssm remove $ServiceName confirm 2>$null | Out-Null

& $nssm install $ServiceName $node "server.js"
& $nssm set $ServiceName AppDirectory $Root
& $nssm set $ServiceName DisplayName "Bastion POS - Servidor Fiscal (NFC-e)"
& $nssm set $ServiceName Description "Motor de emissao de NFC-e/NF-e para os caixas do Bastion POS."
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout (Join-Path $Root "logs\service-out.log")
& $nssm set $ServiceName AppStderr (Join-Path $Root "logs\service-err.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000

New-Item -ItemType Directory -Force -Path (Join-Path $Root "logs") | Out-Null

# 4) Repassa o .env para o servico (variaveis de ambiente do processo).
$envFile = Join-Path $Root ".env"
if (Test-Path $envFile) {
  $pairs = @()
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $idx = $line.IndexOf("=")
      $k = $line.Substring(0, $idx).Trim()
      $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
      $pairs += "$k=$v"
    }
  }
  if ($pairs.Count -gt 0) {
    & $nssm set $ServiceName AppEnvironmentExtra ($pairs -join "`n")
  }
} else {
  Write-Host "AVISO: .env nao encontrado. O servico vai subir sem configuracao fiscal." -ForegroundColor Yellow
}

# 5) Libera a porta no firewall (rede privada) para os caixas alcancarem.
if (-not (Get-NetFirewallRule -DisplayName "Bastion Fiscal $Port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Bastion Fiscal $Port" -Direction Inbound `
    -LocalPort $Port -Protocol TCP -Action Allow -Profile Private | Out-Null
  Write-Host "Regra de firewall criada para a porta $Port (perfil privado)." -ForegroundColor Green
}

& $nssm start $ServiceName

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "Servico '$ServiceName' instalado e iniciado." -ForegroundColor Green
Write-Host "Nos caixas, em Configuracoes -> Servidor fiscal, use: http://${ip}:$Port" -ForegroundColor Cyan
Write-Host "Logs em: $(Join-Path $Root 'logs')" -ForegroundColor DarkGray
