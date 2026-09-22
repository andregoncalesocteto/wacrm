# ADR-005 — API pública `/api/v1` mudada no lugar, pré-estável até o primeiro cliente

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas) · Design Doc, seção 5

## 1. Contexto

- A API atual fala de telefone e de WhatsApp: `POST /api/v1/messages` recebe `to` (E.164) e devolve
  `whatsapp_message_id`, e a criação de contato exige `phone`. O MCP e os webhooks de saída seguem o mesmo formato.
- O novo modelo tem lojas, conexões e canais sem telefone.
- **Não há cliente hoje**, e o produto é independente (não acompanha o upstream do template).
- Manter compatibilidade exigiria uma "conexão padrão" e um `v2` que ninguém usa.

## 2. Decisão

Vamos **mudar `/api/v1` no lugar**, tratando-a como **pré-estável até o primeiro cliente**, e congelar o contrato a
partir dele, exigindo `v2` para qualquer mudança quebradora.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Mudar `/api/v1` no lugar, pré-estável, com congelamento no primeiro cliente** | Sem custo de duas versões; sem quem quebrar | Exige disciplina para congelar na hora certa | **Escolhida** |
| B | Criar `/api/v2` agora | Mantém a `v1` intacta | Mantém uma API antiga sem nenhum usuário | Rejeitada |
| C | Contrato aditivo com "conexão padrão" para manter `to` | Compatível com o que existe | Cria um conceito que só serviria a clientes inexistentes | Rejeitada |

## 4. Consequências

**Positivas**
- O contrato nasce desenhado para o novo modelo (envio por `conversation_id` ou `{connection_id, to}`,
  `external_message_id`, identidades no contato, leitura de lojas e conexões).
- Sem código morto para compatibilidade.

**Negativas / trade-offs**
- Qualquer integração escrita contra o contrato atual quebra. Hoje isso não afeta ninguém.

**Obrigações**
- Marcar a documentação de `docs/public-api.md` como **pré-estável**.
- Registrar a regra: no primeiro cliente integrado, o contrato congela, e mudança quebradora exige `v2`.
- O MCP espelha a API e sobe de versão.
