# Bastion POS · Agente de Impressão Local & Wrapper Desktop

Executável nativo (`.exe` / `.msi` para Windows, `.app` para macOS,
`AppImage/tar.gz` para Linux) que faz duas coisas:

1. **Agente de Impressão Local** — servidor HTTP em `http://127.0.0.1:9100`
   que recebe bytes ESC/POS via `POST /print` e envia direto para a
   impressora USB, **sem diálogo de impressão** e sem drivers extras.
2. **Wrapper do PDV** — abre a URL publicada do PDV em janela **kiosk**
   fullscreen, com ícone na bandeja do sistema e inicialização automática.

O PWA/navegador tenta este agente **antes** de WebUSB/Web Serial, então
basta instalar o `.exe` uma vez no PDV e a impressão passa a funcionar
imediatamente — inclusive em Firefox/Safari, que não têm WebUSB.

---

## 1. Pré-requisitos para compilar

| Plataforma | Requisitos |
| --- | --- |
| Windows 10/11 x64 | Node.js ≥ 20, Python 3, Build Tools for Visual Studio 2022 (workload "Desktop development with C++"), WiX Toolset 3.14 (para `.msi`) |
| macOS 12+        | Node.js ≥ 20, Xcode Command Line Tools |
| Linux (Ubuntu)   | Node.js ≥ 20, `build-essential libudev-dev libusb-1.0-0-dev` |

O pacote `usb` compila bindings nativos (libusb) durante o `npm install`.
Se falhar, revise os requisitos acima.

---

## 2. Instalação de dependências

```bash
cd desktop
npm install
```

Isso baixa Electron, express, `usb` (com libusb) e o packager.

---

## 3. Configuração da URL do PDV

Edite `config.example.json` colocando a URL publicada do seu projeto:

```json
{
  "url": "https://SEU-PROJETO.lovable.app/pdv?kiosk=1",
  "kiosk": true,
  "startMinimized": false
}
```

Salve como `config.json`. Após empacotar, esse arquivo deve ficar **ao lado
do executável** (`C:\Program Files\Bastion POS\config.json`, por exemplo).
O instalador MSI copia automaticamente se você deixar o arquivo em
`desktop/config.json` antes de rodar `pack:win`.

---

## 4. Testar em desenvolvimento

```bash
npm start          # abre a janela Electron + agente
# ou apenas o agente (útil em modo debug):
npm run agent-only
```

Teste o agente com curl:

```bash
curl http://127.0.0.1:9100/status
# {"version":"1.0.0","printers":["Epson-04b8:0202"],"platform":"...","arch":"x64"}

# imprimir "TESTE\n" + corte:
printf 'TESTE\n\n\n\n\n\x1dV\x42\x00' | curl -X POST \
  --data-binary @- -H 'Content-Type: application/octet-stream' \
  http://127.0.0.1:9100/print
```

---

## 5. Compilar para Windows (.exe + .msi)

```bash
# 1) Gera pasta portátil release/BastionPOSAgent-win32-x64/BastionPOSAgent.exe
npm run pack:win

# 2) Gera instalador MSI (requer WiX Toolset instalado)
npm run msi:win
# saída: release/msi/BastionPOSAgent.msi
```

**Distribuição rápida sem MSI:** compacte a pasta `release/BastionPOSAgent-win32-x64/`
em `.zip` e envie ao cliente. Basta descompactar e rodar `BastionPOSAgent.exe`.

**Assinatura digital (opcional mas recomendado):** use `signtool` com um
certificado EV Code Signing para evitar o SmartScreen alertar o usuário:

```powershell
signtool sign /f cert.pfx /p SENHA /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
  release\BastionPOSAgent-win32-x64\BastionPOSAgent.exe
signtool sign /f cert.pfx /p SENHA /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
  release\msi\BastionPOSAgent.msi
```

---

## 6. Compilar para macOS (.app / .zip)

```bash
npm run pack:mac
cd release && zip -r BastionPOSAgent-mac.zip BastionPOSAgent-darwin-x64/
```

**Notarização (para distribuição fora da Mac App Store):**

```bash
xcrun notarytool submit BastionPOSAgent-mac.zip \
  --apple-id você@dominio.com --team-id ABCDE12345 --password @keychain:AC_PASSWORD \
  --wait
xcrun stapler staple release/BastionPOSAgent-darwin-x64/BastionPOSAgent.app
```

---

## 7. Compilar para Linux (.tar.gz)

```bash
npm run pack:linux
tar czf release/BastionPOSAgent-linux-x64.tar.gz -C release BastionPOSAgent-linux-x64/
```

Para rodar como serviço, crie um unit systemd:

```ini
# /etc/systemd/system/bastion-agent.service
[Unit]
Description=Bastion POS Agent
After=network.target

[Service]
Type=simple
ExecStart=/opt/bastion/BastionPOSAgent
Restart=always
User=pos

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now bastion-agent
```

---

## 8. Instalando no PDV do cliente (Windows)

1. Copie `BastionPOSAgent.msi` para a máquina do PDV.
2. Duplo-clique → **Avançar → Instalar** (requer admin).
3. O instalador cria:
   - Atalho no Menu Iniciar e Área de Trabalho.
   - Entrada de auto-start (o agente sobe junto com o Windows).
   - Regra automática de Firewall (loopback, seguro).
4. Abra o PDV no navegador → **botão Impressora → Agente Local**.
   Status deve mostrar `Online · vX.Y.Z · N impressora(s)`.

**Se a impressora não aparecer no `/status`:** o driver de impressora nativo
do Windows está com posse exclusiva do dispositivo. Opções:

- **(Recomendado)** No **Gerenciador de Dispositivos**, localize a impressora,
  desinstale o driver "USB Printing Support" e reconecte — o `usb`/libusb
  passa a enxergar. Não afeta impressão via agente.
- **(Alternativo)** Use o **Zadig** (https://zadig.akeo.ie/) e substitua o
  driver por **WinUSB** — permite tanto o Agente quanto o modo WebUSB.

---

## 9. Segurança

- O agente **só faz bind em 127.0.0.1** (loopback). Não é acessível pela
  rede local nem pela internet.
- CORS liberado por design — o PWA roda em outra origem
  (`*.lovable.app`) e precisa chamar o loopback.
- Não há autenticação: qualquer processo local pode imprimir. Isto é
  aceitável para um terminal de PDV dedicado; se o computador for
  compartilhado, considere adicionar um `X-Agent-Token` (edite `agent.cjs`).

---

## 10. Estrutura do repositório desktop/

```
desktop/
├── package.json           # deps + scripts pack:win/mac/linux
├── main.cjs               # janela Electron + tray + carrega o PDV
├── agent.cjs              # servidor HTTP em 127.0.0.1:9100
├── build-msi.cjs          # gera instalador Windows (.msi)
├── config.example.json    # copie como config.json ao lado do .exe
├── assets/                # ícones (icon.ico / icon.icns / icon.png)
└── release/               # saída de builds (não versionada)
```

---

## 11. Suporte a marcas testadas

Detecção automática por vendorId nas marcas mais comuns no Brasil:
Epson, Bematech, Elgin, Daruma, Custom, Bixolon, Star, Sunmi, Xprinter,
Citizen. Modelos genéricos costumam responder também via detecção de
classe USB 7 (Printer). Se sua impressora não aparecer no `/status`,
abra uma issue anexando a saída de `usb.getDeviceList()` no modo debug.
