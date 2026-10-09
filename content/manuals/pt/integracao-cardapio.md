# Integração do cardápio digital com o wacrm

Para o time que mantém um **cardápio digital próprio** e quer que o wacrm (o CRM) acompanhe os pedidos dos clientes: recuperar quem desistiu do carrinho, agradecer a compra e avisar cada mudança de status do pedido.

O contrato técnico da API, em formato OpenAPI (Swagger), está em [`openapi.yaml`](./openapi.yaml) e pode ser lido e testado na página **Referência da API** deste mesmo endereço (`/developers`). O arquivo também pode ser importado por URL no Insomnia, no Postman ou em <https://editor.swagger.io>.

> **Estabilidade:** a API de eventos é **pré-estável até o primeiro cliente integrar**; depois fica congelada (uma quebra exigiria `v2`). Mudanças incompatíveis antes disso são avisadas nas notas de versão.

---

## 1. Como funciona

```
Cliente ──(conversa)──► CRM ──(envia o link com ?idtrack=…)──► Cliente
                                                                  │
Cliente abre o cardápio, monta o carrinho e faz o pedido ◄────────┘
        │
        ▼
Backend do cardápio ──(eventos, servidor a servidor)──► CRM
                                                         │
CRM move o negócio no funil e envia mensagens ao cliente ┘
```

O cardápio **informa** o que acontece; quem **envia as mensagens** é o CRM, por automações que o operador do CRM configura. Os eventos sozinhos não mandam mensagem nenhuma.

### Os dois modos de identificar o cliente

| Modo                | Quando usar                                                                                        | Como o evento identifica o cliente           |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Com link do CRM** | O cliente recebeu o link do cardápio numa conversa do CRM (`https://<cardápio>/?idtrack=<token>`). | `idtrack`                                    |
| **Direto**          | O cliente chegou por outro caminho (Instagram, link antigo, endereço digitado).                    | `store_key` + `customer.phone` (+ `consent`) |

Um evento precisa trazer **`idtrack`**, **ou** **`store_key` junto com `customer.phone`**. Sem nenhum dos dois, a resposta é `400`. Se vierem os dois, o `idtrack` manda.

Vale implementar os dois: o primeiro cobre o fluxo conversa → link → pedido; o segundo, todos os demais pedidos.

### Os cinco eventos

| `name`               | Quando enviar                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| `ViewContent`        | O cliente abriu o cardápio ou um produto (primeiro acesso da sessão).    |
| `AddToCart`          | O cliente mudou o carrinho. Pode repetir. Sempre o **carrinho inteiro**. |
| `InitiateCheckout`   | O cliente iniciou o fechamento do pedido. Carrinho inteiro.              |
| `Purchase`           | O pedido foi feito. Encerra a jornada como ganha e cria o pedido no CRM. |
| `OrderStatusChanged` | O pedido mudou de estado depois de feito.                                |

A jornada do cliente só avança: Link enviado → Navegando → Carrinho → Checkout → Comprou.

---

## 2. Antes de começar: o que pedir ao operador do CRM

A configuração do CRM (lojas, mensagens, chave de API, agendador) é feita por quem administra o CRM. Peça a essa pessoa, por um canal seguro:

| Item                                                          | Para que serve                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **URL base do CRM**                                           | O endereço deste CRM: `{URL_BASE}`. Os exemplos abaixo usam esse valor.                                                                 |
| **Chave de API** (`wacrm_live_…`) com o escopo `events:write` | Autentica os eventos. Segredo de servidor: nunca no navegador nem no repositório.                                                       |
| **A `store_key` de cada loja**                                | Só para eventos diretos (sem link do CRM). Formato `CÓDIGO/SIGLA DA LOJA/SIGLA DO NEGÓCIO`, por exemplo `89/RPA/BLC`.                   |
| **Um `idtrack` de teste**                                     | O operador envia o link do cardápio a um número de teste e lhe entrega o token que vem depois de `?idtrack=` (só para o modo com link). |

---

## 3. Regras de ouro

1. **Servidor para servidor.** Os eventos saem do **backend** do cardápio. A chave de API nunca vai ao navegador, ao app nem ao repositório: quem a tiver consegue forjar um `Purchase`.
2. **Guarde o identificador junto do pedido.** No navegador, o `idtrack` pode viver em `sessionStorage`, mas os `OrderStatusChanged` chegam horas depois, quando a sessão não existe mais. No momento do `Purchase`, **grave no pedido** o `idtrack` (ou o telefone e a `store_key`) e use esse valor em todos os status.
3. **Todo evento tem um `event_id` único** (UUID, até 200 caracteres). Reenviar o mesmo `event_id` é seguro: o CRM devolve a resposta original e não repete nenhum efeito.
4. **Não envie o que o contrato não pede.** Sem endereço, documento nem forma de pagamento.
5. **Cliente sem identificação não gera evento.** Se o cliente abriu o cardápio sem `idtrack` e você não tem o telefone dele, não envie nada (o evento não seria atribuível).

## 4. O que o cardápio precisa fazer

- **Ler o `idtrack`** da URL (`?idtrack=…`) ao abrir o cardápio e mantê-lo durante a sessão. Ele é **opaco**: não interprete, não decodifique, não use como identificador do cliente. Vale 30 dias, renovado a cada novo link enviado pelo CRM.
- **Enviar os eventos** da seção 6 nos momentos certos.
- **Traduzir os estados internos do pedido** para os sete status do CRM (seção 7).
- **Ter uma fila de saída (outbox)** para `Purchase` e `OrderStatusChanged` (seção 9).
- **Coletar o consentimento** do cliente, se for usar eventos diretos (seção 8).
- **Normalizar o telefone** para E.164 com `+` antes de enviar (`+5511999998888`).

## 5. Chamada

```
POST {URL_BASE}/api/v1/journey/events
Authorization: Bearer wacrm_live_…
Content-Type: application/json
```

Um evento por chamada, sem lote. Campos comuns:

| Campo            | Obrigatório       | Descrição                                                                                              |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `event_id`       | sim               | Único por conta; reuse o mesmo valor em reenvios.                                                      |
| `name`           | sim               | `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase` ou `OrderStatusChanged`.                    |
| `occurred_at`    | sim               | Quando aconteceu **no cardápio**, não quando você envia. ISO 8601 com UTC explícito (`Z` ou `+00:00`). |
| `idtrack`        | veja a seção 3    | Valor recebido na URL. Opcional se `store_key` e `customer.phone` forem enviados.                      |
| `store_key`      | eventos diretos   | `CÓDIGO/SIGLA DA LOJA/SIGLA DO NEGÓCIO`, por exemplo `89/RPA/BLC`.                                     |
| `customer.phone` | eventos diretos   | E.164 com `+`. Outro formato é `400`.                                                                  |
| `customer.name`  | não               | Usado só se o contato ainda não existe; nunca sobrescreve um nome já cadastrado.                       |
| `consent`        | não               | Veja a seção 8.                                                                                        |
| `properties`     | conforme o evento | Todos exigem, menos `ViewContent`.                                                                     |

A resposta de sucesso é sempre `200`:

```json
{
  "data": {
    "event_id": "…",
    "journey_id": "…",
    "stage": "cart",
    "duplicate": false,
    "messaging": "eligible"
  }
}
```

- `stage`: etapa da jornada depois do evento (`link_sent`, `browsing`, `cart`, `checkout`, `won`).
- `duplicate`: `true` quando o `event_id` já tinha sido processado (a resposta traz também o cabeçalho `Idempotent-Replayed: true`).
- `messaging`: `eligible`, `no_consent` ou `no_connection`. Informativo: veja a seção 8.

Teste rápido da chave e da URL, sem enviar evento:

```bash
curl {URL_BASE}/api/v1/me -H "Authorization: Bearer wacrm_live_…"
# → { "data": { "account": {…}, "key": { "scopes": ["events:write"] } } }
```

## 6. Os eventos, um a um

Nos exemplos, `$URL` é `{URL_BASE}/api/v1/journey/events` e `$AUTH` é `Authorization: Bearer wacrm_live_…`.

### `ViewContent`

O cliente abriu o cardápio ou um produto. Envie no primeiro acesso da sessão; repetições são aceitas, mas nunca mudam a etapa. Sem `properties`.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "9b1f6c3e-7f64-4c7a-9a1e-1f2b3c4d5e6f",
  "name": "ViewContent",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:14:05Z"
}'
```

### `AddToCart` e `InitiateCheckout`

O cliente mudou o carrinho ou iniciou o fechamento. Os dois têm as mesmas `properties` e **sempre levam o carrinho inteiro naquele momento**, não só o item novo: assim a perda de uma chamada intermediária não corrompe o total. `AddToCart` pode repetir, cada vez com `event_id` novo.

- `currency`: 3 letras (ISO 4217), por exemplo `BRL`.
- `cart.value`: número ≥ 0.
- `cart.items`: de 1 a 200 itens, cada um com `id`, `quantity` (inteiro ≥ 1), `unit_price` (≥ 0) e `name` (opcional).

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "b6d2c1a4-5e0f-4b7d-8a3c-9e1f2d3c4b5a",
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
}'
```

### `Purchase`

O pedido foi feito. **Encerra a jornada** como ganha, cria o pedido no CRM e dispara o agradecimento.

- `order_id`: o identificador do pedido **no seu sistema** (até 200 caracteres), estável para sempre e único na conta. Todos os `OrderStatusChanged` referenciam este valor.
- `items` é obrigatório (mesmas regras do carrinho). `value` é gravado como enviado, sem conferência contra os itens.
- Um segundo `Purchase` com o mesmo `order_id` e outro `event_id` é tratado como duplicado: `200`, `duplicate: true`, nada é criado nem enviado de novo.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "c41e8d27-6a3b-4f9c-b1d0-7e2a5c8f9b34",
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
}'
```

Depois do `Purchase`, o mesmo `idtrack` continua valendo: um novo evento com ele abre uma **nova jornada**, para que o cliente recorrente que reaproveita a sessão continue sendo atribuído.

### `OrderStatusChanged`

O pedido mudou de estado depois de feito. Use o `idtrack` (ou o telefone e a `store_key`) **gravado no pedido**.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "d78a4b2c-1e3f-4a5b-9c6d-7e8f9a0b1c2d",
  "name": "OrderStatusChanged",
  "idtrack": "trk_8f3a…",
  "occurred_at": "2026-10-02T21:35:00Z",
  "properties": { "order_id": "PED-2026-104233", "status": "preparing" }
}'
```

Este evento **nunca cria contato nem jornada**: um pedido ou telefone desconhecido devolve `400 order_not_found` (veja a seção 10).

## 7. Status do pedido

`status` é um conjunto **fechado**; qualquer outro valor é `400`.

| `status`           | Significado                                         |
| ------------------ | --------------------------------------------------- |
| `received`         | Pedido recebido pela loja                           |
| `preparing`        | Em preparo                                          |
| `finished`         | Preparo finalizado                                  |
| `out_for_delivery` | Saiu para entrega                                   |
| `ready_for_pickup` | Pronto para retirada                                |
| `delivered`        | Entregue, ou retirado pelo cliente                  |
| `cancelled`        | Cancelado (a qualquer momento antes de `delivered`) |

O estado "pedido feito" é o próprio `Purchase`: não existe um status `placed`.

**Regras de avanço.** O status só avança, na ordem `received` → `preparing` → `finished` → `out_for_delivery` **ou** `ready_for_pickup` → `delivered`; etapas podem ser puladas. `out_for_delivery` e `ready_for_pickup` são do mesmo nível: vale o primeiro que chegar. `delivered` e `cancelled` são finais. Um status que não avança (mais antigo, igual ou posterior a um estado final) é aceito com `200`, mas **ignorado**: nada é gravado e nenhuma mensagem sai.

**Traduza os estados internos do cardápio no seu lado.** Estado interno sem mensagem ao cliente simplesmente **não é enviado**. Exemplo de mapa:

| Estado interno (exemplo) | Enviar ao CRM                    |
| ------------------------ | -------------------------------- |
| Pedido registrado        | Nada como status: é o `Purchase` |
| Pedido aprovado          | `received`                       |
| Pronto para produzir     | **Não enviar**                   |
| Em produção              | `preparing`                      |
| Produção finalizada      | `finished`                       |
| Despachado (delivery)    | `out_for_delivery`               |
| Pronto para retirada     | `ready_for_pickup`               |
| Entregue / retirado      | `delivered`                      |
| Cancelado                | `cancelled`                      |

Se algum estado seu precisa avisar o cliente e não cabe nos sete, fale com o time do CRM: o conjunto pode ganhar um status novo.

## 8. Eventos diretos e consentimento

Para o cliente que chegou **sem link do CRM**, identifique-o por `store_key` e `customer.phone`:

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "f2d1a6b8-3c5e-4d7f-8a9b-0c1d2e3f4a5b",
  "name": "Purchase",
  "store_key": "89/RPA/BLC",
  "customer": { "phone": "+5511999998888", "name": "Maria Souza" },
  "consent": { "notifications": true, "marketing": false, "given_at": "2026-10-02T21:10:00Z" },
  "occurred_at": "2026-10-02T21:22:11Z",
  "properties": {
    "order_id": "PED-2026-104233", "currency": "BRL", "value": 89.8,
    "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 } ]
  }
}'
```

O CRM cria o contato se o telefone for novo (origem "cardápio"), abre uma jornada direta, registra o pedido normalmente e **não envia nenhuma mensagem sem consentimento**. O evento é registrado mesmo sem consentimento (pedido, funil e data da última compra).

### O que o cardápio precisa construir: a coleta do consentimento

O cliente precisa poder aceitar, no pedido, receber mensagens no WhatsApp, **separando duas finalidades**:

| Finalidade          | Campo                   | Cobre                                         |
| ------------------- | ----------------------- | --------------------------------------------- |
| Avisos do pedido    | `consent.notifications` | Agradecimento e status do pedido.             |
| Ofertas e lembretes | `consent.marketing`     | Por exemplo, lembrete de carrinho abandonado. |

O **cardápio é responsável por coletar e provar o consentimento**; o CRM guarda o estado, a data e a origem no contato. Regras:

- **`consent.given_at` é obrigatório** quando qualquer finalidade é enviada, e é o momento real em que o cliente decidiu (ISO 8601 UTC). **Não pode estar mais de 5 minutos à frente do relógio do CRM** (`400`): como só vale um `given_at` mais novo que o guardado, um relógio adiantado travaria as atualizações seguintes. Mantenha o relógio dos servidores sincronizado (NTP).
- **Atualização:** uma finalidade só substitui o estado guardado se o `given_at` for **estritamente mais novo** que a última decisão. Igual ou mais antigo não muda nada (eventos atrasados ou repetidos são inofensivos).
- **Revogar:** um `false` explícito revoga **só aquela finalidade**. Um `true` mais novo a reativa.
- **Omitir não é revogar.** Deixar de enviar `consent` (ou uma das finalidades) não muda nada. Para revogar, envie `false`.
- **Consentimento implícito:** quem já escreveu à loja **pela conexão que envia** é tratado como consentindo às duas finalidades (quem escreveu ao número de outra marca não conta). Uma revogação explícita vale acima do implícito.
- **"PARAR":** se o cliente responder só "PARAR" (ou `stop` e outras palavras de descadastro) no WhatsApp, as duas finalidades são revogadas e ele recebe uma confirmação. Um `given_at` mais novo vindo do cardápio as reativa.
- **Conflito:** se `idtrack` e `customer.phone` resolverem para contatos diferentes, o evento é atribuído pelo `idtrack`, e `customer` e `consent` são ignorados.

Se o cliente mudar de ideia no cardápio, envie qualquer evento (por exemplo, `ViewContent`) só com a identificação e o novo `consent`.

### O campo `messaging` da resposta

| Valor           | Significado                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| `eligible`      | Há conexão de WhatsApp e consentimento para avisos (explícito ou implícito).   |
| `no_consent`    | O evento foi registrado, mas nenhuma mensagem será enviada.                    |
| `no_connection` | A loja não tem uma conexão de WhatsApp utilizável. Fale com o operador do CRM. |

É informativo: não bloqueie o pedido por causa dele. Ele só reporta os avisos do pedido (`notifications`).

## 9. Ordem, repetição e entrega confiável

- **Idempotência.** O `event_id` é único por conta, mesmo depois de o `idtrack` expirar. Duas chamadas simultâneas com o mesmo `event_id` são aplicadas uma vez; se a segunda desistir de esperar, recebe um `500` repetível: reenvie com o mesmo `event_id`. Eventos rejeitados (4xx) **não** são registrados, então corrigir o corpo e reenviar funciona.
- **A ordem de chegada não importa.** A jornada só avança. Um `AddToCart` depois de `InitiateCheckout` atualiza o carrinho, mas não faz a etapa recuar; um evento atrasado nunca sobrescreve um carrinho mais novo (comparado por `occurred_at`). Se um evento intermediário nunca chegar, o estado final continua correto.
- **Custo de perder cada evento:**

| Evento                          | Se for perdido                                                                                                                | Exigência                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Purchase`                      | O CRM acha que o cliente desistiu: pode enviar carrinho abandonado a quem já comprou, e o cliente não recebe o agradecimento. | **Obrigatório:** fila de saída (outbox) com reenvio.             |
| `OrderStatusChanged`            | O cliente não recebe o aviso daquele estado.                                                                                  | **Obrigatório:** fila de saída (outbox) com reenvio.             |
| `AddToCart`, `InitiateCheckout` | O funil fica um passo atrás; o lembrete de carrinho abandonado pode sair tarde ou não sair.                                   | Recomendado: até 3 tentativas imediatas, sem bloquear o cliente. |
| `ViewContent`                   | Perde-se a etapa "Navegando".                                                                                                 | Sem reenvio; perda aceitável.                                    |

- **Fila de saída mínima.** No momento em que o pedido é gravado (e a cada mudança de estado), grave também, **na mesma transação**, uma linha de evento pendente com o `event_id`, o corpo e o número de tentativas. Um processo separado envia as pendentes e marca como enviadas ao receber `200`.
- **Eventos de comportamento** (`ViewContent`, `AddToCart`, `InitiateCheckout`) saem de forma assíncrona: o cliente nunca espera pelo CRM.
- **Limite de taxa:** 120 requisições por minuto **por chave**. Um pedido típico gera de 4 a 8 chamadas. Em `429`, respeite o cabeçalho `Retry-After`.

## 10. Respostas de erro e o que fazer

Toda resposta usa o envelope `{ "data": … }` (sucesso) ou `{ "error": { "code", "message" } }` (falha). **Ramifique pelo `error.code`**, que é estável; a `message` é para leitura humana e pode mudar.

| HTTP | `error.code`        | Quando                                                                                                                                            | O que fazer                                                                                                    |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 200  | (sucesso)           | Evento aceito, inclusive repetição de `event_id` e status antigo ignorado                                                                         | Nada.                                                                                                          |
| 400  | `bad_request`       | Corpo malformado, campo ausente, `name` ou `status` desconhecido, telefone fora do E.164, falta de identificação, `given_at` ausente ou no futuro | Corrija o envio; a `message` nomeia o campo. **Não** repita igual.                                             |
| 400  | `order_not_found`   | `OrderStatusChanged` de um `order_id` que o CRM não conhece para esse cliente (por exemplo, o `Purchase` ainda está na sua fila)                  | **Reenvie** com espera crescente; é aceito depois que o `Purchase` chegar. Se persistir por horas, investigue. |
| 401  | `unauthorized`      | Chave ausente, malformada, desconhecida, revogada ou expirada                                                                                     | Verifique a chave.                                                                                             |
| 403  | `forbidden`         | A chave não tem o escopo `events:write`                                                                                                           | Peça ao operador do CRM.                                                                                       |
| 404  | `idtrack_not_found` | O `idtrack` não corresponde a nenhum link enviado pelo CRM                                                                                        | Corrija o dado. **Não** repita.                                                                                |
| 404  | `store_not_found`   | A `store_key` não existe no CRM                                                                                                                   | Corrija a configuração. **Não** repita.                                                                        |
| 410  | `idtrack_expired`   | O `idtrack` passou dos 30 dias                                                                                                                    | **Não** repita; o cliente precisa de um novo link do CRM.                                                      |
| 429  | `rate_limited`      | Limite por chave excedido                                                                                                                         | Reenvie após `Retry-After`, com o **mesmo** `event_id`.                                                        |
| 500  | `internal`          | Erro do CRM                                                                                                                                       | Reenvie com o **mesmo** `event_id` e espera crescente.                                                         |

**Política de reenvio.** Reenvie em `429`, `5xx`, falhas de rede/timeout e `order_not_found`, sempre com o **mesmo** `event_id` e espera crescente (30 s, 2 min, 10 min, 1 h, 6 h, até 24 h). **Não reenvie** os demais `400`, nem `401`, `403`, `404` e `410`: o mesmo corpo falha do mesmo jeito; registre o erro para investigação. Como o CRM executa os efeitos uma vez por `event_id`, reenviar é sempre seguro.

## 11. Testando

Peça ao operador do CRM a URL base, a chave e um `idtrack` de teste (seção 2), e use uma chave e um telefone de teste, nunca os de produção.

1. `GET /api/v1/me` confirma a chave e o escopo `events:write`.
2. Importe o `openapi.yaml` no Insomnia ou no Postman, ou use o `curl` dos exemplos acima, e rode os eventos **um a um**.
3. Confira o campo `stage` de cada resposta (`browsing`, `cart`, `checkout`, `won`) e peça ao operador do CRM para conferir, em **Pipelines → Jornada de Pedido**, a etapa e o carrinho do negócio e, no painel da conversa, o pedido e o status, e se a mensagem chegou ao canal do cliente.

## 12. Critérios de aceite

A integração está pronta quando, em ambiente de testes:

**Com link do CRM**

1. Abrir o link com `?idtrack=…` resulta em um `ViewContent` aceito (`200`).
2. Adicionar vários itens gera vários `AddToCart`, cada um com `event_id` novo e o **carrinho inteiro**, e o CRM mostra valor e contagem atualizados.
3. Iniciar o fechamento gera `InitiateCheckout`.
4. Finalizar o pedido gera `Purchase` com `order_id`, valor, moeda e itens; o cliente recebe o agradecimento no canal de origem; o `idtrack` fica **gravado no pedido**.
5. Cada mudança de estado gera `OrderStatusChanged` com um dos sete status, usando o `idtrack` gravado no pedido; o cliente recebe a mensagem correspondente. Estados sem mensagem não geram chamada.
6. Um segundo pedido na mesma sessão, depois do primeiro `Purchase`, com o mesmo `idtrack`, abre uma nova jornada e é atribuído.

**Eventos diretos** (se implementados)

7. Um `Purchase` com `store_key` e `customer.phone` (sem `idtrack`) cria o pedido e o contato e responde `200`.
8. Telefone fora do formato internacional devolve `400`; `store_key` desconhecida devolve `404 store_not_found` e o seu sistema **não** repete.
9. Com `consent.notifications: true`, o cliente recebe agradecimento e status; com `false` ou sem o campo, não recebe nada e `messaging` indica `no_consent`.
10. `consent.marketing: true` permite o lembrete de carrinho abandonado; sem ele, o lembrete não sai.
11. `consent.notifications: false` depois de um `true` revoga.

**Em qualquer modo**

12. Reenviar o mesmo evento (mesmo `event_id`) devolve `200` com `Idempotent-Replayed: true` e **não** gera mensagem duplicada.
13. `idtrack` inválido devolve `404 idtrack_not_found` e vencido devolve `410 idtrack_expired`, e o seu sistema não entra em laço de reenvio.
14. Uma falha temporária do CRM (`5xx` ou `429`) não perde nenhum `Purchase` nem `OrderStatusChanged`: a fila de saída reenvia com o mesmo `event_id` até o CRM aceitar.
15. A chave de API não aparece no código-fonte, nos logs nem em requisições do navegador.

---

## Problemas comuns

| Sintoma                                            | Causa provável                                                                       | O que fazer                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Eventos rejeitados com `401` ou `403`              | Chave errada, revogada ou sem `events:write`                                         | Peça ao operador do CRM uma chave com esse escopo                             |
| `404 idtrack_not_found`                            | O cardápio perdeu o `idtrack` ou o link não veio do CRM                              | Conferir o link e o que o cardápio guarda no pedido                           |
| `410 idtrack_expired`                              | O link tem mais de 30 dias sem renovação                                             | Enviar novo link ao cliente                                                   |
| `404 store_not_found`                              | A `store_key` não existe no CRM                                                      | Conferir os três campos em **Configurações → Lojas** e o que o cardápio envia |
| `400` citando `customer.phone`                     | Telefone sem `+` ou fora do E.164                                                    | Normalizar antes de enviar                                                    |
| `400` "consent.given_at is in the future"          | Relógio do cardápio adiantado mais de 5 minutos                                      | Sincronizar o relógio ou enviar o momento real do aceite                      |
| `400` "given_at is required"                       | `consent` com finalidade, mas sem data                                               | Sempre enviar `given_at` junto                                                |
| `messaging: no_consent`                            | Sem consentimento ativo para avisos e o cliente nunca escreveu                       | Conferir o bloco de consentimento do contato e o que o cardápio envia         |
| `messaging: no_connection`                         | Loja sem WhatsApp, ou com várias conexões e nenhuma escolhida                        | Peça ao operador do CRM para conferir o cadastro da loja                      |
| O evento entrou, mas nada foi enviado              | Automação desligada, passo ignorado por finalidade, sem template ou agendador parado | Ver o **log** da automação: a mensagem do passo diz o motivo                  |
| O consentimento "não atualiza"                     | O `given_at` enviado não é mais novo que o guardado                                  | Enviar a data real do último aceite ou revogação                              |
| Cliente que já comprou recebe lembrete de carrinho | O `Purchase` se perdeu no caminho                                                    | Fila de saída com reenvio (seção 9)                                           |

## Limitações conhecidas

- A precisão das retomadas depende do intervalo do agendador do CRM.
- `{{menu_link}}` não funciona em botões, listas, templates e Flows.
- O preset cria uma automação por etapa, não por canal; para textos diferentes por canal, duplique a automação.
- O conjunto de eventos (cinco) e de status (sete) é fechado, e não há envio em lote nem consulta do estado da jornada pelo cardápio.
- Não há mensagem para clientes inativos há 30 dias, nem campanhas de marketing por consentimento (fora desta versão).
- Não existe limite diário de primeiros contatos por conta; os freios são o limite por chave (120/min), o uso de template no primeiro contato e o consentimento.
- Templates de mesmo nome em duas WABAs reais: ainda não testado.
- Mensagens de erro da API e notas de transbordo da IA estão em inglês; ramifique sempre pelo `error.code`.
