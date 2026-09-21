# ADR-001 — Modelo de dados: conta como rede, loja, conexão, conversa por (contato, conexão) e identidades por família de canal

- **Status:** Proposto (a decisão de fundo foi tomada no debate de 2026-09-21; os três ajustes do Design Doc, seção 8, ainda esperam confirmação)
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas) · Design Doc, seções 1, 4 e 6

## 1. Contexto

- O tenant é a `account`, e **cada usuário pertence a exatamente uma conta** (`profiles.account_id`). Todas as
  políticas de acesso são `is_account_member(account_id)`.
- Existe **uma conversa por contato** (índice único `(account_id, contact_id)`), e o **telefone é a chave do
  contato** (`phone` NOT NULL, índice único `(account_id, phone_normalized)`, mais um índice por `wa_user_id`).
- `whatsapp_config` é **único por conta** e por `phone_number_id`: uma conexão de um único canal por conta.
- O produto precisa atender **redes com várias lojas e uma central**, com canais diferentes convivendo e tudo no
  mesmo inbox. As lojas são da **mesma empresa**, e os contatos são da rede (decisão de produto).
- O WhatsApp oficial e o não oficial (versão seguinte) reconhecem a **mesma pessoa pelo mesmo telefone**.
- O CRM (`deals`, `pipelines`, `tags`, `custom_fields`, `contact_notes`) não tem coluna de telefone nem de canal.

## 2. Decisão

Vamos manter a **conta como a rede**, introduzir **loja** e **conexão** como entidades próprias (a conexão pertence a
uma loja, e uma loja tem uma ou mais conexões), definir a **conversa por `(contato, conexão)`** e resolver a
identidade do contato por uma tabela de identidades com chave por **família de canal**, como fonte única para todos
os canais.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Conta = rede; loja e conexão como entidades; conversa por (contato, conexão); identidades por família** | Preserva o modelo de segurança por conta; o inbox unificado vem naturalmente; o núcleo resolve identidade igual em qualquer canal | Migra as colunas de identidade do WhatsApp e mexe em 23 leitores da configuração | **Escolhida** |
| B | Loja como tenant, com uma camada "rede" acima e usuário em várias contas | Isolamento total entre lojas | Reescreve as políticas de acesso da base inteira e duplica contatos por loja, sem necessidade, já que as lojas são da mesma empresa | Rejeitada (só faria sentido para franquias com dados isolados) |
| C | Uma tabela de configuração por provedor e as colunas `wa_*` mantidas no contato | Migração menor | O núcleo passa a conhecer cada tabela e tem dois caminhos de identidade; cada canal novo exige migração | Rejeitada |
| D | Identidade com chave por tipo de canal (`whatsapp_cloud`, `telegram`…) | Simples | O mesmo cliente seria dois contatos em conexões de WhatsApp oficial e não oficial | Rejeitada |

## 4. Consequências

**Positivas**
- Um cliente é **um contato só** na rede, mesmo falando com lojas e canais diferentes.
- A loja de cada conversa é **derivada da conexão**, então uma camada futura de permissões por loja se apoia em dado
  que já existe, sem nova migração de estrutura.
- Um canal novo não exige tabela nem migração.

**Negativas / trade-offs**
- A migração toca muitos pontos (leitores de `whatsapp_config`, identidade, índices únicos) e precisa ser feita em
  etapas de expandir e contrair.
- Perde-se o isolamento de dados entre lojas: um administrador da conta vê todas as lojas.

**Obrigações**
- Confirmar os ajustes do Design Doc: chave por `kind` com prefixo de família, `contacts.phone` mantido como
  `NOT NULL DEFAULT ''` (com `null` só na API) e `messages.message_id` sem renomear.
- Cobrir a migração com backfill idempotente e verificação de `connection_id` nulo antes de contrair.
