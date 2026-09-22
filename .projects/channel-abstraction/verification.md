# US-072 — Verificação final na stack Docker

Verificação de ponta a ponta da feature de abstração de canais (lojas, conexões, WhatsApp oficial + Telegram),
rodando contra a stack Docker completa (`docker-compose.yml` + `docker-compose.supabase.yml`), com a conta de
teste `qa-channels@example.com`. Toda verificação usa **payloads simulados** (assinados/autenticados com os
segredos locais), nunca uma conta real da Meta nem um bot real do Telegram — ambos inalcançáveis neste ambiente
(ver `progress.txt`, seção "Codebase Patterns").

## 1. Stack sobe do zero, migrations aplicam

- `docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local up --build -d --wait`
  rodado contra o projeto Docker de desenvolvimento (imagem do app reconstruída, todos os serviços — db, auth,
  rest, storage, realtime, imgproxy, kong, studio, meta, app — convergem `Healthy` em ~37s) e o serviço `migrate`
  roda e conclui sem erro (`migrations: 0 applied` — as 51 já estavam aplicadas; confirma que o comando exato do
  critério funciona de ponta a ponta, incluindo o build da imagem).
- Migrations **do zero**: replay isolado (`-p wacrm-replay`, volumes novos, nunca toca os dados de dev) das 51
  migrations de `001` a `051_final_contract_migration.sql`, seguido de `supabase/ci/verify-schema.sql` —
  **51 applied, "schema verification passed"**, ~16s. Projeto isolado destruído com `down -v` ao final (o
  projeto de dev nunca foi derrubado).
- **Atendido.**

## 2. Cenário das duas lojas (com dev-browser, app em `localhost:3000`)

Semeados via SQL direto nas tabelas `stores` / `channel_connections` / `channel_connection_credentials` da conta
de teste (credenciais cifradas com a `ENCRYPTION_KEY` real do `.env.local`, no mesmo formato GCM que
`getConnectionCredentials` espera) — não existe fluxo de UI para conectar um canal sem uma conta real da Meta ou
um bot real do Telegram, então este é o caminho documentado desde as primeiras histórias para simular conexões:

- **Loja Centro** → conexão WhatsApp Cloud (`pn-verify-centro-001`)
- **Loja Norte** → conexão WhatsApp Cloud (`pn-verify-norte-002`) + conexão Telegram (`999000111`)

Mensagens de entrada **simuladas**:
- Dois webhooks do WhatsApp (`POST /api/whatsapp/webhook`), assinados com HMAC-SHA256 usando o `META_APP_SECRET`
  local (`x-hub-signature-256`), do **mesmo número** de cliente (`15551230001`) para cada uma das duas conexões.
- Uma atualização do Telegram (`POST /api/channels/telegram/webhook/<connectionId>`), com o header
  `X-Telegram-Bot-Api-Secret-Token` batendo com o `secret_token` gravado nas credenciais da conexão.

Resultado (confirmado no banco e na tela do Inbox, `localhost:3000/inbox`, print em
`.dev-browser/tmp/inbox-initial.png` e `contact-sidebar-wide.png`):
- As três mensagens aparecem no mesmo inbox, cada uma com o selo certo: **"Loja Centro · WhatsApp"**,
  **"Loja Norte · WhatsApp"**, **"Loja Norte · Telegram"**. Contadores de não lidas por loja batendo
  (Loja Centro 1, Loja Norte 2).
- **O mesmo cliente (telefone `15551230001`) escrevendo às duas lojas WhatsApp vira UM contato só** (uma linha
  em `contacts`, uma identidade `whatsapp:phone`), com **duas conversas** — uma por conexão/loja. Confirmado no
  banco (`contacts`/`conversations` por `connection_id`) e na UI: o painel do contato lista as duas conversas em
  "CONVERSAS" (`Loja Norte · WhatsApp` e `Loja Centro · WhatsApp`).
- O cliente do Telegram (chat id diferente, sem telefone) vira um contato separado, com identidade
  `telegram:chat_id` (+ `telegram:username`), exibido como "Cliente Verificação" — nome do canal, sem exigir
  telefone.
- **Atendido.**

## 3. Desativar / apagar conexão

- **Desativar** "Telegram Norte" (que tinha 1 conversa): confirmado por diálogo, toast "Conexão desativada.
  Conversas abertas: 1.". A conversa continua **legível** no inbox (histórico intacto, badge "Desativada"), mas
  o compositor é substituído pelo aviso "Esta conexão está desativada; reative-a em Configurações → Canais para
  responder" com link direto — sem caixa de texto para enviar.
- **Apagar**: o botão "Apagar" **não aparece** para conexões com conversas (`canDeleteConnection` = `!has_conversations`,
  `src/lib/channels/ui.ts`) — nem para "Telegram Norte" nem para as duas WhatsApp. Criada uma conexão Telegram
  adicional **sem nenhuma conversa** ("Telegram Temp (sem conversas)"); só nela o botão "Apagar" aparece, e
  apagar funciona (toast "Conexão apagada.", linha removida da lista).
- **Atendido.**

## 4. Limpeza

Toda a semeadura (2 lojas, 3 conexões + credenciais, 2 contatos, 3 identidades, 3 conversas, 3 mensagens) foi
apagada da conta de teste ao final; `/inbox` volta a mostrar "Nenhuma conversa encontrada". Nenhum dado de
desenvolvimento pré-existente foi tocado.

## Métricas de sucesso (PRD, seção "Success Metrics")

1. **Regressão zero no WhatsApp oficial** — Atendida. `TZ=UTC npm test` verde (160 arquivos / 1935 testes),
   incluindo os testes de caracterização das US-002 a US-004 (`send-message.characterization.test.ts`,
   `webhook/route.characterization.test.ts`, `broadcast-deliver`/`flows`/`automations`/`ai` characterization),
   que seguem passando sem alteração de asserção desde a US-002.
2. **O caso das pizzarias funciona** — Atendida. Ver seção 2 acima: 2 lojas, 2 canais (WhatsApp + Telegram), um
   inbox, o mesmo cliente como um contato só com duas conversas.
3. **Um canal novo não toca o núcleo** — Atendida. Nenhum arquivo do núcleo (`src/lib/channels/{ingest,fanout,send,media}.ts`)
   nem dos componentes do inbox (`src/components/inbox/*.tsx`, exceto o teste `telegram-contact.test.tsx`) menciona
   "telegram"; o suporte a Telegram vive inteiramente em `src/lib/channels/providers/telegram/` + o registro em
   `providers/index.ts`.
4. **Uma loja nova é conectada em menos de 10 minutos** — **Não verificável neste ambiente** (marcada no PRD como
   `[SUPOSIÇÃO NÃO VALIDADA]`): exige o assistente de conexão real contra uma conta da Meta ou um bot do Telegram
   de verdade, que este ambiente não alcança. **Verificação manual pendente**, fora desta feature.
5. **O CRM funciona igual para um contato do Telegram** — Atendida. Comprovado tanto por
   `src/lib/channels/providers/telegram/crm.integration.test.ts` (US-059: automação, flow, negócio, tag, nota e
   campo customizado rodando sobre um contato só de Telegram, sem telefone/wamid) quanto pela verificação manual
   desta história (contato do Telegram exibido corretamente no inbox e no painel lateral, sem exigir telefone).
6. `npm run lint`, `npm run typecheck`, `TZ=UTC npm test` e `npm run build` passam — ver seção "Checks" abaixo.

## O que exige uma conta real da Meta ou um bot real do Telegram (verificação manual, fora desta feature)

- Conectar um número WhatsApp de verdade pelo assistente de 4 passos (registro na Meta, PIN de 2 etapas,
  assinatura do app à WABA).
- Conectar um bot Telegram de verdade (webhook público, `getMe`, `setWebhook`) — precisa de um túnel público
  (ver `docs/telegram.md`).
- Health check (`GET /api/channels/cron/health`) contra credenciais reais.
- Envio de saída (mensagens, templates, broadcasts) contra a Meta/Telegram de verdade — os testes automatizados
  já cobrem o caminho de envio com `fetch` mockado; o round-trip real (webhook de status entregue/lido) não é
  alcançável aqui.
- Métrica de sucesso 4 (tempo de conexão de uma loja nova) acima.

## Checks

- `npm run typecheck`: limpo.
- `npm run lint`: **0 erros, 41 avisos** (linha de base da feature antes da US-001; `react/jsx-no-literals`
  zerado — corrigido nesta história um literal `": "` fora de um container JSX introduzido pela US-040 em
  `src/components/settings/connection-detail.tsx`, o único aviso que esta feature havia deixado acima da base).
- `TZ=UTC npm test`: 160 arquivos / 1935 testes, verde.
- `npm run build`: verde (ver nota abaixo sobre o servidor de dev).
- Servidor de dev (`:3100`) parado antes do build e reiniciado depois; `AGENTS.md` restaurado com
  `git checkout -- AGENTS.md` (o `next dev` o reescreve ao subir).
