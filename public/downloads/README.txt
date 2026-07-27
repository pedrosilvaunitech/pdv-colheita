Bastion POS Agent — instaladores
=================================

Distribuição recomendada (automática):
  O workflow .github/workflows/desktop-msi.yml compila, assina e publica
  o instalador no GitHub Releases ao criar uma tag `agent-v*`:

    git tag agent-v1.5.0 && git push origin agent-v1.5.0

  Artefatos publicados:
    BastionPOSAgent-Setup.msi        (instalador Windows x64)
    BastionPOSAgent-win32-x64.zip    (versão portátil)
    SHA256SUMS.txt                   (integridade)

  Depois, defina a env VITE_AGENT_INSTALLER_URL apontando para a URL do
  release (ex.: https://github.com/ORG/REPO/releases/latest/download/
  BastionPOSAgent-Setup.msi). O botão "Baixar Agente Local" no PDV usa
  essa URL automaticamente.

Assinatura digital:
  Configure em Settings > Secrets > Actions:
    WINDOWS_CERT_PFX_BASE64  -> base64 do certificado .pfx (Code Signing)
    WINDOWS_CERT_PASSWORD    -> senha do .pfx
  Sem esses segredos o build continua, porém sem assinatura (o Windows
  SmartScreen exibirá aviso na primeira execução).

Alternativa manual (hospedar aqui):
  1. cd desktop && npm install
  2. npm run pack:win && npm run msi:win
  3. Copie o arquivo para este diretório como:
       BastionPOSAgent-Setup.exe   (nome padrão usado pelo PDV)
