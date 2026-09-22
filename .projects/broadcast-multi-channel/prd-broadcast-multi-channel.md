# PRD: Broadcast Multi-Canal

## Introduction

Broadcast hoje só funciona com WhatsApp Cloud API oficial, mesmo a aplicação
já sendo multi-canal (WhatsApp + Telegram) desde a feature
`channel-abstraction`. A trava não é de infraestrutura — é que o wizard
nunca expôs escolha de conexão (resolve automaticamente "a" conexão
WhatsApp da conta) e o envio sempre exigiu um template aprovado. Esta
feature deixa o usuário escolher **qual conexão** usar ao criar um
broadcast, adaptando o wizard, a elegibilidade de audiência e o envio à
capability real daquele canal.

Referências: `.projects/broadcast-multi-channel/SOLUTION.md`,
`design.md`, `adr/ADR-001-*.md`, `adr/ADR-002-*.md`.

## Goals

- Escolher a conexão de envio (loja + canal) ao criar um broadcast, num
  dropdown de conexões nomeadas.
- O wizard se adapta à capability da conexão: passo de template (WhatsApp)
  vs. passo de composição livre (Telegram e futuros canais sem template).
- Elegibilidade de audiência calculada pela conexão escolhida, não mais
  hardcoded pra WhatsApp.
- Validação de conteúdo usando os limites do canal escolhido, bloqueando o
  avanço do wizard se excedido.
- Relatório de métricas marca como indisponível (não zero) o que o canal
  não suporta.
- Zero regressão no broadcast WhatsApp existente.

## User Stories

### US-001: Migration — colunas de conteúdo do broadcast

**Description:** As a developer, preciso que `broadcasts` suporte conteúdo
de template OU mensagem livre, com o banco garantindo que nunca os dois nem
nenhum dos dois.

**Acceptance Criteria:**
- [ ] Nova migration (próximo número livre): `template_name`/
      `template_language` viram `nullable`; colunas novas `message_text
      text` e `message_media_url text` (nullable).
- [ ] `CHECK` de exclusividade: `(template_name IS NOT NULL) <>
      (message_text IS NOT NULL OR message_media_url IS NOT NULL)`.
- [ ] `supabase/ci/verify-schema.sql` estendido com a checagem das colunas
      novas e do `CHECK`.
- [ ] Aplicada no banco de dev e no replay isolado (`-p wacrm-replay`).
- [ ] Typecheck passes.

### US-002: Migration + código — rename `whatsapp_message_id` → `external_message_id`

**Description:** As a developer, preciso que o histórico de envio de
broadcast use um nome de coluna independente de canal, seguindo o mesmo
padrão já aplicado em `/api/v1/messages` no `channel-abstraction`.

**Acceptance Criteria:**
- [ ] Migration adiciona `broadcast_recipients.external_message_id`,
      faz backfill a partir de `whatsapp_message_id`, replica o índice
      único condicional.
- [ ] `whatsapp_message_id` **não** é removida nesta história (expand
      apenas — o drop fica pra uma história/PRD futura, fora de escopo
      aqui).
- [ ] `broadcast-core.ts`, `broadcast-resume.ts`, a rota de broadcast e
      `use-broadcast-sending.ts`/tipos client passam a ler e escrever
      `external_message_id`.
- [ ] `verify-schema.sql` estendido.
- [ ] Testes existentes que referenciam `whatsapp_message_id` são
      atualizados para o nome novo (não editar teste pra "passar", é
      literalmente o campo mudando de nome).
- [ ] Typecheck e testes passam.

### US-003: Caracterização — resolução de conexão e capability de template hoje

**Description:** As a developer, preciso fixar o comportamento atual antes
de mexer em `createBroadcast`/`deliverBroadcast`, para garantir zero
regressão no caminho WhatsApp (RNF-01).

**Acceptance Criteria:**
- [ ] Auditar a cobertura já existente (`broadcast-core.test.ts`,
      `broadcast-core.credentials.test.ts`,
      `broadcast-core.disabled.test.ts`,
      `broadcast-core.provider.test.ts`,
      `broadcast-deliver.characterization.test.ts`,
      `broadcast-resume.test.ts`) — ela já cobre bem o loop de entrega
      (retry de variante de telefone, credenciais lidas uma vez, conexão
      desabilitada, `finalizeBroadcastStatus`, resume). **Não duplicar.**
- [ ] Adicionar caracterização específica do que ainda **não** está
      coberto e está prestes a mudar: `createBroadcast` resolvendo a
      conexão via `loadWhatsAppSendConnection` (comportamento hoje: sempre
      a única conexão WhatsApp da conta, sem parâmetro) e o branch de
      `deliverBroadcast` que hoje rejeita com `ChannelError('unsupported',
      ...)` quando `!provider.capabilities.templates` (vai virar um branch
      de envio, não mais uma rejeição).
- [ ] Asserts descrevem o comportamento de hoje, não o desejado — servem
      de rede de segurança para as próximas histórias.
- [ ] Typecheck e testes passam.

### US-004: `createBroadcast` aceita `connection_id` explícito

**Description:** As a agent/admin+, ao criar um broadcast eu escolho a
conexão de envio, em vez do sistema assumir a única conexão WhatsApp da
conta.

**Acceptance Criteria:**
- [ ] `createBroadcast` recebe `connection_id` como parâmetro obrigatório;
      `loadWhatsAppSendConnection` deixa de ser chamada em
      `broadcast-core.ts`.
- [ ] Resolve a conexão via consulta genérica (mesmo padrão de
      `getConnectionCredentials`/lookup por id) — não filtra por
      `channel_type`.
- [ ] Erros tipados: conexão inexistente ou de outra conta → 404;
      conexão desabilitada → mantém o `ConnectionDisabledError` /
      `409 connection_disabled` já existente (US-078 do
      `channel-abstraction`), agora para qualquer canal.
- [ ] Persiste `template_name`/`template_language`/`template_variables` OU
      `message_text`/`message_media_url` conforme o conteúdo enviado —
      nunca os dois (o `CHECK` da US-001 é a rede de segurança, a rota
      valida antes).
- [ ] Novo erro `400 content_required` quando nem template nem mensagem
      livre foram enviados.
- [ ] Testes de caracterização da US-003 continuam passando sem alteração
      de asserts (só o setup muda, para passar `connection_id`).
- [ ] Typecheck e testes passam.

### US-005: `deliverBroadcast` envia mensagem livre para canais sem template

**Description:** As a agent/admin+, quero que um broadcast numa conexão sem
capability de template (ex. Telegram) envie a mensagem livre composta, em
vez de falhar.

**Acceptance Criteria:**
- [ ] O branch que hoje rejeita com `ChannelError('unsupported', ...)`
      quando `!provider.capabilities.templates` vira uma checagem de
      `capabilities.initiate`: se `'template'`, mantém o payload
      `{type: 'template', ...}` de hoje **exatamente igual**; se
      `'after_inbound'`/`'free'`, monta `{type: 'text', text}` ou
      `{type: 'media', kind, url, caption}` a partir de
      `broadcast.message_text`/`message_media_url`, com as variáveis já
      resolvidas por destinatário (reaproveita `resolveVariables`).
- [ ] Chama `provider.send(connection, target, message, { credentials })`
      — mesma chamada de hoje, só o `message` monta diferente.
- [ ] `whatsapp_message_id`/`external_message_id` (US-002) grava o
      `externalId` retornado, igual pra qualquer canal.
- [ ] Falha de um destinatário (`recipient_unreachable`,
      `window_closed`, etc.) grava em `broadcast_recipients.error_message`
      com o código tipado, sem abortar os demais — comportamento já
      existente, agora testado também pro caminho não-template.
- [ ] Testes de caracterização do caminho WhatsApp (US-003) continuam
      passando sem alteração de asserts.
- [ ] Novo teste: broadcast de mensagem livre numa conexão Telegram de
      teste envia com sucesso e grava o `external_message_id`.
- [ ] Typecheck e testes passam.

### US-006: Elegibilidade de audiência por canal

**Description:** As a agent/admin+, ao escolher a audiência de um broadcast,
só vejo como elegíveis os contatos que aquele canal específico consegue
alcançar de verdade.

**Acceptance Criteria:**
- [ ] `isBroadcastEligible`/`partitionBroadcastAudience`/
      `fetchIneligibleContacts` passam a receber a conexão (ou pelo menos
      `channel_type` + `connection_id` + `capabilities.initiate`) em vez
      de assumir WhatsApp.
- [ ] `capabilities.initiate === 'template'`: elegível = tem identidade
      daquele canal (qualquer uma) — comportamento idêntico ao de hoje
      pro WhatsApp.
- [ ] `capabilities.initiate !== 'template'`: elegível = existe uma
      `conversations` row para aquele `contact_id` **e** aquele
      `connection_id` específico (não basta ter identidade do canal em
      geral — uma conta pode ter mais de uma conexão do mesmo tipo).
- [ ] `step2-select-audience.tsx` passa a consultar/filtrar pela conexão
      escolhida no passo 0 (US-009), não mais por telefone/identidade
      WhatsApp fixo.
- [ ] Teste cobrindo o caso de duas conexões Telegram na mesma conta: um
      contato que só conversou com o Bot A não aparece elegível pro
      broadcast do Bot B.
- [ ] Testes existentes de elegibilidade WhatsApp continuam passando com
      os mesmos resultados.
- [ ] Typecheck e testes passam.

### US-007: Motivo de inelegibilidade fica por canal

**Description:** As a agent/admin+, quando um contato aparece como não
elegível, quero entender o motivo certo pro canal escolhido, não sempre
"sem número de WhatsApp".

**Acceptance Criteria:**
- [ ] `Broadcasts.wizard.selectAudience.ineligibleReason` deixa de ser um
      texto único fixo — a UI escolhe entre pelo menos duas mensagens:
      "sem identidade neste canal" (canais com template) e "ainda não
      conversou com este canal" (canais sem alcance frio).
- [ ] Chaves novas/ajustadas nas 4 catalogações (en/pt/es/ko).
- [ ] `npx vitest run src/i18n` (paridade de chaves) passa.
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-008: `broadcast-resume.ts` genérico

**Description:** As a agent/admin+, quero que retomar/reenviar um broadcast
abandonado funcione pra qualquer canal, não só WhatsApp.

**Acceptance Criteria:**
- [ ] `broadcast-resume.ts` para de importar `loadWhatsAppSendConnection`
      diretamente — usa o mesmo resolver genérico da US-004
      (`connection_id` já gravado no broadcast).
- [ ] `resolveTemplateRow` só é chamado quando o broadcast é de template
      (`template_name IS NOT NULL`) — não quebra pra broadcast de
      mensagem livre.
- [ ] Testes existentes de resume (`broadcast-resume.test.ts`) continuam
      passando.
- [ ] Novo teste: resume de um broadcast Telegram abandonado (alguns
      `pending`) entrega os que faltam e finaliza a campanha.
- [ ] Typecheck e testes passam.

### US-009: Wizard — passo 0, escolher conexão

**Description:** As a agent/admin+, ao criar um broadcast, primeiro escolho
por qual conexão ele vai sair.

**Acceptance Criteria:**
- [ ] Novo passo antes do atual passo 1: dropdown listando
      `channel_connections` da conta com `status = 'connected'` e
      `disabled_at IS NULL`, nome no formato "Canal — Loja" (reaproveita
      badge/label já usados no inbox).
- [ ] Se a conta só tem uma conexão elegível, ela vem pré-selecionada mas
      o passo continua visível (consistência, sem esconder passo condicionalmente).
- [ ] Se a conta não tem nenhuma conexão conectada, o wizard mostra estado
      vazio orientando a ir em Configurações → Canais, sem deixar avançar.
- [ ] A conexão escolhida fica no estado do wizard e decide o passo
      seguinte (US-010 vs. o `step1-choose-template.tsx` já existente).
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-010: Wizard — passo 1 alternativo, compor mensagem livre

**Description:** As a agent/admin+, ao escolher uma conexão sem template
(ex. Telegram), componho a mensagem do broadcast diretamente, em vez de
escolher um template aprovado.

**Acceptance Criteria:**
- [ ] Novo componente `step1-compose-message.tsx`: textarea pro corpo do
      texto (com inserção de token de variável `{{1}}`/nome de campo,
      mesmo estilo de token que o template já usa), upload de mídia
      opcional (reaproveita o componente de upload já usado pra header de
      template).
- [ ] Validação de tamanho de texto/legenda e tipo/tamanho de mídia lê os
      limites do provider da conexão escolhida (não um número fixo, não
      cita o nome de um canal errado na mensagem — mesmo princípio já
      corrigido nas Flows).
- [ ] Excedendo o limite, o wizard bloqueia o avanço com a mensagem de
      erro específica do limite excedido.
- [ ] Renderizado só quando `capabilities.initiate !== 'template'` na
      conexão escolhida; `step1-choose-template.tsx` continua sendo usado
      sem alteração quando `capabilities.initiate === 'template'`.
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-011: Wizard — passo 3 "Personalizar" generalizado

**Description:** As a agent/admin+, mapeio as variáveis da mensagem livre
pros campos do contato do mesmo jeito que já faço pra template.

**Acceptance Criteria:**
- [ ] `step3-personalize.tsx` lê os tokens da mensagem livre (US-010)
      quando não há template, em vez de assumir sempre `template.variables`.
- [ ] O mapeamento (estático / campo / campo customizado) e a prévia
      (`previewFieldValue`) funcionam igual pros dois casos.
- [ ] Mídia (quando a mensagem livre tem uma) é passada adiante do mesmo
      jeito que o header de mídia de um template hoje.
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-012: Wizard — passo 4 envia com o conteúdo condicional

**Description:** As a agent/admin+, ao confirmar o envio, o broadcast sai
pela conexão e com o conteúdo que escolhi nos passos anteriores.

**Acceptance Criteria:**
- [ ] `use-broadcast-sending.ts`/`BroadcastPayload` passam a incluir
      `connection_id` e o conteúdo condicional (`template` OU
      `message_text`/`message_media_url`).
- [ ] `POST /api/whatsapp/broadcast` valida: `connection_id` obrigatório
      (`400 connection_id_required`); conteúdo presente e exclusivo
      (`400 content_required`); template enviado pra conexão sem
      `capabilities.initiate === 'template'` (`400
      connection_channel_mismatch`).
- [ ] O loop de envio em lotes (tamanho/pausa) continua idêntico ao de
      hoje — só o payload de cada chamada muda.
- [ ] Broadcast de template WhatsApp continua funcionando fim a fim, sem
      diferença perceptível pro usuário.
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-013: Relatório — métricas indisponíveis por canal

**Description:** As a agent/admin+, ao ver o relatório de um broadcast
Telegram, não vejo "0 entregues"/"0 lidos" como se tivesse falhado — vejo
que o canal não reporta isso.

**Acceptance Criteria:**
- [ ] `[id]/page.tsx` (relatório) mostra "—"/"Indisponível" nas colunas
      `delivered`/`read` quando `!capabilities.deliveryStatus`/
      `!capabilities.readStatus` da conexão do broadcast, em vez do
      número (que hoje ficaria sempre 0).
- [ ] `sent`/`failed`/`replied` continuam mostrando o número normalmente
      (não afetados por essa capability).
- [ ] Chave de i18n nova nas 4 catalogações.
- [ ] Verify in browser using dev-browser skill.
- [ ] Typecheck passes.

### US-014: Verificação fim a fim + documentação

**Description:** As a developer, confirmo que a feature funciona de ponta a
ponta nos dois canais antes de considerar pronto.

**Acceptance Criteria:**
- [ ] `npm run typecheck`, `npm run lint` (baseline de warnings mantida),
      `TZ=UTC npm test` passam.
- [ ] `npm run build` roda sem erro.
- [ ] Verificação em navegador (dev-browser): criar e enviar um broadcast
      real numa conexão Telegram de teste (a conexão real já configurada
      nesta sessão, ou uma equivalente semeada), mensagem chega no bot,
      relatório mostra "—" em delivered/read.
- [ ] Verificação em navegador: broadcast de template num WhatsApp de
      teste continua funcionando exatamente como antes (mesmos passos,
      mesmo resultado).
- [ ] `docs/public-api.md`/CLAUDE.md atualizados se algo do broadcast for
      mencionado lá como WhatsApp-only (checar e corrigir se for o caso).
- [ ] Nenhum teste de caracterização das US-003/US-005/US-008 quebrou.

## Functional Requirements

- FR-1: O wizard de broadcast exige escolher uma conexão específica antes
  de compor conteúdo (US-009).
- FR-2: O passo de conteúdo se adapta a `capabilities.initiate` da conexão
  escolhida — template (US existente) ou mensagem livre (US-010).
- FR-3: O mapeamento de variáveis (US-011) funciona igual pros dois tipos
  de conteúdo.
- FR-4: Elegibilidade de audiência é calculada pela conexão escolhida,
  ramificando por `capabilities.initiate` (US-006), com motivo de
  inelegibilidade específico por canal (US-007).
- FR-5: Validação de conteúdo usa os limites do provider escolhido,
  bloqueando o avanço do wizard se excedido (US-010).
- FR-6: Envio (inicial e resume) usa `provider.send`/`getConnectionCredentials`/
  `getProvider` — nenhum caminho hardcoded pra WhatsApp (US-004, US-005,
  US-008).
- FR-7: Relatório marca métricas não suportadas pelo canal como
  indisponíveis, não zero (US-013).
- FR-8: `broadcast_recipients.external_message_id` substitui
  `whatsapp_message_id` na leitura/escrita da aplicação (`whatsapp_message_id`
  continua existindo na tabela até uma história futura de contração)
  (US-002).
- FR-9: O comportamento do broadcast via WhatsApp Cloud API não muda —
  garantido por testes de caracterização escritos antes da refatoração
  (US-003).

## Non-Goals

- WhatsApp não-oficial e Discord — não existem como `ChannelProvider`
  registrado; ficam de fora até virarem canal de verdade.
- Um broadcast disparar em múltiplos canais/conexões numa única campanha
  — continua uma conexão por broadcast.
- Mover o envio do broadcast pro servidor (fila/cron) — o loop
  client-side em lotes continua como está; fora de escopo (ver Design
  Doc, seção "Alternativas Consideradas").
- Drop de `broadcast_recipients.whatsapp_message_id` — só o expand entra
  nesta PRD (US-002); a contração é uma história/PRD futura.
- Inventar um conceito de "template" equivalente para canais que não têm
  isso na própria plataforma.

## Design Considerations

- Reaproveitar `ConversationScopeBadge`/`Settings.channels.type` (já
  existentes na UI do inbox) pro rótulo de canal no dropdown de conexão
  (US-009).
- Reaproveitar o componente de upload de mídia já usado no header de
  template (US-010/US-011) — não criar um novo.
- Seguir o mesmo princípio já corrigido nas Flows para mensagens de
  validação: nunca citar o nome de um canal que não é o escolhido.

## Technical Considerations

- `deliverBroadcast` já é majoritariamente genérico hoje (já usa
  `getProvider`/`getConnectionCredentials`/`provider.send`) — o trabalho
  real é trocar o branch de rejeição por um branch de envio (US-005) e
  fazer `createBroadcast` aceitar `connection_id` (US-004), não uma
  reescrita.
- `provider.send` é chamado diretamente (não `sendOutbound`) porque
  broadcast não escreve `messages`/`conversations` por destinatário como
  uma conversa — mantém esse padrão, não introduzir `sendOutbound` aqui.
- Migrations seguem expand-only (`whatsapp_message_id` fica até uma
  história de contração futura).
- `contact_identities` é por conta, não por conexão — por isso a
  elegibilidade em canais sem alcance frio precisa checar
  `conversations` na conexão específica, não só identidade (US-006).

## Success Metrics

- Uma conta com Telegram consegue criar e enviar um broadcast para
  contatos que já conversaram com o bot, sem tocar em nenhum código
  WhatsApp-específico.
- Zero regressão nos testes de caracterização do broadcast WhatsApp
  (US-003, US-005, US-008).
- Zero warning de lint novo introduzido (baseline mantida).

## Open Questions

Nenhuma pendente — todas as decisões de escopo foram fechadas no debate
(`SOLUTION.md`) e no design (`design.md`/ADRs).
