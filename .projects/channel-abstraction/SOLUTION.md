# Solution — Abstração de canais (multiloja, multicanal)

> Versão 1 — Gerado após debate em 2026-09-21.
> Rodadas anteriores: 0

---

## PARTE 1 — PRODUTO (O QUÊ)

### 1. Problema

O produto é um CRM de atendimento sobre WhatsApp. Hoje ele fala com **um único canal** (WhatsApp Business da
Meta) e com **uma única conexão por conta** (`whatsapp_config` é único por conta). Isso não atende ao cliente
que se quer atingir: **redes com várias lojas e uma central de atendimento**, onde cada loja tem seu número,
onde canais diferentes convivem (por exemplo, WhatsApp oficial em algumas lojas e outro canal em outras) e onde
tudo precisa cair **na mesma tela de conversa**.

Fatos do código que tornam isso um problema de modelo, e não só de integração:

- Existe **uma conversa por contato** (índice único `(account_id, contact_id)`, migration 036). Com várias
  lojas, o mesmo cliente que escreve para duas lojas precisa de duas conversas.
- O **telefone é a chave do contato** (`contacts.phone` NOT NULL e índice único `(account_id, phone_normalized)`,
  migration 022). Um contato de Telegram não tem telefone.
- Cada **usuário pertence a exatamente uma conta** (`profiles.account_id`), e a segurança é feita por conta
  (`is_account_member`).
- O **envio está copiado em três lugares** que falam com a Meta direto (`send-message.ts`,
  `flows/meta-send.ts`, `automations/meta-send.ts`), e o webhook do WhatsApp (1.447 linhas) mistura formato da
  Meta com regra de negócio.
- A **API pública** e o **MCP** falam de telefone e de WhatsApp (`to` em E.164, `whatsapp_message_id`,
  `phone` obrigatório).

O valor do produto passa a ser **um inbox único sobre as conexões que o cliente tiver**, e não um canal
específico. O canal é escolhido por cliente, e até por loja, conforme custo, complexidade e maturidade.

### 2. Objetivos

**Goals:**
- Uma conta (a rede) com **várias lojas**, cada loja com **uma ou mais conexões** de canais diferentes,
  simultâneas, todas no mesmo inbox.
- Uma **abstração de canal** (contrato de provedor) na qual o canal novo entra **sem alterar o núcleo**.
- Provar a abstração com **dois provedores**: o WhatsApp oficial migrado (sem mudança de comportamento) e o
  **Telegram** como canal de prova.
- **Todo o CRM continua funcionando independente do canal**: pipelines, negócios, etiquetas, campos
  personalizados, notas, automações, flows, resposta por IA e painel.
- Deixar o **encaixe pronto** (ciclo de vida da conexão) para o WhatsApp não oficial numa versão seguinte.

**Non-goals (fora desta versão):**
- **Permissões por loja e por grupo de lojas.** Os papéis atuais (owner, admin, agent, viewer) valem para todas
  as lojas da conta. O filtro por loja no inbox é de conveniência, **não uma fronteira de segurança**.
- **WhatsApp não oficial** e **Discord**.
- Roteamento automático e fila de distribuição entre lojas; **transferência de conversa entre lojas**.
- Painéis e relatórios por loja.
- Broadcasts e templates fora do WhatsApp oficial.
- Seletor de conexão no envio (o atendente não troca de canal no meio da conversa).
- **Detecção automática** de contatos duplicados entre canais (o merge manual **entra**).
- Cobrança por conexão.
- API pública para criar ou configurar conexões (só pela interface; a API só lê).
- Rotação de chave de criptografia.
- Compatibilidade com o upstream do template e com a API atual (o produto é independente e não tem cliente).

### 3. Usuários & Casos de Uso

| Usuário | Caso de Uso | Prioridade |
|---------|-------------|------------|
| Central de atendimento (agentes) | Atender clientes de várias lojas e canais numa única tela, responder pela conexão certa e ver o histórico do cliente em outras lojas | Alta |
| Administrador da rede | Cadastrar lojas, conectar canais a cada loja, saber quando uma conexão cai | Alta |
| Rede multiloja (cliente) | Usar o CRM (pipelines, negócios, automações, flows, IA) sobre qualquer canal, com o cliente como contato único da rede | Alta |
| Pequeno negócio (uma conexão) | Usar o produto como hoje, sem ver conceito de loja ou de canal | Média |
| Integrador (API e MCP) | Enviar mensagens, ler contatos e conversas e receber webhooks sabendo de qual loja e canal vieram | Média |
| Dono do produto (operador da instalação) | Entregar o produto por instalação dedicada ou multi-tenant compartilhada | Média |

### 4. Requisitos Funcionais

- RF-01: O sistema deve ter a entidade **Loja**, com cadastro operacional: nome, endereço, telefone, horário,
  responsável e configurações próprias (por exemplo, respostas rápidas).
- RF-02: Uma conta deve poder ter **várias conexões**. Cada conexão pertence a uma loja, tem um canal e suas
  credenciais. Uma loja pode ter uma ou mais conexões, inclusive duas do mesmo canal.
- RF-03: Os canais desta versão são o **WhatsApp oficial** (migrado, comportamento idêntico ao atual) e o
  **Telegram**.
- RF-04: O contato é **único na rede** e tem **identidades por canal**. O telefone passa a ser opcional.
- RF-05: A conversa é definida por **`(contato, conexão)`**: o mesmo cliente falando com duas conexões tem duas
  conversas. A loja de uma conversa é derivada da conexão.
- RF-06: O **inbox unificado** deve mostrar: selo de loja e canal em cada conversa; filtros por loja, conexão e
  canal (somados aos de status e atribuição); não lidas total e por loja; aviso de conexão fora do ar; no perfil
  do contato, as conversas dele em outras lojas; e a resposta sai sempre pela conexão da conversa.
- RF-07: Cada provedor deve **declarar suas capacidades**. A interface esconde ou desabilita o que o canal não
  faz, explicando o motivo. Automações e flows com passos específicos de canal só ativam em conexões
  compatíveis, e a **validação acontece ao ativar**.
- RF-08: No Telegram valem estas diferenças aceitas: só "enviado" (sem entregue e lido), sem iniciar conversa
  com quem nunca falou, e botões no lugar de lista. Um envio agendado para contato sem histórico é registrado
  como **não entregue, com o motivo**.
- RF-09: **Broadcasts e templates** ficam só no WhatsApp oficial, com entrega e rastreio próprios, passando por
  `provider.send` e pela capacidade `templates`. Broadcast continua sem criar conversa nem mensagem.
- RF-10: O envio deve passar por **um único núcleo** (`sendOutbound`), usado pela rota do dashboard, pela API
  pública, pelos flows, pelas automações e pela resposta por IA.
- RF-11: **O CRM não pode depender de canal.** O contato é exibido pelo nome ou pela identidade principal do
  canal, nunca só pelo telefone. A busca considera qualquer identidade. A importação por CSV cria identidades
  de WhatsApp. Contatos do Telegram nascem por mensagem recebida.
- RF-12: O atendente deve poder fazer o **merge manual** de dois contatos. O sistema reaponta o CRM (negócios,
  notas, etiquetas, campos, conversas) para o contato sobrevivente.
- RF-13: Cada conexão deve ter **estado em tempo de execução** (`connected`, `degraded`, `disconnected`,
  `needs_action`), atualizado por evento e por verificação periódica. Administradores recebem a notificação
  `connection_down`, e a página da conexão mostra estado, último erro e contagens das últimas 24 h.
- RF-14: As **credenciais** de cada conexão ficam numa tabela separada, sem leitura por membros, e nunca voltam
  à interface nem vão para log.
- RF-15: A **API pública e o MCP** devem: aceitar o envio por `conversation_id` ou `{connection_id, to}`
  (`connection_id` opcional só quando a conta tem exatamente uma conexão ativa; senão `400
  connection_required`); devolver `external_message_id`, `connection_id` e `channel`; expor `GET
  /api/v1/stores` e `GET /api/v1/connections` só de leitura (escopo `connections:read`); ter `identities` no
  contato; e incluir `connection_id`, `store_id` e `channel` em conversas e webhooks de saída.
- RF-16: Contas existentes migram para **uma loja e uma conexão de WhatsApp**, e a interface fica **idêntica**
  enquanto houver uma conexão só (selos, filtros e avisos de loja só aparecem com mais de uma).
- RF-17: Criar, editar e apagar lojas e conexões exige **administrador ou acima**.

### 5. Requisitos Não-Funcionais

- RNF-01: **Regressão zero no WhatsApp oficial**: enviar, receber, templates, broadcasts, flows e resposta por
  IA se comportam como hoje, e a suíte de testes existente passa sem mudanças além das mecânicas.
- RNF-02: Adicionar um **canal novo** exige criar um provedor e registrá-lo, **sem alterar o núcleo**
  (conversa, contato, inbox, flows e automações).
- RNF-03: **Segredos** nunca aparecem na interface, em log ou em `messages.media_url`. A URL de arquivo do
  Telegram, que carrega o token do bot, nunca é gravada.
- RNF-04: **Recebimento** com ack rápido e ingestão **idempotente**, sem duplicar mensagens em reenvio do
  provedor.
- RNF-05: A **API `/api/v1`** muda no lugar e é **pré-estável até o primeiro cliente**. A partir do primeiro
  cliente integrado, o contrato congela e mudança quebradora exige `v2`.
- RNF-06: A loja de cada conversa é derivada da conexão, para uma camada futura de permissões por loja se
  apoiar em dado que já existe, sem nova migração de estrutura.
- RNF-07: O desenvolvimento e os testes do Telegram usam **túnel público** e **fixtures de payload**, porque o
  webhook exige URL pública.

### 6. Métricas de Sucesso

1. **Regressão zero no WhatsApp oficial** (RNF-01), medida pela suíte existente.
2. **O caso das pizzarias funciona:** uma conta com 2 ou mais lojas e 2 canais (WhatsApp oficial e Telegram)
   vê todas as conversas num inbox, responde pela conexão certa, e o mesmo cliente é um contato só.
3. **O custo de um canal novo é baixo:** um terceiro canal entra só com um provedor e um registro, sem tocar o
   núcleo.
4. **Uma loja nova é conectada em menos de 10 minutos**, do cadastro à primeira mensagem recebida.
   `[SUPOSIÇÃO NÃO VALIDADA]`
5. **O CRM funciona igual para um contato do Telegram:** criar negócio a partir da conversa, etiquetar, anotar,
   preencher campo personalizado, disparar automação e flow, e aparecer nos totais do painel.

A validação do produto é **só técnica** por enquanto (não há rede piloto).

---

## PARTE 2 — ARQUITETURA (O COMO)

### Contexto técnico

- **Sem cliente hoje e produto independente:** não há obrigação de compatibilidade com a API atual nem com o
  upstream; a migração dos dados existentes é mínima (uma loja e uma conexão por conta).
- **Modelo de conta preservado:** a conta é a rede, e a segurança continua por conta. A loja é uma unidade
  dentro dela, o que evita reescrever as políticas de acesso.
- **Duas conexões desta versão chegam por webhook HTTP** (WhatsApp oficial e Telegram), então não há processo
  persistente na versão 1. O WhatsApp não oficial (versão seguinte) mantém sessão contínua e exigirá um
  contêiner de worker, que a hospedagem gerenciada de Node não roda.
- **Padrões existentes a preservar:** webhook do WhatsApp responde rápido e processa em `after()` com
  `maxDuration = 60`; idempotência pela unicidade `(conversation_id, message_id)`; agenda de esperas por rotas de
  cron chamadas por agendador externo; cifra AES-256-GCM com `ENCRYPTION_KEY`.
- **Migrações:** numeração sequencial (a próxima é `043`), sem editar as antigas.

### Decisões Técnicas

#### Modelo de dados
**Decisão:** novas tabelas `stores`, `channel_connections` (substitui `whatsapp_config`; `channel_type`,
`external_id` único por `(channel_type, external_id)`, `config jsonb`, estado e saúde) e `contact_identities`
(fonte única de identidade, inclusive para o WhatsApp). `contacts.phone` passa a poder ser nulo.
`conversations` ganha `connection_id` e o índice único passa a ser `(contact_id, connection_id)`. `messages`
usa o identificador externo genérico. `message_templates` e `broadcasts` ganham `connection_id`. A unicidade
da execução ativa de `flow_runs` passa de "por contato" para "por conversa". Não há coluna de loja na
conversa: ela é derivada por `connection_id → store_id`. Uma loja pode ter várias conexões, sem unicidade por
`(loja, canal)`.
**Alternativas consideradas:** uma tabela por provedor (cada canal novo exige migração e o núcleo conhece as
tabelas); manter as colunas `wa_*` no contato e usar identidades só para canais novos (o núcleo fica com dois
caminhos e a abstração vaza); loja como tenant, com uma camada "rede" acima (reescrita de segurança em toda a
base e usuário em várias contas, sem necessidade, já que as lojas são da mesma empresa).
**Justificativa:** o núcleo resolve identidade e conversa do mesmo jeito em qualquer canal (métrica 3), e o
custo da migração completa é baixo sem clientes. A lógica específica do WhatsApp (ID de usuário por negócio,
username, telefone) fica dentro do provedor, que devolve candidatos de identidade.
[ADR RECOMENDADO]

#### Contrato do provedor de canal
**Decisão:** um **registro em processo** de objetos de provedor, em `src/lib/channels/`, com o contrato:
`type`, `capabilities`, esquemas de configuração e credenciais; ciclo de vida da conexão (`connect`,
`disconnect`, `health`); entrada (`resolveConnection`, `verify`, `parse` → eventos normalizados com candidatos
de identidade); saída (`send`, com destino, mensagem normalizada e resultado normalizado). Erros normalizados
(`auth`, `rate_limited`, `recipient_unreachable`, `unsupported`, `window_closed`…) com o código do provedor ao
lado. As capacidades são declaradas **por tipo** de canal. As rotas de webhook são: **manter
`/api/whatsapp/webhook`** delegando ao provedor, e criar `/api/channels/[channel]/webhook/[connectionId]` para
os novos.
**Alternativas consideradas:** um gateway HTTP por canal com contrato REST e webhook (isola processos
persistentes, mas cria serviço, deploy e observabilidade novos já na versão 1); herança de classes abstratas.
**Justificativa:** simples, tipada, sem infraestrutura nova e testável. O gateway continua possível no futuro
porque um provedor pode chamar um gateway externo (Evolution ou WAHA) por dentro. O contrato já prevê o ciclo
de vida (conectar, QR, saúde, reconectar), para o WhatsApp não oficial entrar sem refazê-lo.
[ADR RECOMENDADO]

#### Recebimento e processos persistentes
**Decisão:** ack rápido, processamento dentro de `after()` e **ingestão idempotente**, como o WhatsApp faz
hoje, em uma função do núcleo que não depende de quem a chama. Desenvolvimento e testes do Telegram com túnel
público documentado e fixtures de payload; o long polling fica para junto do worker.
**Alternativas consideradas:** gravar o evento bruto numa tabela e reprocessar por rota (permite auditar, mas
o volume ainda não justifica); fila real (pg-boss, BullMQ), sem demanda.
**Justificativa:** nada novo para operar e preserva o comportamento atual. Por a ingestão ser idempotente e
independente do chamador, passar para o evento bruto depois só muda quem a invoca. O risco de perda de evento
entre o ack e o processamento é conhecido e fica visível pela atualização de `last_error` da conexão.
[ADR RECOMENDADO]

#### Envio unificado
**Decisão:** um único **`sendOutbound({ conversation, message, actor })`** para os cinco chamadores. Ele carrega
a conversa, a conexão e o contato, pede o destino ao provedor, **valida a mensagem contra as capacidades**,
chama `provider.send`, grava a mensagem e atualiza a conversa, e pausa o flow ativo quando um agente assume. Os
`engineSend*` são apagados. O que é do WhatsApp (variantes de telefone, "destinatário não permitido") fica
dentro do provedor. Reagir, "digitando" e baixar mídia viram métodos opcionais do provedor, protegidos pelas
capacidades. **Broadcasts** mantêm entrega e rastreio próprios, mas passam por `provider.send` e pela capacidade
`templates`.
**Alternativas consideradas:** manter os senders dos motores separados chamando o provedor (persistência e
validação continuam duplicadas); passar o broadcast pelo núcleo de conversa (mudaria o comportamento e
passaria a criar conversas sem que ninguém peça).
**Justificativa:** o próprio código pede a consolidação nos comentários, e é o que garante que um canal novo
não obrigue a mexer em vários lugares (métrica 3).

#### Credenciais por conexão
**Decisão:** tabela separada **`channel_connection_credentials`**, sem política de leitura para membros (só o
servidor, com a chave de serviço). No Telegram, o app gera um **`secret_token`** por conexão, guarda cifrado e o
compara em tempo constante. O WhatsApp mantém o HMAC. Segredos nunca voltam à interface nem vão para log. A URL
de arquivo do Telegram (que contém o token do bot) nunca é gravada. Criar, editar e apagar lojas e conexões exige
administrador ou acima.
**Alternativas consideradas:** coluna cifrada em `channel_connections`, como hoje em `whatsapp_config` (qualquer
membro lê o texto cifrado pela API do banco, dependendo só da cifra).
**Justificativa:** o segredo fica isolado por construção. É barato agora e caro de mudar depois de haver dados.
[ADR RECOMENDADO]

#### API pública e MCP
**Decisão:** mudar **`/api/v1` no lugar**, marcada como **pré-estável até o primeiro cliente**, depois congelada.
`POST /api/v1/messages` aceita `{ conversation_id }` ou `{ connection_id, to }` (`connection_id` opcional só
com exatamente uma conexão ativa; senão `400 connection_required`; não existe "conexão padrão"). Respostas com
`external_message_id`, `connection_id` e `channel`. Recursos só de leitura `GET /api/v1/stores` e
`GET /api/v1/connections` (escopo `connections:read`). Contatos com `identities` e `phone` opcional. Conversas
e webhooks de saída com `connection_id`, `store_id` e `channel`. O MCP espelha a API e sobe de versão.
**Alternativas consideradas:** `/api/v2` agora (mantém uma API antiga sem nenhum usuário); manter `to` e criar
uma conexão padrão por compatibilidade (conceito que só serviria a clientes inexistentes).
**Justificativa:** sem cliente, o custo de manter duas versões não paga nada. A regra de congelar no primeiro
cliente evita que a liberdade de agora vire dívida.
[ADR RECOMENDADO]

#### Observabilidade
**Decisão:** `channel_connections` ganha `status`, `last_inbound_at`, `last_outbound_at`, `last_error` e
`last_health_check_at`, atualizados por **evento** (erro de envio de tipo `auth`, mensagem recebida, falha de
ingestão) e por **verificação periódica** de `provider.health` numa rota de cron, no padrão das que já existem.
Aviso no inbox, página da conexão (estado, último erro, contagens das últimas 24 h calculadas de `messages`) e
notificação interna `connection_down` para administradores (novo tipo em `notifications`). Logs estruturados
com a convenção `[channel:<tipo>] conn=<id> event=<id>`, sem segredos.
**Alternativas consideradas:** só por evento (uma loja parada sem tráfego continua "conectada"); só o aviso no
inbox (quem não olha o inbox não fica sabendo).
**Justificativa:** o pior cenário operacional é uma loja desconectada que ninguém percebe. Sem o cron, o sistema
degrada para só-evento, sem falhar.

#### Continuidade do CRM independente de canal
**Decisão:** a camada de CRM depende de **contato e conversa, nunca de canal**. Pipelines, negócios, etiquetas,
campos personalizados e notas **não mudam** (as tabelas não têm coluna de telefone, WhatsApp nem canal). O que
muda é a camada em volta: o nome de exibição do contato vem do nome ou da identidade principal do canal
(generalizando o `contactHandle`, hoje só do WhatsApp); a busca e a detecção de duplicidade usam identidades; a
importação por CSV cria identidades de WhatsApp; a condição sobre o campo `phone` e a variável `{{phone}}` se
comportam como "não definido" para contatos sem telefone; o painel continua lendo `conversations` e `messages`,
neutras de canal. **Merge manual de contatos** entra no escopo, reaproveitando a lógica de reapontamento da
migration 022.
**Alternativas consideradas:** deixar o merge de contatos de fora (o mesmo cliente por dois canais divide o
CRM em dois registros, contra a intenção de o contato ser da rede).
**Justificativa:** o produto é um CRM, e o CRM não pode quebrar quando o canal muda. A métrica 5 mede isso.
[ADR RECOMENDADO]

### ADRs a Formalizar
- [ ] ADR-001: Modelo de dados (conta = rede, loja, conexão, conversa por `(contato, conexão)`, identidades como fonte única)
- [ ] ADR-002: Contrato do provedor de canal e ciclo de vida da conexão (registro em processo, gateway como caminho futuro)
- [ ] ADR-003: Ingestão idempotente com ack rápido e `after()`
- [ ] ADR-004: Credenciais das conexões em tabela separada
- [ ] ADR-005: Contrato da API pública pré-estável e congelamento no primeiro cliente
- [ ] ADR-006: Merge manual de contatos e independência do CRM em relação ao canal

---

## PARTE 3 — ABERTO & RISCOS

### Riscos
- **R1 — Regressão no WhatsApp oficial** durante a refatoração (único canal que funciona hoje). Impacto alto.
  Mitigação: comportamento idêntico como critério, suíte de testes existente e migrar um caminho de cada vez.
- **R2 — Construir sem demanda real:** nenhum cliente confirmou a necessidade e não há piloto. Impacto alto.
  Mitigação: escopo pequeno, e escolher os próximos canais pela demanda de clientes futuros.
- **R3 — O canal de prova não é o que o mercado quer.** Redes brasileiras usam quase só WhatsApp. Impacto médio.
  Mitigação: o Telegram é prova técnica, e os canais seguintes saem da demanda.
- **R4 — Modelo de identidade errado**, caro de desfazer. Impacto alto. Mitigação: ADR-001 e testes de migração.
- **R5 — WhatsApp não oficial (versão seguinte):** risco de termos e de banimento, que recai sobre o cliente.
  Impacto médio. Mitigação: contrato preparado agora; aviso explícito na interface e nos termos de uso quando
  for implementado.

### Suposições não validadas
- [SUPOSIÇÃO NÃO VALIDADA] O tamanho típico de uma rede-alvo (o debate não o definiu).
- [SUPOSIÇÃO NÃO VALIDADA] Há demanda real por inbox multiloja e multicanal (sem rede piloto).
- [SUPOSIÇÃO NÃO VALIDADA] Do Telegram: o bot só inicia conversa com quem já falou com ele; não há recibos de
  entrega e leitura; o webhook exige URL pública HTTPS. Não confirmei esses pontos na documentação consultada
  (que confirmou reações, "digitando", botões e limite de arquivo de 50 MB).
- [SUPOSIÇÃO NÃO VALIDADA] As capacidades valem por **tipo** de canal, e não por conexão.
- [SUPOSIÇÃO NÃO VALIDADA] Templates por conexão, aceitando a duplicação quando várias conexões compartilham a
  mesma WABA.
- [SUPOSIÇÃO NÃO VALIDADA] O limite de 10 minutos para conectar uma loja é um palpite.
- [SUPOSIÇÃO NÃO VALIDADA] O contrato do provedor serve ao WhatsApp não oficial (só será testado na versão
  seguinte).
- [SUPOSIÇÃO NÃO VALIDADA] A central distingue a loja pelo nome do cadastro.
- [SUPOSIÇÃO NÃO VALIDADA] O custo do merge manual: reaproveita a lógica da migration 022, mas o número de
  tabelas a reapontar cresceu desde então.

### Perguntas em aberto
- [PERGUNTA EM ABERTO] Qual o tamanho das redes-alvo? Afeta o desempenho do inbox e o número de processos de
  conexão no futuro.
- [PERGUNTA EM ABERTO] Templates: compartilhar por WABA em vez de duplicar por conexão?
- [PERGUNTA EM ABERTO] Onde hospedar o worker do WhatsApp não oficial, já que a hospedagem gerenciada de Node
  não o roda?
- [PERGUNTA EM ABERTO] Como e quando entram as permissões por loja e por grupo (a estrutura já permite:
  a loja é derivada da conexão)?

### Tensões identificadas
- ⚠️ TENSÃO (resolvida): "cada loja é um tenant" (como foi descrito) contra o modelo atual de um usuário por
  conta. Resolvida pela alternativa "a rede é o tenant e a loja é uma unidade", já que as lojas são da mesma
  empresa. Só uma rede de franquias com dados isolados exigiria a alternativa mais cara.
- ⚠️ TENSÃO (resolvida): "fusão de contatos duplicados fora do escopo" contra "o CRM funciona igual em
  qualquer canal". Resolvida trazendo o merge manual mínimo para dentro.
- ⚠️ TENSÃO (resolvida): contrato aditivo por compatibilidade contra a liberdade de um produto sem cliente.
  Resolvida mudando `/api/v1` no lugar, sem "conexão padrão", com regra de congelar no primeiro cliente.
- ⚠️ TENSÃO (aberta): a refatoração de envio e recebimento é larga e o WhatsApp oficial é o único canal que
  funciona hoje. Mitigada pela suíte existente e por migrar um caminho de cada vez, mas segue como o maior
  risco de execução.

---

## Próximo passo
Execute `/gen-design` (`/workflow_v1:gen-design`) usando este SOLUTION.md como contexto para gerar o Design Doc
detalhado da abstração de canais.
