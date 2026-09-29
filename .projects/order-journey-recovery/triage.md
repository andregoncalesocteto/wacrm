# Triagem — Jornada de pedido com eventos de cardápio e recuperação

## Debate de features

**Features candidatas**
- Pipeline "Jornada de Pedido" (deals por etapa) alimentado por eventos, independente de canal.
- Ingestão de eventos externos de um cardápio digital via API v1 (`ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`, vocabulário do Meta Pixel), autenticada por API key com scope próprio.
- Vínculo evento ↔ contato (identidade resolvida por `contactId` no link do cardápio ou por `contact_identities`).
- Novo gatilho de automação por evento externo e condição "evento X sem evento Y após N minutos" (detecção de abandono).
- Ações de recuperação por canal, respeitando capacidades (template só no WhatsApp; texto livre no Telegram).
- Movimentação automática de deal por evento (hoje deals não estão na API v1).
- Documentação (`docs/public-api.md`, `docs/mcp.md`) e, se couber, tool no MCP server.

**Incógnitas**
- Modelo do evento: log append-only + estado derivado de carrinho, ou só transição de etapa? `ViewContent` tem volume alto.
- Como identificar o cliente no cardápio (link com `contactId`, token assinado, telefone?) e o que fazer com evento anônimo.
- "Ausência de evento" como primitiva de primeira classe ou tag como atalho (`pedido-feito`).
- Idempotência e deduplicação (`event_id`, como no Pixel), ordenação e atraso de eventos.
- Quem constrói o lado do cardápio (contrato mínimo que o wacrm publica).
- Parâmetros do evento (valor, moeda, itens) entram no deal? Relatório de funil por canal e loja?
- Regras de recuperação (janelas, número de tentativas, limite anti-spam, opt-out).

**Natureza do projeto:** brownfield, com convenções documentadas (`CLAUDE.md`, `AGENTS.md`, contrato `ChannelProvider`, `.projects/` com precedentes de features).

**Reversibilidade:** média-alta. Nova tabela e migration (só adiante, nunca editada) e contrato público em `/api/v1`, "pré-estável até o primeiro cliente, depois congelado". O formato do evento é a decisão mais cara de errar.

**Superfície de risco:** dados de comportamento de clientes ligados a contatos (LGPD, sem processo de compliance formal); endpoint de escrita público (auth, rate limit, SSRF/abuso); mensagens automáticas com risco de spam e de banimento da conta na Meta.

## Scorecard

| Sinal | Voto | Motivo |
|---|---|---|
| Ambiguidade | workflow_v1 | Escopo claro, mas a solução técnica (modelo de evento, ausência de evento, identidade) precisa ser debatida |
| Tamanho | workflow_v1, mattpocock | Várias stories em sequência (migration, API, engine, UI, docs), multi-sessão |
| Codebase | Spec Kit, mattpocock | Brownfield com convenções claras |
| Reversibilidade | workflow_v1 | Contrato público e migration caros de reverter, dev solo; ADR registra o porquê |
| Colaboração | workflow_v1 | Dev solo com rastro escrito em `.projects/` (precedente do repo) |
| Compliance | Spec Kit, mattpocock | Sem compliance formal |
| Controle e execução | abstenção | Não informado para esta feature |

## Recomendação
**Fluxo escolhido:** workflow_v1
**Placar:** BMAD 0 · Spec Kit 2 · workflow_v1 4 · mattpocock 3 (1 abstenção) — margem 1 sobre o segundo
**Força:** fraca
**Justificativa:** o contrato público e a decisão do modelo de evento são caros de reverter e pedem debate técnico com ADR; as features anteriores do repo seguiram o mesmo caminho.
**Sinais contrários:** codebase brownfield bem documentado, ausência de compliance formal e tamanho multi-sessão votaram em mattpocock/skills (segundo colocado). Se o usuário preferir conduzir cada passo com TDD e revisão por ticket, mattpocock é a alternativa.

## Decisão humana

**Fluxo adotado: mattpocock/skills** (o scorecard apontava workflow_v1 com margem fraca; o usuário escolheu conduzir o processo). Seguem `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`, sem Ralph por cima.

## Novas informações (após a triagem)

- O lado do cardápio é de outro time, que precisa receber um **PRD do contrato de eventos** derivado da spec desta feature.
- O cardápio já aceita `idtrack={identificador qualquer}`, que acompanha a jornada de compra: é a chave de correlação evento ↔ contato.
- Fluxo de jornada (diagrama do usuário):
  - **Em produção:** início no WhatsApp → IA de boas-vindas (tira dúvidas: horário, produtos, envia cardápio) → envia link do cardápio → conversa parada: 10 min (1ª retomada) e 30 min (2ª retomada) → jornada de compra pelo link → notificações de pedido (agradecimento, recebido, em execução, finalizado, entrega ou retirada) → retorno do cliente (dúvidas, problemas, erros, demora) → transbordo para call center (IA resume, humano assume).
  - **Roadmap:** após 30 dias (ou outro intervalo) sem compra: recupera cliente, envia cupom, convida para pedir; régua de comunicação para gerar recorrência.
- Implicação: o escopo não é só funil de carrinho. Os eventos incluem **status do pedido** (notificações ao cliente) e o histórico de compra alimenta a recuperação de 30 dias.
