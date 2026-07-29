# Bastion PDV — Guia de Compilação e Implantação

Este repositório contém **três artefatos independentes**. Entender o papel de
cada um evita 90% da confusão na hora de instalar no cliente:

| # | Artefato | Onde roda | Para que serve |
|---|----------|-----------|----------------|
| 1 | **App web (PDV)** | Nuvem (Lovable) / navegador | Telas de venda, estoque, fiscal, relatórios |
| 2 | **Agente Local** (`desktop/`) | PC de **cada caixa** (Windows) | Impressora ESC/POS, gaveta, balança, pinpad TEF e (opcional) emissão da NFC-e |
| 3 | **Servidor Fiscal Node** (`vps-fiscal/`) | **Um** servidor da loja ou VPS | Assina e transmite a NFC-e à SEFAZ para **todos** os caixas |

> **Onde fica o "servidor Node que emite a nota fiscal"?**
> Na pasta [`vps-fiscal/`](./vps-fiscal). É um Node/Express independente do app
> web. Ele pode rodar em um PC da própria loja (o do escritório serve), num
> mini-PC, ou numa VPS/nuvem. O endereço dele (IP ou domínio) é cadastrado no
> PDV em **Configurações → Servidor Fiscal** (rota `/servidor-fiscal`).

---

## Sumário

1. [Escolhendo a arquitetura](#1-escolhendo-a-arquitetura)
2. [Compilar o EXE/MSI do PDV + Agente](#2-compilar-o-exemsi-do-pdv--agente-desktop)
3. [Compilar e subir o Servidor Fiscal Node](#3-compilar-e-subir-o-servidor-fiscal-node-vps-fiscal)
4. [Apontar o PDV para o servidor (IP ou domínio)](#4-apontar-o-pdv-para-o-servidor-ip-ou-domínio)
5. [Checklist de homologação](#5-checklist-de-homologação)
6. [Solução de problemas](#6-solução-de-problemas)

---

## 1. Escolhendo a arquitetura

Escolha **antes** de compilar — muda o que você precisa instalar.

### A) Caixa único → motor no próprio Agente

```
[ PC do caixa ]
  Agente Local (.exe) ──► SEFAZ
     ├── impressora / gaveta / balança / TEF
     └── motor NFC-e (node-dfe) + certificado A1
```

Mais simples: nada além do `.exe`. O certificado A1 fica no PC do caixa.
Se esse PC desligar, ninguém emite.

### B) Dois ou mais caixas → Servidor Fiscal central (recomendado)

```
[ Caixa 1 ] Agente (.exe) ──┐
[ Caixa 2 ] Agente (.exe) ──┼──► [ Servidor Fiscal Node ] ──► SEFAZ
[ Caixa 3 ] Agente (.exe) ──┘        (vps-fiscal/)
                                     certificado A1 (1 cópia só)
```

O Agente continua obrigatório em cada caixa (é ele que fala com a impressora,
a gaveta, a balança e o pinpad), mas **a nota sai pelo servidor central**.
Vantagens: um único certificado para renovar, numeração centralizada, e um
caixa desligado não trava a emissão dos outros.

> A numeração da NFC-e é reservada de forma atômica no banco
> (`reserve_nfce_number`), então dois caixas emitindo no mesmo segundo
> **nunca** recebem o mesmo número — independente da arquitetura.

---

## 2. Compilar o EXE/MSI do PDV + Agente (`desktop/`)

O executável é **um só**: ele abre o PDV em modo quiosque e sobe o Agente
Local em `127.0.0.1:9100` no mesmo processo.

### 2.1 Pré-requisitos (máquina que vai COMPILAR)

| Item | Versão | Observação |
|---|---|---|
| Windows 10/11 x64 | — | Para gerar `.exe`/`.msi` nativo |
| Node.js | ≥ 20 LTS | https://nodejs.org |
| Python | 3.x | Exigido pelo `node-gyp` |
| Visual Studio Build Tools 2022 | — | Workload **"Desktop development with C++"** |
| WiX Toolset | 3.14 | Só para `.msi` — o script baixa sozinho se faltar |

O pacote `usb` compila bindings nativos (libusb). Sem os Build Tools, o
`npm install` falha com erro de `node-gyp`.

### 2.2 Instalar dependências

```bash
cd desktop
npm install
```

### 2.3 Incluir o motor fiscal no Agente (arquitetura A)

Pule este passo se você vai usar o Servidor Fiscal central (arquitetura B).

```bash
cd desktop
npm run install:fiscal
```

Isso instala `node-dfe`, `node-forge` e `qrcode`. Depois de instalado, o
badge **"Motor pronto"** aparece em **Configurações → Fiscal**.

### 2.4 Apontar para a URL do seu PDV

Edite `desktop/config.example.json` (vira `config.json` na primeira execução):

```json
{
  "url": "https://pdv-colheita.lovable.app/pdv?kiosk=1",
  "kiosk": true,
  "startMinimized": false
}
```

### 2.5 Gerar o executável

```bash
cd desktop

npm run pack:win    # pasta portátil  → release/BastionPOSAgent-win32-x64/
npm run zip:win     # ZIP distribuível → release/BastionPOSAgent-win32-x64.zip
npm run msi:win     # instalador       → release/BastionPOSAgent.msi
```

Outras plataformas: `npm run pack:mac`, `npm run pack:linux`.

**O que entregar ao cliente:** o `.msi` (instala, cria atalho e inicia com o
Windows) ou o `.zip` (portátil, basta descompactar e rodar
`BastionPOSAgent.exe`).

### 2.6 Compilar pelo GitHub Actions (sem PC Windows)

O workflow [`.github/workflows/desktop-msi.yml`](./.github/workflows/desktop-msi.yml)
compila em runner Windows, assina o binário (se os segredos de certificado
estiverem cadastrados) e publica em **Releases**. Dispare em
**Actions → Desktop MSI → Run workflow**.

### 2.7 Primeira execução no caixa

1. Instale e abra o `BastionPOSAgent`.
2. Windows Defender pode pedir liberação de rede → **Permitir** (rede privada).
3. No PDV, vá em **Configurações → Hardware** e confirme:
   - Agente online (badge verde com a versão);
   - impressora detectada e selecionada;
   - o caixa aparece em **Terminais** com nome próprio (ex.: "Caixa 01").

Cada caixa recebe um `terminal_key` único automaticamente — é isso que impede
que o Caixa 2 imprima na impressora do Caixa 1.

---

## 3. Compilar e subir o Servidor Fiscal Node (`vps-fiscal/`)

Este é o servidor que assina o XML e conversa com a SEFAZ. Fonte completa e
opções de deploy em [`vps-fiscal/README.md`](./vps-fiscal/README.md).

### 3.1 Requisitos do servidor

- Node.js ≥ 20 (ou Docker)
- Certificado **A1** (`.pfx`) válido e a senha dele
- **CSC ID** e **CSC Token** emitidos no portal da SEFAZ da sua UF
- Porta liberada (padrão `3737`) e, para acesso externo, HTTPS

### 3.2 Rodar em um PC/servidor da própria loja

```bash
git clone <seu-repo>
cd vps-fiscal
npm install                 # instala express, node-dfe, node-forge, qrcode

# credenciais (nunca commite este arquivo)
cp .env.example .env        # edite com seus dados

npm start                   # sobe em http://0.0.0.0:3737
```

Variáveis obrigatórias no `.env`:

```ini
FISCAL_VPS_TOKEN=<token forte, mínimo 32 caracteres>
FISCAL_PFX_PATH=/certs/loja.pfx
FISCAL_PFX_PASSWORD=<senha do certificado A1>
FISCAL_CSC_ID=000001
FISCAL_CSC_TOKEN=<CSC da SEFAZ>
FISCAL_UF=MG
FISCAL_ENVIRONMENT=homologacao      # troque para "producao" só após homologar
FISCAL_CNPJ=00000000000000
FISCAL_IE=<inscrição estadual>
FISCAL_RAZAO_SOCIAL=<razão social>
FISCAL_CRT=1
FISCAL_SERIE=1
PORT=3737
```

**Deixar rodando sempre** (Windows, como serviço):

```powershell
npm i -g pm2 pm2-windows-startup
pm2 start server.js --name bastion-fiscal
pm2 save
pm2-startup install
```

**Deixar rodando sempre** (Linux):

```bash
sudo npm i -g pm2
pm2 start server.js --name bastion-fiscal
pm2 save && pm2 startup
```

### 3.3 Rodar com Docker

```bash
cd vps-fiscal
docker build -t bastion-fiscal .
docker run -d --name bastion-fiscal --restart unless-stopped \
  --env-file .env \
  -v /caminho/dos/certs:/certs:ro \
  -p 3737:3737 \
  bastion-fiscal
```

### 3.4 Conferir se subiu

```bash
curl http://localhost:3737/health
# {"ok":true,"version":"1.0.0","node":"v20.x","engine_ready":true}
```

`engine_ready: false` significa que o `node-dfe` não carregou — rode
`npm install` de novo no servidor.

### 3.5 Expor com segurança

O servidor fiscal **nunca** deve ficar aberto na internet sem TLS e sem token.

- **Rede local:** deixe só na LAN e use o IP interno (ex.: `192.168.0.50:3737`).
  Libere a porta no firewall apenas para a faixa da loja.
- **Acesso externo:** ponha Nginx/Caddy na frente com Let's Encrypt e use um
  domínio (`https://fiscal.suaempresa.com.br`).

Exemplo de Nginx:

```nginx
server {
  server_name fiscal.suaempresa.com.br;
  location / {
    proxy_pass http://127.0.0.1:3737;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;   # SEFAZ é lenta em horário de pico
  }
}
```

---

## 4. Apontar o PDV para o servidor (IP ou domínio)

No PDV, abra **Servidor Fiscal** no menu lateral (rota `/servidor-fiscal`):

1. Escolha **Servidor fiscal central**.
2. Preencha o **endereço**: aceita IP com porta (`192.168.0.50:3737`) ou
   domínio (`https://fiscal.suaempresa.com.br`). Se você digitar só o IP, o
   `http://` é completado automaticamente.
3. Opcional: preencha o **servidor reserva**, usado se o principal cair.
4. Cadastre o **token Bearer** (o mesmo `FISCAL_VPS_TOKEN` do `.env`) como
   segredo no backend — o valor **nunca** trafega para o navegador.
5. Clique em **Salvar**, depois em **Testar conexão** e em **Validar servidor**.

O teste completo confere: URL válida, segredo cadastrado, `/health`, motor
`node-dfe` carregado, certificado A1 e conexão com a SEFAZ.

---

## 5. Checklist de homologação

Antes de emitir nota real:

- [ ] `FISCAL_ENVIRONMENT=homologacao` no servidor **e** ambiente de
      homologação selecionado no PDV
- [ ] Certificado A1 dentro da validade
- [ ] CSC ID e CSC Token corretos (atenção: os rótulos vêm invertidos em
      alguns portais da SEFAZ)
- [ ] Série e próximo número conferidos em **Fiscal → Numeração NFC-e**
- [ ] Ao menos 20 notas de teste aprovadas em homologação
- [ ] Auditoria de numeração sem duplicidades nem lacunas
      (**Erros fiscais → Auditoria de numeração**)
- [ ] Só então trocar para `producao` nos dois lados

---

## 6. Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| `node-gyp` falha no `npm install` | Faltam Build Tools/Python | Instale VS Build Tools 2022 com C++ e Python 3 |
| `Could not find light.exe or candle.exe` | WiX ausente do PATH | Rode `npm run msi:win` de novo (baixa sozinho) ou use `npm run zip:win` |
| Badge "Motor com pendências" | `node-dfe` não instalado | `cd desktop && npm run install:fiscal` |
| "Agente offline" no PDV | Executável fechado ou firewall | Abra o Agente e libere `127.0.0.1:9100` |
| `Servidor fiscal respondeu HTTP 401` | Token divergente | Confirme que o segredo no PDV é igual ao `FISCAL_VPS_TOKEN` |
| `não respondeu em 10s` | IP/porta errados ou firewall | Teste `curl http://IP:3737/health` do PC do caixa |
| Nota fica "pendente" | SEFAZ fora ou erro de conteúdo | Veja o motivo em **Erros fiscais**; a fila reprocessa sozinha |

Segurança e boas práticas de credenciais: [`SECURITY.md`](./SECURITY.md).
