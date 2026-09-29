# Notas de implementação — Jornada de pedido

Memória entre tickets, na branch `feat/order-journey-recovery`. Cada ticket acrescenta uma seção.

## #1 Janela de 24 h no envio
- `sendOutbound` (`src/lib/channels/send.ts`) aceita `windowPolicy?: { fallbackTemplate? }`, ativa só para texto. A janela vem da capacidade `replyWindowHours` do provider (Telegram declara `null`). Sem inbound na conversa, a janela conta como fechada. Fora da janela: com template, envia template; sem template, `ChannelError('window_closed')` e grava mensagem `failed` na conversa.
- Só o texto de automação passa `windowPolicy` (via `engineSendText`). Inbox manual, broadcasts, IA e flows não mudam.
- O passo `send_message` aceita `fallback_template {name, language?, variables?}`; falta a UI do editor para configurá-lo. Retomadas e notificações devem preencher esse campo no WhatsApp.

## #2 Endereço do cardápio por loja
- Migration `055_store_menu_url.sql`: `stores.menu_url` (nula, CHECK `https://`). Validação em `src/lib/stores/validation.ts` (`isValidMenuUrl`). Campo na UI de lojas e em `GET /api/v1/stores`.
