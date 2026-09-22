# ADR-003 — Recebimento com ack rápido, processamento em `after()` e ingestão idempotente

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas) · Design Doc, seção 3

## 1. Contexto

- O webhook do WhatsApp **responde rápido e processa dentro de `after()`**, com `maxDuration = 60`. O comentário do
  código explica: um ack lento faz a Meta reenviar e duplica registros.
- A idempotência hoje é a unicidade `(conversation_id, message_id)` com inserção que ignora duplicata.
- As duas conexões desta versão (WhatsApp oficial e Telegram) chegam por **webhook HTTP**, e ambos os provedores
  reenviam quando não recebem 2xx.
- Se o processamento falha depois do ack, o evento se perde, porque não há fila. Isso já é verdade hoje.
- Não há cliente e o volume é desconhecido.

## 2. Decisão

Vamos manter o modelo atual (**ack rápido, processamento em `after()`**) e concentrar o processamento em uma
**função de ingestão do núcleo, idempotente e independente de quem a chama**, deixando a persistência prévia do
evento bruto para quando houver volume que a justifique.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Ack rápido + `after()` + ingestão idempotente** | Nada novo para operar; preserva o comportamento atual | Um evento pode se perder se o processamento falhar depois do ack | **Escolhida** |
| B | Gravar o evento bruto numa tabela e reprocessar por rota | Reprocessável e auditável | Tabela e rota a mais sem volume que justifique | Adiada (a ingestão idempotente permite migrar depois) |
| C | Fila real (por exemplo pg-boss ou BullMQ) | Robustez | Infraestrutura nova sem demanda | Rejeitada |

## 4. Consequências

**Positivas**
- Sem infraestrutura nova, e o WhatsApp mantém o comportamento que já funciona.
- Passar para a alternativa B depois só muda **quem invoca** a ingestão.

**Negativas / trade-offs**
- O risco de perda entre o ack e o processamento continua. Ele é atenuado por registrar a falha em `last_error` da
  conexão e no log.
- Depende de um processo Node de longa vida ou de `maxDuration` suficiente; o WhatsApp não oficial (versão
  seguinte) exigirá um worker.

**Obrigações**
- A ingestão deve ser idempotente por `(conversa, id externo)` para todos os provedores, com teste de reenvio.
- Documentar o túnel público e as fixtures para testar o Telegram, já que o webhook exige URL pública.
