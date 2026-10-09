# ADR-001 — Manuais como arquivos Markdown versionados no repositório, com a visibilidade declarada num registro

- **Status:** Proposto
- **Data:** 2026-10-09
- **Feature:** integration-docs · SOLUTION (Temas Técnicos 6 e 10) · Design Doc, seções 2, 3 e 4

## 1. Contexto

- O manual de integração e o `openapi.yaml` existem hoje só como arquivos
  (`docs/integracao-cardapio/`), e o manual mistura dois públicos: o operador do
  CRM e o dev do cardápio externo, que não tem login nem acesso ao repositório.
- Já foi decidido (SOLUTION, temas 1 e 2) que os manuais são **somente leitura**,
  que há **dois** (operador, logado; integração, público) e que "podem existir
  vários". Não há requisito de edição pela interface.
- O conteúdo descreve código que muda junto: `event-payload.ts` (nomes de evento,
  status, limites), rótulos da interface em `messages/pt.json`, números de
  migration. Um manual que não acompanha o PR que muda isso envelhece sem aviso.
- O produto é um template self-hosted que as pessoas fazem fork. Cada instalação
  tem o seu banco e as suas migrations aplicadas à mão (`docs/docker.md`).
- Os manuais usam `{{menu_link}}`, `{{order_id}}` e outras variáveis do produto
  como texto literal, e muitas tabelas.
- Já houve um segredo (`wacrm_live_…`) commitado dentro de `.projects/`. O conteúdo
  que será público não pode vir de uma pasta de trabalho.

## 2. Decisão

Vamos guardar os manuais como arquivos Markdown puro (e o contrato como YAML)
numa pasta própria do repositório, descritos por um registro em TypeScript que
declara, para cada manual, o slug, o título e a **visibilidade** (`public` ou
`admin`); só o que o registro marca como `public` pode ser servido sem login.

## 3. Alternativas Consideradas

| #   | Alternativa                                                                | Prós                                                                                                                                                                         | Contras                                                                                                                                  | Motivo                                                              |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A   | **Markdown puro e YAML em arquivos do repo, com registro de visibilidade** | Revisado em PR junto do código que muda; zero migration; legível no GitHub; o conteúdo atual já está nesse formato; "vários manuais" vira um arquivo e uma linha no registro | Precisa de um renderizador de Markdown; sem edição pela interface                                                                        | **Escolhida**                                                       |
| B   | Conteúdo no banco (tabela `manuals`, editor, RLS)                          | Editável pelo operador                                                                                                                                                       | Migration, RLS, editor e seed em cada instalação; o texto fica desvinculado do código que descreve; o requisito de edição foi descartado | Rejeitada: custo alto para um requisito que não existe              |
| C   | MDX importado no build (`@next/mdx`)                                       | Componentes React dentro do texto                                                                                                                                            | `{{menu_link}}` e afins são expressões JSX e quebram o build, exigindo escapar o texto todo; mais dependências                           | Rejeitada: o conteúdo é texto e tabelas, não precisa de componentes |
| D   | Site de documentação separado (Docusaurus, Nextra, GitHub Pages)           | Busca, versões e visual prontos                                                                                                                                              | Segundo deploy e outro domínio; o manual do operador não teria como ficar atrás do login do CRM                                          | Rejeitada: duplica infraestrutura num template self-hosted          |

## 4. Consequências

**Positivas**

- Mudar o contrato ou a interface e atualizar o manual cabem no mesmo PR e no
  mesmo deploy.
- Não há migration, política de acesso ou editor para manter; o histórico do
  manual é o `git log`.
- A visibilidade é um dado explícito e testável, não uma convenção de pasta.

**Negativas / trade-offs**

- Corrigir um erro de digitação no manual exige PR e deploy.
- Cada fork tem o manual da versão que implantou, não uma versão central
  atualizada.
- O manual do operador cita rótulos da interface e números de migration, que
  envelhecem em silêncio quando mudam.

**Obrigações**

- O conteúdo mora numa pasta própria (`content/`), **nunca** em `.projects/`.
- Testes no CI: nenhum manual `public` contém algo que pareça `wacrm_live_…`; os
  valores fechados do `openapi.yaml` batem com `event-payload.ts`.
- A regra de manter o contrato e os manuais juntos entra no `CLAUDE.md` do projeto.
- O carregador expõe funções distintas para o acesso público e o do operador,
  para que servir o manual errado exija uma escolha deliberada.
