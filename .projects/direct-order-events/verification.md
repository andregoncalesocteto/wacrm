# Verificação final: Eventos diretos do cardápio (ticket #25)

Verificação de ponta a ponta da feature na branch `feat/direct-order-events`, contra os 8 critérios de aceite da seção 7 de `prd-menu-events-addendum.md` e os pontos de teste de `spec.md` ("Testing Decisions"). Formato do `../order-journey-recovery/verification.md`.

**Leia primeiro os limites.** Tudo o que é comportamento do CRM foi provado com testes automatizados sobre um banco **simulado em memória** (`src/lib/channels/crm-world.fake.ts`, `engine.characterization.fake.ts`), chamando os handlers de rota como função (`POST(new Request(...))`), sem servidor HTTP. O Postgres real só foi usado para aplicar as migrations e rodar `verify-schema.sql` (seção 3). Nada foi verificado contra WhatsApp/Meta, cardápio ou Supabase reais (seção 5).

Atalhos de arquivo: `route.direct.test.ts` = `src/app/api/v1/journey/events/route.direct.test.ts`; `route.test.ts` = mesma pasta; `integration` = `src/lib/journeys/journey.integration.test.ts` (describe "direct events to a customer who never wrote (consent, closed conversation, template)"); `engine.char.test.ts` = `src/lib/automations/engine.characterization.test.ts`.

## 1. Critérios de aceite do adendo (seção 7)

| # | Critério | Teste que comprova | Lacuna |
| - | -------- | ------------------ | ------ |
| 1 | `Purchase` com `store_key` e `customer.phone` (sem `idtrack`) cria pedido e contato e responde 200 | `route.direct.test.ts` › "Purchase with store_key + phone creates contact, direct Journey and order"; "reuses the contact of the same phone and never overwrites its name"; "finds the contact by a differently formatted stored phone"; "matches the key ignoring case and edge spaces". `integration` › "consent -> contact created -> thank-you and status by template -> closed conversation -> customer reply reopens it" | O cardápio real enviando com a chave certa: **cardápio** |
| 2 | Telefone fora do formato internacional devolve 400 | `route.direct.test.ts` › "rejects the phone %s (not E.164)" (5 formatos); "answers 400 without idtrack and without store_key + phone" | O cardápio normalizar para E.164 (já respondido por eles no adendo, seção 8): **cardápio** |
| 3 | `store_key` desconhecida devolve 404 `store_not_found` e o sistema não repete | `route.direct.test.ts` › "answers 404 store_not_found for an unknown key and leaves nothing behind"; "does not see the store of another account"; "with an unknown store_key the idtrack still attributes the event" | Não haver laço de reenvio no 404: **cardápio** (o adendo e `docs/public-api.md` dizem para não repetir) |
| 4 | Com `consent.notifications: true` recebe agradecimento e avisos de status; com `false` ou sem o campo, nada e `messaging: no_consent` | Com consentimento: `integration` › "consent -> contact created -> thank-you and status by template -> ..." (agradecimento e `preparing` por template, conversa criada fechada, resposta reabre). Sem: `integration` › "without consent the order is recorded, the step is skipped with the reason and nothing is created or sent" (pedido criado, nenhuma conversa, `no_consent`, motivo no log, sem telefone no log); "consent given only for marketing does not release the order notices". Por `false`: `route.direct.test.ts` › "revoking notifications answers no_consent, even for someone who wrote". Quem já escreveu: "someone who wrote is eligible without explicit consent; someone who never did is not". Motor: `engine.char.test.ts` › "consent gate and conversation creation for customers who never wrote (#22)" (10 casos) | Só os 7 status do preset foram exercitados no motor; na integração os status percorridos são `received`, `preparing` e `finished`. Nenhuma mensagem real saiu (seção 5) |
| 5 | `consent.marketing: true` permite o lembrete de carrinho abandonado; sem ele, não sai | `integration` › "abandoned cart of a direct Journey: sent by template only with marketing consent, 10 minutes after the last cart event" (cron real aos 5 e aos 11 min; uma vez só) e "abandoned cart without marketing consent (only notifications): nothing is sent, with the reason logged". Motor: `engine.char.test.ts` › "Abandoned cart for a DIRECT Journey ... (#24)" (10 casos: só `notifications` não basta, revogação, `Purchase` cancela, rajada, resposta na espera, retomadas nunca disparam) | A espera real de 10 min depende do agendador externo chamando o cron (relógio simulado aqui) |
| 6 | `consent.notifications: false` depois de `true` revoga | `route.direct.test.ts` › "an explicit false revokes only that purpose (revoked_at = given_at)"; "a given_at that is not newer changes nothing"; "an event without consent, or without a purpose, changes nothing". `consent.test.ts` › "recordConsent"/"a revocation with no prior row is stored (and holds)". `integration` › "revoking with false after true stops the next notice, end to end" (novo neste ticket) | Nenhuma no lado do CRM |
| 7 | Evento com `idtrack` e `store_key`/`customer` de outro telefone é atribuído pelo `idtrack` | `route.direct.test.ts` › "a conflict: the idtrack wins, nothing of the phone contact changes and the log masks the phone"; "ignores the consent when idtrack and phone resolve different contacts"; "applies the consent of an idtrack event to the contact of the token" (sem conflito) | Nenhuma |
| 8 | Idempotência, reenvio e fila de saída continuam com os campos novos | `route.direct.test.ts` › "a replayed event_id answers the stored response, messaging included"; "a replay of the same event_id does not apply the consent again"; "two simultaneous events for the same unknown phone create ONE contact". `route.test.ts` › "idempotency by event_id" (inalterado, segue verde). `integration` › "a replay of a direct event with the new fields sends, stores and creates nothing again" (cabeçalho `Idempotent-Replayed`, um só pedido, uma só mensagem, consentimento intacto, mesmo `order_id` com outro `event_id`) | A **fila de saída (outbox)** e os tempos de espera são do cardápio. Uma resposta gravada antes da feature não tem `messaging` no replay (documentado) |

## 2. Pontos de teste da spec e cenários extras

| Ponto | Onde está | Cobertura |
| ----- | --------- | --------- |
| 1. Rota pública de eventos (HTTP, banco simulado) | `route.direct.test.ts` (30 casos) e `route.test.ts` | Identificação por chave e telefone, contato criado e nome preservado, `store_not_found`, telefone inválido, conflito com `idtrack`, origem da jornada, atualização/revogação do consentimento, `messaging`, isolamento por conta, `given_at` no futuro (novo: "rejects a given_at more than 5 minutes in the future and accepts a small skew"). Coberto |
| 2. Motor de automações | `engine.char.test.ts` (#19, #22, #24), `send-gate.test.ts` | Bloqueio por falta de consentimento, finalidade por passo, conversa criada fechada, template primeiro, retomadas de 10/30 min ignoradas em jornada direta, carrinho abandonado com `marketing`, condição por sigla do negócio, `{{store_name}}` ("each store gets its own name from the same automation"). Coberto |
| 3. Camada de envio | `src/lib/channels/send.test.ts` › "first contact of a conversation with no message at all goes by template and stays closed"; "outside the window without a template: fails visibly, sends nothing" | Coberto |
| Consentimento e "PARAR" | `consent.test.ts`, `opt-out.test.ts`, `ingest.optout.test.ts`, `fanout.test.ts` ("PARAR"), `consent/no-channel-imports.test.ts` | Coberto; ponta a ponta no `integration` › "PARAR after consent silences the notices; a NEWER consent from the menu reactivates them" (novo: PARAR real via `ingestInbound`, nada enviado mesmo para quem já escreveu, consentimento igual/mais antigo não reativa, mais novo reativa) |
| Loja e chave | `store-key.test.ts`, `validation.test.ts`, `notification-connection.test.ts`, `ui.test.ts` | Chave normalizada, `/` recusado, conexão de avisos (única, padrão, ambígua, Telegram fora) |
| Funil por origem | `funnel.test.ts` | Separação `crm_link`/`menu_direct`, `purchaseRate`, grupos sem conexão/sem loja |

Cenários adicionais deste ticket em `journey.integration.test.ts` (rota real + módulo `journeys` + motor real com o **preset real** + `sendOutbound` real + provider WhatsApp real, bordas simuladas):

- Loja sem conexão de WhatsApp: evento aceito com `messaging: no_connection`, contato, pedido e Journey (`menu_direct`, `connection_id` nulo, `store_id` da loja) criados, nenhuma conversa e nenhuma mensagem; o log diz "sem conexão de avisos da loja".
- Os dois negócios BLC e PZA na mesma conta (`89/RPA/BLC`, `89/RPA/PZA`): um só conjunto de automações, o agradecimento usa `{{store_name}}` e cada cliente recebe o nome da sua loja, pela conexão da sua loja.
- Carrinho abandonado direto com e sem `marketing` (critério 5).

## 3. Banco real: migrations do zero

- Um Postgres descartável (`supabase/postgres:17.6.1.136`, mesma imagem da stack Docker) foi subido num contêiner novo (`pgverify25`, já removido). O schema `storage` foi copiado do banco de desenvolvimento em execução (`pg_dump -s -n storage`), porque a migration `008` precisa de `storage.buckets`; algumas policies do storage que referenciam `public.profiles` falharam na cópia (esperado: a tabela ainda não existia) e não afetam as migrations.
- As **66 migrations** (`001` a `066`) foram aplicadas em ordem, uma transação por arquivo com `ON_ERROR_STOP` (como `docker/supabase/migrate.sh`): **66 aplicadas, 0 falhas**.
- `supabase/ci/verify-schema.sql` rodou em seguida: **`schema verification passed`**.
- As migrations `063` a `066` foram **reaplicadas** por cima (idempotência): 4 de 4 sem erro, e o verify-schema passou de novo.
- O que este passo **não** prova: comportamento em runtime sobre o banco real. Nenhum teste de aplicação rodou contra esse Postgres (índices únicos parciais sob concorrência, `merge_contacts` com dados, RLS com os papéis reais, embeds do PostgREST). Migrations aplicadas em banco vazio, não sobre uma base com dados. Os tickets #17, #18, #20 e #24 conferiram com SQL real a unicidade da chave, o CHECK de jornada e a fusão de contatos (`implementation-notes.md`); neste ticket não repetimos isso.

## 4. Qualidade

| Verificação | Resultado |
| ----------- | --------- |
| `npm run typecheck` | Sem erros |
| `npm test` | 2471 passam, 2 falham (as 2 conhecidas de `src/lib/dashboard/date-utils.test.ts`, fuso horário; já falhavam antes). 183 arquivos, 182 verdes |
| `npm run lint` | 0 erros, **41 avisos, o mesmo número de `main`**. Os 3 arquivos da feature que têm avisos (`pipelines/page.tsx`, `contact-detail-view.tsx`, `contact-sidebar.tsx`) têm os mesmos 9 avisos em `main` (conferido lintando uma cópia limpa de `main`): nenhum aviso novo |
| `npm run build` (env fictício do CI) | Sucesso |
| `npx prettier --check` | Passa nos arquivos novos da feature (`.ts`/`.tsx`/`.sql`/`.json` adicionados em relação a `main`), em `journey.integration.test.ts`, `event-payload.ts` e `docs/order-journey.md`. `docs/public-api.md` já não seguia o prettier em `main` e não foi reformatado |
| `bash -n eventos-diretos-curl.sh` | Sintaxe ok; os 22 corpos JSON gerados (com as variáveis expandidas) são JSON válido. `eventos-diretos-insomnia.json` carrega como JSON (export v4) |

## 5. O que NÃO foi verificado (limites honestos)

- **WhatsApp/Meta reais.** `sendTextMessage` e `sendTemplateMessage` são stubs. Não foi exercitado: um template aprovado de verdade, o primeiro contato por template a um número que nunca falou com a loja, a recusa da Meta (número sem WhatsApp, template rejeitado, limite de conversas iniciadas pela empresa), a janela de 24 h real (aqui é o relógio simulado), nem o recebimento real de "PARAR" e de uma resposta que reabre a conversa (a ingestão foi chamada como função, com o evento já no formato interno).
- **Duas WABAs reais.** A convenção de templates com o mesmo nome em cada WABA (cada marca com o seu conteúdo) **não foi testada**: os testes usam uma só conexão por vez e o nome do template é só um texto no stub. O que está provado é que o envio sai pela conexão da loja certa e que `{{store_name}}` usa a loja certa.
- **O cardápio real.** Nenhum evento do cardápio de verdade: o formato do telefone (E.164), da chave, de `given_at`, o texto do consentimento coletado e a fila de saída com reenvio são do outro time (critérios 2, 3 e 8 só no lado do CRM).
- **Concorrência real no Postgres.** Duas requisições simultâneas, `recordConsent` (compare-and-swap em `updated_at`), o índice único de conversa e de jornada aberta por loja são simulados por intercalamento num processo só; a atomicidade real do Postgres não foi exercitada.
- **Sem servidor HTTP.** As rotas foram chamadas como função: roteamento do Next, middleware, cabeçalhos de proxy e o agendador externo do cron não foram exercitados (o cron foi chamado à mão).
- **UI.** Sem teste de componente para: campos da loja e seletor de conexão de avisos, bloco de consentimento no contato e no painel da inbox, seletor de finalidade nos passos de envio, condição "Sigla do negócio da loja é", origem nos cards/filtros e as novas colunas do funil. Os dados que os alimentam têm teste; a renderização não foi vista neste ticket nem no navegador. Os nomes de tela do manual foram conferidos contra `messages/pt.json`, não contra a tela.
- **Migrations sobre dados existentes** e contra produção: só em banco vazio.
- **O manual do operador** (`manual-configuracao.md`) não foi seguido por uma pessoa de ponta a ponta.

## 6. Discrepâncias e pontos de atenção encontrados

- **`given_at` no futuro** era aceito (risco apontado na revisão); agora `400` se estiver mais de 5 minutos à frente do relógio do CRM. `route.direct.test.ts` passou a fixar o relógio em 2026-10-10 (as datas de consentimento dos testes são de outubro de 2026); o adendo (seção 3) e `docs/public-api.md` foram atualizados.
- **Contradição corrigida em `docs/public-api.md`:** dizia para "não enviar eventos" de quem abre o cardápio sem `idtrack`, o oposto do que esta feature faz.
- **`docs/docker.md`** dizia `055 a 062`; agora lista `063` a `066` e as duas features juntas exigem `055` a `066`.
- O preset e o painel de consentimento mostram "Sem registro" para quem só tem consentimento implícito (já anotado no #20).
- `messaging` só reflete `notifications`; não diz nada sobre `marketing` (por desenho).
- `OrderStatusChanged` direto nunca cria contato; telefone ou pedido desconhecido é `400 order_not_found` (por desenho, #18).
- Risco não tratado nesta versão (na spec): sem teto diário de primeiros contatos por conta; os freios são o limite por chave (120/min), o primeiro contato só por template e o consentimento.
