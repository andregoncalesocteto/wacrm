# Notas de implementação — Eventos diretos do cardápio

Memória entre tickets, na branch `feat/direct-order-events`. Cada ticket acrescenta uma seção. As notas da jornada original estão em `../order-journey-recovery/implementation-notes.md`.

## #17 Campos da loja (código, sigla, sigla do negócio), chave e conexão de avisos

**Migration `063_store_key_and_notification_connection.sql`** (aplicada do zero com as 063 migrations num Postgres descartável `supabase/postgres:17.6.1.136`, `verify-schema.sql` passou, reaplicação idempotente, unicidade/`/`/coexistência `89/RPA/BLC` x `89/RPA/PZA` conferidas com SQL real). Em `stores`: `store_code`, `store_acronym`, `business_acronym` (nulos, CHECK: já aparados, não vazios, até 40, sem `/`), `store_key_normalized` (coluna GERADA, minúscula, nula se faltar uma das três partes) com índice único parcial `stores_account_store_key_uniq (account_id, store_key_normalized)`, e `notification_connection_id` (FK `channel_connections` ON DELETE SET NULL, nula). Lojas existentes ficam sem chave.

**Para reaproveitar**
- `src/lib/stores/notification-connection.ts`: `findStoreByKey(db, accountId, key)` -> `{id, name} | null` (normaliza a chave recebida; chave malformada -> null); `resolveNotificationConnection(db, accountId, storeId)` -> `{ok:true, connectionId} | {ok:false, reason:'none'|'ambiguous'}`; `isValidNotificationConnection`; `isPhoneReachableChannel(type)`.
- `src/lib/stores/store-key.ts`: `buildStoreKey(parts)` (texto como digitado, ou null), `normalizeStoreKey(raw)` (partes aparadas + minúscula; espaços ao redor das `/` são tolerados), e os corpos de erro `STORE_KEY_TAKEN` (409 `store_key_taken`) e `INVALID_NOTIFICATION_CONNECTION` (400 `invalid_notification_connection`).
- `GET /api/v1/stores` devolve `store_code`, `store_acronym`, `business_acronym`, `store_key`. `notification_connection_id` NÃO foi exposto na API v1 (não pedido).

**Decisões**
- "Alcançável por telefone" = capacidade declarada pelo provider: `capabilities.initiate !== 'after_inbound'` (WhatsApp sim, Telegram não), via registry + `registerBuiltinProviders` (como `automations/engine.ts`); o módulo não importa provider concreto. A UI (só para decidir o que oferecer) usa `channel_type === 'whatsapp_cloud'` em `notificationCandidates`; o servidor revalida.
- Conexão ativa = não desabilitada e status `connected`/`degraded`. Uma só ativa -> ela (mesmo que o padrão aponte para outra inativa); várias -> o padrão se estiver entre as ativas, senão `ambiguous`.
- Duplicata de chave vem do índice único (`23505`) -> 409 com `code`; a UI traduz. Sem pré-consulta (evita corrida).
- Na criação de loja `notification_connection_id` não nulo é 400 (loja nova não tem conexões); a UI só mostra o seletor ao editar, com 2+ conexões WhatsApp ativas da loja.
- `ON DELETE SET NULL` no FK; o servidor é quem garante mesma loja/conta/WhatsApp (sem FK composta nem trigger).

**Fora**: a API v1 não expõe a conexão padrão; nenhuma rota pública usa ainda `findStoreByKey`/`resolveNotificationConnection` (tickets seguintes).

## #19 Variável `{{store_name}}` e condição `business_acronym_is`

Sem migration (usa `stores.business_acronym` do #17). Tudo em `src/lib/automations/engine.ts`.

**Para reaproveitar**
- `storeOfConversation(args, conversationId)` (privada do motor): conversa -> `channel_connections.store_id` -> `stores` (`name`, `business_acronym`), tudo filtrado por `account_id`; null sem conexão/loja.
- `interpolate(s, args, extra?)` ganhou o 3º parâmetro `{ store_name }`: a substituição é síncrona, então o passo `send_message` resolve a loja ANTES (só se o texto usa `{{store_name}}`) e passa o valor, sem reinterpretar o nome da loja como variável.
- Condição `business_acronym_is`: sigla em `operand`; tipo em `src/types`, `validate.ts`, construtor, textos nos 4 idiomas.

**Decisões**
- Aviso de loja ausente vai no `detail` do passo (`sent via Meta (id); warning: ...`), status continua `success`.
- `{{store_name}}` usa a conversa que o envio vai usar (`resolveConversationId`); a condição usa a da `conditionConversation` (contexto, senão a mais recente do contato), como as demais.
- Validação: operando em branco é inválido; sem limite de tamanho.

**Fora**: preset inalterado; convenção de templates com mesmo nome por WABA documentada em `docs/order-journey.md`, não testada com duas WABAs reais.

## #18 Eventos diretos: identificação por chave da loja e telefone

**Migration `064_direct_journeys.sql`** (aplicada do zero com as 064 migrations num Postgres descartável, `verify-schema.sql` passou, reaplicação idempotente; unicidade, CHECK e `merge_contacts` conferidos com SQL real). `journeys.origin` (`crm_link` default | `menu_direct`), `journeys.store_id` (FK `stores` CASCADE, nulo nas existentes), `journeys.link_sent_at` e `journeys.connection_id` agora NULOS, CHECK `journeys_connection_or_store` (conexão OU loja), índice único parcial `uq_journeys_open_contact_store (account, contact, store) WHERE state='open' AND connection_id IS NULL` (o `uq_journeys_open_contact_connection` continua como está: NULLs são distintos). `orders.idtrack` nulo. `contacts.source` (texto, nulo = legado; `'menu'` nos criados por evento direto). `merge_contacts` redefinida (cópia da 058) para colidir também Jornadas abertas sem conexão da mesma loja.

**Para reaproveitar**
- `src/lib/journeys/direct.ts`: `resolveDirectContact` (usa `resolveOrCreateContact` SEM nome, para nunca sobrescrever; nome e `source` só no contato recém-criado), `findContactByPhone` (só leitura, usa `findContact`, agora exportada de `channels/identity.ts`), `findConversationId`, `maskPhone` (últimos 4 dígitos), `MENU_CONTACT_SOURCE`, e **`resolveMessagingEligibility`** (`eligible | no_consent | no_connection`): o ponto único que o #20 estende com o consentimento guardado.
- `journeys.ts`: `openDirectJourney` / `findOpenDirectJourney` (por conexão; sem conexão, por loja). A Jornada direta nasce já na etapa do evento (`directStage` de cada handler em `events.ts`: ViewContent browsing, AddToCart cart, InitiateCheckout checkout, Purchase nasce em checkout e vai a `won` pelo fluxo normal); o deal nasce no estágio da Jornada (`ensureJourneyDeal` usa `journey.stage`, não mais `link_sent` fixo).
- `event-payload.ts`: `CommonEventFields` ganhou `storeKey`, `customer {phone, name}`, `consent {notifications?, marketing?, givenAt?}` (só formato validado; `undefined` = omitido, nunca revogação). `events.ts`: `identify()` (idtrack primeiro; conflito com telefone registrado com `console.warn` mascarado) e `EventIdentity.customerApplies` (false no conflito): **o #20 deve ignorar `customer`/`consent` quando for false** (já vai em `HandlerContext.identity`).
- `respond.ts`: `storeNotFound()` / código `store_not_found` (404).

**Decisões**
- Com `idtrack` presente, `store_key` não é resolvida (nem gera 404) e `customer.phone` só serve para detectar conflito; telefone desconhecido não é anexado ao contato do token.
- `OrderStatusChanged` direto nunca cria contato (telefone desconhecido = `order_not_found`).
- Evento direto só dispara `onJourneyEventAccepted`/`onOrderStatusChanged` se `messaging === 'eligible'` e já houver conversa (conversa para quem nunca escreveu é do #20). Eventos com `idtrack` disparam como antes.
- `messaging` de eventos com `idtrack` usa a conexão do token (não checa se está ativa).
- `lost.ts`: âncora de Jornada direta = `created_at` (depois `last_event_at`); a pré-consulta SQL usa `or(link_sent_at < corte, link_sent_at nulo e created_at < corte)`; sem conexão, a última mensagem do cliente vale em qualquer conversa do contato. `handoff-state.ts` ordena por `link_sent_at` (nulos por último) e depois `created_at`. O funil agrupa por loja as Jornadas sem conexão (`store_id`), sem canal.
- UI mínima: o card do negócio mostra "Direto do cardápio" (chave `Pipelines.card.originDirect`) quando `journey.origin = 'menu_direct'`.
- Fake compartilhado `crm-world.fake.ts`: unicidade `(account_id, phone)` em `contacts` (modela a 022).

**Fora / atenção**: o funil ainda conta Jornadas diretas em `link_sent` (todas alcançam o passo 0), o que infla a conversão; a separação por origem é o #21. Respostas de eventos gravadas antes desta versão não têm `messaging` num replay. Sem consentimento guardado (#20) nem criação de conversa fechada.

## #21 Funil da Journey separado por origem

Sem migration. `src/lib/journeys/funnel.ts`: `FunnelCounts` ganhou `total` e `purchaseRate` (comprou / total de Jornadas); novo `FunnelWithOrigin` (`byOrigin: {crm_link, menu_direct}`), usado por `total` e por cada `FunnelGroup`. `JourneyFunnel` tem a mesma forma, mais os campos novos (`/api/journeys/funnel` sem mudança de rota).

**Decisões**
- Jornada direta nunca conta em `link_sent` (o funil dela começa na primeira etapa alcançada); `conversion` (link -> comprou) só vale para `crm_link`, inclusive no agregado (`conversion` do agregado = o de `byOrigin.crm_link`). Para as diretas, `purchaseRate` = compradas / total de Jornadas diretas. Linhas legadas sem `origin` contam como `crm_link`.
- Nada some por causa do join: Jornada sem conexão vai para o grupo de canal `NO_GROUP` ("Sem conexão"); a loja vem de `conn.store_id`, senão de `journeys.store_id`, senão `NO_GROUP` ("Sem loja"). Grupos ordenados por `total` (antes por `link_sent`).
- Quadro: cada grupo tem uma linha agregada e uma por origem; colunas novas "Jornadas" e "Compradas / Jornadas". O quadro segue sem filtro de datas e sem reagir ao filtro do pipeline. O estado vazio agora é `total.total === 0` (só-diretas não some).
- Filtro do pipeline ganhou origem (`JourneyFilterValue.origin`); o embed do deal passou a trazer `journeys.store_id`, usado no filtro de loja quando o deal não tem conexão. O filtro de canal exclui deals sem conexão. Card do deal mostra "Direto do cardápio" ou "Link do CRM" quando há Jornada.

**Fora**: não há opção "sem conexão" no filtro de canal.

## #20 Consentimento por finalidade guardado no contato

**Migration `065_contact_consents.sql`** (aplicada do zero com as 065 migrations num Postgres descartável `supabase/postgres:17.6.1.136` + schema `storage` copiado, `verify-schema.sql` passou, reaplicação idempotente; fusão de `merge_contacts` conferida com SQL real). Tabela `contact_consents` (`account_id`, `contact_id`, `purpose` `notifications|marketing`, `granted`, `given_at`, `revoked_at`, `source`, `created_at`, `updated_at`), único `(account_id, contact_id, purpose)`, CHECK de que há `given_at` ou `revoked_at`, RLS: membros leem, escrita só service-role. `merge_contacts` redefinida (cópia da 064): por finalidade sobrevive, no sobrevivente, a decisão mais recente das duas.

**Para reaproveitar** (`src/lib/consent/consent.ts`, sem importar canal)
- `hasConsent(db, accountId, contactId, purpose)`: LEITURA. Linha explícita existe -> `granted` decide (revogação vale mesmo para quem já escreveu); sem linha -> implícito se já escreveu (`hasWrittenToUs`, mensagem `sender_type='customer'` em qualquer conversa do contato); senão false. Nada é gravado para o implícito. Os motores (#22) e o "PARAR" (#23) devem usar isto.
- `recordConsent(db, {accountId, contactId, purpose, granted, at, source})`: grava SÓ se `at` é estritamente mais novo que `GREATEST(given_at, revoked_at)` (compare-and-swap em `updated_at`, tenta 3x). Grant limpa `revoked_at`; revogação mantém `given_at`. O "PARAR" do #23 chama `recordConsent(..., granted: false, at: now, source: 'chat')` para as duas finalidades.
- `applyEventConsent(db, {accountId, contactId, consent, source})`; chamado em `events.ts` antes de `resolveMessagingEligibility`, só se `identity.customerApplies`. `CONSENT_PURPOSES`, `ConsentPurpose`.
- `resolveMessagingEligibility` (direct.ts) agora usa `hasConsent(..., 'notifications')`; `hasWrittenToUs` saiu de direct.ts para o módulo de consentimento.
- UI: `src/components/contacts/contact-consents.tsx` (somente leitura, datas por `useFormatter`), no detalhe do contato e no painel lateral da inbox; chaves `Contacts.consents.*` nos 4 idiomas.

**Decisões**
- Tabela em vez de colunas (uma linha por finalidade, com prova própria; o verify-schema exige tratar `contact_id` no merge, feito).
- Implícito cobre as DUAS finalidades (como hoje, "avisos e recuperação"); `marketing` só é negado a quem nunca escreveu ou revogou.
- `given_at` obrigatório com qualquer finalidade: `400` já no parser (`parseConsent`). Um `consent` com `given_at` mas sem finalidade é aceito e não faz nada.
- Um `false` sem linha prévia grava uma linha revogada (`given_at` nulo), para a revogação valer.
- Replay de `event_id`: já tratado pelo claim de `journey_events` (teste apaga o consentimento e confirma que o replay não o recria).

**Fora / atenção**: `given_at` no futuro não é rejeitado (um relógio errado do cardápio poderia travar atualizações futuras daquela finalidade); a UI mostra "Sem registro" para quem só tem consentimento implícito (não consulta mensagens); o motor de automações ainda não consulta `hasConsent` por passo (#22).

## #23 "PARAR" no chat revoga o consentimento

Sem migration. Módulo novo `src/lib/consent/opt-out.ts` (sem importar canal; teste `consent/no-channel-imports.test.ts` cobre a pasta e `channels/ingest.ts`).

**Para reaproveitar**
- `isOptOutText(text)` (pura), `OPT_OUT_WORDS`, `revokeConsentFromChat(db, {accountId, contactId, at})` (`recordConsent` granted=false nas duas finalidades, `source: 'chat'`), `loadOptOutConfirmation(locale?)` (catálogo `Contacts.consents.optOutConfirmation`, fallback `en`).
- `ingest.ts` (`ingestMessage`): após gravar a mensagem NOVA (nunca em duplicata/redelivery) e antes do hook `onMessageStored`, se o conteúdo é `text` e `isOptOutText`, revoga; `IngestedMessage.optOut` indica sucesso. Falha é logada e não derruba a ingestão (`optOut: false`).
- `fanout.ts`: se `stored.optOut`, envia a confirmação por `sendOutbound` como texto livre (ator `bot`, isolado/best-effort); a resposta da IA é pulada quando `isOptOutText(texto)` (sem mudar `lib/ai`). Automações de palavra-chave e fluxos seguem como antes.

**Decisões**
- Regra: mensagem INTEIRA igual a uma palavra, sem caixa/acentos/pontuação-emoji nas pontas. Lista: parar, pare, parar mensagens, stop, cancelar envio, cancelar mensagens, nao quero receber, nao quero mais receber, descadastrar, unsubscribe, 수신거부. `cancelar` SOZINHO fica de fora (é como se cancela pedido).
- Confirmação só sai por `fanoutHook` (WhatsApp e rota genérica já o usam); quem chamar `ingestInbound` sem esse hook revoga mas não confirma.
- Precedência/idempotência vêm do #20: `at` = instante da mensagem; grant mais novo do cardápio reativa, mais antigo não. O painel já traduz a origem `chat`.

**Fora**: um fluxo que consuma o "PARAR" (fluxo aguardando resposta) ainda o recebe; não mudamos fluxos.

## #22 Envio condicionado ao consentimento, conversa fechada e avisos para quem nunca escreveu

Sem migration (conversas já aceitam `status='closed'`; `consent_purpose` vive em `step_config`).

**Para reaproveitar**
- `src/lib/automations/send-gate.ts`: `gateSend(db, {accountId, userId, contactId, purpose, conversationId?, storeId?})` -> `{ok:true, conversationId, connectionId} | {ok:false, reason}`; `stepConsentPurpose(declared)` (ausente/inválido = `marketing`); `DEFAULT_CONSENT_PURPOSE`. O motor chama `gateSendStep` no início de `send_message`, `send_buttons`, `send_list` e `send_template`: sem consentimento da finalidade (`hasConsent`, #20) lança `ExecutionIgnored` -> passo `skipped`, `detail: "ignored: sem consentimento: <finalidade>"` (sem telefone); loja sem conexão de avisos -> `skipped` com `sem conexão de avisos da loja (none|ambiguous)`.
- `AutomationContext.store_id`: só os eventos diretos o preenchem. Sem `conversation_id` mas com `store_id`, o passo acha-ou-cria a conversa (contato, conexão de `resolveNotificationConnection`) já FECHADA, usando `findOrCreateConversationRow` (agora exportada de `whatsapp/resolve-conversation.ts`, com o 6o parâmetro `createStatus`; retry de leitura no 23505). A conversa criada entra só nos args daquele passo; os seguintes a reencontram pela busca do contato.
- `event-hooks.ts`: `AcceptedJourneyEvent.conversationId/connectionId` agora podem ser `null` e há `storeId`; `onOrderStatusChanged(db, change, storeId?)`. `events.ts` dispara os dois ganchos para TODO evento direto (não depende mais de `messaging` nem de conversa); eventos com `idtrack` inalterados.
- Tipos: `StepConsentPurpose`; `consent_purpose?` em `SendMessage/SendButtons/SendList/SendTemplateStepConfig`. `validate.ts` recusa valor fora de `notifications|marketing` em passos de envio.
- Preset: agradecimento e os 7 avisos de status nascem com `consent_purpose: 'notifications'`; retomadas e carrinho abandonado NÃO declaram nada (padrão estrito `marketing`, o #24 trata o carrinho). `installJourneyPreset` devolve também `backfilled`: nas automações já instaladas (por `preset_key`) só preenche `consent_purpose` nos passos de envio que não o têm, sem mexer em texto/template/finalidade já escolhida.
- Construtor: seletor "Avisos do pedido"/"Marketing" (`ConsentPurposeField`) nos 4 passos de envio, com dica; chaves `Automations.builder.config.consentPurpose*` nos 4 idiomas. Sem valor salvo o seletor mostra Marketing (o padrão real).

**Decisões**
- `hasConsent` vale para TODO passo de envio e todo gatilho: quem escreveu segue implícito; revogação explícita da finalidade bloqueia até quem escreveu.
- Contato sem conversa e sem `store_id` (ex.: tag_added de quem nunca escreveu) mantém a falha antiga "contact has no existing conversation" (nada é enviado de qualquer forma), para não mudar testes/mensagens existentes.
- Ao ignorar um passo o escopo termina (comportamento de `ExecutionIgnored`), como nos demais "ignorados".
- Sem template: a conversa já foi criada (fechada) e o envio falha com `window_closed`, gravando a mensagem `failed` nela (falha visível, não `skipped`).
- Condição `business_acronym_is` usa a loja do `store_id` do contexto quando ainda não há conversa.

**Fora / atenção para o #24**: o passo `wait` exige conversa (colunas NOT NULL) e falha em execução de evento direto sem conversa ("contact has no existing conversation"); o carrinho abandonado (espera de 10 min) precisa resolver isso e declarar sua finalidade (`marketing`). `conversation_unattended` e `customer_replied_since` sem conversa avaliam falso. Edições de teste: `route.direct.test.ts` (o gancho agora dispara para evento direto sem consentimento/conversa) — único teste existente alterado; os de `idtrack` passaram sem alteração.

## #24 Carrinho abandonado para jornadas diretas, com consentimento de marketing

**Migration `066_pending_execution_without_conversation.sql`** (aplicada do zero com as 066 migrations num Postgres descartável + schema `storage` copiado; `verify-schema.sql` passou, reaplicação idempotente): `automation_pending_executions.conversation_id` e `.connection_id` voltam a aceitar NULL (eram NOT NULL desde a 051). `verify-schema.sql` agora exige que as duas sejam NULAS (antes exigia NOT NULL; `message_templates`/`broadcasts` seguem NOT NULL).

**Mudanças no motor (`src/lib/automations/engine.ts`)**
- `wait`: execução SEM conversa no contexto e COM `store_id` (evento direto) estaciona com `conversation_id`/`connection_id` nulos, sem resolver conversa. O contexto guarda `store_id`/`journey_id`; o passo de envio cria a conversa FECHADA depois do consentimento (#22), como sempre. Sem `store_id` a regra antiga continua (resolve a conversa mais recente ou falha "contact has no existing conversation").
- `conversation_unattended` sem conversa = VERDADEIRO. `customer_replied_since` sem conversa = falso (já era; agora comentado). Sem conversa no contexto, as condições ainda procuram a conversa mais recente do contato: se o cliente escreveu durante a espera, a resposta suprime o envio.
- `supersedePendingRuns` já funcionava sem conversa (filtra por automação e contato): rajada de AddToCart deixa uma espera só.
- Retomadas: `onMenuLinkSent` (`journeys/link-hooks.ts`) ignora Journey de origem `menu_direct` (defesa; o gatilho só dispara em envio de link, e Jornada direta não tem conexão/link). Os passos `journey_stage`/`journey_open` leem a Journey do contexto, então nenhuma corrente `menu_link_sent` pega Journey direta.

**Preset**: o envio do carrinho abandonado agora traz `consent_purpose: 'marketing'` explícito; o backfill do #22 o preenche em automações já instaladas (texto/template editados preservados). Retomadas seguem sem declarar (padrão estrito `marketing`; não se aplicam a jornadas diretas).

**Testes**: `engine.characterization.test.ts` (describe "Abandoned cart for a DIRECT Journey"): 10 min/uma vez/template/conversa fechada, espera sem conversa, só `notifications` = nada enviado + motivo no log, revogação, Purchase cancela, rajada, resposta durante a espera, quem já escreveu, retomadas nunca disparam. `journey-preset.test.ts` atualizado (cart = marketing).

**Decisões / fora**: `docs/order-journey.md` ganhou frase sobre o carrinho direto e a exclusão das retomadas; `docs/docker.md` (faixa "055 a 062") não foi atualizado (já estava defasado desde a 063). Sem UI nova, sem texto i18n. Uma execução parada com a conversa criada DEPOIS (o cliente escreve na espera) não reescreve `conversation_id` da linha pendente; o envio acha a conversa pela busca do contato/loja.

## #25 Documentação e verificação ponta a ponta

Sem migration. Sem mudança de contrato além da correção abaixo.

- **`consent.given_at` no futuro** (`src/lib/journeys/event-payload.ts`, `parseConsent`): mais de 5 minutos à frente de `Date.now()` é `400 bad_request` (mensagem cita `consent.given_at` e "future"), já no parser, antes de criar contato/jornada. Tolerância `MAX_CONSENT_CLOCK_SKEW_MS`. `route.direct.test.ts` fixa `Date` em 2026-10-10 (`vi.useFakeTimers({ toFake: ['Date'] })`) para as datas fixas de outubro de 2026 dos testes.
- **Docs:** `docs/public-api.md` (migrations 055 a 066, contradição sobre eventos sem `idtrack` removida, exemplos diretos, `given_at` futuro, "PARAR", `messaging`), `docs/order-journey.md` (tabela 063 a 066, seção "Orders that do not come from a CRM link", funil por origem), `docs/docker.md`. Adendo: uma linha na seção 3.
- **Operador e testes manuais:** `manual-configuracao.md`, `eventos-diretos-curl.sh` (validado com `bash -n`), `eventos-diretos-insomnia.json` (gerados de uma mesma lista de casos, por um script descartável; se mudar o contrato, edite os dois).
- **`verification.md`:** mapa dos 8 critérios para testes, limites honestos, resultado das 66 migrations num Postgres descartável (0 falhas, verify-schema passou, 063 a 066 reaplicáveis).
- **Testes novos** em `journey.integration.test.ts`: revogação `false` depois de `true`, PARAR e reativação por consentimento mais novo, loja sem conexão, replay com campos novos, BLC/PZA com `{{store_name}}`, carrinho abandonado direto com e sem `marketing`.
- **Fora:** UI sem teste de componente; convenção de templates por WABA sem teste com duas WABAs reais; sem teto diário de primeiros contatos.
