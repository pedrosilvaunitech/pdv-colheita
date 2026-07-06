
# Expansão do sistema — 5 fases

Vou entregar em fases porque são ~15 integrações diferentes. Cada fase é utilizável de forma independente e não bloqueia a próxima. As integrações externas (Pix real, NFC-e, WhatsApp Cloud) precisam de credenciais suas — deixo tudo com **seletor de provedor** para você configurar quando tiver a conta.

## Fase 1 — Núcleo operacional do caixa (nesta rodada)

**Banco:**
- `cash_registers` (sessões de caixa: aberto/fechado, abertura, fechamento, operador, loja)
- `cash_movements` (sangria, suprimento, reforço, retirada — com motivo e valor)
- `customers`: já existe, adicionar `discount_percent`, `credit_limit`, `birthday`, `tags`
- `products`: adicionar `is_weighable` (balança), `unit` (UN/KG/L), `ncm`, `cest`, `cfop`
- `receipt_settings` por loja: `default_document` (fiscal/nao_fiscal), `printer_target`, `logo_url`, `footer_text`

**Telas:**
- `/caixa` — abrir caixa (valor inicial), fechar caixa (contagem cega + diferença), sangria, suprimento, histórico de sessões, relatório Z (fechamento por forma de pagamento)
- PDV bloqueia venda se caixa da loja não estiver aberto para o operador
- Botão "Imprimir" no PDV com dropdown **[Recibo não-fiscal | NFC-e]** + default configurável

**Recibo não-fiscal:**
- Template térmico 58mm/80mm em HTML/CSS printer-friendly
- Envio para impressora via Web USB / Web Serial (ESC/POS)
- Fallback: PDF para download / envio WhatsApp

## Fase 2 — Nota Fiscal (NFC-e) real com escolha de provedor

**Seletor de provedor fiscal** (`fiscal_configs.provider`):
- Focus NFe, PlugNotas, NFe.io, Migrate, WebmaniaBR — mesma interface interna, adapters diferentes
- Server function `emitir_nfce({ sale_id })` → chama adapter → grava `invoices` (chave, protocolo, XML, DANFE URL, status)
- Fluxo de contingência offline, cancelamento (< 30 min), inutilização de numeração
- Configuração de certificado A1 (upload .pfx no Storage, criptografado)

**Escolha na venda:**
- Toggle padrão da loja (fiscal/não-fiscal)
- Override por venda (checkbox "Emitir NFC-e" ou "Só recibo")
- CPF/CNPJ na nota (opcional) — busca cliente ou avulso

## Fase 3 — Pagamentos: Pix real + Maquininha

**Pix (multi-PSP)** — tabela `payment_providers` com `type='pix'` e seletor:
- Mercado Pago, Efí, Sicredi, Banco do Brasil, Itaú, Sicoob, Asaas, PagBank, Cora
- Server function `criar_cobranca_pix({ valor, sale_id })` → adapter → retorna QR Code (base64) + `txid`
- Webhook `/api/public/webhooks/pix/:provider` valida assinatura, marca venda como paga, dispara impressão
- Tela PDV mostra QR + polling a cada 3s até confirmação

**Maquininha (TEF/Pay)**:
- Adapters: Cielo Lio (Pay integrado), Stone/Pagar.me, GetNet, PagBank, SiTef (TEF genérico)
- Modo TEF: comunicação via agente local (documentado, opcional)
- Modo Pay: SDK web/deep-link para maquininha Android

## Fase 4 — Hardware (Web APIs do navegador)

Requer Chrome/Edge desktop em HTTPS (publicação Lovable atende).

- **Leitor de código de barras USB/Bluetooth**: keyboard-wedge (auto — já funciona no PDV atual). Adicionar buffer inteligente + som ao ler.
- **Leitor de mesa (RS-232/USB serial)**: Web Serial API
- **Balança** (Toledo Prix, Filizola, Urano, Elgin): Web Serial, protocolos configuráveis (Prix III, P05, PS)
- **Impressora térmica** (Elgin i9, Bematech MP-4200, Epson TM-T20, Daruma, Iris/Sweda): Web USB + ESC/POS via biblioteca `esc-pos-encoder`
- **Página de configuração de hardware** `/hardware` com teste de cada equipamento

## Fase 5 — WhatsApp + Notificações + Clientes/Fornecedores/Descontos

**WhatsApp (multi-provedor)** — `whatsapp_configs.provider`:
- WhatsApp Cloud API (oficial Meta), Twilio, Z-API, Evolution API, Baileys (self-hosted), UltraMsg, ChatPro
- Templates: recibo de venda, cobrança Pix, aniversário do cliente, estoque baixo (para gerente), fechamento de caixa
- Agendador via `pg_cron` chamando `/api/public/hooks/whatsapp-scheduler` (aniversários, resumo diário, alertas de vencimento fiscal)

**Clientes / Fornecedores / Descontos:**
- Cliente: histórico de compras, saldo/crediário, desconto fixo, cashback (opcional)
- Fornecedores: já existe, adicionar contatos múltiplos, condições de pagamento
- Regras de desconto: por cliente, por categoria, por produto, por quantidade, promoções vigência

## Detalhes técnicos

- **Adapters pattern**: cada integração externa é uma classe com interface comum (`PixProvider`, `FiscalProvider`, `WhatsAppProvider`, `PrinterDriver`). Trocar de provedor = mudar config, sem tocar em código de negócio.
- **Server functions** (`createServerFn` + `requireSupabaseAuth`) para toda chamada externa; secrets via `add_secret`.
- **Webhooks públicos** em `/api/public/webhooks/*` com validação de assinatura HMAC.
- **RLS** em todas as novas tabelas, escopo por `store_id` via `has_store_access()`.
- **Tokens semânticos NOC/SOC** mantidos.

## O que preciso de você (só quando chegar a hora, não agora)

- Fase 2: qual provedor fiscal você vai contratar (posso deixar todos configuráveis, você ativa 1)
- Fase 3: credenciais do PSP Pix escolhido (`client_id`/`client_secret` ou certificado)
- Fase 5: token da API WhatsApp escolhida

## Ordem de execução

**Agora**: Fase 1 completa (caixa + recibo não-fiscal + toggle fiscal/não-fiscal + hardware discovery UI).
**Próximas rodadas** (você me chama): Fase 2 → 3 → 4 → 5.

Confirma que sigo com a Fase 1?
