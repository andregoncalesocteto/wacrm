# Verificação final: Jornada de pedido (ticket #16)

Verificação de ponta a ponta da feature na branch `feat/order-journey-recovery`, contra os 10 critérios de aceite da
seção 10 de `prd-menu-events-contract.md` e os três pontos de teste de `spec.md` ("Testing Decisions").

**Leia primeiro os limites.** Tudo o que é comportamento do CRM foi provado com testes automatizados sobre um banco
**simulado em memória** (`src/lib/channels/crm-world.fake.ts`, `engine.characterization.fake.ts`), chamando os
handlers de rota como função (`POST(new Request(...))`), sem servidor HTTP no ar. Nada foi verificado contra Meta,
Telegram, cardápio ou Supabase reais (seção 5). Os critérios 9 e 10 são obrigações do **time do cardápio**: o CRM
só pode provar o lado dele.

## 1. Critérios de aceite do contrato (seção 10 do PRD)

Legenda: **CRM** = provado por teste automatizado do lado do CRM; **cardápio** = comportamento do outro time, fora do
alcance de qualquer teste aqui.

Atalhos de arquivo: `route.test.ts` = `src/app/api/v1/journey/events/route.test.ts`;
`engine.char.test.ts` = `src/lib/automations/engine.characterization.test.ts`;
`journey.integration.test.ts` = `src/lib/journeys/journey.integration.test.ts` (novo neste ticket; roda uma vez em
WhatsApp Cloud e uma vez em Telegram).

| # | Critério | Teste que comprova | Lacuna |
| - | -------- | ------------------ | ------ |
| 1 | `ViewContent` com `idtrack` é aceito (200) | `route.test.ts` › "ViewContent -> Navegando, AddToCart -> Carrinho, InitiateCheckout -> Checkout"; "ViewContent marks Navegando once; the rest only count". `journey.integration.test.ts` › "link -> ViewContent -> AddToCart -> ... -> delivered" (WhatsApp e Telegram, com o `idtrack` extraído do link realmente enviado) | O cardápio real abrir o link com `?idtrack=` e chamar: **cardápio** |
| 2 | Vários `AddToCart` com carrinho inteiro; o CRM mostra valor e contagem | `route.test.ts` › "several AddToCart with different ids replace the cart snapshot"; "AddToCart after InitiateCheckout updates the cart without stepping back"; "an out-of-order event neither steps back nor overwrites a newer cart". Integração: `cart_items_count = 3`, `cart_value = 100` após o `AddToCart` | A exibição na UI (linha "N itens · valor" do card, `deal-card.tsx`) **não tem teste automatizado**; só os dados (`journeys`, `funnel.test.ts`). Conferida apenas por leitura de código |
| 3 | `InitiateCheckout` | `route.test.ts` (mesmo "happy path", etapa `checkout`); integração (etapa `checkout` nos dois canais) | Chamada real do cardápio: **cardápio** |
| 4 | `Purchase` com `order_id`, valor, moeda, itens; agradecimento no canal de origem; `idtrack` gravado no pedido | `route.test.ts` › "Purchase › creates the order, closes the Journey as won and moves the deal to Comprou"; "records the contact last purchase date...". Agradecimento: `engine.char.test.ts` › "Order notifications › Purchase thank-you (journey_event) › fires on Purchase only and can use the order variables". Integração: pedido `placed` com o `idtrack`, Journey e deal `won`, uma única mensagem de agradecimento **no canal da conversa e nenhuma no outro** (WhatsApp e Telegram) | Gravar o `idtrack` no pedido **do lado do cardápio**: **cardápio** (o CRM guarda o dele em `orders.idtrack`) |
| 5 | `OrderStatusChanged` com os sete status, inclusive `delivered`; o cliente recebe a mensagem; `TODO` não gera chamada | `route.test.ts` › "OrderStatusChanged › follows the whole delivery path and records every change in order"; "follows the pickup path"; "names the valid statuses in the error". Mensagens: `engine.char.test.ts` › "Order notifications" (sete status, "a status with no automation configured sends nothing", "outside the 24 h window sends the status template"). Integração: `received`, `preparing`, `finished`, `out_for_delivery`, `delivered` cada um gera exatamente a mensagem do preset (texto real do catálogo `en`) e um status repetido/antigo não envia nada | `ready_for_pickup` e `cancelled` estão nos testes de rota e de motor, mas **não** no teste de integração (que percorre o caminho de entrega). Que `TODO` não seja enviado é decisão do **cardápio** (o CRM não tem esse status e devolveria 400 se recebesse) |
| 6 | Reenvio do mesmo `event_id`: 200, `Idempotent-Replayed: true`, sem mensagem duplicada | `route.test.ts` › "idempotency by event_id" (replay, replay com token vencido, duas requisições simultâneas, escopo por conta, libera a reserva se falha); "Purchase › repeating the same event_id replays and creates nothing again". Integração: cabeçalho `Idempotent-Replayed: true`, `duplicate: true`, nenhuma mensagem nova e um só pedido (nos dois canais) | A concorrência é simulada em um único processo; ver seção 5 |
| 7 | `idtrack` inválido: 404 `idtrack_not_found`; vencido: 410 `idtrack_expired` | `route.test.ts` › "errors" (token desconhecido, token de outra conta, token vencido). Integração: 404 e 410 (vencimento por 31 dias de relógio simulado) | O cardápio **não entrar em laço de reenvio** nesses códigos: **cardápio** |
| 8 | Segundo pedido na mesma sessão, com o mesmo `idtrack`, abre nova Journey e é atribuído | `route.test.ts` › "Purchase › a new event on the same token after the Purchase opens a new Journey and deal"; "a Purchase on a lost Journey opens a new one and wins it, leaving the lost one alone". Integração: duas Journeys `won`, o segundo pedido ligado à segunda Journey, `last_purchase_at` gravado | Nenhuma |
| 9 | Falha temporária do CRM (5xx/429) não perde `Purchase`/`OrderStatusChanged`: a fila do cardápio reenvia com o mesmo `event_id` | **Lado do cardápio, não verificável aqui.** O que o CRM garante e está testado: reenviar é seguro (critério 6); erro durante o processamento libera o `event_id` para nova tentativa (`route.test.ts` › "releases the event_id when processing fails, so a retry is processed"); "Purchase › a failure before the Journey closes is finished by the retry, once"; 429 por chave (`route.test.ts` › "429 after the per-key rate limit (120/min)") | A fila de saída (outbox), os tempos de espera e o respeito a `Retry-After` são do **cardápio**. Sem teste de contrato contra o cardápio real |
| 10 | A chave de API nunca aparece no código nem nas requisições do navegador | **Lado do cardápio, não verificável aqui.** O CRM guarda só o hash SHA-256 da chave e o escopo `events:write` é exclusivo (não lê contatos, conversas, mensagens): `route.test.ts` › "authorization" (401 sem chave, chave revogada/desconhecida, 403 sem `events:write`, chave de outra conta não usa o token de uma conta) | Revisão do código e do tráfego do cardápio: **cardápio** |

## 2. Pontos de teste da spec

| Ponto | Onde está | Cobertura |
| ----- | --------- | --------- |
| 1. Rota pública de eventos (HTTP, banco simulado) | `route.test.ts` (930 linhas) | Resolução de token e erros; idempotência; `AddToCart` repetido; nunca recuar de etapa; `Purchase` terminal com pedido e `last_purchase_at`; novo evento depois do `Purchase` abre nova Journey; status fora do conjunto; escopo ausente (401/403); isolamento por conta (token, `event_id`, pedido); transição de Journey e deal. Coberto |
| 2. Motor de automações com os novos gatilhos | `engine.char.test.ts` (`journey_event`, `menu_link_sent`, `order_status_changed`, condições) | Disparo por evento e por status; retomadas de 10/30 min só se o cliente não respondeu ("a reply before 10 min suppresses both", "a reply between R1 and 30 min suppresses only R2"); interrupção por `AddToCart`/`InitiateCheckout`/`Purchase` ("reaching the cart after R1 suppresses R2", "a Purchase (Journey won) during the wait suppresses both"); supressão por humano ou transbordo **no momento do disparo** ("an agent assigned during the wait...", "an AI handoff during the wait...", "a handoff after R1 suppresses R2 (checked again at 30 min)"); carrinho abandonado uma vez por Journey. Variável do link: `menu-link.test.ts`, `link-hooks.test.ts`, `auto-reply.test.ts` › "{{menu_link}}" (loja sem endereço, token criado, Journey aberta). Nota de transbordo: `handoff-state.test.ts`, `src/lib/ai/handoff.test.ts` › "with Journey state", `auto-reply.test.ts` › "handoff note with Journey state". Coberto |
| 3. Envio consciente da janela (`sendOutbound`) | `src/lib/channels/send.test.ts` › "sendOutbound reply window (windowPolicy)" | Texto dentro da janela; template fora dela; falha visível sem template (`window_closed`); Telegram sem janela. Coberto |

Cenários adicionais deste ticket (`journey.integration.test.ts`, por canal, 7 casos x 2 canais = 14 testes), que exercitam
juntos o que os pontos acima cobrem em separado: rota real + módulo `journeys` + motor real com o **preset real** "Jornada
de pedido" (instalado por `installJourneyPreset` e ativado) + `sendOutbound` real + provider real de cada canal.

- Jornada completa: link enviado por uma automação com `{{menu_link}}` (URL da loja com `utm` preservado e `idtrack`),
  `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`, `received` até `delivered`, com as mensagens de cada etapa.
- Idempotência, 404/410, segundo pedido com o mesmo `idtrack`.
- Abandono: link, cron real (`GET /api/automations/cron`) aos 10 e 30 min envia a retomada 1 e 2, nada antes; após 23 h a
  Journey segue aberta; após 25 h o cron a fecha como `lost` (deal `lost`, etapa "Perdido"), sem mensagem nova e sem
  repetir na varredura seguinte.
- Resposta do cliente antes dos 10 min e `Purchase` antes dos 10 min suprimem as retomadas.
- **Sem canal no núcleo:** o mesmo código roda em WhatsApp e Telegram, e cada teste confere que só o canal da conversa
  recebeu mensagem. A regra estática (o módulo `journeys` não importa nada de canal) é garantida por
  `src/lib/journeys/no-channel-imports.test.ts`.

## 3. Banco real: migrations do zero

- Um Postgres descartável (`supabase/postgres:17.6.1.136`, a mesma imagem da stack Docker do projeto) foi subido num
  contêiner novo (`pgverify`, já removido); o schema `public` ficou vazio.
- As **61 migrations** de `supabase/migrations` (`001` a `061`, incluindo as da feature, `055` a `061`) foram aplicadas
  em ordem, uma transação por arquivo com `ON_ERROR_STOP`, como faz `docker/supabase/migrate.sh`: **61 aplicadas, 0
  falhas**.
- `supabase/ci/verify-schema.sql` rodou em seguida: **`schema verification passed`**.
- **Depois da revisão** foi acrescentada a migration `062_orders_origin_event.sql` (uma coluna nula, com assert em `verify-schema.sql`). Ela NÃO foi reaplicada nesse Postgres descartável: o resultado acima cobre `001` a `061`. Os testes das correções de revisão (ver `implementation-notes.md`, "Correções de revisão") usam os fakes em memória e simulam a concorrência por intercalamento controlado.
- Ressalva do ambiente: a imagem pelada não traz as tabelas do serviço `storage` (a migration `008` precisa de
  `storage.buckets`). Elas foram copiadas do schema `storage` da stack de desenvolvimento em execução (`pg_dump -s -n
  storage`). O CI oficial usa o Supabase CLI, que traz o storage; não foi usado aqui. Isso não afeta as migrations `055` a
  `061`, que só tocam `public`.
- O que este passo **não** prova: comportamento em runtime sobre o banco real. Nenhum teste de aplicação rodou contra
  esse Postgres (índices únicos parciais sob concorrência, RLS com os papéis reais, dicas de FK dos embeds do PostgREST
  como `deals_journey_id_fkey`). Só se provou que o schema aplica e que as asserções de `verify-schema.sql` passam.

## 4. Qualidade

| Verificação | Resultado |
| ----------- | --------- |
| `npm run typecheck` | Sem erros |
| `npm test` | 2244 passam, 2 falham (as 2 conhecidas de `src/lib/dashboard/date-utils.test.ts`, fuso horário; já falhavam antes da feature). 174 arquivos, 173 verdes. Inclui os 14 testes novos |
| `npm run lint` | 0 erros. **41 avisos, o mesmo número de `main`** (comparado rodando o lint numa cópia limpa de `main`, mensagem a mensagem). Antes deste ticket havia 2 avisos novos da feature (`_db`/`_args` sem uso em `cancelPendingForJourney`, `src/lib/journeys/orders.ts`), corrigidos aqui; os 41 restantes são dívida antiga e não foram tocados |
| `npm run build` (com o ambiente fictício do CI: `NEXT_PUBLIC_SUPABASE_URL`, `_ANON_KEY`, `ENCRYPTION_KEY` de 64 zeros, `META_APP_SECRET`) | Sucesso. Só os dois avisos de depreciação do Next (`middleware` e Edge Runtime), pré-existentes |
| `npx prettier --check` nos arquivos NOVOS da feature (todos os adicionados em relação a `main`, mais `journey.integration.test.ts` e `docs/order-journey.md`) | Passa (um arquivo novo do #4, `src/lib/ai/defaults.test.ts`, estava fora do padrão e foi reformatado). Arquivos antigos não foram reformatados |

## 5. O que NÃO foi verificado (limites honestos)

- **Meta (WhatsApp Cloud), Telegram e cardápio reais.** O envio é simulado na borda: `sendTextMessage` (Meta) e `fetch`
  (Bot API do Telegram) são stubs; as credenciais e o cofre de chaves também. Nenhuma mensagem real saiu; formato de payload,
  regras de template aprovado, rejeições de conteúdo e a janela de 24 h real da Meta não foram exercitados. A janela é
  calculada pelo relógio simulado.
- **Sem servidor HTTP.** As rotas foram chamadas como função. Roteamento do Next, middleware, cabeçalhos de proxy e o
  agendador externo real (quem chama o cron a cada 1 a 2 minutos) não foram exercitados. O cron foi chamado diretamente,
  com o relógio avançado à mão.
- **Banco simulado.** Unicidade, `created_at` e filtros são modelados só no essencial. A concorrência (dois `event_id`
  simultâneos, duas varreduras sobrepostas, corrida entre dois `Purchase`) é serial em um processo: a lógica de
  "claim" condicional está testada, mas a atomicidade real do Postgres não. O `.or()` do fake compartilhado é um no-op,
  então o pré-filtro SQL da varredura de Journeys perdidas não é exercitado (a decisão final é feita em código por Journey e
  é a testada). O limite de lote (50) e a paginação de 1000 do funil também não.
- **UI.** Não há teste de componente para: card do deal com carrinho, painel de funil, filtros, cartão do preset, lista de
  pedidos, campo "Digital menu URL". Os dados que os alimentam têm teste; a renderização não foi vista neste ticket.
- **Lado do cardápio** (critérios 9 e 10 e o envio correto dos eventos): depende do outro time.
- **Migrations sobre dados existentes.** Foram aplicadas em banco vazio, não sobre uma base com dados.

## 6. Discrepâncias encontradas entre contrato e código

- O PRD (seção 7) não lista o código `order_not_found`; o código real devolve **400 `order_not_found`** para
  `OrderStatusChanged` com `order_id` desconhecido, de outra conta ou de outro contato (decisão do #8, mesma resposta nos
  três casos para não vazar dados). A documentação pública (`docs/public-api.md`) já o lista; o PRD não foi alterado
  (é o documento entregue ao time do cardápio, e a mudança deve ser combinada com eles).
- O PRD (seção 11) fala em "seis status fechados" e em "cinco eventos"; o conjunto real e o da seção 5 são **sete** status.
- O PRD promete um único cabeçalho `Idempotent-Replayed` para reenvio; o código também o envia num `Purchase` repetido
  com outro `event_id` e o mesmo `order_id` (duplicado), o que a documentação pública agora diz.
