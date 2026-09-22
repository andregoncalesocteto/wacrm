# ADR-002 — Modelo de dados do broadcast multi-canal: colunas nullable + CHECK de exclusividade, não uma tabela por tipo de conteúdo

- **Status:** Proposto
- **Data:** 2026-09-22
- **Feature:** broadcast-multi-channel · SOLUTION (Tema Técnico 2) · Design Doc, seção 4

## 1. Contexto

- `broadcasts.template_name`/`template_language` são `NOT NULL` hoje —
  o schema assume que todo broadcast é, necessariamente, um template
  aprovado do WhatsApp.
- Canais cuja `capabilities.initiate` não é `'template'` (Telegram hoje;
  qualquer canal sem alcance frio no futuro) não têm o conceito de
  "template pré-aprovado" — o conteúdo é uma mensagem livre (texto + mídia
  opcional), decidida no debate de negócio como dentro do escopo desta
  versão.
- `broadcasts.connection_id` já é `NOT NULL` (introduzido no
  `channel-abstraction`) — o modelo já assume uma conexão por broadcast, só
  o **conteúdo** ainda assume um único formato.
- `broadcast_recipients` (histórico de envio), o relatório
  (`[id]/page.tsx`) e `broadcast-resume.ts` (retry) todos leem o conteúdo
  do broadcast para decidir o que reenviar/mostrar — qualquer estrutura
  escolhida aqui é lida em pelo menos três lugares diferentes.
- Existe precedente direto no próprio schema: `channel_connections.config`
  já é um jsonb condicional por `channel_type`, numa tabela só, em vez de
  uma tabela de configuração por canal — o mesmo princípio que orientou
  ADR-003 (contrato do provedor) do `channel-abstraction`.

## 2. Decisão

Vamos adicionar colunas novas e `nullable` em `broadcasts`
(`message_text`, `message_media_url`), soltar o `NOT NULL` de
`template_name`/`template_language`, e adicionar um `CHECK` de banco
garantindo exclusividade (template **ou** mensagem livre, nunca os dois,
nunca nenhum) — reaproveitando a coluna `template_variables` (jsonb) já
existente como o mapeamento de variáveis para os dois casos —, em vez de
criar uma tabela separada por tipo de conteúdo.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Colunas nullable + `CHECK` de exclusividade em `broadcasts`** | Leitura sem join extra em relatório/resume/lista; mesmo padrão já usado em `channel_connections.config`; menor migração | `broadcasts` acumula colunas nullable se um terceiro formato de conteúdo aparecer no futuro | **Escolhida** |
| B | Tabela separada `broadcast_free_messages` (1:1 com `broadcasts`) | `broadcasts` fica "limpa", cada formato de conteúdo isolado no seu próprio schema | Todo lugar que lê conteúdo de broadcast (relatório, resume, API) precisa de um join a mais; duas fontes de verdade pra "qual é o conteúdo deste broadcast" | Rejeitada — custo de manutenção em três consumidores sem ganho concreto de integridade que o `CHECK` já não resolva |
| C | Coluna única `content jsonb` polimórfica (schema-less, sem colunas tipadas) | Máxima flexibilidade para formatos futuros, zero migration por formato novo | Perde a garantia de integridade do banco (`CHECK`/`NOT NULL` por campo); toda validação migra para a camada de aplicação, onde já falhou antes (é exatamente a falta dessa garantia que este ADR resolve) | Rejeitada — o problema original era justamente falta de estrutura garantida pelo banco |

## 4. Consequências

**Positivas**
- Relatório, resume e a rota de envio continuam com uma consulta simples em
  `broadcasts`, sem join adicional.
- O banco garante a exclusividade (template xor mensagem livre) independente
  de bug na camada de aplicação — um `INSERT`/`UPDATE` inconsistente falha
  na escrita, não silenciosamente em produção.
- `template_variables` continua sendo a única forma de mapear variável para
  campo de contato, nos dois casos — nenhum conceito duplicado.

**Negativas / trade-offs**
- Se um terceiro formato de conteúdo aparecer no futuro (ex. um canal com
  "quick replies" nativas), a tabela ganha mais colunas nullable e o `CHECK`
  cresce — não escala indefinidamente, mas é aceitável para dois formatos.
- O `CHECK` em SQL puro é menos expressivo que um discriminated union
  tipado no TypeScript — a camada de aplicação (`step0`/`step1` do wizard,
  validação da rota) continua sendo a primeira linha de defesa; o `CHECK`
  é a rede de segurança, não a única validação.

**Obrigações**
- `supabase/ci/verify-schema.sql` ganha a checagem do `CHECK` de
  exclusividade, seguindo o padrão já aplicado a cada migration desde `043`.
- Migration nova (próximo número livre) — não edita nenhuma migration já
  aplicada, mesma regra do resto do projeto.
- Toda leitura de conteúdo do broadcast (relatório, resume, rota de envio)
  precisa checar `template_name IS NOT NULL` para decidir o ramo, nunca
  assumir um dos dois por padrão.
