# ADR-003 — Duas árvores de rota: `/developers` pública e estática, `/settings/manuals` do operador, dinâmica e sem cache compartilhado

- **Status:** Proposto
- **Data:** 2026-10-09
- **Feature:** integration-docs · SOLUTION (Temas Técnicos 9 e 10) · Design Doc, seções 3, 5 e 7

## 1. Contexto

- Há dois públicos com acessos opostos: o dev do cardápio, **sem conta**, lê o
  manual de integração; o operador (owner/admin) lê o manual de configuração.
- O middleware (`src/middleware.ts`) exige sessão só para uma lista fixa de
  prefixos (`/dashboard`, `/inbox`, …, `/settings`). Qualquer outro caminho é
  público; `src/middleware.test.ts` já cobre esse comportamento.
- `/settings` é uma página cliente única, com seções por `?tab=`. Um Server
  Component não pode ser renderizado dentro dela, e a `SettingsRail` só sabe
  trocar de `?tab`. Também não existe nela uma flag `adminOnly`: a rail mostra
  tudo e cada painel decide sozinho.
- O `next.config.ts` aplica `Cache-Control: public, s-maxage=300,
stale-while-revalidate=86400` a toda rota fora de `/_next/static`,
  `/_next/image` e `/api`. Uma página servidor com checagem de papel, sob essa
  regra, poderia ser guardada por um CDN ou proxy compartilhado e entregue a quem
  não é admin.
- O app roda como `output: "standalone"`; a imagem final só recebe
  `.next/standalone`, `.next/static` e `public/`. Arquivos lidos em runtime fora
  de `public/` não vão para a imagem a menos que declarados em
  `outputFileTracingIncludes`.

## 2. Decisão

Vamos servir os manuais públicos como páginas estáticas pré-geradas sob
`/developers` (sem sessão, `noindex`, slug desconhecido é 404) e o manual do
operador como páginas dinâmicas sob `/settings/manuals`, que exigem sessão e papel
owner/admin na própria página e respondem com `Cache-Control: private, no-store`.

## 3. Alternativas Consideradas

| #   | Alternativa                                                                      | Prós                                                                                                                                                                                            | Contras                                                                                                                                                                                        | Motivo                                             |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A   | **`/developers` estática e pública + `/settings/manuals` dinâmica e privada**    | Cada árvore tem o seu modelo de acesso e de cache; `/settings` já herda o login do middleware; as públicas não tocam o disco em runtime; a rota do operador não pode ser cacheada por terceiros | Primeira página servidor da área logada, sem precedente no repo; a rail precisa de um item que navega e de `adminOnly`; duas regras em `next.config.ts`                                        | **Escolhida**                                      |
| B   | Uma só árvore (`/manuals/**`) cuja visibilidade é decidida por requisição        | Um conjunto de rotas                                                                                                                                                                            | Toda página vira dinâmica, perde o cache estático e passa a depender de cookie; o dev externo carregaria o custo e o risco do caminho autenticado; um `if` esquecido vaza o manual do operador | Rejeitada: mistura os dois modelos de acesso       |
| C   | Manual do operador como mais um painel `?tab=manuals` na página de Configurações | Nenhuma rota nova; segue o padrão atual                                                                                                                                                         | Impossível renderizar Server Component dentro da página cliente; o Markdown teria de ir para o bundle cliente ou vir por uma API                                                               | Rejeitada: obriga a renderizar Markdown no cliente |
| D   | Conteúdo em `public/`                                                            | Sai na imagem Docker sem configuração                                                                                                                                                           | Servido por URL direta, **inclusive o manual do operador**                                                                                                                                     | Rejeitada: anula a restrição de acesso             |

## 4. Consequências

**Positivas**

- O dev externo recebe um único link (`/developers`) e nunca passa pelo caminho
  autenticado.
- O manual do operador não pode ficar em cache compartilhado; um `curl -I`
  confirma.
- Slug não público ou inexistente é 404 nas duas árvores, sem leitura de disco
  nas páginas públicas.

**Negativas / trade-offs**

- Duas árvores de rota para manter, com layouts e regras de cache distintas.
- A rota do operador lê o disco em runtime e depende do tracing do Next.
- Estabelece o padrão da primeira página servidor da área logada
  (`requireRole('admin')`, `ForbiddenError` → `notFound()`, `UnauthorizedError` →
  `redirect('/login')`).

**Obrigações**

- `outputFileTracingIncludes` para `/settings/manuals/*`; `dynamicParams = false` e
  `generateStaticParams` nas rotas públicas; `dynamic = 'force-static'` na rota
  do YAML.
- Tirar `settings/manuals` da regra de cache pública no `next.config.ts` e fixar
  `private, no-store`, verificando com `curl -I`.
- `RAIL_LINKS` na rail com `adminOnly` filtrado por `useCan('edit-settings')`, sem
  alterar `SETTINGS_SECTIONS`.
- Testes de middleware: `/developers/*` passa sem sessão; `/settings/manuals`
  redireciona para `/login`.
- Verificar na stack Docker (skill `wacrm-stack`) que o conteúdo está na imagem,
  pois o CI só roda `next build`.
