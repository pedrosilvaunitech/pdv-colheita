# Emissão Direta SEFAZ — Guia Operacional

Este guia cobre a emissão de NFC-e (modelo 65) **direto no SEFAZ**, sem
usar provedor pago. Você tem dois motores possíveis:

- **Agente Local** — roda no PC do caixa (Windows). Certificado fica no PC.
- **VPS** — roda num servidor próprio. Certificado fica na VPS.

Ambos usam a mesma biblioteca ([`node-dfe`](https://www.npmjs.com/package/node-dfe))
para construir XML, assinar (XML-DSig) e falar com SEFAZ via SOAP + mTLS.

## Escolha o motor

| Cenário | Motor |
|---|---|
| Loja física com PC no caixa, um só terminal | **Agente Local** |
| Vários terminais na mesma loja | **VPS** (evita duplicar certificado) |
| Emissão via celular/tablet | **VPS** |
| Backup + failover | **Agente Local com fallback VPS** |

## 1. Pré-requisitos (para qualquer motor)

- CNPJ ativo com CNAE de comércio varejista
- Inscrição Estadual (IE) habilitada na SEFAZ
- **Certificado digital A1** (`.pfx` + senha) — compre em Serasa, Certisign, Valid, Soluti
- **CSC ID e CSC Token** — gere no portal da SEFAZ da sua UF
- **Credenciamento NFC-e** aprovado pela SEFAZ

Nada disso o Bastion POS gera pra você — são requisitos legais.

## 2. Motor: Agente Local

### Instalação

1. Baixe o instalador em **PDV → botão de impressora → "Baixar Agente Local"**
2. Instale como Administrador (Windows 10/11)
3. O agente inicia sozinho e escuta em `http://127.0.0.1:9100`

### Configurar certificado

Abra o wrapper Electron e vá em **Configurações fiscais**:

- Caminho do `.pfx`
- Senha
- CSC ID e Token
- UF (`MG`, `SP`, etc.)
- Ambiente: **homologacao** (padrão) ou **producao**
- Série NFC-e

A senha é salva localmente em `%USERPROFILE%\.bastion-pos\fiscal.json` com
permissão restrita. **Nunca sai da máquina.**

### Instalar dep node-dfe

Uma vez, na pasta do agente:

```powershell
cd "C:\Program Files\Bastion POS Agent\resources\app"
npm install node-dfe qrcode node-forge
```

Depois reinicie o agente (ícone da bandeja → "Sair" → abrir de novo).

## 3. Motor: VPS

Ver [`vps-fiscal/README.md`](../vps-fiscal/README.md) para os 3 caminhos de
deploy (Fly.io, Railway, Contabo).

Depois:
1. Em **Configurações → Fiscal**, marque **Motor de Emissão Direta: VPS**
2. Preencha a **URL da VPS**
3. Cadastre o secret `FISCAL_VPS_TOKEN` no painel de secrets do Lovable

## 4. Homologação (obrigatório antes de produção)

A SEFAZ exige que você **emita e valide pelo menos 20 notas de teste** em
ambiente de homologação antes de habilitar produção.

Em **Configurações → Fiscal**, use o botão **"Testar em Homologação"**. Ele
dispara uma venda-teste real, mostra o XML retornado, chave, protocolo e
tempo de resposta. Faça isso ~20 vezes com valores/produtos diferentes.

Depois entre no portal SEFAZ da sua UF, seção "Contribuinte NFC-e", e peça
liberação para produção anexando as notas de teste.

## 5. Virar produção

**Não vire sem homologação completa** — nota errada em produção gera multa.

Em **Configurações → Fiscal**, altere `Ambiente = producao` e salve. As
próximas emissões vão para o SEFAZ real.

## 6. Troubleshooting

### `node-dfe não instalado`
Rode o passo "Instalar dep node-dfe" acima.

### `Arquivo .pfx não encontrado`
Verifique o caminho no `fiscal.json`. Use `\\` em Windows.

### `Rejeição 108: Certificado inválido`
Cert vencido ou senha errada. Compre um novo A1 ou corrija a senha.

### `Rejeição 204: Duplicidade de NF-e`
Número já emitido. Sincronize numeração em **Fiscal → Numeração NFC-e**.

### `Rejeição 539: Rejeição por schema`
Falta CNAE, CRT, NCM, CFOP em algum item, ou IE inválida. Revise o produto.

### `Rejeição 999: Erro não catalogado / SEFAZ fora do ar`
Aguarde 15min e reemita. Confira `/nfce/status`.

### Certificado expira em breve
O card "Certificado" mostra `days_left`. Renove com 15 dias de folga.

## 7. Escopo desta versão

Implementado:
- ✅ Emissão NFC-e (mod. 65) autoriz. síncrona
- ✅ Cancelamento (≤30min)
- ✅ Inutilização de faixa
- ✅ Consulta de status
- ✅ QR Code + URL de consulta SEFAZ

**Fora do escopo desta iteração:**
- ❌ NF-e (mod. 55) — em breve
- ❌ Contingência offline (EPEC/FS-DA)
- ❌ CC-e (carta de correção)
- ❌ Manifesto do destinatário

## 8. Referências

- [Manual do Contribuinte NFC-e (v6.00)](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=NFCe.pdf)
- [Portal NFC-e SEFAZ-MG](https://portalsped.fazenda.mg.gov.br/portalnfe/section/main.html)
- [Códigos de rejeição SEFAZ](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=W0jrOhoRvUE=)
- [node-dfe no npm](https://www.npmjs.com/package/node-dfe)
