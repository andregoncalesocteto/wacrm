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
