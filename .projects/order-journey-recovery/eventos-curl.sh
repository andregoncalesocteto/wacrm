#!/usr/bin/env bash
# Chamadas curl da API de eventos da jornada de pedido (POST /api/v1/journey/events).
#
# Para TESTE manual: copie e cole os comandos um a um, na ordem. Não execute o
# arquivo inteiro de uma vez: os eventos alteram jornada, pedido e mensagens
# reais (o cliente recebe as notificações configuradas).
#
# Contrato completo: prd-menu-events-contract.md e docs/public-api.md.
#
# Antes de começar, defina as variáveis abaixo.

# URL base do CRM, sem barra no final.
BASE_URL="https://seu-crm.exemplo.com"
# Chave criada em Configurações → Chaves de API, só com o escopo events:write.
API_KEY="wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# Valor de ?idtrack= do link do cardápio que o CRM enviou ao cliente.
IDTRACK="cole-aqui-o-idtrack-do-link"
# Identificador do pedido no SEU sistema (estável para sempre).
ORDER_ID="PED-2026-104233"

URL="$BASE_URL/api/v1/journey/events"

# Cada chamada gera um event_id novo e a hora atual em UTC.
# Para reenviar o MESMO evento (teste de idempotência), fixe o valor antes:
#   EVENT_ID="$(uuidgen)"   e troque "$(uuidgen)" por "$EVENT_ID" na chamada.
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }


# ---------------------------------------------------------------------------
# 0. Verificar a chave (não exige escopo). Deve listar o escopo events:write.
# ---------------------------------------------------------------------------
curl -sS "$BASE_URL/api/v1/me" -H "Authorization: Bearer $API_KEY"


# ---------------------------------------------------------------------------
# 1. ViewContent: o cliente abriu o cardápio (sem "properties").
#    Resposta: 200 { data: { event_id, journey_id, stage: "browsing", duplicate: false } }
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)"
}
EOF


# ---------------------------------------------------------------------------
# 2. AddToCart: o cliente alterou o carrinho. Envie o carrinho INTEIRO.
#    Pode repetir, cada vez com um event_id novo.
#    Resposta: 200 { ..., stage: "cart" }
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "AddToCart",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": {
    "currency": "BRL",
    "cart": {
      "value": 59.9,
      "items": [
        { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 }
      ]
    }
  }
}
EOF

# 2b. AddToCart de novo, agora com dois itens (carrinho inteiro: R$ 89,80).
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "AddToCart",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
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
EOF


# ---------------------------------------------------------------------------
# 3. InitiateCheckout: o cliente iniciou o fechamento (mesmo formato do AddToCart).
#    Resposta: 200 { ..., stage: "checkout" }
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "InitiateCheckout",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
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
EOF


# ---------------------------------------------------------------------------
# 4. Purchase: o pedido foi feito. Fecha a Journey como ganha, cria o pedido e
#    dispara o agradecimento (se a automação estiver ligada).
#    Guarde o idtrack junto do pedido: os status chegam horas depois.
#    Resposta: 200 { ..., stage: "won", duplicate: false }
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "Purchase",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": {
    "order_id": "$ORDER_ID",
    "currency": "BRL",
    "value": 89.8,
    "items": [
      { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 },
      { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 }
    ]
  }
}
EOF


# ---------------------------------------------------------------------------
# 5. OrderStatusChanged: o pedido mudou de estado. Um comando por status.
#    Ordem: received → preparing → finished → (out_for_delivery OU ready_for_pickup)
#    → delivered. "cancelled" vale a qualquer momento antes de delivered.
#    O status só avança; um status atrasado é aceito (200) e ignorado.
#
#    Mapa dos estados do cardápio:
#      APPROVED → received      DOING → preparing        DONE → finished
#      DISPACHED → out_for_delivery    READYTOPICKUP → ready_for_pickup
#      DELIVERED → delivered    CANCELED → cancelled     TODO → NÃO enviar
# ---------------------------------------------------------------------------

# 5.1 received (APPROVED)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "received" }
}
EOF

# 5.2 preparing (DOING)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "preparing" }
}
EOF

# 5.3 finished (DONE)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "finished" }
}
EOF

# 5.4a out_for_delivery (DISPACHED, pedido para entrega)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "out_for_delivery" }
}
EOF

# 5.4b ready_for_pickup (READYTOPICKUP, pedido para retirada; use no lugar de 5.4a)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "ready_for_pickup" }
}
EOF

# 5.5 delivered (DELIVERED; na retirada, quando o cliente retira)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "delivered" }
}
EOF

# 5.6 cancelled (CANCELED; a qualquer momento antes de delivered)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "cancelled" }
}
EOF


# ===========================================================================
# CASOS DE TESTE: idempotência e erros
# ===========================================================================

# ---------------------------------------------------------------------------
# 6. Idempotência: enviar DUAS VEZES o mesmo event_id. A segunda resposta traz
#    "duplicate": true e o cabeçalho Idempotent-Replayed: true (-i mostra os
#    cabeçalhos). Nenhum efeito se repete (nem mensagem ao cliente).
# ---------------------------------------------------------------------------
EVENT_ID="$(uuidgen)"
for i in 1 2; do
  curl -sS -i -X POST "$URL" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
    --data @- <<EOF
{
  "event_id": "$EVENT_ID",
  "name": "ViewContent",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)"
}
EOF
  echo
done


# ---------------------------------------------------------------------------
# 7. 404 idtrack_not_found: idtrack que o CRM não conhece. Não repita.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "idtrack": "token-que-nao-existe",
  "occurred_at": "$(now)"
}
EOF


# ---------------------------------------------------------------------------
# 8. 400 bad_request: status fora do conjunto (a mensagem lista os válidos).
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "TODO" }
}
EOF


# ---------------------------------------------------------------------------
# 9. 400 order_not_found: status de um pedido que o CRM não conhece para esse
#    idtrack (por exemplo, o Purchase ainda não chegou). Reenvie com espera
#    crescente depois que o Purchase for aceito.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)",
  "properties": { "order_id": "PEDIDO-INEXISTENTE", "status": "received" }
}
EOF


# ---------------------------------------------------------------------------
# 10. 401 unauthorized: chave inválida. (403 forbidden: chave sem events:write.)
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer wacrm_live_chave_invalida" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "idtrack": "$IDTRACK",
  "occurred_at": "$(now)"
}
EOF

# Outros erros documentados:
#   410 idtrack_expired  → idtrack com mais de 30 dias sem novo link (não repita;
#                          o cliente precisa de um novo link).
#   429 rate_limited     → 120 requisições/min por chave; respeite o Retry-After
#                          e reenvie com o MESMO event_id.
#   5xx internal         → reenvie com o MESMO event_id, com espera crescente.
