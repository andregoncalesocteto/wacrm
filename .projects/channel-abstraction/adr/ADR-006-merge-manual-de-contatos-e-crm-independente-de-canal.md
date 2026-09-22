# ADR-006 — Merge manual de contatos e CRM independente de canal

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas, "Continuidade do CRM") · Design Doc, seções 4 e 8

## 1. Contexto

- O produto é um CRM: pipelines, negócios, etiquetas, campos personalizados, notas, automações, flows, IA e painel
  precisam funcionar **igual em qualquer canal**.
- As tabelas do CRM **não têm coluna de telefone nem de canal**; o que depende do telefone é a camada em volta
  (16 arquivos de interface, busca, duplicidade, importação por CSV, condição do campo `phone`, variável `{{phone}}`).
- Com identidades por canal, **o mesmo cliente falando por WhatsApp e por Telegram aparece como dois contatos**, e o
  negócio, as notas e as etiquetas ficam divididos entre eles.
- Já existem funções SQL de merge (`merge_duplicate_contacts`, `merge_duplicate_conversations`) que reapontam as
  tabelas para um contato sobrevivente.
- A detecção automática de duplicados foi considerada fora do escopo.

## 2. Decisão

Vamos tratar a camada de CRM como dependente de **contato e conversa, nunca de canal**, e incluir um **merge manual
de contatos** feito pelo atendente, reaproveitando a lógica de reapontamento existente, sem detecção automática.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Merge manual, reaproveitando o reapontamento existente** | Resolve o CRM dividido com custo baixo; o atendente decide | Depende de alguém perceber a duplicidade | **Escolhida** |
| B | Sem merge | Menos escopo | O mesmo cliente divide o CRM em dois registros, contra a intenção de o contato ser da rede | Rejeitada |
| C | Detecção e fusão automáticas por identidades | Sem trabalho manual | Risco de juntar pessoas diferentes; mais complexo | Rejeitada nesta versão |

## 4. Consequências

**Positivas**
- Um cliente pode ter um CRM só (negócios, notas, etiquetas, conversas) mesmo usando canais diferentes.
- A métrica 5 (o CRM funciona igual para um contato do Telegram) passa a ser verificável.

**Negativas / trade-offs**
- O merge é uma ação manual e, uma vez feito, difícil de desfazer.
- O custo é incerto: o número de tabelas a reapontar cresceu desde as migrations 022 e 036
  `[SUPOSIÇÃO NÃO VALIDADA]`.

**Obrigações**
- O nome de exibição do contato vem do nome ou da identidade principal do canal, generalizando o `contactHandle`.
- Escrever um teste que **liste as tabelas com `contact_id` e falhe se alguma não for reapontada** no merge.
- Definir o comportamento para contato sem telefone: a condição sobre `phone` é "não definido" e `{{phone}}` sai vazio.
