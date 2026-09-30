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
