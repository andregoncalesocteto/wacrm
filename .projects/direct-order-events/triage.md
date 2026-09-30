# Triagem — Eventos diretos do cardápio (sem link do CRM) com consentimento

Nova feature, filha da jornada de pedido (`../order-journey-recovery/`). A discussão, a entrevista e a spec já aconteceram com o fluxo mattpocock/skills; este arquivo só registra a decisão.

## Debate de features

**Features candidatas:** eventos identificados por chave da loja e telefone; criação de contato; origem da jornada; consentimento por finalidade; envio condicionado ao consentimento e primeiro contato por template; recuperação de carrinho para jornadas diretas; "PARAR"; condição por sigla do negócio; funil por origem.

**Incógnitas:** consentimento coletado no cardápio (feito pelo time do cardápio); uma marca ou várias por conta (resolvido: várias); formato da chave (resolvido: `CÓDIGO/SIGLA/NEGÓCIO`).

**Natureza:** brownfield, com convenções documentadas e uma feature-irmã em produção.

**Reversibilidade:** custo alto. O contrato de eventos passa a carregar telefone e consentimento, e a decisão flexibiliza a segurança da feature original (ADR local).

**Superfície de risco:** dados pessoais (LGPD), política de opt-in da Meta para mensagens iniciadas pela empresa, risco de spam por chave de API vazada.

## Scorecard

| Sinal | Voto |
| --- | --- |
| Ambiguidade | abstenção (resolvida na entrevista) |
| Tamanho | workflow_v1, mattpocock |
| Codebase | Spec Kit, mattpocock |
| Reversibilidade | workflow_v1 |
| Colaboração | workflow_v1 (dev solo com rastro escrito) |
| Compliance | workflow_v1 (consentimento e prova de opt-in) |
| Controle e execução | abstenção |

## Recomendação
**Fluxo do scorecard:** workflow_v1. **Placar:** BMAD 0 · Spec Kit 1 · workflow_v1 4 · mattpocock 2 (2 abstenções) — margem 2 sobre o segundo. **Força:** fraca.

## Decisão humana

**Fluxo adotado: mattpocock/skills**, em continuidade com a feature original, cuja entrevista (`/grill-with-docs`) e spec já foram feitas. Seguem `/to-tickets` → `/implement`, sem Ralph por cima. O sinal de compliance (consentimento) é tratado pelo ADR local e pelos critérios de aceite do adendo ao contrato.
