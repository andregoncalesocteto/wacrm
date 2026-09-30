# Adendo v2 ao contrato de eventos: pedidos sem link do CRM

Adendo para o **time do cardápio digital**. Ele **acrescenta** campos opcionais ao contrato que você já conhece (`../order-journey-recovery/prd-menu-events-contract.md`). **Nada do que existe muda:** quem envia com `idtrack` continua funcionando igual.

## 1. O que muda e por quê

Hoje só conseguimos acompanhar o cliente que recebeu um link do CRM com `idtrack`. Como o cardápio sempre tem o telefone do cliente, podemos acompanhar **todos** os pedidos, também os que não vieram de um link do CRM, e avisar o cliente sobre o pedido, desde que ele tenha dado **consentimento**.

## 2. Novos campos (opcionais quando há `idtrack`)

Valem para **qualquer** evento (`ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`, `OrderStatusChanged`).

| Campo | Descrição |
| --- | --- |
| `store_key` | A chave da loja, em um campo: `CÓDIGO/SIGLA DA LOJA/SIGLA DO NEGÓCIO`, por exemplo `89/RPA/BLC`. Não diferenciamos maiúsculas de minúsculas e ignoramos espaços nas pontas. As lojas são cadastradas no CRM com esses três campos. |
| `customer.phone` | Telefone no formato internacional, com `+`, DDI e DDD (`+5511999998888`). Outro formato é recusado. |
| `customer.name` | Opcional. Só é usado quando o contato ainda não existe no CRM; nunca sobrescreve um nome já cadastrado. |
| `consent.notifications` | `true` se o cliente aceitou receber **avisos do pedido** (status, agradecimento) no WhatsApp. |
| `consent.marketing` | `true` se o cliente aceitou receber **ofertas e lembretes** (por exemplo, carrinho abandonado). |
| `consent.given_at` | Quando o cliente deu o consentimento (ISO 8601, UTC). |

**Regra de identificação:** cada evento precisa trazer **`idtrack`**, ou **`store_key` mais `customer.phone`**. Sem nenhum dos dois, o retorno é `400`. Se vierem os dois, o `idtrack` manda.

Exemplo de `Purchase` sem link do CRM:

```json
{
  "event_id": "f2d1…",
  "name": "Purchase",
  "store_key": "89/RPA/BLC",
  "customer": { "phone": "+5511999998888", "name": "Maria Souza" },
  "consent": { "notifications": true, "marketing": false, "given_at": "2026-10-02T21:10:00Z" },
  "occurred_at": "2026-10-02T21:22:11Z",
  "properties": {
    "order_id": "PED-2026-104233", "currency": "BRL", "value": 89.8,
    "items": [ { "id": "pizza-g", "name": "Pizza G", "quantity": 1, "unit_price": 59.9 } ]
  }
}
```

## 3. Consentimento: o que o cardápio precisa construir

Esta é uma funcionalidade **nova do lado do cardápio**: o cliente precisa poder aceitar, no pedido, receber mensagens no WhatsApp, separando (1) avisos do pedido e (2) ofertas e lembretes. O cardápio guarda quando o cliente aceitou e o envia em `consent`.

- Envie o estado atual dos dois valores. **Omitir `consent` não revoga nada**; só um `false` explícito revoga.
- Se o cliente revogar no cardápio, envie `false` para a finalidade correspondente.
- O CRM guarda a data, a origem ("cardápio") e a finalidade como prova. O cliente também pode parar de receber respondendo "PARAR" no WhatsApp.
- **Sem consentimento o CRM não envia nenhuma mensagem.** O evento continua sendo registrado (pedido, funil, data da última compra).

## 4. O que o CRM faz com o cliente

- Se o telefone não existe no CRM, o contato é criado.
- A conversa só é criada se houver consentimento, e nasce **fechada** (não aparece na fila do atendente). O primeiro contato é sempre um template aprovado. Se o cliente responder, a conversa reabre para um atendente.
- Quem já conversou com a loja continua como hoje, sem precisar de consentimento novo para os avisos do pedido.

## 5. Respostas

A resposta de sucesso ganha o campo `messaging`:

| `messaging` | Significado |
| --- | --- |
| `eligible` | Há consentimento e uma conexão de WhatsApp para enviar mensagens |
| `no_consent` | Sem consentimento: o evento foi registrado, nenhuma mensagem será enviada |
| `no_connection` | A loja não tem conexão de WhatsApp (nenhuma mensagem será enviada) |

Erros novos:

| HTTP | Código | O que fazer |
| --- | --- | --- |
| 404 | `store_not_found` | A chave da loja não existe no CRM. Corrija; **não** repita |
| 400 | `bad_request` | Faltou `idtrack` ou `store_key` mais `customer.phone`, ou o telefone não está em formato internacional |

As regras de idempotência, ordem, reenvio e fila de saída do contrato original **continuam valendo** (seções 6 a 8).

## 6. Segurança e privacidade

- A chave de API continua sendo segredo de servidor. Com telefone, uma chave vazada pode criar contatos e disparar mensagens a quem tem consentimento registrado, então guarde-a com mais cuidado ainda.
- Envie só os campos deste contrato; não envie endereço, documento nem forma de pagamento.
- O cardápio é responsável por coletar e provar o consentimento do cliente.

## 7. Critérios de aceite

1. Um `Purchase` com `store_key` e `customer.phone` (sem `idtrack`) cria o pedido e o contato, e responde `200`.
2. Telefone fora do formato internacional devolve `400`.
3. Uma `store_key` desconhecida devolve `404 store_not_found` e o seu sistema não repete.
4. Com `consent.notifications: true`, o cliente recebe o agradecimento e os avisos de status; com `false` ou sem o campo, não recebe nada e `messaging` indica `no_consent`.
5. `consent.marketing: true` permite o lembrete de carrinho abandonado; sem ele, o lembrete não sai.
6. Enviar `consent.notifications: false` depois de um `true` revoga o consentimento.
7. Um evento com `idtrack` e com `store_key`/`customer` de um telefone diferente é atribuído pelo `idtrack`.
8. A idempotência, o reenvio e a fila de saída continuam funcionando com os campos novos.

## 8. Respostas do time do cardápio

1. O cardápio consegue coletar o consentimento no pedido, separando avisos e ofertas, e guardar a data? **Sim.**
2. A chave `CÓDIGO/SIGLA/NEGÓCIO` está disponível em cada pedido, no momento de enviar o evento? **Sim.**
3. O telefone do cliente é sempre guardado em formato internacional, ou precisa ser normalizado antes do envio? **Será normalizado antes do envio** (formato E.164, com `+`, DDI e DDD, como o contrato exige).

**Sem pendências abertas neste adendo.**
