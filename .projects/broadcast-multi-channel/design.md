# Design Doc — Broadcast Multi-Canal

## Ajustes ao SOLUTION.md

Um achado durante a pesquisa técnica refina (sem contradizer) as decisões já
fechadas: `ChannelProvider.capabilities` já tem um campo mais preciso do que
o `templates: boolean` usado no debate —

```ts
initiate: 'template' | 'after_inbound' | 'free';
```

Isso descreve exatamente a regra de negócio de cada canal (Tema de negócio
"regras de validação/elegibilidade por canal"): `'template'` = só alcança
frio via template aprovado (WhatsApp); `'after_inbound'` = só depois que o
contato escreveu primeiro (Telegram); `'free'` = sem restrição (nenhum canal
hoje, mas o contrato já prevê). Este design usa `capabilities.initiate` como
o único sinal que decide passo do wizard, elegibilidade de audiência e
conteúdo do payload — em vez de checar `capabilities.templates` em alguns
lugares e reinventar a mesma distinção em outros.

## 1. Contexto

Broadcast está preso ao WhatsApp Cloud API por três amarras concretas no
código, apesar da aplicação já ser multi-canal desde `channel-abstraction`:

1. `loadWhatsAppSendConnection` (`src/lib/channels/whatsapp-connection.ts`)
   resolve **a** conexão WhatsApp automaticamente — não existe escolha de
   conexão no wizard nem na API.
2. `isWhatsAppReachable` (`src/lib/contacts/broadcast-eligibility.ts`) é o
   único critério de elegibilidade de audiência.
3. `broadcasts.template_name`/`template_language` são `NOT NULL`, e
   `POST /api/whatsapp/broadcast` rejeita qualquer canal sem
   `capabilities.templates`.

A infraestrutura de canal plugável já existe e, notavelmente, já **previu**
este caso: `OutboundMessage` já tem `{type: 'template'}`/`{type:
'text'}`/`{type: 'media'}`, e `SendOptions.credentials` já existe com um
comentário explícito dizendo que serve para um chamador que manda várias
mensagens na mesma conexão — exatamente o formato de um broadcast. Este
design conecta o broadcast a essa infraestrutura em vez de duplicá-la.

## 2. Solução Proposta

```
┌─────────────────────────────────────────────────────────────────┐
│  Wizard de broadcast (client)                                    │
│                                                                    │
│  Passo 0: Conexão ─┬─► capabilities.initiate === 'template'       │
│  (novo, dropdown    │      └─► Passo 1: Escolher template (atual) │
│   de conexões       │                                             │
│   nomeadas)          └─► capabilities.initiate !== 'template'     │
│                            └─► Passo 1: Compor mensagem (novo)    │
│                                                                    │
│  Passo 2: Audiência ──► isBroadcastEligible(contact, connection)  │
│                          (ramifica por capabilities.initiate)     │
│                                                                    │
│  Passo 3: Personalizar ──► mesmo mapeador de variáveis (reuso)    │
│  Passo 4: Agendar/Enviar ──► loop client-side (inalterado)        │
└────────────────────────────┬───────────────────────────────────┘
                              │ POST /api/whatsapp/broadcast (por lote)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  broadcast-core.ts (server)                                       │
│                                                                    │
│  1. Resolve conexão + credenciais 1x (getConnectionCredentials,   │
│     getProvider) — substitui loadWhatsAppSendConnection            │
│  2. Monta 1 OutboundMessage (template OU text/media) a partir do  │
│     conteúdo salvo em `broadcasts`                                │
│  3. Para cada destinatário do lote: sendOutbound(connection,       │
│     target, message, { credentials })                             │
└─────────────────────────────────────────────────────────────────┘
```

O envio propriamente dito não ganha um caminho novo — ele **se torna** um
consumidor comum de `sendOutbound`, do mesmo jeito que `automations` e
`flows` já são. O que muda é só a camada acima: escolha de conexão,
conteúdo condicional, elegibilidade condicional.

## 3. Arquitetura

### Componentes

| Componente | Responsabilidade | Muda? |
| --- | --- | --- |
| `broadcast-core.ts` | Resolve conexão/credenciais, monta `OutboundMessage`, itera `sendOutbound` | Refatorado |
| `broadcast-resume.ts` | Retry/resume de lote abandonado | Refatorado (reaproveita o resolver novo) |
| `broadcast-eligibility.ts` | Calcula quem é elegível pra receber | Refatorado (ramifica por `capabilities.initiate`) |
| `/api/whatsapp/broadcast/route.ts` | Endpoint que o loop client-side chama por lote | Refatorado (recebe `connection_id`, conteúdo condicional) |
| `use-broadcast-sending.ts` | Loop client-side em lotes de 10, 1 chamada/lote | Ajustado (payload condicional) — loop em si inalterado |
| `step1-choose-template.tsx` | Passo 1 pra canais com template | Inalterado |
| `step1-compose-message.tsx` (novo) | Passo 1 pra canais sem template — texto + mídia | Novo |
| `step0-choose-connection.tsx` (novo) | Escolher a conexão (dropdown nomeado) | Novo |
| `step3-personalize.tsx` | Mapeamento de variáveis | Generalizado pra aceitar tokens da mensagem livre, não só do template |
| `sendOutbound` / `getProvider` / `getConnectionCredentials` | Infraestrutura de envio já existente | Sem alteração — só passa a ser chamada daqui também |

### Fluxo de criação e envio

1. Usuário abre `/broadcasts/new` → **Passo 0**: escolhe a conexão
   (dropdown "WhatsApp — Loja Centro", "Telegram Bot X", …), carregado de
   `channel_connections` (status `connected`, não `disabled`).
2. `capabilities.initiate` da conexão escolhida decide o Passo 1:
   - `'template'`: lista de templates aprovados (fluxo atual, sem mudança).
   - `'after_inbound'` / `'free'`: editor de "Compor mensagem" — texto com
     tokens `{{1}}`/`{{nome}}` + upload de mídia opcional. Validação de
     tamanho/mídia usa os limites do provider escolhido (não um número
     fixo).
3. **Passo 2 (Audiência):** `fetchEligibleContacts` agora recebe a conexão
   escolhida. Ramifica:
   - `'template'`: identidade daquele canal (qualquer uma) — como hoje.
   - `'after_inbound'`/`'free'`: existe `conversations` com aquele
     `connection_id` específico.
4. **Passo 3 (Personalizar):** o mesmo mapeador de variáveis de hoje,
   generalizado pra ler os tokens do template OU da mensagem livre.
5. **Passo 4 (Agendar/Enviar):** inalterado na mecânica (loop client-side em
   lotes de 10, 1s de pausa) — só o payload de cada chamada passa a incluir
   `connection_id` e o conteúdo condicional.
6. `POST /api/whatsapp/broadcast` (por lote): resolve conexão + credenciais
   uma vez por chamada de rota (não por destinatário — `SendOptions.credentials`
   evita o lookup repetido), monta o `OutboundMessage`, chama `sendOutbound`
   por destinatário do lote, grava em `broadcast_recipients`.
7. Se a aba fechar no meio: `broadcast-resume.ts` retoma exatamente do mesmo
   jeito, agora lendo `connection_id` do broadcast em vez de assumir
   WhatsApp.

## 4. Modelo de Dados

### Diagrama simplificado

```
broadcasts
├── connection_id      (já NOT NULL — sem mudança de FK)
├── template_name       nullable (era NOT NULL)
├── template_language    nullable (era NOT NULL)
├── template_variables   jsonb — reaproveitado p/ os dois casos
├── message_text        text, nullable (NOVO)
├── message_media_url    text, nullable (NOVO)
└── CHECK (
      (template_name IS NOT NULL) <> (message_text IS NOT NULL OR message_media_url IS NOT NULL)
    )                                                          ← exclusividade

broadcast_recipients
├── whatsapp_message_id  (renomeia → external_message_id, expand-contract)
```

Nenhuma tabela nova. `channel_connections`/`contact_identities`/
`conversations` já existem e já carregam tudo que a elegibilidade por canal
precisa (nenhuma coluna nova ali).

### Alterações em tabelas existentes

**`broadcasts`** (migration nova, próximo número livre — hoje `052`):

```sql
ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL,
  ALTER COLUMN template_language DROP NOT NULL,
  ADD COLUMN message_text text,
  ADD COLUMN message_media_url text,
  ADD CONSTRAINT broadcasts_content_exclusive CHECK (
    (template_name IS NOT NULL) <> (message_text IS NOT NULL OR message_media_url IS NOT NULL)
  );
```

`template_variables` (jsonb, já existente) não muda de tipo — passa a
guardar o mapeamento de variáveis também para o caso de mensagem livre, sem
migration.

**`broadcast_recipients.whatsapp_message_id` → `external_message_id`:**
expand-contract, mesmo padrão já usado em `/api/v1/messages` (US-060) e nas
migrations `043`-`051` do `channel-abstraction`:

1. Migration N: adiciona `external_message_id`, backfill a partir de
   `whatsapp_message_id`, índice único condicional espelhado.
2. Código (rota, `broadcast-core.ts`, `broadcast-resume.ts`,
   `use-broadcast-sending.ts`, tipos client) passam a ler/escrever a coluna
   nova.
3. Migration N+1 (história separada/posterior, como foi `051` no
   `channel-abstraction`): dropa `whatsapp_message_id`.

### Estratégia de migração (expandir e contrair)

Segue exatamente o padrão já estabelecido no `channel-abstraction`: nenhuma
coluna vira `NOT NULL`/é removida na mesma migration em que é introduzida.
`supabase/ci/verify-schema.sql` ganha as checagens correspondentes (constraint
de exclusividade + presença da coluna nova), como já é feito para toda
migration desde `043`.

## 5. APIs / Interfaces

### Núcleo de envio (reaproveitado, sem mudança de contrato)

```ts
// src/lib/channels/types.ts — já existe, sem alteração
type OutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: MediaKind; url: string; caption?: string }
  | { type: 'template'; template: TemplateMessage }
  | …

sendOutbound(connection, target, message: OutboundMessage, { credentials }): Promise<SendResult>
```

`broadcast-core.ts` passa a montar esse `OutboundMessage` uma vez por
campanha (não por destinatário) e a resolver `credentials` uma vez por
chamada de rota:

```ts
const connection = await resolveBroadcastConnection(broadcast.connection_id); // novo, genérico
const credentials = await getConnectionCredentials(connection.id);
const provider = getProvider(connection.channel_type);

const message: OutboundMessage = broadcast.template_name
  ? { type: 'template', template: buildTemplatePayload(broadcast) }   // caminho WhatsApp inalterado
  : broadcast.message_media_url
    ? { type: 'media', kind: inferKind(broadcast.message_media_url), url: broadcast.message_media_url, caption: broadcast.message_text }
    : { type: 'text', text: broadcast.message_text! };

for (const recipient of batch) {
  const target = resolveTarget(recipient, connection);          // já existe por provider
  const result = await sendOutbound(connection, target, message, { credentials });
  // grava result.externalId em broadcast_recipients.external_message_id
}
```

### HTTP

`POST /api/whatsapp/broadcast` (caminho mantido por compat; considerar
`/api/broadcasts/[id]/send` numa iteração futura, fora de escopo aqui):

**Request** (novo campo `connection_id`, `template_name` vira opcional):

```json
{
  "connection_id": "uuid",
  "name": "Promoção de aniversário",
  "template_name": "birthday_promo",      // opcional agora
  "template_language": "pt_BR",           // opcional agora
  "message_text": null,                   // OU preenchido, nunca os dois
  "message_media_url": null,
  "template_params": ["Maria"],
  "recipients": [{ "contact_id": "uuid" }]
}
```

400 novo: `connection_id_required`, `content_required` (nem template nem
mensagem livre preenchidos), `connection_channel_mismatch` (id de template
enviado pra conexão sem `capabilities.initiate === 'template'`).

**Response** — campo renomeado, mesma forma:

```json
{ "phone": "+55...", "status": "sent", "external_message_id": "…" }
```

### Interface de configuração (telas)

- `step0-choose-connection.tsx` (novo): lista `channel_connections` do
  account, status `connected`, agrupadas por loja, com badge do canal
  (reaproveita `ConversationScopeBadge`/`Settings.channels.type` já
  existentes na UI de inbox).
- `step1-compose-message.tsx` (novo): textarea + inserir token de variável +
  upload de mídia opcional; validação lê `INTERACTIVE_LIMITS`-equivalente do
  provider escolhido (mesmo princípio corrigido recentemente em Flows —
  mensagem de erro não cita canal errado).
- Relatório de broadcast (`[id]/page.tsx`): colunas `delivered`/`read`
  mostram "—" (indisponível) em vez de `0` quando
  `!capabilities.deliveryStatus`/`!capabilities.readStatus` da conexão do
  broadcast.

## 6. Alternativas Consideradas

| Decisão | Escolhida | Alternativa rejeitada | Por quê |
| --- | --- | --- | --- |
| Resolver de conexão | Reaproveitar `getConnectionCredentials`/`getProvider` | Resolver próprio do broadcast | Duplicaria lógica de credenciais/capabilities já madura em `send.ts` |
| Conteúdo do broadcast | Colunas nullable + `CHECK` em `broadcasts` | Tabela `broadcast_free_messages` 1:1 | Evita join extra em relatório/resume; mesmo padrão de `channel_connections.config` |
| Elegibilidade | Ramificar por `capabilities.initiate` | Um critério único (identidade por família) | Marcaria como elegível contato que só falou com outra conexão do mesmo canal — `⚠️ TENSÃO` real, não hipotética |
| **Envio server-driven vs. client-driven** | **Manter loop client-side (inalterado)** | Mover o envio inteiro pro servidor (ex. fila/cron) nesta mesma iteração | Fora do escopo desta feature — o problema que isso resolveria (aba fechada) já tem mitigação (`broadcast-resume.ts`), independente de canal. Trocar a mecânica de envio junto com a de multi-canal dobraria o raio de risco da mudança sem necessidade |

## 7. Riscos

| Risco | Probabilidade | Impacto | Mitigação |
| --- | --- | --- | --- |
| Regressão no broadcast WhatsApp existente | Média | Alto | Testes de caracterização no fluxo WhatsApp **antes** de tocar em `broadcast-core.ts` (mesma régua do `channel-abstraction`); asserts inalterados |
| Elegibilidade errada deixa passar contato não alcançável (ex. Telegram sem conversa ativa) | Média | Médio (falha de envio, não vazamento de dado) | `sendOutbound`/provider Telegram já rejeita com `recipient_unreachable`; falha fica registrada em `broadcast_recipients.status = 'failed'`, não silenciosa |
| `CHECK` de exclusividade não cobre um caso de borda (ex. `message_media_url` sem `message_text`) | Baixa | Baixo | Teste de banco explícito no `verify-schema.sql`, além dos existentes por migration |
| Rename `whatsapp_message_id` quebra algum consumidor externo (docs públicas, MCP) | Baixa | Médio | `docs/public-api.md`/`docs/mcp.md` já documentam o mesmo rename feito em `/api/v1/messages`; aplicar aviso equivalente se broadcast algum dia for exposto na API pública (hoje não é) |

## 8. Plano de Implementação

1. **Migration + schema**: `052_broadcast_content_and_connection.sql`
   (colunas nullable + `CHECK`), `verify-schema.sql` atualizado.
2. **Testes de caracterização**: fixam o comportamento atual do broadcast
   WhatsApp (template, variáveis, contagens) antes de qualquer refatoração.
3. **Resolver de conexão genérico**: `broadcast-core.ts`/`broadcast-resume.ts`
   passam a usar `getConnectionCredentials`/`getProvider`.
4. **Elegibilidade por canal**: `broadcast-eligibility.ts` ramifica por
   `capabilities.initiate`.
5. **Envio condicional**: monta `OutboundMessage` (`template` vs.
   `text`/`media`) a partir do conteúdo salvo.
6. **Wizard**: `step0-choose-connection.tsx` (novo) +
   `step1-compose-message.tsx` (novo) + `step3-personalize.tsx` generalizado.
7. **Relatório**: métricas indisponíveis por capability.
8. **Rename** `whatsapp_message_id` → `external_message_id` (expand;
   contract numa história separada).
9. **Docs**: `docs/public-api.md`/CLAUDE.md, se o broadcast algum dia for
   exposto fora do dashboard.

## 9. Observabilidade

- Reaproveita o log estruturado já existente (`channelLog`,
  `[channel:<type>] conn=<id> event=<id>`) dentro de `sendOutbound` — nenhum
  logging novo necessário no core de envio.
- `broadcast_recipients.error_message` continua sendo o registro por
  destinatário (já existente); passa a incluir os códigos de `ChannelError`
  do provider (`recipient_unreachable`, `unsupported`, etc.), não só erros
  da Meta.
- Métrica de sucesso do SOLUTION.md ("zero regressão no WhatsApp") é
  verificável via os testes de caracterização do passo 2 — não precisa de
  observabilidade em produção nova.

---

Próximos passos possíveis:

a) Gerar os dois ADRs sinalizados (resolver de conexão; modelo de dados)
b) Gerar o breakdown de tasks (PRD → prd.json) a partir deste design
c) Refinar alguma seção
