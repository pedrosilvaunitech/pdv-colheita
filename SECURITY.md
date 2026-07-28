# Política de Segurança — PDV Colheita

## Classificação de credenciais

| Valor | Classificação | Onde vive |
|---|---|---|
| `VITE_SUPABASE_URL`, `SUPABASE_PROJECT_ID` | Público | `.env` (versionado pela plataforma) |
| `sb_publishable_...` | Público por design | `.env` + bundle do browser |
| Service role key / senha do banco | **Segredo** | Indisponível no Lovable Cloud — não existe no repositório |
| Certificado A1 (.pfx) e sua senha | **Segredo** | Tabela `fiscal_configs`, protegida por RLS |
| CSC Token NFC-e | **Segredo** | Tabela `fiscal_configs`, protegida por RLS |
| Credenciais TEF (SiTef, PayGo, Cielo…) | **Segredo** | Configuração local do Agente, no PC do caixa |

O que protege os dados **não** é a chave publicável: é o RLS, habilitado em
100% das tabelas do schema `public`.

## Proteções ativas

1. **Gitleaks no CI** (`.github/workflows/secret-scan.yml`) — roda em todo push
   e PR, mais uma varredura semanal do histórico completo (`fetch-depth: 0`).
   Regras extras em `.gitleaks.toml` cobrem CSC da NFC-e, senha de certificado
   A1 e blobs PKCS#12 em base64.
2. **`.env.example`** — documenta as variáveis necessárias sem expor valores.
3. **Auditoria de RPC + rate limit** — tabelas `rpc_audit_log` e
   `rpc_rate_limits` registram e bloqueiam chamadas sensíveis abusivas.
4. **Testes de RLS** (`src/tests/rls.test.ts`) executados no CI.

## Ações manuais necessárias no GitHub

Estas não podem ser feitas a partir do código — precisam ser feitas por você,
com permissão de admin no repositório:

1. **Tornar o repositório privado**
   `Settings → General → Danger Zone → Change repository visibility → Private`.
   O sync bidirecional com o Lovable continua funcionando normalmente.
2. **Ativar o Secret scanning e o Push protection**
   `Settings → Code security and analysis`:
   - *Secret scanning* → **Enable**
   - *Push protection* → **Enable** (bloqueia o push que contenha um segredo
     reconhecido, antes de ele entrar no histórico)
   - *Dependabot alerts* e *Dependabot security updates* → **Enable**
   Em repositório privado, esses recursos exigem GitHub Advanced Security nos
   planos Team/Enterprise; o job do Gitleaks acima cobre o mesmo cenário sem
   custo adicional.
3. **Desativar o remix público** no Lovable, se estiver ligado:
   `Project Settings → General → Public remixing`.

## Rotação de credenciais

Sempre que uma credencial for exposta (chat, print de tela, log, commit):

- **CSC NFC-e** — gerar novo código no portal da SEFAZ-MG e reeditar em
  *Configurações → Fiscal & Certificado A1*. O CSC ID (`000001`) pode ser
  reaproveitado ou incrementado.
- **Certificado A1** — revogar na AC emissora e reemitir.
- **Credenciais TEF** — solicitar novas chaves à adquirente.

## Reportando uma vulnerabilidade

Abra uma issue privada (Security → Report a vulnerability) ou contate o
administrador da loja. Não abra issue pública com detalhes exploráveis.
