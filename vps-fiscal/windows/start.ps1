<#
  Bastion POS — Servidor Fiscal (NFC-e) no Windows
  ------------------------------------------------
  Sobe o motor fiscal em uma máquina Windows (servidor, ou até o PC do caixa
  principal). Não precisa de Docker nem de Linux: é Node.js puro.

  Uso:
    1. Instale o Node.js 20 LTS  ->  https://nodejs.org
    2. Copie o certificado A1 para  C:\bastion-fiscal\certs\store.pfx
    3. Preencha o arquivo .env (use .env.example como base)
    4. Botão direito neste arquivo -> "Executar com o PowerShell"
       (ou:  powershell -ExecutionPolicy Bypass -File .\start.ps1 )
#>

$ErrorActionPreference = "Stop"

# Raiz do projeto = pasta pai de \windows
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "=== Bastion POS — Servidor Fiscal (Windows) ===" -ForegroundColor Cyan

# 1) Node.js presente?
try {
  $nodeVersion = (node --version) 2>$null
} catch {
  $nodeVersion = $null
}
if (-not $nodeVersion) {
  Write-Host "Node.js nao encontrado. Instale o Node 20 LTS em https://nodejs.org e rode de novo." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}
$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($major -lt 18) {
  Write-Host "Node $nodeVersion e antigo. Instale a versao 20 LTS." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}
Write-Host "Node $nodeVersion OK" -ForegroundColor Green

# 2) Dependencias
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Write-Host "Instalando dependencias (npm install)..." -ForegroundColor Yellow
  npm install --omit=dev
}

# 3) Variaveis de ambiente a partir do .env
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  Write-Host "Arquivo .env nao encontrado em $envFile." -ForegroundColor Red
  Write-Host "Copie o .env.example para .env e preencha os dados fiscais." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $idx = $line.IndexOf("=")
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    # Nunca imprimir o valor: pode ser senha do certificado ou token.
    [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
  }
}

# 4) Checagens rapidas antes de subir
foreach ($k in @("FISCAL_VPS_TOKEN", "FISCAL_PFX_PATH", "FISCAL_PFX_PASSWORD", "FISCAL_CNPJ", "FISCAL_UF")) {
  if (-not [System.Environment]::GetEnvironmentVariable($k, "Process")) {
    Write-Host "Variavel obrigatoria ausente no .env: $k" -ForegroundColor Red
    Read-Host "Pressione Enter para sair"
    exit 1
  }
}

$pfx = [System.Environment]::GetEnvironmentVariable("FISCAL_PFX_PATH", "Process")
if (-not (Test-Path $pfx)) {
  Write-Host "Certificado A1 nao encontrado em: $pfx" -ForegroundColor Red
  Write-Host "Ajuste FISCAL_PFX_PATH no .env (ex.: C:\bastion-fiscal\certs\store.pfx)." -ForegroundColor Red
  Read-Host "Pressione Enter para sair"
  exit 1
}

$port = [System.Environment]::GetEnvironmentVariable("PORT", "Process")
if (-not $port) { $port = "3737"; [System.Environment]::SetEnvironmentVariable("PORT", $port, "Process") }

Write-Host "Certificado OK. Subindo o servidor na porta $port..." -ForegroundColor Green
Write-Host "Nos caixas, aponte 'Servidor fiscal' para: http://<ip-desta-maquina>:$port" -ForegroundColor Cyan

node server.js
