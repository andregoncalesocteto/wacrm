# Design Doc — Abstração de canais (multiloja, multicanal)

> Base: `.projects/channel-abstraction/SOLUTION.md` (v1). O template `design-docs/templates/DESIGN_TEMPLATE.md`
> não existe neste repositório; a estrutura segue as 9 seções pedidas pelo comando.
>
> Status: rascunho para revisão · 2026-09-21

## Ajustes ao SOLUTION.md

Ao abrir o código para desenhar, seis pontos do SOLUTION mudaram ou foram acrescentados. Os marcados na
seção 8, "Decisões a confirmar", **dependem da sua confirmação**.

1. **Identidade por família de canal, não por `channel_type`.** O SOLUTION previa `contact_identities` com
   `channel_type`. Mas o WhatsApp oficial e o não oficial (versão seguinte) reconhecem a **mesma pessoa pelo
   mesmo telefone**. A chave passa a ser um `kind` com prefixo de família (`whatsapp:phone`, `whatsapp:bsuid`,
   `whatsapp:username`, `telegram:chat_id`, `telegram:username`). Assim o mesmo cliente é o mesmo contato em
   qualquer conexão da mesma família.
2. **`contacts.phone` fica `NOT NULL DEFAULT ''`, sem virar nulo no banco.** O código já usa `''` para "sem
   telefone" (contatos identificados só por BSUID; índice único parcial `WHERE phone_normalized <> ''`). A API
   traduz `''` para `null` na borda. É o mesmo efeito de produto, sem migrar a constraint.
3. **`messages.message_id` não é renomeada.** Ela vira, por documentação, o identificador externo genérico. O
   nome novo (`external_message_id`) existe só na API. Evita tocar dezenas de consultas e o índice único
   `(conversation_id, message_id)`.
4. **O merge de contatos já existe como funções SQL** (`merge_duplicate_contacts` e
   `merge_duplicate_conversations`, migrations 022 e 036). O merge manual as reaproveita.
5. **Dois pontos que o SOLUTION não citava e o modelo exige:** `message_templates` é único por
   `(user_id, name, language)`, e as **execuções pendentes de automação** (`automation_pending_executions`) só
   guardam `contact_id`. Com várias conversas por contato, elas precisam de `connection_id` e
   `conversation_id`. Ver seções 4 e 7.
6. **Conexões têm ciclo de vida: desativar em vez de apagar** (decisão tomada ao detalhar as telas de
   configuração). `conversations.connection_id` é `ON DELETE RESTRICT`, então uma conexão com histórico não pode
   ser apagada. Ela é **desativada** (`disabled_at`), continua no inbox como somente leitura, e só se apaga uma
   conexão sem nenhuma conversa. O SOLUTION falava em "criar, editar e apagar" sem tratar esse caso.

---

## 1. Contexto

O produto é um CRM de atendimento sobre WhatsApp que hoje fala com **um canal** (Meta) e com **uma conexão por
conta**. O objetivo é atender **redes com várias lojas e uma central**, com canais diferentes convivendo e tudo
no mesmo inbox, e manter **todo o CRM independente do canal** (SOLUTION, seções 1 e 2).

**O acoplamento medido no código**
- **Envio em três lugares:** `lib/whatsapp/send-message.ts` (dashboard e `/api/v1/messages`),
  `lib/flows/meta-send.ts` e `lib/automations/meta-send.ts` (flows, automações e resposta por IA), e
  `lib/whatsapp/broadcast-core.ts` (broadcast). Todos decifram credenciais, resolvem destino, refazem variantes de
  telefone e falam com `meta-api.ts` (1.225 linhas).
- **Recebimento:** `app/api/whatsapp/webhook/route.ts` (1.447 linhas) verifica o HMAC, resolve a conta pelo
  `phone_number_id`, processa dentro de `after()` (`maxDuration = 60`) e mistura formato da Meta com regra de
  negócio: `handleStatusUpdate`, `processMessage`, `parseMessageContent`, `findOrCreateContact`,
  `findOrCreateConversation`.
- **23 arquivos leem `whatsapp_config`** (envio, webhook, templates, broadcast, mídia, IA, telas de configuração
  e a página do inbox).
- **Restrições de banco:** conversa única por `(account_id, contact_id)` (`idx_conversations_account_contact`);
  contato único por `(account_id, phone_normalized)` e por `(account_id, wa_user_id)`; execução de flow ativa
  única por `(account_id, contact_id)` (`idx_one_active_run_per_contact`); `whatsapp_config` único por conta e por
  `phone_number_id`; mensagem única por `(conversation_id, message_id)` (idempotência).
- **O que já ajuda:** `contactHandle()` já exibe um contato sem telefone (BSUID ou `@username`);
  `resolveContactSendTarget()` já separa "endereço de envio" de "telefone"; `flow_runs` já tem `conversation_id`;
  o CRM (`deals`, `pipelines`, `tags`, `custom_fields`, `contact_notes`) não tem coluna de telefone nem de
  canal; e há funções SQL de merge.

**Restrições herdadas do debate:** produto sem cliente e independente; a conta é a rede e a segurança continua por
conta; permissões por loja fora do escopo; WhatsApp oficial migrado sem mudar comportamento (RNF-01); canal novo
sem tocar o núcleo (RNF-02); só o Telegram como canal de prova.

## 2. Solução Proposta

Separar o sistema em **três camadas** e trocar o modelo de dados para que loja, conexão e identidade sejam
primeiros-classe.

```
   HTTP (rotas)                 NÚCLEO DE CANAIS (não conhece nenhum canal)            PROVEDORES
┌──────────────────┐     ┌──────────────────────────────────────────────────┐     ┌────────────────────┐
│ /api/whatsapp/   │     │  ingestInbound(events, connection)               │     │ whatsapp-cloud     │
│   webhook        │────►│    identidade → contato → conversa → mensagem    │◄───►│  (meta-api,        │
│ /api/channels/   │     │    → mídia → fan-out (automações, flows, IA,     │     │   template, HMAC)  │
│  [ch]/webhook/   │     │       webhooks de saída, notificações)           │     ├────────────────────┤
│  [connectionId]  │     │                                                  │     │ telegram           │
│ /api/v1/messages │────►│  sendOutbound({conversation, message, actor})    │◄───►│  (Bot API,         │
│ dashboard send   │     │    capacidades → provider.send → grava → efeitos │     │   secret_token)    │
│ flows/automações │     │                                                  │     ├────────────────────┤
│ IA               │     │  health(connection) · cron                       │     │ (futuro) whatsapp- │
└──────────────────┘     └──────────────────────────────────────────────────┘     │ unofficial, ...    │
                                          │                                       └────────────────────┘
                                          ▼
   stores ──< channel_connections ──< conversations >── contacts ──< contact_identities
                     │                       │
                     │                       └──< messages
                     └── channel_connection_credentials (só servidor)
```

**Resumo das decisões**
- **Contrato do provedor** em `src/lib/channels/`, com **registro em processo**; o provedor devolve **eventos
  normalizados** e o núcleo persiste e distribui. 🔴 ADR NEEDED
- **Modelo:** `stores`, `channel_connections`, `channel_connection_credentials`, `contact_identities`; conversa por
  `(contato, conexão)`. 🔴 ADR NEEDED
- **Recebimento:** ack rápido + `after()` + ingestão idempotente. 🔴 ADR NEEDED
- **Envio:** um único `sendOutbound` para os cinco chamadores; broadcast com entrega própria via `provider.send`.
- **Credenciais** em tabela separada, sem leitura por membros. 🔴 ADR NEEDED
- **API `/api/v1`** muda no lugar, pré-estável até o primeiro cliente. 🔴 ADR NEEDED
- **CRM independente de canal**, com merge manual de contatos. 🔴 ADR NEEDED
- **Migração em expandir/contrair**, mantendo o CI verde a cada passo (seção 8).

## 3. Arquitetura

### Componentes

| Componente | Responsabilidade | Tecnologia |
|---|---|---|
| `lib/channels/types.ts` | Contrato: `ChannelProvider`, `Capabilities`, `InboundEvent`, `OutboundMessage`, `ChannelError` | TypeScript |
| `lib/channels/registry.ts` | Registro `channel_type → provider`; único lugar que conhece os provedores | TypeScript |
| `lib/channels/ingest.ts` | `ingestInbound`: identidade, contato, conversa, mensagem, mídia, fan-out; idempotente | TypeScript, Supabase (service role) |
| `lib/channels/send.ts` | `sendOutbound`: valida capacidades, chama o provedor, grava, efeitos | TypeScript |
| `lib/channels/connections.ts` | Acesso a conexões e credenciais (decifra); substitui os 23 leitores de `whatsapp_config` | TypeScript |
| `lib/channels/identity.ts` | Resolução e criação de identidades e contatos; nome de exibição (`contactHandle` generalizado) | TypeScript |
| `lib/channels/health.ts` | Atualiza estado da conexão por evento e por `provider.health` | TypeScript |
| `lib/channels/providers/whatsapp-cloud/` | O que hoje é `lib/whatsapp/*` (Meta API, HMAC, templates, variantes de telefone, BSUID) | TypeScript |
| `lib/channels/providers/telegram/` | Bot API: `setWebhook`, `sendMessage`/mídia, botões, reações, `getWebhookInfo` | TypeScript, `fetch` |
| `app/api/whatsapp/webhook/route.ts` | Rota mantida; delega ao provedor e ao `ingestInbound` | Next route |
| `app/api/channels/[channel]/webhook/[connectionId]/route.ts` | Webhook genérico dos canais novos | Next route |
| `app/api/channels/cron/health/route.ts` | Verificação periódica (`x-cron-secret`) | Next route |
| `app/api/channels/connections/**` | CRUD de conexões e lojas pela interface (administrador ou acima) | Next routes |
| `app/api/contacts/merge/route.ts` | Merge manual, reaproveitando as funções SQL de merge | Next route |
| Seções `stores` e `channels` de Configurações | Lojas e canais (substituem a seção `whatsapp`); detalhe da conexão, conectar, desativar, mover de loja | React, `next-intl` |
| `lib/channels/ui-registry.tsx` | Mapeia `channel_type` para o descritor de formulário ou para o painel próprio do provedor | React, TypeScript |
| Interface do inbox | Selos de loja e canal, filtros, não lidas por loja, aviso de conexão caída, conversas do contato em outras lojas | React |
| Migrations `043`+ | Schema novo, backfill e contração | SQL |

### Fluxo de recebimento

```
Meta/Telegram ─► rota (webhook)
                    │ provider.resolveConnection(req)   (phone_number_id | connectionId da URL)
                    │ provider.verify(req, conn)        (HMAC | secret_token, tempo constante)
                    │ provider.parse(req) → InboundEvent[]
                    ▼
             responde 200 imediatamente
                    ▼  after()
             ingestInbound(events, conn)
               ├─ message : candidatos de identidade → contato (acha ou cria) → conversa (contato, conexão)
               │            → INSERT mensagem (ON CONFLICT (conversation_id, message_id) DO NOTHING)
               │            → mídia (provider.downloadMedia → nosso storage, sem URL com token)
               │            → fan-out: automações · flows · IA · webhooks de saída · notificações
               ├─ status  : degrau de estado da mensagem (só provedores com recibos)
               ├─ reaction: grava reação
               └─ connection_event: atualiza estado da conexão
             falha → last_error da conexão + log estruturado
```

### Fluxo de envio

```
dashboard | /api/v1/messages | flow | automação | IA
        │  sendOutbound({ conversation, message, actor })
        ▼
   carrega conversa + conexão + contato + identidades
   provider.resolveTarget(identidades) → destino | erro recipient_unreachable
   valida message × provider.capabilities → erro tipado (unsupported | window_closed | ...)
   provider.send(conn, target, message) → { externalId } | ChannelError
   INSERT mensagem (status sending→sent) · UPDATE conversa · pausa flow se ator = agente
```

## 4. Modelo de Dados

### Diagrama simplificado

```
accounts (a rede)
   ├──< stores ──< channel_connections >── channel_connection_credentials (1:1, só servidor)
   │                    │      ├──< message_templates      (WhatsApp)
   │                    │      ├──< broadcasts             (WhatsApp)
   │                    │      └──< conversations >──< messages
   └──< contacts ──< contact_identities ─────────────────────┘ (conversa: contato × conexão)
                └──< deals · notes · tags · custom values   (inalterados)
```

### Tabelas novas

```sql
-- 043_stores_and_connections.sql (expandir)
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL, address text, phone text,
  business_hours jsonb, manager_name text,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_connections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  channel_type text NOT NULL,                 -- 'whatsapp_cloud' | 'telegram' (validado pelo registro)
  display_name text NOT NULL,
  external_id text NOT NULL,                  -- phone_number_id | id do bot
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected','degraded','disconnected','needs_action')),
  config jsonb NOT NULL DEFAULT '{}',         -- waba_id, mirror_inbound_media, registro, ... (sem segredos)
  last_inbound_at timestamptz, last_outbound_at timestamptz,
  last_error jsonb, last_error_at timestamptz, last_health_check_at timestamptz,
  connected_at timestamptz,
  disabled_at timestamptz,                    -- nulo = ativa; preenchido = desativada (histórico preservado)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_type, external_id)          -- substitui whatsapp_config_phone_number_id_key
);

CREATE TABLE channel_connection_credentials (
  connection_id uuid PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secrets_encrypted text NOT NULL,            -- JSON cifrado com AES-256-GCM (encryption.ts)
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE channel_connection_credentials ENABLE ROW LEVEL SECURITY;  -- sem política: só service role

CREATE TABLE contact_identities (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,                          -- 'whatsapp:phone' | 'whatsapp:bsuid' | 'whatsapp:username'
                                               -- | 'telegram:chat_id' | 'telegram:username'
  external_id text NOT NULL,
  handle text,                                 -- exibição, ex. '@maria'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, external_id)
);
CREATE INDEX idx_contact_identities_contact ON contact_identities(contact_id);
```

**RLS** (mesmo padrão de `whatsapp_config`): `stores` e `channel_connections` com `SELECT` para membros e
`INSERT/UPDATE/DELETE` para `admin`+ (`is_account_member(account_id, 'admin')`); `contact_identities` segue as
políticas de `contacts` (leitura para membros, escrita para `agent`+); `channel_connection_credentials` sem política.

### Alterações em tabelas existentes

| Tabela | Mudança |
|---|---|
| `conversations` | `+ connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE RESTRICT`; troca `idx_conversations_account_contact` por `UNIQUE (contact_id, connection_id)`; `+ INDEX (connection_id, last_message_at DESC)` para o filtro do inbox |
| `messages` | Sem mudança de schema. `message_id` passa a ser o id externo genérico; o índice `(conversation_id, message_id)` continua sendo a fronteira de idempotência |
| `contacts` | `phone` continua `NOT NULL DEFAULT ''`. As colunas `wa_user_id`, `wa_parent_user_id`, `wa_username` viram identidades e são removidas na contração |
| `message_templates` | `+ connection_id`; troca `UNIQUE (user_id, name, language)` por `UNIQUE (connection_id, name, language)` |
| `broadcasts` | `+ connection_id` (o WhatsApp que envia). `broadcast_recipients` e seu índice de `wamid` não mudam |
| `flow_runs` | Troca `idx_one_active_run_per_contact` por `UNIQUE (conversation_id) WHERE status = 'active'` |
| `automation_pending_executions` | `+ conversation_id`, `+ connection_id`, para a espera retomar o envio na mesma conversa |
| `notifications` | `type` aceita também `'connection_down'` (alteração da restrição `CHECK`) |
| `quick_replies` | `+ store_id` opcional (nulo = da rede) |
| `whatsapp_config` | Removida na contração, depois que todos os leitores migrarem |

### Estratégia de migração (expandir e contrair)

Mesmo sem clientes, o CI precisa ficar verde a cada PR.

1. **Expandir (`043`, `044`):** cria as tabelas novas e as colunas novas **nulas**. Backfill idempotente: por conta,
   uma `store` (nome da conta) e uma `channel_connection` `whatsapp_cloud` a partir de `whatsapp_config` (credenciais
   cifradas movidas para `channel_connection_credentials`); `conversations.connection_id` preenchido com a conexão
   da conta; `contact_identities` a partir de `phone_normalized`, `wa_user_id` e `wa_username`; `connection_id`
   de templates e broadcasts.
2. **Migrar os leitores** (fases 2 a 5) para `lib/channels/connections.ts`, um PR por caminho.
3. **Contrair (`04x`):** `connection_id` vira `NOT NULL`, trocam-se os índices únicos, removem-se `whatsapp_config`
   e as colunas `wa_*`. Só depois de nenhum código ler as antigas.

## 5. APIs / Interfaces

### Contrato do provedor (TypeScript)

```ts
export type ChannelType = 'whatsapp_cloud' | 'telegram';

export interface Capabilities {
  templates: boolean;
  interactiveButtons: boolean;
  interactiveList: boolean;
  reactions: boolean;
  typingIndicator: boolean;
  deliveryStatus: boolean;             // entregue
  readStatus: boolean;                 // lido
  initiate: 'template' | 'after_inbound' | 'free';   // como abrir conversa
  replyWindowHours: number | null;     // janela de 24 h do WhatsApp
  mediaKinds: MediaKind[];
  maxMediaBytes: number;
  captionMaxLength: number;
}

export interface ChannelProvider {
  readonly type: ChannelType;
  readonly identityKinds: string[];                       // ex.: ['whatsapp:phone','whatsapp:bsuid']
  readonly capabilities: Capabilities;

  configSchema: ZodType; credentialsSchema: ZodType;

  // ciclo de vida
  connect(conn: Connection): Promise<ConnectResult>;      // setWebhook | registra número | (futuro) QR
  disconnect(conn: Connection): Promise<void>;
  health(conn: Connection): Promise<Health>;

  // entrada
  resolveConnection(req: Request): Promise<Connection | null>;
  verify(req: Request, conn: Connection): Promise<boolean>;
  parse(req: Request, conn: Connection): Promise<InboundEvent[]>;
  downloadMedia?(conn: Connection, ref: MediaRef): Promise<Blob>;

  // saída
  resolveTarget(identities: ContactIdentity[]): Target | null;
  send(conn: Connection, target: Target, msg: OutboundMessage): Promise<SendResult>;
  react?(conn: Connection, target: Target, ref: MessageRef, emoji: string): Promise<void>;
  typing?(conn: Connection, target: Target): Promise<void>;
}

export type InboundEvent =
  | { kind: 'message'; externalId: string; sender: IdentityCandidate[]; at: Date;
      content: InboundContent; replyToExternalId?: string; senderName?: string }
  | { kind: 'status'; externalId: string; status: 'sent'|'delivered'|'read'|'failed'; error?: ChannelErrorInfo }
  | { kind: 'reaction'; externalId: string; sender: IdentityCandidate[]; emoji: string | null }
  | { kind: 'connection'; state: 'connected'|'degraded'|'disconnected'|'needs_action'; reason?: string };

export type ChannelErrorCode =
  'auth' | 'rate_limited' | 'recipient_unreachable' | 'unsupported' | 'window_closed' | 'invalid' | 'unknown';
export class ChannelError extends Error { code: ChannelErrorCode; providerCode?: string | number; retryable: boolean }
```

Os valores das capacidades do Telegram reproduzem o quadro do tema 5; os pontos marcados como não confirmados
(`deliveryStatus`, `readStatus` e `initiate: 'after_inbound'`) entram como **valores iniciais** e são validados na
fase 6.

### Núcleo de envio

```ts
export async function sendOutbound(input: {
  conversationId: string;
  message: OutboundMessage;              // text | media | template | interactive | reaction
  actor: { type: 'agent' | 'bot' | 'automation' | 'flow' | 'ai'; id?: string };
}): Promise<{ messageId: string; externalMessageId: string }>;   // lança ChannelError tipado
```

### HTTP

**`POST /api/v1/messages`** — responder numa conversa existente:
```json
{ "conversation_id": "c1e0…", "type": "text", "text": "Seu pedido saiu para entrega" }
```
ou abrir conversa por uma conexão (`connection_id` é opcional só quando a conta tem exatamente uma conexão ativa):
```json
{ "connection_id": "9b7a…", "to": "+5511999990000", "type": "text", "text": "Olá!" }
```
Resposta `201`:
```json
{ "data": { "message_id": "…", "external_message_id": "wamid.…", "conversation_id": "…",
            "connection_id": "9b7a…", "channel": "whatsapp_cloud", "contact_id": "…", "contact_created": false } }
```
Erros novos: `400 connection_required` (duas ou mais conexões e nenhuma informada), `409 unsupported`
(capacidade ausente), `422 recipient_unreachable`, `409 window_closed`.

**`GET /api/v1/connections`** (escopo `connections:read`) e **`GET /api/v1/stores`**:
```json
{ "data": [ { "id": "9b7a…", "store_id": "s1…", "channel": "telegram",
              "display_name": "Loja Centro — Telegram", "status": "connected" } ] }
```

**Contato** ganha `identities` (e `phone` passa a `null` quando vazio):
```json
{ "id": "…", "name": "Maria", "phone": null,
  "identities": [ { "kind": "telegram:chat_id", "external_id": "123456789", "handle": "@maria" } ] }
```

**Webhook de saída `message.received`** ganha `connection_id`, `store_id`, `channel` e `contact.identities`.

**Webhooks de entrada**
- WhatsApp: `GET|POST /api/whatsapp/webhook` (inalterado para a Meta).
- Telegram: `POST /api/channels/telegram/webhook/{connectionId}`, cabeçalho
  `X-Telegram-Bot-Api-Secret-Token`, resposta `200` vazia. `[SUPOSIÇÃO NÃO VALIDADA]` O nome exato do cabeçalho vem
  do conhecimento geral do Bot API e é confirmado na fase 6.

**Interno (interface, administrador ou acima):**
- `GET /api/channels/providers` — descritores dos provedores disponíveis (nome, capacidades, campos do formulário).
- `GET|POST /api/channels/connections`; `PATCH /api/channels/connections/{id}` (nome, configuração, **mover de loja**);
  `DELETE` só se a conexão não tem conversas (senão `409 has_conversations`).
- `POST /api/channels/connections/{id}/connect` · `/test` (chama `provider.health` na hora) · `/disable` · `/enable`.
- `GET|POST /api/stores`, `PATCH|DELETE /api/stores/{id}` (`DELETE` só sem conexões, senão `409 has_connections`).

**Cron:** `GET /api/channels/cron/health` com `x-cron-secret`, no padrão de `/api/automations/cron`.

**Merge manual:** `POST /api/contacts/merge` `{ "survivor_id": "…", "duplicate_id": "…" }` → `200
{ "data": { "survivor_id": "…", "moved": { "conversations": 2, "deals": 1, "notes": 4 } } }`.

**MCP:** `list_stores`, `list_connections`, `send_message` com `connection_id`/`conversation_id`, contatos com
`identities`. O pacote sobe de versão.

### Interface de configuração (telas)

**Princípio.** A **loja vem primeiro**: uma conexão só existe dentro de uma loja. Toda a interface segue as regras de
i18n do projeto: texto por `useTranslations` (nenhum literal), datas por `useFormatter()`, chaves nos quatro
catálogos. As ações exigem administrador ou acima (`useCan('edit-settings')`); os demais papéis veem a lista em
somente leitura, sem detalhes de credenciais.

**1. Navegação** (`settings-sections.ts`). A seção `whatsapp` é substituída por duas, no grupo *Workspace*:
`stores` ("Lojas") e `channels` ("Canais"). `resolveSection` mapeia o valor antigo `?tab=whatsapp` para `channels`,
então os links da barra lateral e do cabeçalho continuam funcionando. A visão geral (`settings-overview.tsx`) troca o
cartão de WhatsApp por dois: "Lojas: N" e "Canais: X conectados de Y", com o pior estado destacado. Ela passa a ler
`GET /api/channels/connections` em vez de consultar `whatsapp_config` direto.

**2. Lojas.** Lista com nome, endereço, telefone e o número de conexões com seus estados. "Nova loja" abre um
diálogo (nome obrigatório; endereço, telefone, horário e responsável opcionais). Editar usa o mesmo diálogo.
**Apagar** só é permitido para loja **sem nenhuma conexão** (ativa ou desativada); com conexões, o botão fica
desabilitado e explica por quê. Não há arquivar loja nesta versão. Estado vazio: "Cadastre sua primeira loja".
Contas migradas já têm uma loja (o nome da conta).

**3. Canais.** Lista agrupada por loja. Cada linha mostra o canal (ícone e nome), o nome da conexão, o estado
(`connected`, `degraded`, `disconnected`, `needs_action` ou **desativada**), o último recebimento e as ações
*Configurar*, *Desativar/Ativar* e *Apagar* (esta só aparece para conexão sem conversas). Estado vazio com o botão
"Conectar canal"; se **não existir loja**, o botão leva a criar a loja primeiro.

**4. Conectar um canal** (fluxo em quatro passos):
1. **Loja** (pré-selecionada se o fluxo começou na loja).
2. **Canal:** cartões vindos de `GET /api/channels/providers`, com nome, descrição curta e um resumo das
   capacidades (por exemplo, "sem templates" no Telegram).
3. **Dados do canal:** o formulário do provedor (item 5).
4. **Conectar e testar:** chama `connect` e depois `health`, e mostra o resultado com o motivo e como corrigir. O
   Telegram registra o webhook sozinho e avisa se a URL pública não for HTTPS; o WhatsApp mostra a URL do webhook e
   o token de verificação para colar no painel da Meta.

**5. Formulário por provedor.** Regra de custo mínimo para o núcleo da interface (RNF-02 vale também para a tela):
- Provedores simples (Telegram) declaram um **descritor**: `{ fields: [{ key, type: 'text'|'secret'|'select'|'switch',
  required, validation }] }`, com rótulos e ajuda por chave de tradução (`Channels.providers.<tipo>.*`). O formulário
  é gerado a partir dele.
- O WhatsApp oficial usa um **painel próprio** (`providers/whatsapp-cloud/ui/`), que **reaproveita o
  `whatsapp-config.tsx` atual** (1.049 linhas: número, WABA, token, PIN, sondagem de registro, espelhamento de
  mídia) em vez de reescrevê-lo, recebendo a conexão como parâmetro. Reescrever traria o risco de regressão (R12).
- O `ui-registry` mapeia `channel_type` para o descritor ou para o painel. Um canal novo entra registrando um dos dois.

**6. Detalhe da conexão.** Estado e motivo, último erro (código e mensagem, com a ação sugerida por tipo de erro),
contagens das últimas 24 h, e as ações *Testar conexão* (`/test`), *Reconectar*, *Mover de loja*, *Desativar* e
*Apagar*.

**7. Segredos.** Campos do tipo `secret` **nunca são preenchidos** pela API. A tela mostra "token informado" e um
botão *Substituir*; o valor novo é enviado uma vez e nunca volta. Nada disso vai para log (RNF-03).

**8. Ciclo de vida.**
- **Desativar:** chama `provider.disconnect` (no Telegram, remove o webhook), **preserva as credenciais** (reativar é
  um clique) e marca `disabled_at`. A conexão sai da verificação de saúde e deixa de contar para a regra "exatamente
  uma conexão ativa" da API. No inbox, as conversas dela continuam visíveis, o compositor fica desabilitado com uma
  explicação, e o selo indica "desativada".
- **Apagar:** só sem conversas; apaga também as credenciais (cascata).
- **Mover de loja:** permitido a administradores, com confirmação ("as N conversas desta conexão passam a aparecer
  na loja X"). O histórico acompanha a conexão, já que a loja da conversa é derivada dela.

**9. Telas vizinhas afetadas.**
- `template-manager.tsx` (1.168 linhas): ganha um seletor de **conexão de WhatsApp** no topo (oculto quando há uma
  só); a lista e o envio para aprovação passam a ser por `connection_id`.
- Respostas rápidas: campo opcional **Loja** (vazio = da rede).
- O inbox e o compositor (capacidades do canal, selos, filtros) ficam na fase F5b.

**10. Verificação.** Testes de unidade dos descritores e das regras de apagar e desativar; teste de API para
`409 has_conversations` e `409 has_connections`; políticas de acesso das tabelas novas; paridade dos quatro
catálogos; e a passada de `dev-browser` por cada tela nos modos claro e escuro e com `pt` ativo.

## 6. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Decisão |
|---|---|---|---|---|
| A | Loja como tenant, com "rede" acima (usuário em várias contas) | Isolamento total entre lojas | Reescrita das políticas de acesso da base inteira; contatos duplicados por loja | Rejeitada: as lojas são da mesma empresa |
| B | Uma tabela de configuração por provedor (`whatsapp_config`, `telegram_config`…) | Colunas tipadas | Cada canal novo exige migração e o núcleo conhece as tabelas (fere RNF-02) | Rejeitada |
| C | Manter as colunas `wa_*` no contato e identidades só para canais novos | Migração menor | Dois caminhos de identidade; a abstração vaza | Rejeitada |
| D | Gateway HTTP por canal (serviço externo com contrato REST) | Isola processos persistentes | Serviço, deploy e observabilidade novos já na versão 1 | Adiada: um provedor pode chamar um gateway por dentro |
| E | Ingestão com tabela de eventos brutos e reprocessamento | Auditável, reprocessável | Tabela e rota a mais sem volume que justifique | Adiada (a ingestão idempotente permite migrar depois) |
| F | Chave de identidade por `channel_type` | Simples | O WhatsApp oficial e o não oficial reconheceriam a mesma pessoa como contatos diferentes | Rejeitada: usa `kind` por família |
| G | Manter os senders dos motores separados chamando o provedor | Menos risco imediato | Persistência e validação continuam duplicadas | Rejeitada |
| H | Credenciais numa coluna cifrada de `channel_connections` | Uma tabela a menos | Qualquer membro lê o texto cifrado pela API do banco | Rejeitada |

## 7. Riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **Regressão no WhatsApp oficial** ao extrair o provedor e migrar os 23 leitores de `whatsapp_config` | Média | Alto | Fase 0 com testes de caracterização; mover código sem mudar comportamento; um caminho por PR; `TZ=UTC npm test` verde em cada passo |
| R2 | **Idempotência quebrada** ao mudar o modelo de conversa: reenvio do provedor duplica mensagem em `(contato, conexão)` | Média | Alto | Manter o índice `(conversation_id, message_id)`; teste de reenvio por provedor; a ingestão é uma função só |
| R3 | **Resolução de identidade errada** cria contatos duplicados ou junta pessoas diferentes | Média | Alto | Chave por `kind`; candidatos vêm do provedor; testes com BSUID, telefone e `@username`; merge manual como válvula |
| R4 | **Automação com espera perde o contexto de conversa** (várias conversas por contato) | Alta | Alto | `conversation_id` e `connection_id` em `automation_pending_executions`; regra: gatilhos por tempo ou etiqueta resolvem a conversa mais recente numa conexão compatível, ou registram "ignorado, com motivo" |
| R5 | **Telegram sem URL pública** no ambiente local | Alta | Médio | Túnel documentado; fixtures nos testes; validação real na fase 6 |
| R6 | **Comportamento do Telegram diferente do suposto** (iniciar conversa, recibos, cabeçalho do segredo) | Média | Médio | Capacidades como valores iniciais validados na fase 6; erros tipados (`recipient_unreachable`) |
| R7 | **Vazamento de segredo** (token do bot na URL de arquivo, em log ou na interface) | Baixa | Alto | Nunca gravar a URL com token; tabela de credenciais sem leitura; teste que varre logs e `media_url` |
| R8 | **Merge de contatos incompleto** (tabela nova não reapontada) | Média | Médio | Reaproveitar `merge_duplicate_contacts`; teste que lista as tabelas com `contact_id` e falha se uma faltar |
| R9 | **Migração de dados** deixa `connection_id` nulo em alguma conversa | Baixa | Alto | Backfill idempotente com verificação; contração só depois de `SELECT count(*) … IS NULL = 0`; incluir em `verify-schema.sql` |
| R10 | **Interface muda para o caso de uma conexão** | Média | Médio | Selos, filtros e avisos condicionados a "mais de uma conexão"; verificação de tela por `dev-browser` |
| R11 | **Construir sem demanda real** | Média | Alto | Escopo pequeno; validação só técnica; canais seguintes pela demanda futura |
| R12 | **Regressão na tela de configuração do WhatsApp** (registro na Meta, PIN, sondagem) ao trocá-la por uma lista de conexões | Média | Alto | Reaproveitar `whatsapp-config.tsx` como painel do provedor em vez de reescrever; teste manual do registro e da sondagem antes de remover a rota antiga |
| R13 | **Conexão desativada com conversas abertas** deixa o atendente sem saber por que não consegue responder | Média | Médio | Compositor desabilitado com explicação; selo "desativada"; aviso ao desativar com contagem de conversas abertas |

## 8. Plano de Implementação

Ordem em **fatias verticais que mantêm o CI verde**, começando pelo que protege o WhatsApp oficial.

| Fase | Entregas | Verificação |
|---|---|---|
| **F0 · Rede de segurança** | Mapear os testes existentes de envio, webhook, templates, broadcast, flows e IA; acrescentar testes de caracterização onde faltar (idempotência, ordem de status, variantes de telefone, BSUID) | Suíte verde com `TZ=UTC`; lista do que cada teste cobre |
| **F1 · Schema (expandir)** | Migrations `043` e `044`: tabelas novas, colunas novas nulas, backfill idempotente, políticas de acesso; `verify-schema.sql` atualizado; `lib/channels/connections.ts` (leitura de conexão e credenciais) | Migração replay do zero no CI; backfill sem `connection_id` nulo |
| **F2 · Contrato e provedor WhatsApp** | `lib/channels/{types,registry}.ts`; extrair `lib/whatsapp/*` para `providers/whatsapp-cloud/` sem mudar comportamento; migrar os 23 leitores de `whatsapp_config` para `connections.ts` | Nenhum teste existente alterado além de caminhos de import |
| **F3 · Recebimento** | `ingestInbound` (identidade, conversa, mensagem, mídia, fan-out); `/api/whatsapp/webhook` vira casca fina; `contact_identities` como fonte única; `wa-identity.ts` passa a devolver candidatos | Testes do webhook e de identidade verdes; reenvio idempotente |
| **F4 · Envio unificado** | `sendOutbound`; migrar dashboard, `/api/v1/messages`, flows, automações e IA, **um por PR**; apagar `engineSend*`; broadcast passa por `provider.send`; `automation_pending_executions` com `conversation_id` e `connection_id` | Testes de flows, automações, IA e broadcast verdes |
| **F5a · Configuração de lojas e canais** | Seções `stores` e `channels` e redirecionamento de `?tab=whatsapp`; lojas (criar, editar, apagar); conectar canal em 4 passos; detalhe da conexão; desativar, ativar, apagar sem conversas, mover de loja; `ui-registry` com o painel do WhatsApp reaproveitando `whatsapp-config.tsx`; `GET /api/channels/providers`; cartões da visão geral; seletor de conexão em `template-manager.tsx`; campo Loja nas respostas rápidas | `dev-browser` por tela; testes de API (`409`); paridade dos quatro catálogos |
| **F5b · Inbox multiloja** | Selos de loja e canal, filtros, não lidas por loja, aviso de conexão caída, conversas do contato em outras lojas, compositor por capacidades, conversas de conexão desativada em somente leitura; tudo escondido com uma conexão só; `flow_runs` único por conversa | `dev-browser` em cada tela; paridade dos catálogos |
| **F6 · Telegram** | Provedor Telegram (`connect`/`setWebhook`, `parse`, `send`, botões, reações, `health`); rota `/api/channels/telegram/webhook/[connectionId]`; túnel documentado; fixtures; validar as suposições da seção 5 | Testes com fixtures; um bot real via túnel recebe e responde |
| **F7 · CRM independente de canal** | Nome de exibição generalizado; busca e duplicidade por identidade; CSV cria identidades de WhatsApp; condição `phone` e `{{phone}}` para contato sem telefone; merge manual (`/api/contacts/merge`) | Métrica 5 com um contato do Telegram; teste de tabelas do merge |
| **F8 · API pública e MCP** | Mudanças da seção 5 em `/api/v1`; `stores` e `connections`; webhooks de saída; MCP; `docs/public-api.md` e `docs/mcp.md` | Testes de rota; documentação atualizada |
| **F9 · Saúde e observabilidade** | Estado da conexão por evento e cron; notificação `connection_down`; logs estruturados; página da conexão | Simular token inválido e ver aviso e notificação |
| **F10 · Contração e fechamento** | Migração final: `NOT NULL`, troca de índices, remove `whatsapp_config` e `wa_*`; `CLAUDE.md`, ADRs 001 a 006, docs do Docker; passada completa dos critérios | `npm run lint`, `typecheck`, `TZ=UTC npm test`, `build`; métricas 1 a 5 |

**Decisões a confirmar antes de implementar**
1. **Chave de identidade por `kind` com prefixo de família** (ajuste 1).
2. **`contacts.phone` continua `NOT NULL DEFAULT ''`**, com `null` só na API (ajuste 2).
3. **`messages.message_id` não é renomeada** (ajuste 3).
4. **Mover uma conexão de loja** é permitido a administradores, e o histórico acompanha a conexão.
5. **Loja com conexões, mesmo desativadas, não pode ser apagada**, e não há "arquivar loja" nesta versão.
6. **Formulário de canal:** descritor genérico para provedores simples e painel próprio para o WhatsApp,
   reaproveitando a tela atual.

F1 a F4 são a espinha dorsal e devem sair antes de qualquer interface. A **F5a** precisa só do modelo (F1) e do
contrato e registro (F2), e já pode sair com o WhatsApp; o descritor do Telegram entra na F6. A **F5b** depende da F3
e da F4. F6 só começa depois da F4. F7 e F8 podem correr em paralelo depois da F5b.

## 9. Observabilidade

**Logs estruturados.** Convenção `[channel:<tipo>] conn=<id> event=<id> …` em todo código de `lib/channels/`.
Nunca registrar credenciais, `secret_token`, URLs de arquivo do Telegram ou corpo de mensagem. Falha de ingestão
registra o `event` e atualiza `last_error` da conexão.

**Estado da conexão.** `status`, `last_inbound_at`, `last_outbound_at`, `last_error` e `last_health_check_at`,
atualizados:
- **por evento:** erro de envio `auth` → `needs_action`; mensagem recebida → `last_inbound_at`; falha de ingestão →
  `last_error`;
- **por verificação periódica:** `GET /api/channels/cron/health` chama `provider.health` (Telegram:
  `getWebhookInfo`; WhatsApp: verificação de inscrição do app). Sem o cron, degrada para só-evento.

**Métricas** (calculadas de `messages` e `channel_connections`, sem infraestrutura nova): mensagens recebidas,
enviadas e falhas por conexão nas últimas 24 h; tempo desde `last_inbound_at`; conexões por estado.

**Alertas**
- Notificação interna `connection_down` para administradores quando uma conexão passa a `disconnected` ou
  `needs_action` (nova ocorrência por transição, sem repetir).
- Aviso no inbox e na página da conexão.
- CI vermelho se os testes de paridade dos catálogos, a idempotência ou a verificação de schema falharem.

**Fora do escopo:** e-mail e webhook de alerta, painel de métricas e rastreamento distribuído.
