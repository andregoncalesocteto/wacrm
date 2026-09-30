#!/usr/bin/env bash
# Chamadas curl da API de eventos DIRETOS do cardápio (POST /api/v1/journey/events sem idtrack:
# o cliente é identificado por store_key + customer.phone, com consentimento por finalidade).
#
# Para TESTE manual: copie e cole os comandos um a um. Não execute o arquivo inteiro de uma vez:
# os eventos criam contato, jornada e pedido reais e o cliente recebe as mensagens configuradas
# (se houver consentimento). Use um telefone SEU em PHONE.
#
# Contrato: prd-menu-events-addendum.md (esta pasta), ../order-journey-recovery/prd-menu-events-contract.md
# e docs/public-api.md. Manual de configuração: manual-configuracao.md.
#
# Antes de começar, defina as variáveis abaixo.

# URL base do CRM, sem barra no final.
BASE_URL="https://seu-crm.exemplo.com"
# Chave criada em Configurações → Chaves de API, só com o escopo events:write.
API_KEY="wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# Chave da loja, como cadastrada em Configurações → Lojas: CÓDIGO/SIGLA DA LOJA/SIGLA DO NEGÓCIO.
STORE_KEY="89/RPA/BLC"
# SEU telefone, formato internacional com "+", DDI e DDD (E.164).
PHONE="+5511999998888"
# Identificador do pedido no SEU sistema (estável para sempre).
ORDER_ID="PED-DIRETO-0001"
# Só para o caso de conflito (seção D): idtrack de um link enviado a OUTRO contato.
IDTRACK="cole-aqui-o-idtrack-de-outro-contato"

URL="$BASE_URL/api/v1/journey/events"

# Cada chamada gera um event_id novo e a hora atual em UTC.
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# 0. Verificar a chave (não exige escopo). Deve listar o escopo events:write.
# ---------------------------------------------------------------------------
curl -sS "$BASE_URL/api/v1/me" -H "Authorization: Bearer $API_KEY"

# ---------------------------------------------------------------------------
# Lojas e chaves (escopo connections:read; a chave acima precisa dele para isto):
#   curl -sS "$BASE_URL/api/v1/stores" -H "Authorization: Bearer $API_KEY"
# ---------------------------------------------------------------------------


# ===========================================================================
# A. EVENTOS DIRETOS (SEM IDTRACK) COM CONSENTIMENTO
# ===========================================================================


# ---------------------------------------------------------------------------
# 1. ViewContent direto
#    O cliente abriu o cardápio sem link do CRM. Resposta: stage "browsing".
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": true, "marketing": false, "given_at": "$(now)" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 2. AddToCart direto (1 item)
#    Carrinho INTEIRO. Resposta: stage "cart". Sem consentimento marketing, o lembrete de carrinho
#    abandonado NÃO sai; para testá-lo, envie antes o consentimento de marketing (consentimento de marketing, seção C).
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "AddToCart",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "currency": "BRL", "cart": { "value": 59.9, "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 } ] } }
}
EOF

# ---------------------------------------------------------------------------
# 3. AddToCart direto (2 itens)
#    Carrinho inteiro de novo (R$ 89,80). Resposta: stage "cart".
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "AddToCart",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "currency": "BRL", "cart": { "value": 89.8, "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 }, { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 } ] } }
}
EOF

# ---------------------------------------------------------------------------
# 4. InitiateCheckout direto
#    Resposta: stage "checkout".
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "InitiateCheckout",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "currency": "BRL", "cart": { "value": 89.8, "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 }, { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 } ] } }
}
EOF

# ---------------------------------------------------------------------------
# 5. Purchase direto com consentimento
#    Purchase sem idtrack: store_key + customer.phone. O CRM cria o contato (se o telefone é novo),
#    abre uma jornada direta, cria o pedido e, com notifications=true, dispara o agradecimento por
#    template numa conversa criada FECHADA.
#    Resposta: 200 { data: { event_id, journey_id, stage: "won", duplicate: false, messaging: "eligible" } }
#    (messaging = no_connection se a loja não tem conexão de WhatsApp).
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "Purchase",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": true, "marketing": false, "given_at": "$(now)" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "currency": "BRL", "value": 89.8, "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 }, { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 } ] }
}
EOF

# ===========================================================================
# B. STATUS DO PEDIDO POR TELEFONE
# ===========================================================================


# ---------------------------------------------------------------------------
# 6. received (APPROVED)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "received" }
}
EOF

# ---------------------------------------------------------------------------
# 7. preparing (DOING)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "preparing" }
}
EOF

# ---------------------------------------------------------------------------
# 8. finished (DONE)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "finished" }
}
EOF

# ---------------------------------------------------------------------------
# 9. out_for_delivery (DISPACHED)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "out_for_delivery" }
}
EOF

# ---------------------------------------------------------------------------
# 10. ready_for_pickup (READYTOPICKUP)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "ready_for_pickup" }
}
EOF

# ---------------------------------------------------------------------------
# 11. delivered (DELIVERED)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "delivered" }
}
EOF

# ---------------------------------------------------------------------------
# 12. cancelled (CANCELED)
#    OrderStatusChanged por store_key + phone. NUNCA cria contato: telefone ou pedido desconhecido
#    = 400 order_not_found (envie o Purchase antes). Ordem: received → preparing → finished →
#    (out_for_delivery OU ready_for_pickup) → delivered; cancelled antes de delivered.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "OrderStatusChanged",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID", "status": "cancelled" }
}
EOF

# ===========================================================================
# C. CONSENTIMENTO: MARKETING, REVOGAÇÃO E AUSÊNCIA
# ===========================================================================


# ---------------------------------------------------------------------------
# 13. Consentimento de marketing (ofertas e lembretes)
#    Ativa o consentimento de marketing (permite o lembrete de carrinho abandonado). given_at precisa ser
#    MAIS NOVO que o valor guardado; igual ou mais antigo não muda nada.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "marketing": true, "given_at": "$(now)" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 14. Revogação: consent.notifications false
#    Revoga SÓ os avisos do pedido (o marketing segue como está). Depois disso, messaging = no_consent
#    e nenhum aviso sai, inclusive para quem já escreveu ao CRM. Um true com given_at mais novo reativa.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": false, "given_at": "$(now)" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 15. Evento sem consentimento (omitir NÃO revoga)
#    Sem o campo consent: o evento é registrado (pedido, funil, última compra), nada é enviado e, para
#    quem nunca escreveu ao CRM e não tem consentimento guardado, messaging = no_consent. Para ver isso
#    com um contato novo, troque PHONE por um telefone que o CRM não conhece.
# ---------------------------------------------------------------------------
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "Purchase",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)",
  "properties": { "order_id": "$ORDER_ID-SEM-CONSENT", "currency": "BRL", "value": 89.8, "items": [ { "id": "pizza-calabresa-g", "name": "Pizza Calabresa G", "quantity": 1, "unit_price": 59.9 }, { "id": "refri-2l", "name": "Refrigerante 2L", "quantity": 1, "unit_price": 29.9 } ] }
}
EOF

# ===========================================================================
# D. ERROS E CASOS ESPECIAIS
# ===========================================================================


# ---------------------------------------------------------------------------
# 16. 404 store_not_found (chave desconhecida)
#    A chave não existe no CRM. NÃO repita: corrija a configuração.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "00/XXX/YYY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 17. 400 bad_request (telefone fora do formato internacional)
#    Telefone sem "+" (precisa ser E.164: +5511999998888).
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "11999998888", "name": "Cliente Teste" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 18. 400 bad_request (sem idtrack e sem store_key + phone)
#    Falta identificação: o evento precisa de idtrack OU store_key + customer.phone.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 19. 400 bad_request (consent.given_at no futuro)
#    given_at mais de 5 minutos à frente do relógio do CRM é recusado (um relógio errado travaria as
#    atualizações seguintes do consentimento). Nada do evento é gravado.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": true, "given_at": "2099-01-01T00:00:00Z" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 20. Conflito idtrack x telefone (o idtrack manda)
#    Use um IDTRACK de um link enviado a OUTRO contato (não o dono de PHONE). O evento é atribuído ao
#    contato do idtrack; customer e consent são IGNORADOS e nenhum consentimento é atualizado (o CRM
#    registra o conflito no log, com o telefone mascarado). Resposta: 200 com a jornada do idtrack.
# ---------------------------------------------------------------------------
curl -sS -i -X POST "$URL" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "event_id": "$(uuidgen)",
  "name": "ViewContent",
  "idtrack": "$IDTRACK",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": true, "marketing": true, "given_at": "$(now)" },
  "occurred_at": "$(now)"
}
EOF

# ---------------------------------------------------------------------------
# 21. Idempotência: enviar 2x (mesmo event_id)
#    Envie DUAS vezes. A segunda resposta traz duplicate: true e o cabeçalho Idempotent-Replayed: true,
#    sem repetir efeitos (nem consentimento, nem mensagem).
# ---------------------------------------------------------------------------
EVENT_ID="$(uuidgen)"
for i in 1 2; do
  curl -sS -i -X POST "$URL" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
    --data @- <<EOF
{
  "event_id": "$EVENT_ID",
  "name": "ViewContent",
  "store_key": "$STORE_KEY",
  "customer": { "phone": "$PHONE", "name": "Cliente Teste" },
  "consent": { "notifications": true, "marketing": false, "given_at": "$(now)" },
  "occurred_at": "$(now)"
}
EOF
  echo
done

# Outros erros documentados:
#   401 unauthorized     → chave inválida; 403 forbidden → chave sem events:write.
#   410 idtrack_expired  → só com idtrack; não se aplica a eventos por telefone.
#   429 rate_limited     → 120 requisições/min por chave; respeite o Retry-After e reenvie com o
#                          MESMO event_id.
#   5xx internal         → reenvie com o MESMO event_id, com espera crescente.
