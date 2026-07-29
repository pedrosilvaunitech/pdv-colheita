# Bastion POS — Motor Fiscal em VPS

Servidor Node/Express que expõe endpoints REST para emissão de NFC-e/NF-e
direto na SEFAZ, usando **mutual TLS** com o certificado A1 (`.pfx`) e
**assinatura XML-DSig**. Rodado numa VPS acessível pelo seu backend Lovable.

Este é o motor de referência para o modo `direct_engine=vps` do PDV.

## Por que uma VPS?

O backend do Lovable (Cloudflare Workers) não pode:
- Apresentar certificado cliente no handshake TLS (mTLS).
- Executar bibliotecas Node com dependências nativas de crypto.
- Manter estado suficiente para retransmitir SOAP com timeouts longos.

O agente local resolve isso quando o caixa está online. A VPS resolve quando
você quer emissão do lado servidor (celular, terminais que não rodam Windows,
frentes headless, etc).

## Endpoints

Todos exigem `Authorization: Bearer <FISCAL_VPS_TOKEN>`, exceto `/health`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Info do processo, sem auth |
| GET | `/nfce/status` | Status do serviço SEFAZ da UF configurada |
| POST | `/nfce/emit` | Emite NFC-e (mod. 65) — body: DTO da venda |
| POST | `/nfce/cancel` | Cancela NFC-e (≤30min) |
| POST | `/nfce/inutilizar` | Inutiliza faixa de numeração |

## Variáveis de ambiente

Obrigatórias:

```
FISCAL_VPS_TOKEN=<token forte, min 32 chars>
FISCAL_PFX_PATH=/certs/store.pfx
FISCAL_PFX_PASSWORD=<senha do .pfx>
FISCAL_CSC_ID=000001
FISCAL_CSC_TOKEN=<token CSC do SEFAZ>
FISCAL_UF=MG
FISCAL_ENVIRONMENT=homologacao
FISCAL_CNPJ=51483602000188
FISCAL_IE=<inscrição estadual>
FISCAL_RAZAO_SOCIAL=<razão social>
FISCAL_CRT=1
FISCAL_SERIE=1
PORT=3737
```

## Deploy

### Opção A — Fly.io (grátis até 3 apps)

```bash
cd vps-fiscal
fly launch --name bastion-fiscal --now
fly secrets set FISCAL_VPS_TOKEN=... FISCAL_PFX_PASSWORD=... [demais]
# subir o .pfx como volume
fly volumes create certs --size 1
# copiar o .pfx no volume (via fly ssh)
```

### Opção B — Railway (US$ 5/mês)

1. Novo projeto → Deploy from GitHub / Upload
2. Configure secrets no painel
3. Adicione um volume em `/certs` e faça upload do `.pfx`

### Opção C — Windows (sem Docker, sem Linux)

O servidor é Node puro: roda em qualquer Windows 10/11 ou Windows Server.
Pode ser uma máquina dedicada, o PC da retaguarda ou até o caixa principal.

1. Instale o **Node.js 20 LTS** (https://nodejs.org).
2. Copie a pasta `vps-fiscal` para, por exemplo, `C:\bastion-fiscal`.
3. Copie o certificado A1 para `C:\bastion-fiscal\certs\store.pfx`.
4. Copie `.env.example` para `.env` e preencha, usando caminho Windows:
   `FISCAL_PFX_PATH=C:\bastion-fiscal\certs\store.pfx`
5. Rodar em primeiro plano (para testar):

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\start.ps1
```

6. Rodar como **serviço do Windows** (sobe no boot, reinicia sozinho) —
   PowerShell **como Administrador**:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-service.ps1
```

O script instala o NSSM, cria o serviço `BastionFiscal`, repassa o `.env`,
grava logs em `vps-fiscal\logs\` e libera a porta 3737 no firewall privado.
Para remover: `nssm remove BastionFiscal confirm`.

Nos caixas, em **Configurações → Servidor fiscal**, aponte para
`http://<ip-do-servidor>:3737`. Como é IP privado da rede local, o app aceita
`http://` sem TLS. Se for expor pela internet, use HTTPS (IIS/Nginx/Cloudflare
Tunnel na frente) — nunca abra a porta 3737 direto ao público.

### Opção D — Contabo/Hetzner (~R$ 25/mês)


```bash
apt install docker.io -y
git clone <seu-repo>/vps-fiscal
cd vps-fiscal
cp .env.example .env && vim .env
docker build -t bastion-fiscal .
docker run -d --name bastion-fiscal \
  --env-file .env \
  -v /root/certs:/certs:ro \
  -p 3737:3737 \
  bastion-fiscal
```

Ponha atrás de Nginx com Let's Encrypt para expor via HTTPS.

## Segurança

- **Nunca** exponha esta VPS diretamente ao público sem TLS e sem Bearer token.
- **Nunca** commite o `.pfx` no git. Monte como volume.
- Rotacione `FISCAL_VPS_TOKEN` no mesmo turno em que rotacionar o certificado.
- Restrinja acesso via firewall à origem do Cloudflare Workers se possível.

## Integração com PDV

Em **Configurações → Fiscal**, escolha **VPS Externa** no card "Motor de
Emissão Direta" e preencha a URL (ex.: `https://fiscal.suaempresa.com`).
Cadastre o token em segredos com nome `FISCAL_VPS_TOKEN`.

## Homologação

Antes de virar produção, emita ≥20 notas de teste em homologação e valide
no portal SEFAZ da sua UF. Só depois altere `FISCAL_ENVIRONMENT=producao`.
