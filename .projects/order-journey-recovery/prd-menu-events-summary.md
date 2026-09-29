# Resumo do contrato de eventos do cardápio para o CRM (wacrm)

Resumo para enviar ao time do cardápio. Documento completo: `prd-menu-events-contract.md`.

Olá, time do cardápio!

O CRM vai acompanhar cada pedido do cliente desde o link até a entrega, para recuperar quem desistiu e avisar o andamento do pedido. Para isso, o **backend do cardápio** precisa informar ao CRM o que acontece na jornada.

**O essencial, em uma frase:** guardem o `idtrack` que chega na URL do cardápio e enviem-no ao CRM, **do servidor**, em cada evento.

## 1. O link que vocês recebem

`https://<endereço-da-loja>/?idtrack=<token>`. O token é opaco, não o interpretem. Vale 30 dias.

## 2. Regras principais

- Envio **só de servidor para servidor**, com chave de API (`Authorization: Bearer wacrm_live_…`, escopo `events:write`). Nunca coloquem a chave no navegador.
- **Gravem o `idtrack` junto do pedido** no momento do `Purchase`. Os status chegam horas depois, quando o `sessionStorage` já não existe.
- Se o cliente abrir o cardápio sem `idtrack`, **não enviem eventos**.
- Todo evento tem um `event_id` único (por exemplo um UUID). Reenviar o mesmo `event_id` é seguro.

## 3. Endpoint

`POST /api/v1/journey/events`, um evento por chamada. Campos comuns: `event_id`, `name`, `idtrack`, `occurred_at` (ISO 8601, UTC).

| Evento | Quando | Dados extras |
| --- | --- | --- |
| `ViewContent` | Abriu o cardápio | nenhum |
| `AddToCart` | Alterou o carrinho (pode repetir) | carrinho **inteiro**: valor, moeda, itens |
| `InitiateCheckout` | Iniciou o fechamento | carrinho inteiro |
| `Purchase` | Pedido feito | `order_id` (seu identificador), valor, moeda, itens |
| `OrderStatusChanged` | Pedido mudou de estado | `order_id`, `status` |

## 4. Mapa dos estados de vocês

| Estado do cardápio | Enviar como |
| --- | --- |
| `PLACED` | o evento `Purchase` (não é status) |
| `APPROVED` | `received` |
| `TODO` | **não enviar** |
| `DOING` | `preparing` |
| `DONE` | `finished` |
| `DISPACHED` | `out_for_delivery` |
| `READYTOPICKUP` | `ready_for_pickup` |
| `DELIVERED` | `delivered` |
| `CANCELED` | `cancelled` |

## 5. Comportamento

- A jornada e o status **só avançam**. Evento atrasado ou fora de ordem é aceito e não estraga o estado.
- Depois do `Purchase`, o mesmo `idtrack` continua válido: um novo pedido abre uma nova jornada.
- Limite: 120 requisições por minuto por chave.

## 6. Respostas de erro

| HTTP | Código | O que fazer |
| --- | --- | --- |
| 400 | `bad_request` | Corrigir o envio. Não repetir igual |
| 400 | `order_not_found` | Reenviar com espera crescente: o `Purchase` provavelmente ainda está na fila de vocês |
| 401 / 403 | `unauthorized` / `forbidden` | Verificar a chave e o escopo |
| 404 | `idtrack_not_found` | Corrigir o link. Não repetir |
| 410 | `idtrack_expired` | Não repetir; o cliente precisa de um novo link |
| 429 / 5xx | `rate_limited` / `internal` | Reenviar com o **mesmo** `event_id`, com espera crescente |

## 7. Fila de saída (combinado)

`Purchase` e `OrderStatusChanged` precisam de uma fila com reenvio: gravar o evento pendente na mesma transação do pedido e ter um processo que reenvia até receber `200`. Sem ela, um `Purchase` perdido faz o CRM mandar lembrete de carrinho a quem já comprou. Para os demais eventos, até 3 tentativas imediatas, sem bloquear o cliente.

## 8. Critérios de aceite

Verificaremos juntos, em ambiente de teste: os cinco eventos chegando com `200`, o carrinho inteiro nos `AddToCart`, o reenvio idempotente, `idtrack` inválido (404) e vencido (410) sem laço de reenvio, um segundo pedido na mesma sessão atribuído, o `idtrack` gravado no pedido e a chave fora do navegador.

## Confirmem, por favor

- O prazo da fila de saída e do `idtrack` no pedido é viável?
- `TODO` pode mesmo ficar sem aviso ao cliente?

## Notas para quem envia (remover antes de enviar)

- Acrescente a URL base do CRM e a chave de teste; o resumo usa só `/api/v1/…`.
- Se a versão anterior do PRD já foi enviada, avise que esta a substitui: mudaram o status `delivered`, o erro `order_not_found` e a regra de reenviar nele.
