# Emissão fiscal (NFC-e / NF-e) — guia completo

Este guia explica como configurar o módulo fiscal do Bastion POS para emitir NFC-e (venda ao consumidor) e NF-e (nota entre empresas) em produção, usando um provedor real e o certificado digital A1 já cadastrado.

O sistema já vem pronto: a **credencial do provedor pode ficar para depois**. Enquanto ela não é preenchida, o PDV opera em modo recibo não-fiscal (documento de treinamento) e o botão de emissão fica bloqueado com uma mensagem explicando o que falta.

---

## 1. O que você precisa antes de começar

Todos os itens abaixo estão listados como checklist na tela `Nota Fiscal → Passo a passo para andar na lei`. Marque cada item conforme conclui.

1. **CNPJ ativo** com CNAE de comércio varejista compatível (ex.: 4711-3/02 supermercado, 4712-1/00 mini-mercado, 4761-0/03 papelaria).
2. **Inscrição Estadual (IE)** habilitada na SEFAZ do seu estado. MEI pode ser isento em alguns estados — verifique.
3. **Certificado digital A1 (e-CNPJ)** — arquivo `.pfx` com senha, válido por 12 meses. Compre em uma AC credenciada ICP-Brasil (Serasa, Certisign, Valid, Soluti). Preço médio R$ 180 a R$ 300/ano.
4. **Credenciamento na SEFAZ** para NFC-e/NF-e. Obtenha o **CSC ID** e o **CSC Token** no portal da SEFAZ do seu estado.
5. **Conta em um provedor de emissão** (recomendado). O provedor cuida da comunicação com a SEFAZ, retentativas, contingência e histórico dos XMLs. Sem provedor você precisaria implementar todo o protocolo SOAP com a SEFAZ do seu estado.

---

## 2. Provedores suportados

O sistema aceita seis destinos para transmissão da nota. Escolha um em `Configurações → Fiscal & Certificado A1 → Provedor de emissão`.

| Provedor        | Preço médio por nota | Site oficial                | Segredo esperado no backend       |
|-----------------|----------------------|-----------------------------|-----------------------------------|
| Focus NFe       | R$ 0,08              | https://focusnfe.com.br     | `FISCAL_FOCUS_NFE_TOKEN`          |
| PlugNotas       | R$ 0,09              | https://plugnotas.com.br    | `FISCAL_PLUGNOTAS_API_KEY`        |
| NFe.io          | R$ 0,12              | https://nfe.io              | `FISCAL_NFE_IO_API_KEY`           |
| WebmaniaBR      | R$ 0,15              | https://webmaniabr.com      | `FISCAL_WEBMANIA_API_KEY`         |
| TecnoSpeed      | sob contrato         | https://tecnospeed.com.br   | `FISCAL_TECNOSPEED_API_KEY`       |
| Direto SEFAZ    | grátis (só custo do certificado) | manual do estado | não usa segredo — usa o `.pfx` + CSC |

Todos os provedores oferecem plano **sandbox/homologação** gratuito para você testar sem gastar créditos e sem gerar nota válida.

---

## 3. Como obter a chave/API de cada provedor

### Focus NFe

1. Crie a conta em https://app.focusnfe.com.br/cadastro.
2. Após confirmar o e-mail, faça login e vá em **Empresas → Cadastrar empresa**. Anexe o `.pfx` e informe a senha.
3. Em **Empresas → sua empresa → Tokens de acesso**, gere um token para o ambiente **produção** (e outro para homologação, se quiser testar antes).
4. Copie o valor exibido (começa com letras/números; ex.: `abcd1234...`). Guarde — ele só aparece uma vez.
5. No Bastion POS, abra `Configurações → Fiscal & Certificado A1`, marque **Configurar credencial depois = OFF**, clique em **Salvar credencial** e cole o token no formulário seguro que aparece. O token vira a variável de ambiente `FISCAL_FOCUS_NFE_TOKEN` no backend — nunca fica no navegador.

Documentação da API: https://focusnfe.com.br/doc/

### PlugNotas

1. Cadastro em https://app.plugnotas.com.br/cadastro.
2. Em **Certificados**, faça o upload do `.pfx` com a senha. O provedor emite pela sua identidade a partir daí.
3. Em **API → Chaves de acesso**, gere uma **API Key**. Guarde o valor.
4. Configure a chave no Bastion POS como `FISCAL_PLUGNOTAS_API_KEY` (mesmo passo do Focus NFe).

Documentação: https://plugnotas.com.br/docs

### NFe.io

1. Conta em https://app.nfe.io.
2. **Configurações → Empresas → adicionar** e envie o `.pfx`.
3. **Configurações → API → Token da conta**, copie o valor.
4. Configure como `FISCAL_NFE_IO_API_KEY`.

Documentação: https://nfe.io/docs

### WebmaniaBR

1. Conta em https://webmaniabr.com/nfe.
2. **Configurações → Certificado**, faça o upload do `.pfx`.
3. **API → Consumer Key / Consumer Secret / Access Token / Access Token Secret** — a autenticação é OAuth 1.0a. Cole os 4 valores concatenados no formato `consumer_key:consumer_secret:access_token:access_token_secret` como `FISCAL_WEBMANIA_API_KEY`.

Documentação: https://webmaniabr.com/docs/rest-api-nfe

### TecnoSpeed (PlugNotas white label / NDDigital)

1. Comercial responde no https://tecnospeed.com.br. É contrato B2B (não self-service).
2. Após o contrato, você recebe um `token` e a URL do ambiente. Configure `FISCAL_TECNOSPEED_API_KEY` (token) e informe a URL em `Configurações → Fiscal → URL da API`.

### Direto SEFAZ (avançado)

Não precisa provedor. O sistema assina o XML localmente com o `.pfx` e envia direto para os webservices SOAP da SEFAZ do seu estado. Exige:

- O `.pfx` cadastrado.
- O CSC ID e CSC Token cadastrados.
- Homologação prévia manual no PSC (Portal do Contribuinte) do seu estado.

Só recomendo essa opção se você já opera nota fiscal e conhece o Manual de Orientação do Contribuinte (MOC) da SEFAZ. Para 99% dos comércios, um provedor sai mais barato do que o custo de manter esse código.

---

## 4. Fluxo passo a passo dentro do Bastion POS

1. **Cadastre a loja** em `Lojas → Nova loja`. O criador é vinculado automaticamente como **admin dev**.
2. Envie o **certificado A1**: `Configurações → Fiscal & Certificado A1 → Enviar .pfx / .p12`. Informe a senha antes de escolher o arquivo. Ele fica em bucket privado; o navegador nunca lê o arquivo depois disso.
3. Preencha **CNAE, CRT, CSC ID, CSC Token**.
4. Escolha o **Provedor de emissão** e o **Ambiente** (comece em homologação).
5. Marque **Configurar credencial depois = ON** enquanto ainda não tem o token do provedor. O sistema aceita salvar tudo mesmo assim e mostra na tela `Nota Fiscal` que a emissão está bloqueada por falta de credencial.
6. Quando tiver a chave do provedor: desmarque o toggle e clique em **Salvar credencial**. Um formulário seguro do Lovable Cloud abre — cole a chave lá. Ela é guardada como variável de ambiente do backend, nunca vai ao navegador.
7. Ajuste a **numeração NFC-e/NF-e** para o próximo número disponível (peça a última nota emitida ao contador, ou zere se for CNPJ novo).
8. Emita uma nota de teste em **homologação** através da tela `Nota Fiscal → Emitir nota (teste)`. Se a SEFAZ autorizar, a nota volta com chave de acesso + protocolo + link do XML.
9. Mude o ambiente para **produção**. A partir daí cada venda finalizada no PDV emite NFC-e válida.

---

## 5. Modelo de segurança

- O certificado A1 é armazenado no bucket privado `fiscal-certificates`, com política RLS que só permite acesso a admins/gerentes da loja dona.
- A senha do certificado, o token do provedor e o CSC Token viram **variáveis de ambiente do backend** (`Lovable Cloud → Segredos`) — nunca aparecem no navegador ou no HTML da página.
- A emissão real acontece dentro de uma **server function** com `requireSupabaseAuth`, então cada emissão é rastreada pelo usuário autenticado que a disparou.
- Os XMLs autorizados são baixados pelo backend e gravados na tabela `invoices` (chave de acesso, protocolo, status, link do PDF/DANFE). Guarde-os por 5 anos (obrigação fiscal).

---

## 6. Solução de problemas

- **"Provedor sem credencial configurada"** — abra `Configurações → Fiscal → Salvar credencial` e cole a chave do provedor. Enquanto ela não existir, o backend recusa emitir para não gerar nota corrompida.
- **"Certificado inválido ou senha incorreta"** — reenvie o `.pfx`; a senha precisa ser digitada de novo (não fica salva em texto claro).
- **"Rejeição SEFAZ 539"** — número da nota duplicado. Ajuste em `Configurações → Numeração` para o próximo livre.
- **"Rejeição SEFAZ 233"** — CSC incorreto. Confira ID + Token no portal SEFAZ do estado.
- **Certificado expirado** — o campo `Válido até` aparece em vermelho a menos de 30 dias do vencimento. Compre um novo `.pfx` e reenvie.

Para dúvidas sobre a operação, consulte o Manual de Orientação do Contribuinte (MOC) da SEFAZ ou o suporte técnico do provedor escolhido.
