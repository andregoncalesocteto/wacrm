# Solution — Broadcast Multi-Canal

> Versão 1 — Gerado após debate em 2026-09-22.
> Rodadas anteriores: nenhuma.

---

## PARTE 1 — PRODUTO (O QUÊ)

### 1. Problema

Broadcast hoje só funciona com WhatsApp Cloud API oficial, mesmo a aplicação já
sendo multi-canal desde a feature `channel-abstraction` (WhatsApp + Telegram em
produção). A trava está em dois pontos hardcoded:

- **Elegibilidade de audiência** (`isWhatsAppReachable`) só considera telefone
  ou identidade `whatsapp:*`.
- **O envio exige template aprovado** (`template_name`/`template_language`
  `NOT NULL` no schema; a rota rejeita qualquer canal sem
  `capabilities.templates`).

O wizard também não expõe escolha de conexão — resolve automaticamente **a**
conexão WhatsApp da conta (`loadWhatsAppSendConnection`), assumindo que só
existe uma. Uma conta com Telegram configurado não tem como disparar um
broadcast por esse canal, mesmo tendo contatos que já conversam com o bot.

### 2. Objetivos

**Goals:**

- Escolher, ao criar um broadcast, **qual conexão** (loja + canal) usar, via
  dropdown de conexões nomeadas.
- O wizard se adapta à capability da conexão escolhida: passo de template
  (WhatsApp) vs. passo de composição livre (Telegram e futuros canais sem
  template).
- Elegibilidade de audiência calculada por canal, respeitando a regra de cada
  plataforma (alcance frio via template no WhatsApp; só quem já conversou nos
  canais sem esse conceito).
- Validação de conteúdo (tamanho de texto/legenda, mídia) usando os limites
  do canal escolhido, bloqueando o avanço do wizard se excedido.
- Relatório de métricas marca como **indisponível** (não zero) o que o canal
  não suporta.

**Non-goals:**

- WhatsApp não-oficial e Discord — não existem como canal implementado
  (`ChannelProvider` registrado); ficam de fora até virarem provider de
  verdade.
- Um broadcast disparar em múltiplos canais/conexões simultaneamente numa
  única campanha — continua sendo uma conexão por broadcast.
- Inventar um conceito equivalente a "template" para canais que não têm essa
  noção na própria plataforma.
- Mudar o comportamento hoje existente do broadcast via WhatsApp Cloud API
  (RNF-01).

### 3. Usuários & Casos de Uso

| Usuário         | Caso de Uso                                                                 | Prioridade |
| --------------- | ---------------------------------------------------------------------------- | ---------- |
| Agente/Admin+   | Criar broadcast escolhendo a conexão WhatsApp de uma loja (fluxo atual)      | Alta       |
| Agente/Admin+   | Criar broadcast escolhendo uma conexão Telegram, compondo mensagem livre     | Alta       |
| Agente/Admin+   | Ver o relatório de um broadcast e diferenciar "não entregue" de "sem dado"   | Média      |
| Agente/Admin+   | Retomar/reenviar um broadcast pendente ou falho, em qualquer canal           | Média      |

### 4. Requisitos Funcionais

- RF-01: O wizard exige a escolha de uma conexão específica (dropdown
  nomeado, ex. "WhatsApp — Loja Centro", "Telegram Bot X") antes de compor o
  conteúdo.
- RF-02: Se a conexão escolhida suporta templates (`capabilities.templates`),
  o passo 1 mostra a lista de templates aprovados — comportamento atual,
  inalterado.
- RF-03: Se a conexão escolhida não suporta templates, o passo 1 vira
  **"Compor mensagem"**: texto livre com tokens de variável + mídia opcional.
- RF-04: O passo de personalização (mapeamento de variáveis) funciona igual
  nos dois casos, mapeando os tokens do template ou da mensagem livre para
  campo do contato / campo customizado / valor estático.
- RF-05: Elegibilidade de audiência por canal:
  - Canal com alcance frio (`capabilities.templates`): elegível = tem
    identidade daquele canal (qualquer uma), como hoje.
  - Canal sem alcance frio: elegível = tem **conversa existente com aquela
    conexão específica** (não apenas identidade do canal em geral — uma conta
    pode ter mais de uma conexão do mesmo canal).
- RF-06: Validação de conteúdo (tamanho de texto/legenda, tipo/tamanho de
  mídia) usa os limites da conexão/canal escolhido e bloqueia o avanço do
  wizard se excedido — sem citar o nome de um canal errado na mensagem de
  erro.
- RF-07: O relatório do broadcast marca como "indisponível" as métricas que o
  canal não suporta (ex. `delivered`/`read` no Telegram), em vez de mostrar
  zero.
- RF-08: Envio (inicial e resume/retry) passa a usar a mesma infraestrutura
  de `sendOutbound` / `getProvider` / `getConnectionCredentials` já usada
  pelo resto do app, resolvendo conexão e credenciais uma única vez por
  campanha.
- RF-09: O comportamento existente do broadcast via WhatsApp Cloud API não
  muda (RNF-01) — coberto por testes de caracterização antes da
  refatoração.

### 5. Requisitos Não-Funcionais

- RNF-01: Comportamento do broadcast via WhatsApp Cloud API não pode mudar
  (herdado do `channel-abstraction`).
- RNF-02: A arquitetura suporta um canal novo (ex. um futuro WhatsApp
  não-oficial) sem exigir redesenho do broadcast — basta registrar o
  provider com as `capabilities` corretas.

### 6. Métricas de Sucesso

- Uma conta com Telegram consegue criar e enviar um broadcast para contatos
  que já conversaram com o bot, sem tocar em nenhum código
  WhatsApp-específico.
- Zero regressão nos testes de caracterização do broadcast WhatsApp
  existente.

---

## PARTE 2 — ARQUITETURA (O COMO)

### Contexto técnico

- `broadcasts.connection_id` já é `NOT NULL` — o modelo de dados já amarra um
  broadcast a uma conexão específica, só não está exposto na UI nem usado
  pelo resolver.
- `OutboundMessage` (o contrato que `sendOutbound`/`provider.send` usam) já
  tem `{type: 'template'}`, `{type: 'text'}` e `{type: 'media'}`.
  `SendOptions.credentials` já existe com o comentário explícito de que serve
  para "a caller that sends many messages on the SAME connection (a
  broadcast) resolve them once" — a infraestrutura para isto já foi prevista
  no `channel-abstraction`, só nunca foi conectada ao broadcast.
- `contact_identities` é por **conta** (`UNIQUE(account_id, kind,
external_id)`), não por conexão — suficiente para elegibilidade em canais
  com alcance frio, insuficiente sozinho para canais sem alcance frio quando
  há mais de uma conexão do mesmo tipo (ver Tema 3 abaixo).
- `broadcast-resume.ts` reaproveita `deliverBroadcast` de `broadcast-core.ts`
  e hoje importa `loadWhatsAppSendConnection` (hardcoded) diretamente — vem
  de graça generalizado, ao generalizar o envio inicial.

### Decisões Técnicas

#### Resolver de conexão do broadcast

**Decisão:** Reaproveitar `getConnectionCredentials`/`getProvider` — a mesma
infraestrutura que `sendOutbound`/`ingestInbound` já usam — em vez de manter
`loadWhatsAppSendConnection` como caminho hardcoded.
**Alternativas consideradas:** manter um resolver próprio e paralelo ao de
`sendOutbound`, isolado mas duplicando lógica de credenciais/capabilities.
**Justificativa:** broadcast passa a ser, estruturalmente, "várias chamadas a
`sendOutbound` numa conexão fixa escolhida" — mesma filosofia do resto do
`channel-abstraction` (um único ponto de entrada por operação).
[ADR RECOMENDADO]

#### Modelo de dados — conteúdo do broadcast por canal

**Decisão:** Colunas novas e nullable em `broadcasts` (`message_text`,
`message_media_url`), soltar o `NOT NULL` de `template_name`/
`template_language`, e um `CHECK` garantindo exclusividade (template XOR
mensagem livre, nunca os dois, nunca nenhum). `template_variables` (jsonb)
reaproveitado como a coluna de mapeamento de variáveis para os dois casos.
**Alternativas consideradas:** tabela paralela `broadcast_free_messages` 1:1
— mais "limpa", mas adiciona um join a todo lugar que lê conteúdo de
broadcast (relatório, resume).
**Justificativa:** uma tabela, conteúdo condicional por tipo — mesmo padrão
que `channel_connections.config` já usa; evita duplicar o conceito de
variável.
[ADR RECOMENDADO]

#### Elegibilidade de audiência por canal

**Decisão:** `isBroadcastEligible` passa a receber a conexão escolhida (não
só o contato) e ramifica por capability: canais com `capabilities.templates`
usam identidade por família (como hoje); canais sem usam existência de
`conversations` com aquele `connection_id` específico.
**Alternativas consideradas:** usar só identidade por família em qualquer
canal — rejeitada por poder marcar como elegível um contato que só falou com
**outra** conexão do mesmo tipo de canal (`⚠️ TENSÃO` identificada e
resolvida por esta decisão).
**Justificativa:** `contact_identities` é por conta, não por conexão;
canais sem alcance frio exigem uma checagem ligada à conexão específica.

#### Envio — payload condicional por canal

**Decisão:** `broadcast-core.ts` resolve conexão + credenciais uma vez, monta
**um** `OutboundMessage` (`template` ou `text`/`media`, decidido pelo
conteúdo salvo, não pelo canal diretamente) e itera os destinatários
elegíveis chamando `sendOutbound` com essa mesma conexão/credenciais.
**Alternativas consideradas:** nenhuma séria — é reaproveitar infraestrutura
já pronta e prevista (`SendOptions.credentials`).
**Justificativa:** mesmo padrão que `automations`/`flows` já seguem para
enviar mensagem; comportamento fino do WhatsApp (retry de variante de
telefone, `resolveTemplateRow`) continua vivendo dentro do provider
WhatsApp, sem reimplementação no broadcast.

#### RNF-01 e rename de `whatsapp_message_id`

**Decisão:** testes de caracterização no fluxo WhatsApp de broadcast antes de
qualquer refatoração (mesma régua do `channel-abstraction`).
`broadcast_recipients.whatsapp_message_id` → `external_message_id` via
migration expand-contract (mesmo padrão já aplicado em `/api/v1/messages`
durante o `channel-abstraction`).
**Justificativa:** consequências diretas de decisões já fechadas, não
escolhas novas.

### ADRs a Formalizar

- [ ] ADR-001: Resolver de conexão e credenciais do broadcast (reaproveitar
      infraestrutura de `sendOutbound`)
- [ ] ADR-002: Modelo de dados do broadcast multi-canal (colunas nullable +
      `CHECK` de exclusividade em vez de tabela separada)

---

## PARTE 3 — ABERTO & RISCOS

### Suposições não validadas

- `[SUPOSIÇÃO NÃO VALIDADA]` Nenhum plano concreto de implementar WhatsApp
  não-oficial ou Discord no curto prazo — se isso mudar, os non-goals desta
  versão precisam ser revisitados.

### Perguntas em aberto

Nenhuma pendente — todas as perguntas levantadas no debate foram fechadas
nesta rodada.

### Tensões identificadas

- ⚠️ TENSÃO (resolvida): `contact_identities` é por conta, não por conexão —
  poderia marcar como elegível um contato que só conversou com **outra**
  conexão do mesmo canal. Resolvida pela decisão de elegibilidade do Tema 3
  (conversa na conexão específica para canais sem alcance frio).

---

## Próximo passo

Execute `/gen-design` usando este SOLUTION.md como contexto para gerar o
Design Doc detalhado.
