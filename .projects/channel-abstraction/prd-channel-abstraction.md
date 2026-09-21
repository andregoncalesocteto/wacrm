# PRD: Abstração de canais (multiloja, multicanal)

> Base: `SOLUTION.md` (v1), `design.md` e `adr/ADR-001` a `ADR-007` desta pasta.
> As histórias estão em **ordem estrita de execução**: cada uma só depende das anteriores, e o CI fica verde a cada uma.
> Todas as verificações de teste usam `TZ=UTC npm test` (dois testes de `date-utils` falham em fuso não UTC, por um
> problema de ambiente já conhecido).

## Introdução

O produto é um CRM de atendimento sobre WhatsApp que hoje fala com **um canal** (WhatsApp Business da Meta) e com **uma
conexão por conta**. Esta feature o transforma em um CRM **multiloja e multicanal**: uma conta (a rede) tem várias
**lojas**, cada loja tem uma ou mais **conexões** de canais diferentes, e todas as conversas caem num **inbox único**.
Ela introduz um **contrato de provedor de canal**, migra o WhatsApp oficial para ele **sem mudar seu comportamento**, e
prova a abstração com um segundo canal, o **Telegram**. O CRM (pipelines, negócios, etiquetas, campos, notas,
automações, flows, IA e painel) continua funcionando **igual em qualquer canal**.

O produto não tem cliente hoje e é independente do template original. A API pública `/api/v1` muda no lugar e é
pré-estável até o primeiro cliente.

## Goals

- Uma conta com várias lojas; cada loja com uma ou mais conexões, inclusive de canais diferentes ao mesmo tempo.
- Um contrato de provedor no qual um canal novo entra com **um provedor e um registro**, sem alterar o núcleo.
- **Regressão zero no WhatsApp oficial**: a suíte de testes existente continua passando.
- O caso das pizzarias funciona: 2 ou mais lojas e 2 canais (WhatsApp oficial e Telegram) no mesmo inbox, com o mesmo
  cliente como um contato só.
- O CRM funciona igual para um contato do Telegram.
- Conexões com estado em tempo de execução e aviso quando uma cai.

## User Stories

> Convenções que valem para **todas** as histórias e não se repetem nos critérios:
> - Texto de interface usa `useTranslations`, sem literal em inglês; chaves novas entram nos **quatro catálogos**
>   (`en`, `pt`, `es`, `ko`) e o teste de paridade passa.
> - Datas e números usam `useFormatter()`; nunca `toLocale*String` nem `new Intl.*Format` direto.
> - `npm run typecheck`, `npm run lint` (0 erros) e `TZ=UTC npm test` passam.
> - Migrations são novas e sequenciais (a próxima é `043`); nunca se edita uma já aplicada, e o replay do zero passa.
> - O comportamento observável do **WhatsApp oficial** não muda, salvo onde a história disser.

### Fase 0 · Rede de segurança

### US-001: Mapear a cobertura de testes do WhatsApp oficial
**Description:** Como desenvolvedor, quero saber o que os testes atuais cobrem no WhatsApp oficial para refatorar sem
regredir.

**Acceptance Criteria:**
- [ ] `.projects/channel-abstraction/coverage-map.md` lista, para envio, webhook (mensagem, status, reação, mídia),
  templates, broadcast (criar, entregar, retomar), motor de flows, motor de automações e resposta por IA, os arquivos de
  teste existentes e o que cada um garante
- [ ] O arquivo lista as **lacunas** (comportamentos sem teste) que as US-002 a US-004 vão cobrir
- [ ] Nenhum código de produção é alterado
- [ ] Typecheck/lint passes

### US-002: Testes de caracterização do recebimento do WhatsApp
**Description:** Como desenvolvedor, quero testes que fixem o comportamento do webhook antes da refatoração.

**Acceptance Criteria:**
- [ ] Teste: o **reenvio** da mesma mensagem não duplica (a mesma `(conversa, id externo)` é ignorada)
- [ ] Teste: mensagem de número novo cria contato (por telefone normalizado) e conversa; de contato conhecido reaproveita
- [ ] Teste: mensagem identificada só por BSUID/`username` cria e reencontra o contato sem telefone
- [ ] Teste: os degraus de status (`sent`, `delivered`, `read`, `failed`) só avançam, e o motivo de falha é gravado
- [ ] Teste: reação e mensagem com mídia são registradas
- [ ] Os testes passam **contra o código atual, sem alterá-lo**
- [ ] Typecheck/lint passes

### US-003: Testes de caracterização do envio do WhatsApp
**Description:** Como desenvolvedor, quero testes que fixem o comportamento do envio antes da refatoração.

**Acceptance Criteria:**
- [ ] Teste: em erro "destinatário não permitido", o envio tenta as variantes de telefone e para nos demais erros
- [ ] Teste: contato sem telefone válido usa o BSUID como destino; sem nenhum destino, falha com erro claro
- [ ] Teste: envio de texto, mídia, template e interativo grava a mensagem e atualiza a conversa
- [ ] Teste: quando um agente envia, o flow ativo do contato é pausado
- [ ] Os testes passam **contra o código atual, sem alterá-lo**
- [ ] Typecheck/lint passes

### US-004: Testes de caracterização dos motores e do broadcast
**Description:** Como desenvolvedor, quero testes que fixem o envio feito por flows, automações, IA e broadcast.

**Acceptance Criteria:**
- [ ] Teste: os envios do motor de flows (texto, mídia, botões, lista) gravam a mensagem e atualizam a conversa
- [ ] Teste: o envio do motor de automações (texto e template) e a retomada de uma espera enviam pela conversa certa
- [ ] Teste: a resposta automática por IA envia o texto gerado e respeita o limite por conversa
- [ ] Teste: `deliverBroadcast` atualiza `broadcast_recipients` (enviado ou falha) e `finalizeBroadcastStatus` calcula o
  estado final, inclusive numa retomada
- [ ] Os testes passam **contra o código atual, sem alterá-lo**
- [ ] Typecheck/lint passes

### Fase 1 · Schema (expandir)

### US-005: Criar as tabelas de loja, conexão, credenciais e identidades
**Description:** Como desenvolvedor, preciso das tabelas do novo modelo para começar a migrar os dados.

**Acceptance Criteria:**
- [ ] Migration `043` cria `stores`, `channel_connections` (com `disabled_at`, estado, saúde, `UNIQUE (channel_type,
  external_id)`), `channel_connection_credentials` (com `secrets_encrypted` e `secrets_format`) e `contact_identities`
  (`UNIQUE (account_id, kind, external_id)`), com os índices do Design Doc
- [ ] Políticas de acesso: `stores` e `channel_connections` com leitura para membros e escrita para `admin`+;
  `contact_identities` segue as regras de `contacts`; `channel_connection_credentials` com RLS ligado e **sem nenhuma política**
- [ ] `supabase/ci/verify-schema.sql` verifica que as quatro tabelas existem e que `channel_connection_credentials` não
  tem política
- [ ] O replay das migrations do zero passa e `verify-schema.sql` passa
- [ ] Typecheck/lint passes

### US-006: Acrescentar as colunas novas, ainda nulas
**Description:** Como desenvolvedor, preciso das colunas novas antes de mudar o código que as usa.

**Acceptance Criteria:**
- [ ] Migration `044` acrescenta, **nulos**: `conversations.connection_id`, `message_templates.connection_id`,
  `broadcasts.connection_id`, `automation_pending_executions.conversation_id` e `.connection_id`, `quick_replies.store_id`
- [ ] A restrição de `notifications.type` passa a aceitar também `'connection_down'`
- [ ] Nenhum índice único existente é alterado nesta história
- [ ] `verify-schema.sql` verifica as colunas novas
- [ ] O replay do zero e a suíte existente passam
- [ ] Typecheck/lint passes

### US-007: Preencher os dados existentes (backfill)
**Description:** Como desenvolvedor, quero que as contas existentes ganhem uma loja e uma conexão para o novo modelo funcionar.

**Acceptance Criteria:**
- [ ] Migration `045`, **idempotente**, cria por conta uma `store` (nome da conta) e uma `channel_connection`
  `whatsapp_cloud` a partir de `whatsapp_config` (`external_id` = `phone_number_id`, estado e `config`)
- [ ] O `access_token` já cifrado é copiado **como está** para `channel_connection_credentials.secrets_encrypted` com
  `secrets_format = 'wa_token_v0'` (formato de token único), sem exigir a chave de cifra na migration
- [ ] `conversations.connection_id`, `message_templates.connection_id`, `broadcasts.connection_id` e
  `automation_pending_executions.conversation_id`/`connection_id` são preenchidos
- [ ] `contact_identities` recebe uma linha por `phone_normalized` (`whatsapp:phone`), `wa_user_id` (`whatsapp:bsuid`) e
  `wa_username` (`whatsapp:username`) de cada contato
- [ ] `verify-schema.sql` afirma que não sobra `connection_id` nulo em conversas de contas que tinham `whatsapp_config`
- [ ] Rodar a migration duas vezes não duplica nenhuma linha
- [ ] Typecheck/lint passes

### US-008: Criar o acesso a conexões e credenciais
**Description:** Como desenvolvedor, quero um único lugar para ler conexões e credenciais.

**Acceptance Criteria:**
- [ ] `src/lib/channels/connections.ts` expõe: buscar por id, por `(canal, external_id)`, listar por conta e por loja, e
  obter credenciais decifradas (só com o cliente de serviço)
- [ ] A leitura das credenciais entende `wa_token_v0` (token único) e o formato novo (JSON), e **regrava no formato novo**
  na primeira leitura, no mesmo padrão do upgrade de CBC para GCM já existente
- [ ] Nenhuma função devolve credenciais para um cliente de usuário (teste que garante isso)
- [ ] Testes de unidade cobrem os dois formatos, o upgrade e a ausência de conexão
- [ ] Typecheck/lint passes

### Fase 2 · Contrato do provedor e adaptador do WhatsApp

### US-009: Definir o contrato de provedor e o registro
**Description:** Como desenvolvedor, quero o contrato que todo canal implementa.

**Acceptance Criteria:**
- [ ] `src/lib/channels/types.ts` define `ChannelType`, `Capabilities`, `ChannelProvider`, `InboundEvent`,
  `OutboundMessage`, `SendResult`, `Target`, `Health` e `ChannelError` (com os códigos `auth`, `rate_limited`,
  `recipient_unreachable`, `unsupported`, `window_closed`, `invalid`, `unknown`), como no Design Doc
- [ ] `src/lib/channels/registry.ts` registra e busca provedores por `channel_type`; um tipo desconhecido lança erro claro
- [ ] Testes de unidade do registro
- [ ] Typecheck/lint passes

### US-010: Provedor WhatsApp — capacidades, envio e destino
**Description:** Como desenvolvedor, quero o WhatsApp oficial como o primeiro provedor, no lado do envio.

**Acceptance Criteria:**
- [ ] `src/lib/channels/providers/whatsapp-cloud/` declara as capacidades (templates, botões, lista, reações,
  "digitando", entregue, lido, iniciar por template, janela de 24 h, mídia e limites) e os esquemas de configuração e
  credenciais
- [ ] `resolveTarget` usa `resolveContactSendTarget` (telefone, com BSUID como reserva)
- [ ] `send` envia texto, mídia, template e interativo pelas funções atuais de `lib/whatsapp/meta-api.ts`, com a
  **retentativa de variantes de telefone dentro do provedor**
- [ ] Erros da Meta são convertidos em `ChannelError` tipado, preservando o código original
- [ ] O adaptador **usa** os arquivos atuais de `lib/whatsapp/*`, sem movê-los
- [ ] Testes de unidade cobrem envio, variantes, destino e mapeamento de erros; o registro conhece `whatsapp_cloud`
- [ ] Typecheck/lint passes

### US-011: Provedor WhatsApp — entrada (conexão, verificação e parse)
**Description:** Como desenvolvedor, quero o WhatsApp entendendo o que chega, em formato normalizado.

**Acceptance Criteria:**
- [ ] `resolveConnection` acha a conexão pelo `phone_number_id` do payload
- [ ] `verify` valida o HMAC com `META_APP_SECRET` (aceitando a lista separada por vírgulas), em tempo constante
- [ ] `parse` converte o payload em `InboundEvent[]` (mensagem, status, reação), com **candidatos de identidade**
  (`whatsapp:phone`, `whatsapp:bsuid`, `whatsapp:username`) e todo o conteúdo suportado hoje (texto, mídia, botão,
  lista, localização, resposta a outra mensagem)
- [ ] Os testes usam os payloads de fixtures do webhook atual e produzem eventos equivalentes ao que o código atual grava
- [ ] O webhook atual **ainda não usa** este código
- [ ] Typecheck/lint passes

### US-012: Provedor WhatsApp — ciclo de vida e operações opcionais
**Description:** Como desenvolvedor, quero conectar, desconectar e checar o WhatsApp pelo contrato.

**Acceptance Criteria:**
- [ ] `connect` reaproveita a lógica atual de registro e inscrição do app (de `config/route.ts` e `verify-registration`)
- [ ] `disconnect` e `health` são implementados (o estado sai da sondagem de registro existente)
- [ ] `downloadMedia`, `react` e `typing` chamam as funções atuais da Meta e são declarados como capacidades
- [ ] Testes de unidade com a Meta simulada cobrem sucesso e erro de cada operação
- [ ] Typecheck/lint passes

### US-013: Gravar também em `channel_connections` ao salvar a configuração
**Description:** Como desenvolvedor, quero que a tela atual continue funcionando enquanto migramos os leitores.

**Acceptance Criteria:**
- [ ] `POST` e `DELETE /api/whatsapp/config`, o botão de espelhamento de mídia e a verificação de registro passam a
  gravar também em `channel_connections` e `channel_connection_credentials` (**escrita dupla**)
- [ ] Salvar cria a loja padrão e a conexão da conta se ainda não existirem
- [ ] `whatsapp_config` continua sendo gravada exatamente como hoje
- [ ] Testes de rota cobrem criar, atualizar e apagar nas duas tabelas
- [ ] Typecheck/lint passes

### US-014: Migrar os leitores de envio para `connections.ts`
**Description:** Como desenvolvedor, quero que o envio leia a conexão nova.

**Acceptance Criteria:**
- [ ] `send-message.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`, `ai/auto-reply.ts` e
  `whatsapp/resolve-conversation.ts` deixam de ler `whatsapp_config` e usam `connections.ts`
- [ ] Nenhum teste existente é alterado além de caminhos e dublês
- [ ] Nenhuma leitura de `whatsapp_config` sobra nesses arquivos (busca no código)
- [ ] Typecheck/lint passes

### US-015: Migrar os leitores de broadcast
**Description:** Como desenvolvedor, quero que o broadcast leia a conexão nova.

**Acceptance Criteria:**
- [ ] `broadcast-core.ts`, `broadcast-resume.ts` e `app/api/whatsapp/broadcast/route.ts` deixam de ler `whatsapp_config`
- [ ] Um broadcast passa a gravar o `connection_id` da conexão de WhatsApp que envia
- [ ] Os testes de broadcast e de retomada passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-016: Migrar os leitores de templates, mídia e reação
**Description:** Como desenvolvedor, quero que templates, mídia e reações leiam a conexão nova.

**Acceptance Criteria:**
- [ ] `templates/submit`, `templates/[id]`, `templates/sync`, `template-webhook.ts`, `media/[mediaId]` e `react` deixam de
  ler `whatsapp_config`
- [ ] Templates novos gravam `connection_id`
- [ ] Os testes existentes passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-017: Migrar o webhook, a API v1 e a página do inbox
**Description:** Como desenvolvedor, quero que o webhook e o restante dos leitores usem a conexão nova.

**Acceptance Criteria:**
- [ ] A busca da conta por `phone_number_id` e a verificação `hub.verify_token` do `GET` do webhook usam
  `channel_connections`
- [ ] `lib/api/v1/contacts.ts` e `app/(dashboard)/inbox/page.tsx` deixam de ler `whatsapp_config`
- [ ] Uma busca no código por `whatsapp_config` só acha as telas de configuração (`settings-overview.tsx`,
  `whatsapp-config.tsx`) e a rota de escrita dupla
- [ ] `route.test.ts` do webhook passa sem alteração de comportamento
- [ ] Typecheck/lint passes

### Fase 3 · Recebimento

### US-018: Resolver o contato por identidades
**Description:** Como desenvolvedor, quero um único caminho para achar ou criar o contato a partir do que o provedor entrega.

**Acceptance Criteria:**
- [ ] `src/lib/channels/identity.ts` recebe candidatos de identidade e devolve o contato existente (por qualquer
  candidato) ou cria um contato com todas as identidades
- [ ] Encontrar por um candidato e trazer candidatos novos acrescenta as identidades novas ao mesmo contato
- [ ] `contactDisplayName` devolve nome, ou a identidade principal (`@username`, telefone, BSUID, id do canal), nunca vazio
- [ ] Os casos de `wa-identity.ts` (telefone, BSUID, `username`, duplicata por unicidade) têm teste equivalente
- [ ] Typecheck/lint passes

### US-019: Ingerir mensagens recebidas
**Description:** Como desenvolvedor, quero um núcleo que grave a mensagem recebida de qualquer canal.

**Acceptance Criteria:**
- [ ] `src/lib/channels/ingest.ts` (`ingestInbound`) trata eventos `message`: resolve o contato, acha ou cria a conversa
  por `(contato, conexão)`, grava a mensagem com `ON CONFLICT (conversation_id, message_id) DO NOTHING` e atualiza a
  conversa (último texto, horário, não lidas)
- [ ] O reenvio do mesmo evento não duplica nada (teste)
- [ ] A função só depende dos dados que recebe, sem depender de rota ou de `after()`
- [ ] Testes de unidade com provedor simulado
- [ ] Typecheck/lint passes

### US-020: Ingestão — distribuição para os demais motores
**Description:** Como desenvolvedor, quero que a mensagem recebida dispare tudo o que dispara hoje.

**Acceptance Criteria:**
- [ ] Depois de gravar, a ingestão dispara automações, flows, resposta por IA, webhooks de saída (`message.received`) e
  notificações, e sinaliza a resposta de um broadcast, com as mesmas regras do código atual
- [ ] Uma falha num motor não impede os outros nem desfaz a mensagem gravada (teste)
- [ ] Testes de unidade cobrem cada disparo com dublês
- [ ] Typecheck/lint passes

### US-021: Ingestão — mídia, status e reação
**Description:** Como desenvolvedor, quero a ingestão tratando mídia, status e reações.

**Acceptance Criteria:**
- [ ] O espelhamento de mídia recebida usa `provider.downloadMedia` e o armazenamento atual, respeitando a opção da conexão
- [ ] Eventos `status` avançam o estado da mensagem só para frente e gravam o motivo de falha (provedores sem recibo
  simplesmente não geram esse evento)
- [ ] Eventos `reaction` gravam ou removem a reação
- [ ] Testes de unidade para cada tipo de evento
- [ ] Typecheck/lint passes

### US-022: Reduzir o webhook do WhatsApp a uma casca fina
**Description:** Como desenvolvedor, quero o webhook do WhatsApp delegando ao provedor e ao núcleo.

**Acceptance Criteria:**
- [ ] `POST /api/whatsapp/webhook` faz `resolveConnection` → `verify` → `parse`, responde `200` e processa com
  `ingestInbound` dentro de `after()` (mantendo `maxDuration = 60`)
- [ ] O código antigo de processamento de mensagens do arquivo é removido
- [ ] `GET` (verificação de inscrição da Meta) e a rota continuam no mesmo caminho
- [ ] Todos os testes da rota e os de caracterização da US-002 passam **sem alteração**
- [ ] Typecheck/lint passes

### Fase 4 · Envio unificado

### US-023: Núcleo de envio — texto e mídia
**Description:** Como desenvolvedor, quero um único caminho para enviar mensagens.

**Acceptance Criteria:**
- [ ] `src/lib/channels/send.ts` (`sendOutbound`) carrega conversa, conexão, contato e identidades, pede o destino ao
  provedor, valida a mensagem contra as capacidades, chama `provider.send`, grava a mensagem e atualiza a conversa
- [ ] Capacidade ausente ou destino inexistente lança `ChannelError` tipado (`unsupported`, `recipient_unreachable`)
  **sem chamar o provedor**
- [ ] Quando o ator é um agente, o flow ativo da conversa é pausado
- [ ] Erro do provedor grava a mensagem como falha com `error_code`/`error_title`/`error_details`
- [ ] Testes de unidade com provedor simulado; os testes de caracterização de envio (US-003) têm equivalente aqui
- [ ] Typecheck/lint passes

### US-024: Núcleo de envio — template e interativo
**Description:** Como desenvolvedor, quero o núcleo cobrindo templates e mensagens interativas.

**Acceptance Criteria:**
- [ ] `sendOutbound` aceita `template` e `interactive`, validando `templates`, botões e lista pelas capacidades
- [ ] O conteúdo gravado para template e interativo é idêntico ao que o envio atual grava
- [ ] Testes de unidade para template, botões e lista, inclusive o erro `unsupported` num provedor sem a capacidade
- [ ] Typecheck/lint passes

### US-025: Rota de envio do dashboard usa o núcleo
**Description:** Como agente, quero que o envio pelo inbox continue funcionando.

**Acceptance Criteria:**
- [ ] `POST /api/whatsapp/send` chama `sendOutbound` e mapeia `ChannelError` para as mesmas respostas HTTP de hoje
- [ ] O teste da rota (`route.test.ts`) passa sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-026: API pública de mensagens e criação de conversa usam o núcleo
**Description:** Como integrador, quero o envio pela API pública passando pelo núcleo, sem mudar o contrato ainda.

**Acceptance Criteria:**
- [ ] `POST /api/v1/messages` e `resolve-conversation.ts` usam `sendOutbound`; toda conversa criada recebe `connection_id`
  (a conexão de WhatsApp ativa da conta)
- [ ] O contrato atual da API (campos, códigos de erro) fica inalterado nesta história
- [ ] Os testes de rota e de `send-message` passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-027: Motor de flows usa o núcleo
**Description:** Como operador, quero que os flows continuem enviando.

**Acceptance Criteria:**
- [ ] Os passos de envio de flows (texto, mídia, botões, lista) chamam `sendOutbound` com ator `flow`
- [ ] `flows/meta-send.ts` deixa de ser usado pelos flows
- [ ] Os testes do motor de flows passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-028: Motor de automações usa o núcleo e guarda a conversa nas esperas
**Description:** Como operador, quero que as automações, inclusive as esperas, enviem pela conversa certa.

**Acceptance Criteria:**
- [ ] Os passos de envio de automações chamam `sendOutbound` com ator `automation`
- [ ] Ao agendar uma espera, `automation_pending_executions` grava `conversation_id` e `connection_id`, e a retomada
  envia por essa conversa
- [ ] Gatilhos sem conversa (por tempo ou etiqueta) resolvem a **conversa mais recente do contato** numa conexão que
  suporta o passo; se não houver, a execução é registrada como **ignorada, com o motivo**
- [ ] Os testes do motor de automações passam, e há testes novos para a espera e para o caso "ignorada"
- [ ] Typecheck/lint passes

### US-029: Resposta por IA usa o núcleo
**Description:** Como operador, quero que a resposta por IA continue funcionando.

**Acceptance Criteria:**
- [ ] `ai/auto-reply.ts` envia com `sendOutbound` (ator `ai`) e usa `provider.typing` quando a capacidade existe
- [ ] Os testes de IA passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-030: Broadcast usa o provedor
**Description:** Como operador, quero que o broadcast continue igual.

**Acceptance Criteria:**
- [ ] `deliverBroadcast` envia por `provider.send` da conexão do broadcast e exige a capacidade `templates`
- [ ] O broadcast **não** cria conversa nem mensagem, e o rastreio em `broadcast_recipients` fica idêntico
- [ ] Os testes de broadcast e de retomada passam sem alteração de comportamento
- [ ] Typecheck/lint passes

### US-031: Remover o envio antigo
**Description:** Como desenvolvedor, quero apagar as cópias de envio que ficaram sem uso.

**Acceptance Criteria:**
- [ ] `engineSendText`, `engineSendMedia`, `engineSendTemplate`, `engineSendInteractive*` e o código morto de envio
  em `send-message.ts` são removidos
- [ ] Uma busca no código não acha chamadas diretas a `meta-api` fora do provedor do WhatsApp, das rotas de
  templates e de mídia e das telas de configuração
- [ ] A suíte completa passa
- [ ] Typecheck/lint passes

### US-032: Trocar os índices únicos para o novo modelo
**Description:** Como desenvolvedor, quero que o banco garanta a regra "uma conversa por contato e conexão".

**Acceptance Criteria:**
- [ ] Migration `046` torna `conversations.connection_id` `NOT NULL`, troca `idx_conversations_account_contact` por
  `UNIQUE (contact_id, connection_id)` e cria o índice `(connection_id, last_message_at DESC)`
- [ ] Troca `idx_one_active_run_per_contact` por unicidade da execução ativa **por conversa**
- [ ] `verify-schema.sql` verifica os índices novos e a ausência de `connection_id` nulo
- [ ] O replay do zero, `verify-schema.sql` e a suíte passam
- [ ] Typecheck/lint passes

### Fase 5a · Configuração de lojas e canais

### US-033: Rotas de lojas
**Description:** Como administrador, quero gerenciar lojas pela interface.

**Acceptance Criteria:**
- [ ] `GET|POST /api/stores` e `PATCH|DELETE /api/stores/{id}`, com nome obrigatório e endereço, telefone, horário e
  responsável opcionais
- [ ] Escrita só para `admin`+; membros comuns só leem
- [ ] `DELETE` numa loja com qualquer conexão (ativa ou desativada) responde `409 has_connections`
- [ ] Testes de rota para papéis, validação e o `409`
- [ ] Typecheck/lint passes

### US-034: Rotas de conexões
**Description:** Como administrador, quero listar, criar, editar e apagar conexões.

**Acceptance Criteria:**
- [ ] `GET|POST /api/channels/connections` e `PATCH|DELETE /api/channels/connections/{id}`; `PATCH` aceita nome, configuração
  e **mover de loja**
- [ ] Criar valida a configuração e as credenciais pelo esquema do provedor e grava as credenciais na tabela separada
- [ ] Nenhuma resposta traz credenciais (teste)
- [ ] `DELETE` numa conexão com conversas responde `409 has_conversations`
- [ ] Escrita só para `admin`+
- [ ] Testes de rota para papéis, validação, mover de loja e os `409`
- [ ] Typecheck/lint passes

### US-035: Rotas do ciclo de vida e dos provedores
**Description:** Como administrador, quero conectar, testar, desativar e reativar uma conexão.

**Acceptance Criteria:**
- [ ] `POST .../{id}/connect` chama `provider.connect`; `.../test` chama `provider.health` na hora; `.../disable` chama
  `provider.disconnect`, preserva as credenciais e preenche `disabled_at`; `.../enable` reativa
- [ ] `GET /api/channels/providers` devolve os provedores disponíveis (nome, capacidades, descritor de campos)
- [ ] Desativar avisa a contagem de conversas abertas na resposta
- [ ] Testes de rota para cada ação, inclusive o efeito em `disabled_at`
- [ ] Typecheck/lint passes

### US-036: Navegação das configurações
**Description:** Como administrador, quero as seções de lojas e canais no menu de configurações.

**Acceptance Criteria:**
- [ ] `settings-sections.ts` troca a seção `whatsapp` por `stores` ("Lojas") e `channels` ("Canais"), no grupo *Workspace*
- [ ] `resolveSection('whatsapp')` leva a `channels`, então os links existentes continuam funcionando
- [ ] Seções renderizam um espaço reservado, e as ações exigem `useCan('edit-settings')` (demais papéis: somente leitura)
- [ ] Chaves de tradução novas nos quatro catálogos
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (menu de configurações e o link antigo `?tab=whatsapp`)

### US-037: Tela de lojas
**Description:** Como administrador, quero cadastrar e editar as lojas.

**Acceptance Criteria:**
- [ ] Lista com nome, endereço, telefone e as conexões da loja com seus estados
- [ ] Diálogo "Nova loja" (nome obrigatório) e o mesmo diálogo para editar
- [ ] Apagar fica **desabilitado**, com explicação, quando a loja tem conexões
- [ ] Estado vazio: "Cadastre sua primeira loja"
- [ ] Erros de validação e de API aparecem em toast traduzido
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (criar, editar, tentar apagar loja com conexão, estado vazio)

### US-038: Tela de canais (lista)
**Description:** Como administrador, quero ver todas as conexões por loja.

**Acceptance Criteria:**
- [ ] Lista agrupada por loja, com ícone e nome do canal, nome da conexão, estado (`connected`, `degraded`,
  `disconnected`, `needs_action` ou desativada), último recebimento e as ações
- [ ] *Apagar* só aparece para conexão sem conversas
- [ ] Estado vazio com "Conectar canal"; se não existir loja, o botão leva a criar a loja primeiro
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (lista, estados e estado vazio)

### US-039: Conectar um canal
**Description:** Como administrador, quero conectar um canal a uma loja.

**Acceptance Criteria:**
- [ ] Assistente em quatro passos: loja, canal (cartões de `GET /api/channels/providers`), dados, conectar e testar
- [ ] `src/lib/channels/ui-registry.tsx` mapeia `channel_type` para um descritor de formulário ou para um painel próprio
- [ ] O painel do WhatsApp **reaproveita `whatsapp-config.tsx`**, recebendo a conexão como parâmetro (número, WABA, token,
  PIN, sondagem de registro, espelhamento de mídia, URL do webhook e token de verificação)
- [ ] Campos `secret` nunca são preenchidos; só se envia o valor novo
- [ ] O resultado do passo 4 mostra sucesso ou o motivo do erro
- [ ] Salvar não usa mais a escrita dupla para os dados da conexão criada por aqui
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (conectar um WhatsApp com credenciais inválidas e ver o erro tratado; o
  registro e a sondagem de registro continuam funcionando na tela reaproveitada)

### US-040: Detalhe da conexão
**Description:** Como administrador, quero ver o estado de uma conexão e agir sobre ela.

**Acceptance Criteria:**
- [ ] Mostra estado e motivo, último erro (código, mensagem e ação sugerida por tipo de erro) e as contagens das
  últimas 24 h (mensagens recebidas, enviadas e falhas, calculadas de `messages`)
- [ ] Ações: *Testar conexão*, *Reconectar*, *Mover de loja* (confirmação com a contagem de conversas), *Desativar*
  (aviso com a contagem de conversas abertas) e *Apagar* (só sem conversas)
- [ ] Segredos aparecem como "informado" com o botão *Substituir*; o valor antigo nunca é exibido
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (cada ação, o aviso ao desativar e o segredo mascarado)

### US-041: Visão geral, templates e respostas rápidas
**Description:** Como administrador, quero as telas vizinhas cientes de lojas e conexões.

**Acceptance Criteria:**
- [ ] `settings-overview.tsx` troca o cartão de WhatsApp por "Lojas: N" e "Canais: X conectados de Y" (pior estado
  destacado) e lê `GET /api/channels/connections`
- [ ] `template-manager.tsx` ganha um seletor de **conexão de WhatsApp**, oculto quando há uma só, e lista e envia por
  `connection_id`
- [ ] Respostas rápidas ganham o campo opcional **Loja** (vazio = da rede)
- [ ] `settings-overview.tsx` e `whatsapp-config.tsx` deixam de ler `whatsapp_config`
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (visão geral, seletor de conexão em templates, campo Loja)

### Fase 5b · Inbox multiloja

### US-042: Consultas e filtros do inbox por loja, conexão e canal
**Description:** Como agente, quero filtrar as conversas por loja, conexão e canal.

**Acceptance Criteria:**
- [ ] `CONVERSATION_SELECT` traz a conexão (com loja e canal) de cada conversa, e os tipos de `Conversation` refletem isso
- [ ] Uma função de filtro (ao lado de `matchesContactFilters`) filtra por loja, conexão e canal, combinada com status e atribuição
- [ ] Testes de unidade dos filtros e da normalização
- [ ] Typecheck/lint passes

### US-043: Selos e filtros no inbox
**Description:** Como agente, quero ver de qual loja e canal é cada conversa.

**Acceptance Criteria:**
- [ ] Cada conversa na lista e no cabeçalho mostra um selo com o nome da loja e o canal
- [ ] Filtros de loja, conexão e canal na lista, combinados com os existentes; a visão padrão mistura tudo, pela última mensagem
- [ ] Com **uma conexão só**, selos e filtros de loja não aparecem e a tela fica idêntica à atual
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (uma conexão, depois duas lojas com duas conexões)

### US-044: Não lidas por loja, aviso de conexão caída e conexão desativada
**Description:** Como agente, quero saber quando uma loja não está recebendo e quais conversas estão sem resposta.

**Acceptance Criteria:**
- [ ] Contagem de não lidas total e por loja (só com mais de uma loja)
- [ ] Aviso no inbox quando uma conexão está `disconnected` ou `needs_action` ("a loja X está desconectada")
- [ ] Conversas de conexão **desativada** ficam visíveis, com selo "desativada" e **compositor desabilitado** com uma explicação
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (aviso, contagens por loja e conexão desativada)

### US-045: Conversas do contato em outras lojas
**Description:** Como agente, quero ver se o mesmo cliente também falou com outra loja.

**Acceptance Criteria:**
- [ ] O perfil do contato lista todas as conversas dele, com loja, canal e último contato, cada uma com um link
- [ ] Sem outras conversas, a seção não aparece
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (um contato com conversas em duas conexões)

### US-046: Compositor por capacidades
**Description:** Como agente, quero que o compositor mostre só o que o canal da conversa faz.

**Acceptance Criteria:**
- [ ] Botões de template, mídia, interativo e reação aparecem, ou ficam desabilitados com explicação, conforme as
  capacidades da conexão da conversa
- [ ] Um `ChannelError` do envio aparece como mensagem traduzida (por exemplo, "esta conversa não aceita templates")
- [ ] Para uma conexão de WhatsApp o compositor fica idêntico ao atual
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (compositor numa conversa de WhatsApp)

### Fase 6 · Telegram (canal de prova)

### US-047: Provedor Telegram — capacidades e ciclo de vida
**Description:** Como desenvolvedor, quero o Telegram como o segundo provedor.

**Acceptance Criteria:**
- [ ] `providers/telegram/` declara as capacidades (texto, mídia até 50 MB, legenda de 1024 caracteres, botões, reações,
  "digitando"; sem templates, lista, entregue e lido; iniciar só depois de o contato falar) e os esquemas de configuração e credenciais
- [ ] `connect` gera um `secret_token`, guarda cifrado e chama `setWebhook` com a URL da conexão; recusa com erro claro se a URL
  pública não for HTTPS
- [ ] `disconnect` remove o webhook; `health` usa `getWebhookInfo` (erro recente e mensagens pendentes)
- [ ] O registro conhece `telegram`
- [ ] Testes de unidade com `fetch` simulado
- [ ] Typecheck/lint passes

### US-048: Provedor Telegram — recebimento
**Description:** Como desenvolvedor, quero receber mensagens do Telegram.

**Acceptance Criteria:**
- [ ] `POST /api/channels/[channel]/webhook/[connectionId]` responde `200` e processa com `ingestInbound` em `after()`
- [ ] `verify` compara o `secret_token` do cabeçalho em tempo constante; um valor inválido responde `401` e não processa
- [ ] `parse` converte texto, foto, documento, voz, vídeo e resposta de botão em `InboundEvent`, com candidatos
  `telegram:chat_id` e `telegram:username`, usando **fixtures de payload**
- [ ] A mídia é espelhada **sem gravar a URL que contém o token do bot** (teste que garante isso)
- [ ] O reenvio da mesma atualização não duplica (teste)
- [ ] Typecheck/lint passes

### US-049: Provedor Telegram — envio
**Description:** Como desenvolvedor, quero enviar mensagens pelo Telegram.

**Acceptance Criteria:**
- [ ] `send` envia texto, mídia e botões; `react` e `typing` implementados; `resolveTarget` usa a identidade `telegram:chat_id`
- [ ] Erros do Bot API viram `ChannelError` tipado, com bot bloqueado ou usuário que ainda não falou como `recipient_unreachable`
- [ ] Um envio por um provedor sem a capacidade (por exemplo, template) é recusado pelo núcleo com `unsupported`
- [ ] Testes de unidade com `fetch` simulado
- [ ] Typecheck/lint passes

### US-050: Telegram na interface e documentação do túnel
**Description:** Como administrador, quero conectar um Telegram pela interface e saber como testar localmente.

**Acceptance Criteria:**
- [ ] O Telegram declara um **descritor** de formulário (token do bot, nome da conexão), com rótulos e ajuda por chave de
  tradução nos quatro catálogos, registrado no `ui-registry`
- [ ] O assistente de conectar mostra o Telegram e usa o descritor
- [ ] `docs/telegram.md` explica como criar o bot, o túnel público para testar localmente e as limitações do canal
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (o cartão do Telegram e o formulário; a conexão real depende de um bot e de um túnel, e fica como verificação manual)

### US-051: Capacidades em flows e automações
**Description:** Como operador, quero saber quando um passo não funciona no canal da conversa.

**Acceptance Criteria:**
- [ ] Ao ativar um flow ou uma automação com passo específico de canal (template, lista), a interface **avisa** quais passos só funcionam
  em conexões compatíveis
- [ ] Em execução, um passo incompatível com a conexão da conversa falha com `unsupported` **registrado no log da execução**, e nunca em silêncio
- [ ] Um envio agendado para um contato do Telegram sem histórico é registrado como **não entregue, com o motivo**
- [ ] Testes de unidade dos três casos
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (o aviso ao ativar)

### Fase 7 · CRM independente de canal

### US-052: Nome de exibição no inbox e nas conversas
**Description:** Como agente, quero identificar cada contato mesmo sem telefone.

**Acceptance Criteria:**
- [ ] Lista, cabeçalho e cartões do inbox usam `contactDisplayName` (nome, ou identidade principal do canal) em vez de `contact.phone`
- [ ] Nenhum lugar do inbox mostra uma linha em branco para um contato sem telefone
- [ ] Um teste percorre os componentes do inbox com um contato do Telegram
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (um contato sem telefone no inbox)

### US-053: Nome de exibição em contatos, pipelines e broadcasts
**Description:** Como operador, quero identificar contatos sem telefone no CRM.

**Acceptance Criteria:**
- [ ] Lista de contatos, detalhe, cartões de negócio e seleção de audiência de broadcast usam `contactDisplayName`
- [ ] Contatos sem identidade de WhatsApp aparecem no broadcast como **não elegíveis, com o motivo**
- [ ] Uma busca no código não acha `contact.phone` sendo usado como identificador de exibição (só como atributo do contato)
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (contatos, pipelines e audiência de broadcast)

### US-054: Busca e detecção de duplicidade por identidade
**Description:** Como operador, quero achar e evitar contatos duplicados por qualquer identidade.

**Acceptance Criteria:**
- [ ] A busca de contatos considera nome, e-mail, telefone e qualquer identidade (`@username`, id do canal)
- [ ] O formulário de contato detecta duplicidade pelas identidades (telefone continua valendo) e oferece "ver existente"
- [ ] Testes de unidade da busca e da duplicidade
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (busca por `@username` e o aviso de duplicidade)

### US-055: Importação por CSV cria identidades
**Description:** Como operador, quero que a importação continue funcionando.

**Acceptance Criteria:**
- [ ] A importação cria a identidade `whatsapp:phone` de cada contato e mantém as regras atuais de duplicidade e de erro
- [ ] Os testes de importação existentes passam; há um teste novo confirmando a identidade criada
- [ ] Typecheck/lint passes

### US-056: Condição `phone` e `{{phone}}` para contatos sem telefone
**Description:** Como operador, quero flows e automações previsíveis com contatos sem telefone.

**Acceptance Criteria:**
- [ ] A condição sobre o campo `phone` se comporta como "não definido" para um contato sem telefone
- [ ] A variável `{{phone}}` (personalização) sai vazia, sem erro
- [ ] Testes de unidade de ambos os casos, inclusive contato com telefone (comportamento inalterado)
- [ ] Typecheck/lint passes

### US-057: Merge manual de contatos — API
**Description:** Como agente, quero juntar dois contatos do mesmo cliente.

**Acceptance Criteria:**
- [ ] `POST /api/contacts/merge` `{ survivor_id, duplicate_id }` reaponta conversas, negócios, notas, etiquetas, valores de campos, identidades,
  execuções e demais tabelas com `contact_id` para o contato sobrevivente, reaproveitando `merge_duplicate_contacts`
- [ ] Um **teste lista todas as tabelas com `contact_id` no schema e falha se alguma não for tratada** pelo merge
- [ ] Duas conversas do mesmo contato na mesma conexão são unidas (`merge_duplicate_conversations`)
- [ ] Exige `agent`+ e contatos da mesma conta; responde com as contagens movidas
- [ ] Testes de rota e de banco
- [ ] Typecheck/lint passes

### US-058: Merge manual de contatos — interface
**Description:** Como agente, quero juntar contatos pelo perfil do cliente.

**Acceptance Criteria:**
- [ ] No perfil do contato, a ação "Vincular a outro contato" abre um diálogo com busca e a **confirmação** do que será movido
- [ ] Depois do merge, a tela mostra o contato sobrevivente com todas as conversas e o histórico
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (juntar dois contatos com negócio e nota e conferir o resultado)

### US-059: O CRM funciona com um contato do Telegram
**Description:** Como operador, quero confirmar que o CRM não depende do canal.

**Acceptance Criteria:**
- [ ] Um teste de integração, com um contato do Telegram criado por uma mensagem simulada, cobre: criar negócio a partir da conversa, etiquetar, anotar,
  preencher campo personalizado, disparar uma automação e um flow, e aparecer nos totais do painel
- [ ] Nada nesse fluxo exige telefone nem `wamid`
- [ ] Typecheck/lint passes

### Fase 8 · API pública e MCP

### US-060: Novo endereçamento em `POST /api/v1/messages`
**Description:** Como integrador, quero enviar por conversa ou por conexão.

**Acceptance Criteria:**
- [ ] Aceita `{ conversation_id }` ou `{ connection_id, to }`; `connection_id` é **opcional só quando a conta tem exatamente uma conexão ativa**, e senão
  responde `400 connection_required`
- [ ] A resposta traz `external_message_id`, `connection_id` e `channel` (e não traz mais `whatsapp_message_id`)
- [ ] Códigos novos: `409 unsupported`, `422 recipient_unreachable`, `409 window_closed`
- [ ] Testes de rota para cada forma, a regra de conexão única e cada erro
- [ ] Typecheck/lint passes

### US-061: Lojas e conexões na API pública
**Description:** Como integrador, quero descobrir os ids de loja e de conexão.

**Acceptance Criteria:**
- [ ] `GET /api/v1/stores` e `GET /api/v1/connections`, só leitura, sem credenciais, com o escopo novo `connections:read`
  criado no cadastro de chaves de API
- [ ] Um teste confirma que uma chave sem o escopo recebe `403`
- [ ] Testes de rota
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (o escopo `connections:read` disponível ao criar uma chave de API)

### US-062: Contatos e conversas na API pública
**Description:** Como integrador, quero ver identidades, loja, conexão e canal.

**Acceptance Criteria:**
- [ ] Contatos trazem `identities` e `phone: null` quando não há telefone; criar contato aceita `identities` e mantém `phone` como atalho de WhatsApp
- [ ] Conversas trazem `connection_id`, `store_id` e `channel`
- [ ] Testes de rota
- [ ] Typecheck/lint passes

### US-063: Webhooks de saída com loja, conexão e canal
**Description:** Como integrador, quero saber de onde veio cada evento.

**Acceptance Criteria:**
- [ ] `message.received` e os demais eventos incluem `connection_id`, `store_id`, `channel` e `contact.identities`
- [ ] O `phone` do contato é `null` quando não existe
- [ ] Testes de entrega verificam o payload e a assinatura
- [ ] Typecheck/lint passes

### US-064: MCP e documentação da API
**Description:** Como integrador, quero o MCP e a documentação atualizados.

**Acceptance Criteria:**
- [ ] O MCP tem ferramentas para lojas e conexões, envio com `connection_id`/`conversation_id` e contatos com identidades, e o pacote sobe de versão
- [ ] `docs/public-api.md` e `docs/mcp.md` descrevem o contrato novo, marcado como **pré-estável até o primeiro cliente**
- [ ] O MCP compila (`npm run build` dentro de `mcp-server/`) e seus testes passam, se existirem
- [ ] Typecheck/lint passes

### Fase 9 · Saúde e observabilidade

### US-065: Estado da conexão por evento
**Description:** Como administrador, quero que o estado da conexão reflita o que acontece.

**Acceptance Criteria:**
- [ ] Erro de envio de tipo `auth` marca a conexão como `needs_action`; mensagem recebida atualiza `last_inbound_at`; envio atualiza `last_outbound_at`
- [ ] Falha de ingestão grava `last_error` (código e mensagem) na conexão
- [ ] Voltar a funcionar (mensagem recebida ou envio com sucesso) limpa o estado `needs_action`
- [ ] Testes de unidade das transições
- [ ] Typecheck/lint passes

### US-066: Verificação periódica de saúde
**Description:** Como administrador, quero detectar uma conexão parada mesmo sem tráfego.

**Acceptance Criteria:**
- [ ] `GET /api/channels/cron/health`, protegida por `x-cron-secret` (`503` sem a variável configurada, como as outras rotas de cron), chama
  `provider.health` de cada conexão **ativa** e atualiza estado e `last_health_check_at`
- [ ] Conexões desativadas são ignoradas
- [ ] Sem o cron configurado, o sistema continua funcionando só por evento
- [ ] Testes de rota
- [ ] Typecheck/lint passes

### US-067: Notificação `connection_down`
**Description:** Como administrador, quero ser avisado quando uma conexão cai.

**Acceptance Criteria:**
- [ ] A transição para `disconnected` ou `needs_action` cria **uma** notificação `connection_down` para cada administrador, sem repetir enquanto continuar
  no mesmo estado
- [ ] A notificação aparece na lista de notificações, traduzida, com link para a conexão
- [ ] Testes de unidade da criação e da não repetição
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (a notificação na lista, com o link)

### US-068: Logs estruturados
**Description:** Como desenvolvedor, quero logs padronizados e sem segredos.

**Acceptance Criteria:**
- [ ] Um utilitário de log em `lib/channels/` emite `[channel:<tipo>] conn=<id> event=<id> …` e é usado em todo o código de `lib/channels/`
- [ ] Um teste confirma que credenciais, `secret_token` e URLs de arquivo do Telegram nunca aparecem na saída do utilitário
- [ ] Typecheck/lint passes

### Fase 10 · Contração e fechamento

### US-069: Parar a escrita dupla e retirar a tela antiga
**Description:** Como desenvolvedor, quero remover o caminho legado da configuração.

**Acceptance Criteria:**
- [ ] `POST|DELETE /api/whatsapp/config` deixam de gravar em `whatsapp_config`, ou são removidas se nada mais as usa
- [ ] Uma busca no código não acha nenhuma leitura ou escrita de `whatsapp_config`
- [ ] Os links para `?tab=whatsapp` continuam levando a `channels`
- [ ] A suíte completa passa
- [ ] Typecheck/lint passes

### US-070: Migration final de contração
**Description:** Como desenvolvedor, quero o banco só com o modelo novo.

**Acceptance Criteria:**
- [ ] Migration `047` torna `connection_id` `NOT NULL` em `message_templates` e `broadcasts`, troca a unicidade de templates para
  `(connection_id, name, language)`, remove `whatsapp_config` e as colunas `wa_user_id`, `wa_parent_user_id` e `wa_username` de `contacts`
- [ ] `automation_pending_executions.conversation_id` e `.connection_id` viram `NOT NULL`
- [ ] `verify-schema.sql` reflete o schema final
- [ ] Um teste confirma que nenhum código referencia as colunas e a tabela removidas
- [ ] O replay do zero e a suíte passam
- [ ] Typecheck/lint passes

### US-071: Documentação e convenções
**Description:** Como mantenedor, quero que o repositório descreva o novo modelo.

**Acceptance Criteria:**
- [ ] `CLAUDE.md` descreve o modelo (rede, loja, conexão), o contrato do provedor em `lib/channels/`, como acrescentar um canal e a regra de que o núcleo não conhece nenhum canal
- [ ] `docs/multi-waba.md`, `docs/docker.md` e o README refletem lojas, conexões e o Telegram
- [ ] A regra "o `/api/v1` está pré-estável e congela no primeiro cliente" está documentada
- [ ] Nenhuma outra seção do `CLAUDE.md` é alterada

### US-072: Verificar tudo na stack Docker
**Description:** Como dono do produto, quero confirmar o caso das pizzarias no ambiente real.

**Acceptance Criteria:**
- [ ] A stack sobe com `docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local up --build -d --wait` e as migrations
  aplicam do zero
- [ ] Com uma conta de teste: duas lojas, uma conexão de WhatsApp em cada e um Telegram numa delas; mensagens de entrada **simuladas** (payload do WhatsApp assinado
  com o `META_APP_SECRET` local e atualização do Telegram com o `secret_token`) aparecem todas no mesmo inbox, com o selo certo
- [ ] O mesmo cliente escrevendo às duas lojas aparece como um contato só, com duas conversas
- [ ] Desativar uma conexão mantém as conversas legíveis e desabilita o compositor; apagar só é possível para uma conexão sem conversas
- [ ] O resultado por tela e por métrica está em `.projects/channel-abstraction/verification.md`, com as **métricas 1 a 5** marcadas como
  atendidas ou não, e o que exigiria um bot real ou uma conta da Meta real indicado como verificação manual
- [ ] `npm run lint`, `npm run typecheck`, `TZ=UTC npm test` e `npm run build` passam
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: A conta é a rede. Há uma entidade **Loja** com nome, endereço, telefone, horário, responsável e configurações próprias.
- FR-2: Uma conta pode ter várias **conexões**; cada uma pertence a uma loja, tem um canal e credenciais. Uma loja pode ter uma ou mais conexões,
  inclusive duas do mesmo canal.
- FR-3: Os canais desta versão são o **WhatsApp oficial** (comportamento idêntico ao atual) e o **Telegram**.
- FR-4: O contato é único na rede e tem identidades com chave por **família de canal** (`whatsapp:phone`, `whatsapp:bsuid`, `whatsapp:username`,
  `telegram:chat_id`, `telegram:username`). `contacts.phone` continua `NOT NULL DEFAULT ''` no banco e a API devolve `null` quando vazio.
- FR-5: A conversa é única por `(contato, conexão)`. A loja da conversa é derivada da conexão.
- FR-6: O inbox mostra selo de loja e canal, filtros por loja, conexão e canal, não lidas total e por loja, aviso de conexão caída, as conversas do
  contato em outras lojas, e a resposta sai sempre pela conexão da conversa. Com uma conexão só, nada disso aparece.
- FR-7: Cada provedor declara suas capacidades; a interface esconde ou desabilita o que o canal não faz, com explicação.
- FR-8: Um passo de flow ou automação incompatível com a conexão da conversa falha com `unsupported` registrado, e a interface avisa ao ativar.
- FR-9: No Telegram: só "enviado", sem iniciar conversa com quem nunca falou, botões no lugar de lista; envio agendado sem histórico é registrado como não entregue, com o motivo.
- FR-10: Broadcasts e templates só existem no WhatsApp oficial, com entrega e rastreio próprios; o broadcast não cria conversa nem mensagem.
- FR-11: Todo envio passa por `sendOutbound`, usado por dashboard, API pública, flows, automações e IA. O que é específico do canal fica no provedor.
- FR-12: Todo recebimento passa por `ingestInbound`, com ack rápido, processamento em `after()` e idempotência por `(conversa, id externo)`.
- FR-13: O CRM não depende de canal: nome de exibição pela identidade principal, busca por qualquer identidade, CSV cria identidades de WhatsApp, e a condição
  `phone` e `{{phone}}` se comportam como "não definido" sem telefone.
- FR-14: O atendente pode fazer o **merge manual** de dois contatos, com o CRM reapontado para o sobrevivente.
- FR-15: As credenciais ficam em tabela separada, sem leitura por membros, e nunca voltam à interface nem vão para log ou para `media_url`.
- FR-16: Criar, editar e apagar lojas e conexões exige administrador ou acima.
- FR-17: Conexão com histórico é **desativada**, nunca apagada; só se apaga uma sem conversas. Loja com conexões não se apaga.
- FR-18: Mover uma conexão de loja é permitido a administradores, e o histórico acompanha a conexão.
- FR-19: `POST /api/v1/messages` aceita `{ conversation_id }` ou `{ connection_id, to }`; `connection_id` é opcional só com exatamente uma conexão ativa.
- FR-20: A API expõe `GET /api/v1/stores` e `GET /api/v1/connections` (escopo `connections:read`), contatos com `identities`, e conversas e webhooks de saída com
  `connection_id`, `store_id` e `channel`.
- FR-21: Cada conexão tem estado em tempo de execução, atualizado por evento e por verificação periódica; administradores recebem `connection_down`.
- FR-22: A configuração tem as seções **Lojas** e **Canais**; a loja vem primeiro; o formulário é um descritor genérico para provedores simples e um
  painel próprio para o WhatsApp.
- FR-23: O `?tab=whatsapp` continua funcionando, levando a `channels`.

## Non-Goals (Out of Scope)

- Permissões por loja e por grupo de lojas; o filtro por loja não é uma fronteira de segurança.
- WhatsApp não oficial e Discord.
- Roteamento automático, fila e transferência de conversa entre lojas.
- Painéis e relatórios por loja.
- Broadcasts e templates fora do WhatsApp oficial.
- Seletor de conexão no envio.
- Detecção automática de contatos duplicados (só o merge manual).
- Arquivar loja.
- Cobrança por conexão.
- API pública para criar ou configurar conexões (só leitura de lojas e conexões).
- Rotação de chave de criptografia e cofre de segredos externo.
- Fila de eventos ou tabela de eventos brutos e worker de processo persistente.
- Compatibilidade com o upstream do template e com o contrato antigo da API.

## Design Considerations

- Reaproveitar `whatsapp-config.tsx` (1.049 linhas) como painel do provedor, em vez de reescrevê-lo, para não regredir o registro na Meta.
- `contactHandle()` já exibe contatos sem telefone; `contactDisplayName` o generaliza.
- `settings-sections.ts`, `resolveSection` e `settings-overview.tsx` já suportam seções, alias de abas antigas e cartões de resumo.
- Com uma conexão só, a interface do inbox e das configurações fica visualmente igual à atual.

## Technical Considerations

- **Adaptador em vez de mover arquivos.** O Design Doc previa mover `lib/whatsapp/*` para o provedor. Este PRD mantém esses arquivos onde estão e o
  provedor os **usa por um adaptador** (US-010 a US-012), porque 71 arquivos importam `lib/whatsapp` e mover não muda comportamento. Uma
  mudança física de pastas pode ser feita depois, fora desta feature.
- **`secrets_format`.** O backfill em SQL não tem a chave de cifra, então copia o token já cifrado como está (`wa_token_v0`), e a leitura em `connections.ts`
  o regrava no formato JSON novo (US-005, US-007, US-008). Isso refina o Design Doc, que só previa o JSON cifrado.
- **Expandir e contrair:** as migrations `043` a `045` só acrescentam; `046` troca os índices depois que toda criação de conversa usa `connection_id`; `047` remove
  o que sobrou depois que nenhum código o lê. A escrita dupla de `/api/whatsapp/config` (US-013) dura até a US-069.
- **Idempotência:** a fronteira continua sendo `(conversation_id, message_id)`; `messages.message_id` **não é renomeada**.
- **Ambiente de testes:** `TZ=UTC npm test`. Meta e Telegram **não são alcançáveis** no ambiente de teste: recebimento com payloads simulados e assinados; envio
  com `fetch` simulado. A conexão real de um bot do Telegram (túnel público) e da Meta é verificação manual.
- **Docker:** o app no Docker embute `NEXT_PUBLIC_*` no build; qualquer verificação em `localhost:3000` exige `up --build`. `npm run build` e o servidor de
  desenvolvimento disputam o mesmo `.next`; pare um antes de rodar o outro.
- **Regras de i18n do projeto** (ver `CLAUDE.md`): `react/jsx-no-literals` em `warn`, formatação direta em `error`.
- **ADRs:** ADR-001 (modelo), ADR-002 (contrato do provedor), ADR-003 (ingestão), ADR-004 (credenciais), ADR-005 (API pré-estável), ADR-006 (merge e CRM),
  ADR-007 (desativar conexões). Todos ainda estão como "Proposto".

## Success Metrics

1. **Regressão zero no WhatsApp oficial:** a suíte de testes existente passa, e os testes de caracterização das US-002 a US-004 passam antes e depois.
2. **O caso das pizzarias funciona** (US-072): 2 lojas, 2 canais, um inbox, o mesmo cliente como um contato só.
3. **Um canal novo não toca o núcleo:** o Telegram (US-047 a US-050) é adicionado só com um provedor e um registro; nenhum arquivo de `ingest`, `send` ou do inbox
   menciona um canal pelo nome.
4. **Uma loja nova é conectada em menos de 10 minutos**, do cadastro à primeira mensagem recebida `[SUPOSIÇÃO NÃO VALIDADA]`.
5. **O CRM funciona igual para um contato do Telegram** (US-059).
6. `npm run lint`, `typecheck`, `TZ=UTC npm test` e `build` passam ao final.

## Open Questions

- **Escopo de conexão de flows e automações.** O SOLUTION diz que passos específicos de canal "só ativam em conexões compatíveis", mas não define se um
  flow ou automação tem uma conexão associada. Este PRD adota a regra mais simples (aviso ao ativar e falha registrada em execução, US-051). Se você quiser que
  flows e automações fiquem **presos a conexões**, isso vira uma história e uma migration a mais.
- **Verificação com bot e Meta reais:** o ambiente de execução não alcança a Meta nem o Telegram. As histórias de recebimento e envio se apoiam em fixtures e
  dublês, e a verificação com um bot real e um número real é manual.
- **Tamanho das redes-alvo** e **templates por WABA** (duplicados por conexão nesta versão) continuam em aberto.
- **Hospedagem do worker do WhatsApp não oficial** (versão seguinte) continua em aberto.
- **Número de histórias:** são 72, maior que a do pt-BR. Se alguma exceder uma iteração, dividi-la antes de executar. As candidatas são a US-011 (parse do
  WhatsApp), a US-020 (distribuição da ingestão) e a US-039 (assistente de conectar).
- **ADRs ainda como "Proposto"** e as cinco confirmações do Design Doc, agora respondidas (1A, 2A, 3A), esperam o aceite formal.

## Adendo — histórias divididas na conversão para `prd.json`

Três histórias que o PRD apontava como candidatas a estourar uma iteração foram divididas, mantendo os ids originais e acrescentando ids novos,
posicionados logo depois (a ordem de execução é a do campo `priority` do `prd.json`):

- **US-011** agora cobre `resolveConnection`, `verify` e o `parse` de **status e reação**; **US-073** (nova, logo após a US-011) cobre o `parse` de **mensagens**
  e os candidatos de identidade.
- **US-020** agora cobre a distribuição para **automações, flows e IA**; **US-074** (nova, logo após a US-020) cobre **webhooks de saída, notificações e a
  marcação de resposta de broadcast**.
- **US-039** agora cobre o **painel do WhatsApp por conexão e o `ui-registry`**; **US-075** (nova, logo após a US-039) cobre o **assistente de quatro passos**.
  A ordem foi invertida em relação ao PRD original (painel antes do assistente), porque o assistente depende do registro.

Total: **75 histórias**.
