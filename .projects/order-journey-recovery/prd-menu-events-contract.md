# PRD: contrato de eventos do cardápio digital para o CRM

Documento para o **time do cardápio digital**. Derivado de `spec.md` (decisões em `adr/0001-journey-events-server-to-server-with-tracking-token.md`). O CRM é o **wacrm**; o cardápio é o **Digital menu**.

> Status do contrato: rascunho até a API pública de eventos ser implementada. Depois da implementação, ele segue a regra da API v1: pré-estável até o primeiro cliente, depois congelado (uma quebra exige `v2`).

## 1. Objetivo

O cliente conversa com a loja por um canal de mensagens (hoje WhatsApp e Telegram) e recebe o link do cardápio da loja. O pedido acontece inteiro no cardápio. Para que o CRM possa retomar quem desistiu e avisar o cliente sobre o andamento do pedido, o **backend do cardápio** informa ao CRM o que acontece na jornada de compra e no pedido.

O que o cardápio precisa fazer, em uma frase: **guardar o `idtrack` que chegou na URL durante toda a sessão de compra e enviá-lo ao CRM, a partir do servidor, em cada evento.**

## 2. O que o CRM entrega ao cardápio

O link que o cliente recebe é o endereço do cardápio da loja com um parâmetro a mais:

```
https://<endereço-do-cardápio-da-loja>/?idtrack=<token>
```

- O `idtrack` é um valor **opaco**. Não interprete, não decodifique, não use como identificador do cliente no seu sistema.
- O endereço do cardápio é cadastrado por loja no CRM; cada loja envia o seu domínio.
- O CRM mantém os demais parâmetros que o endereço da loja já tiver.
- O mesmo cliente pode receber o mesmo `idtrack` em links diferentes enquanto ele for válido. O token vale por **30 dias**, renovado a cada novo link enviado.

## 3. Regras de ouro

1. **Servidor para servidor.** Os eventos são enviados pelo backend do cardápio, com uma chave de API. **Nunca** coloque a chave no navegador do cliente: quem tiver a chave consegue forjar um `Purchase` e disparar cupons e notificações.
2. **O `idtrack` acompanha a sessão de compra e depois o pedido.** No navegador ele pode viver só em `sessionStorage`, mas os status chegam horas depois, do seu backend, quando essa sessão já não existe. Por isso, **grave o `idtrack` junto do pedido no seu banco no momento do `Purchase`** e use esse valor em todos os `OrderStatusChanged`. Sem `idtrack` no pedido, os status não podem ser enviados.
   - Se o cliente abrir o cardápio sem `idtrack` (endereço direto, favorito), **não envie eventos**: eles não seriam atribuíveis.
3. **Todo evento tem um `event_id` único.** Reenviar o mesmo evento é seguro; o CRM devolve a resposta original e não repete nenhum efeito.
4. **A ordem de chegada não importa.** Eventos atrasados ou fora de ordem não estragam o estado (seção 6).

## 4. Autenticação

- Cada chamada usa `Authorization: Bearer wacrm_live_…`.
- A chave é criada no CRM (**Configurações → Chaves de API**) por quem já tem permissão para criar chaves, com o escopo exclusivo **`events:write`**. Essa chave só pode enviar eventos: ela não lê contatos, conversas nem mensagens.
- O CRM limita a **120 requisições por minuto por chave**. Um pedido típico gera entre 4 e 8 chamadas (uma por evento), mas uma loja com muitas sessões simultâneas deve considerar esse limite. Em `429`, respeite o header `Retry-After`.

## 5. Endpoint

`POST /api/v1/journey/events`

Um evento por chamada. Corpo em JSON. Não há envio em lote nesta versão.

### Campos comuns

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `event_id` | string | sim | Único por conta. Gere no seu lado (por exemplo um UUID) e reuse o mesmo valor em reenvios. |
| `name` | string | sim | `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase` ou `OrderStatusChanged`. |
| `idtrack` | string | sim | O valor recebido na URL. |
| `occurred_at` | string (ISO 8601, UTC) | sim | Instante em que o evento aconteceu no cardápio, não o de envio. |

### `ViewContent`

O cliente abriu o cardápio ou uma página de produto. Envie no primeiro acesso da sessão; repetições são aceitas e contadas, mas não mudam a etapa.

```json
{
  "event_id": "9b1f6c3e-7f64-4c7a-9a1e-1f2b3c4d5e6f",
  "name": "ViewContent",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:14:05Z"
}
```

### `AddToCart`

O cliente adicionou (ou alterou) itens no carrinho. **Pode repetir** durante a mesma jornada, cada vez com um `event_id` diferente. Envie sempre o **carrinho inteiro naquele momento**, não só o item novo: assim a perda de uma chamada intermediária não corrompe o total.

```json
{
  "event_id": "b6d2…",
  "name": "AddToCart",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:16:40Z",
  "properties": {
    "currency": "BRL",
    "cart": {
      "value": 89.8,
      "items": [
        { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 },
        { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 }
      ]
    }
  }
}
```

### `InitiateCheckout`

O cliente iniciou o fechamento do pedido. Mesmo formato de `properties` do `AddToCart` (carrinho inteiro).

### `Purchase`

O pedido foi feito. **É terminal para a jornada**: fecha a tentativa como ganha e cria o pedido no CRM. O CRM envia o agradecimento ao cliente ao recebê-lo.

```json
{
  "event_id": "c41e…",
  "name": "Purchase",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:22:11Z",
  "properties": {
    "order_id": "PED-2026-104233",
    "currency": "BRL",
    "value": 89.8,
    "items": [
      { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 },
      { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 }
    ]
  }
}
```

- `order_id` é o **identificador do pedido no seu sistema**, estável para sempre. Todos os `OrderStatusChanged` seguintes referenciam esse mesmo valor.
- Um segundo `Purchase` com o mesmo `order_id` e outro `event_id` é tratado como duplicado: nada é criado de novo.

### `OrderStatusChanged`

O pedido mudou de estado depois de feito.

```json
{
  "event_id": "d78a…",
  "name": "OrderStatusChanged",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:35:00Z",
  "properties": {
    "order_id": "PED-2026-104233",
    "status": "preparing"
  }
}
```

Valores aceitos de `status` (conjunto fechado):

| `status` | Significado |
| --- | --- |
| `received` | Pedido recebido pela loja |
| `preparing` | Em preparo |
| `finished` | Preparo finalizado |
| `out_for_delivery` | Saiu para entrega |
| `ready_for_pickup` | Pronto para retirada |
| `delivered` | Pedido entregue ou retirado |
| `cancelled` | Cancelado (a qualquer momento) |

Qualquer outro valor é recusado. O CRM precisa saber exatamente qual mensagem enviar ao cliente para cada estado, por isso o conjunto é fechado e os estados internos do cardápio são traduzidos do seu lado.

### Mapa dos estados do cardápio

| Estado interno do cardápio | O que enviar ao CRM |
| --- | --- |
| `PLACED` (pedido registrado) | Nada como status: é o próprio evento `Purchase` |
| `APPROVED` (pedido aprovado) | `OrderStatusChanged` com `received` |
| `TODO` (pronto para produzir) | **Não enviar.** Não há mensagem ao cliente para este estado |
| `DOING` (sendo produzido) | `preparing` |
| `DONE` (produção finalizada) | `finished` |
| `DISPACHED` (delivery) | `out_for_delivery` |
| `READYTOPICKUP` (retirada) | `ready_for_pickup` |
| `DELIVERED` (entregue) | `delivered` |
| `CANCELED` (cancelado) | `cancelled` |

Se algum dos estados que não enviamos (`TODO`) precisar avisar o cliente, diga e nós incluímos um status novo no conjunto.

## 6. Ordem, repetição e idempotência

- **Idempotência.** O `event_id` é único por conta. Reenviar o mesmo `event_id` devolve a resposta original (a resposta traz o header `Idempotent-Replayed: true`) e não repete efeitos, como mensagens ao cliente.
- **A jornada só avança.** As etapas são Link enviado → Navegando → Carrinho → Checkout → Comprou. Um `AddToCart` depois de `InitiateCheckout` atualiza o carrinho, mas não faz a jornada recuar. Se um evento intermediário nunca chegar, o estado final continua correto.
- **O status do pedido só avança**, na ordem `received` → `preparing` → `finished` → `out_for_delivery` ou `ready_for_pickup` → `delivered`. `cancelled` vale a qualquer momento. Um status mais antigo que chega depois de um mais novo é aceito (`200`), mas ignorado: nenhuma mensagem é enviada ao cliente.
- **Depois do `Purchase`, o mesmo `idtrack` continua valendo.** Um novo evento com ele abre uma **nova jornada**, para que clientes recorrentes que reaproveitam a mesma sessão continuem sendo atribuídos.

## 7. Respostas

Todas as respostas usam o envelope da API v1.

```jsonc
// sucesso
{ "data": { "event_id": "b6d2…", "journey_id": "…", "stage": "cart", "duplicate": false } }

// falha
{ "error": { "code": "idtrack_expired", "message": "…" } }
```

Ramifique pelo `error.code` (estável); a `message` é para leitura humana e pode mudar.

| HTTP | `error.code` | Quando | O que fazer |
| --- | --- | --- | --- |
| 200 | (sucesso) | Evento aceito, inclusive repetição de `event_id` e status antigo ignorado | Nada. |
| 400 | `bad_request` | Corpo malformado, campo ausente, `status` fora do conjunto, `name` desconhecido | Corrigir o seu envio. **Não** repita igual. |
| 400 | `order_not_found` | `OrderStatusChanged` para um `order_id` que o CRM não conhece para esse `idtrack` (por exemplo, o `Purchase` ainda está na sua fila de saída e não chegou) | **Reenvie** com espera crescente: o status é aceito depois que o `Purchase` chegar. Se persistir por horas, investigue. |
| 401 | `unauthorized` | Chave ausente, inválida, revogada ou expirada | Verificar a chave. |
| 403 | `forbidden` | A chave não tem o escopo `events:write` | Pedir a quem administra o CRM. |
| 404 | `idtrack_not_found` | O `idtrack` não corresponde a nenhum link enviado | Corrigir o link/parâmetro. **Não** repita. |
| 410 | `idtrack_expired` | O `idtrack` passou da validade de 30 dias | Não repita; o cliente precisa de um novo link do CRM. |
| 429 | `rate_limited` | Limite por chave estourado | Reenviar depois de `Retry-After`, com o **mesmo** `event_id`. |
| 500 | `internal` | Erro do CRM | Reenviar com o **mesmo** `event_id` (seção 8). |

## 8. Entrega confiável e política de reenvio

Hoje o backend do cardápio não tem fila nem reenvio. Sem isso, qualquer falha momentânea do CRM (ou da rede) perde o evento, e o impacto não é igual para todos:

| Evento | Se for perdido | Exigência |
| --- | --- | --- |
| `Purchase` | O CRM acha que o cliente abandonou e envia retomada ou carrinho abandonado a quem já comprou; o cliente também não recebe o agradecimento | **Obrigatório** usar fila de saída (outbox) com reenvio |
| `OrderStatusChanged` | O cliente não recebe a notificação daquele estado | **Obrigatório** usar fila de saída (outbox) com reenvio |
| `InitiateCheckout`, `AddToCart` | O funil fica um passo atrás; a mensagem de carrinho abandonado pode sair mais tarde ou nem sair | Recomendado: até 3 tentativas imediatas, sem bloquear o cliente |
| `ViewContent` | Perde a etapa "Navegando" | Sem reenvio; perda aceitável |

**Fila de saída mínima para `Purchase` e `OrderStatusChanged`.** No momento em que o pedido é gravado (e a cada mudança de estado), grave também, na mesma transação, uma linha de evento pendente com o `event_id`, o corpo e o número de tentativas. Um processo separado envia as pendentes e as marca como enviadas ao receber `200`.

- **Reenvie** em `429`, `5xx` e falhas de rede/timeout, com o **mesmo** `event_id` e espera crescente (por exemplo 30s, 2min, 10min, 1h, 6h, até 24 h).
- **Não reenvie** em `400` (exceto `order_not_found`, veja a seção 7), `401`, `403`, `404` e `410`: o mesmo corpo vai falhar do mesmo jeito; registre o erro para investigação.
- O CRM executa os efeitos uma vez por `event_id`, então reenviar é sempre seguro.
- Os eventos de comportamento (`ViewContent`, `AddToCart`, `InitiateCheckout`) devem sair de forma assíncrona: o cliente nunca espera pelo CRM.

## 9. Segurança e privacidade

- O `idtrack` não é dado pessoal do cliente e não deve ser registrado com outros identificadores dele fora do necessário para enviar os eventos.
- Não envie ao CRM dados que ele não precisa (telefone, documento, endereço, forma de pagamento). Só os campos deste contrato.
- Guarde a chave de API como segredo de servidor (variável de ambiente ou cofre). Se ela vazar, peça a revogação no CRM; a revogação vale na próxima requisição.

## 10. Critérios de aceite da integração

O time do cardápio considera a integração pronta quando, em ambiente de testes com uma chave de teste e um `idtrack` fornecido pelo CRM:

1. Abrir o link do cardápio com `?idtrack=…` resulta em um `ViewContent` aceito (`200`).
2. Adicionar vários itens em sequência gera vários `AddToCart`, cada um com `event_id` novo e o carrinho inteiro, e o CRM mostra o valor e a contagem atualizados.
3. Iniciar o fechamento gera `InitiateCheckout`.
4. Finalizar o pedido gera `Purchase` com `order_id`, valor, moeda e itens; o cliente recebe o agradecimento no canal de origem. O `idtrack` fica gravado no pedido.
5. Cada mudança de estado do pedido gera `OrderStatusChanged` com um dos sete status do mapa (inclusive `delivered`), usando o `idtrack` gravado no pedido; o cliente recebe a mensagem correspondente. `TODO` não gera chamada.
6. Reenviar o mesmo evento (mesmo `event_id`) devolve `200` com `Idempotent-Replayed: true` e não gera mensagem duplicada ao cliente.
7. Um `idtrack` inválido devolve `404 idtrack_not_found` e um vencido devolve `410 idtrack_expired`, e o seu sistema não fica em laço de reenvio.
8. Um segundo pedido na mesma sessão, depois do primeiro `Purchase`, com o mesmo `idtrack`, abre uma nova jornada e é atribuído.
9. Uma falha temporária do CRM (`5xx`/`429`) não perde nenhum `Purchase` nem `OrderStatusChanged`: a fila de saída reenvia com o mesmo `event_id`, com espera crescente, até o CRM aceitar.
10. A chave de API nunca aparece no código nem nas requisições do navegador.

## 11. Fora desta versão

- Envio de vários eventos em uma chamada (lote).
- Eventos além dos cinco listados.
- Status de pedido além dos sete fechados.
- Consulta do estado da jornada ou do pedido pelo cardápio.
- Recuperação por inatividade de 30 dias e régua de recorrência (fase seguinte, no CRM; não exige nada do cardápio além dos eventos acima).

## 12. Respostas do time do cardápio e pendências

**Respondido**

1. O cardápio consegue enviar o **carrinho inteiro** em `AddToCart` e `InitiateCheckout`: **sim**. A regra do contrato fica como está.
2. Os estados internos (`PLACED`, `APPROVED`, `CANCELED`, `TODO`, `DOING`, `DONE`, `DISPACHED`, `READYTOPICKUP`, `DELIVERED`) foram traduzidos na tabela da seção 5. Consequência: entrou o status `delivered`, e `TODO` não é enviado.
3. O `idtrack` fica **só em `sessionStorage`**. Isso basta até o `Purchase`, mas exige gravá-lo no pedido (seção 3, regra 2).
4. **Não existe mecanismo de reenvio.** Consequência: a seção 8 passou a exigir fila de saída para `Purchase` e `OrderStatusChanged`.

**Confirmado na segunda rodada**

- O `idtrack` **é salvo no pedido**.
- `DELIVERED` na retirada acontece **quando o cliente retira** o pedido, então `delivered` vale para os dois modos.
- `TODO` **pode ficar sem notificação** ao cliente e não é enviado.

**Decidido**

- O time do cardápio **implementará a fila de saída** com reenvio para `Purchase` e `OrderStatusChanged` (seção 8). Registrado a partir da confirmação do responsável pelo projeto; o time do cardápio deve validar o prazo e o desenho ao receber este PRD.
- A alternativa de o CRM consultar um endpoint do cardápio antes de enviar mensagem de recuperação fica descartada nesta fase.

**Sem pendências abertas neste contrato.**
