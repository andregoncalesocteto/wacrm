# Design Doc — Manuais e Swagger na web (integration-docs)

## Ajustes ao SOLUTION.md

A leitura do código para este design refina (sem contradizer o que foi
decidido no debate) seis pontos do `SOLUTION.md`. Os dois primeiros corrigem
uma premissa errada.

1. **A `SettingsRail` não tem a flag `adminOnly`.** O comentário em
   `settings-sections.ts` ("`adminOnly` items are hidden for non-admins") está
   desatualizado: `SectionMeta` não tem esse campo e a rail mostra todas as
   seções a todos; cada painel decide sozinho o que permitir (`useCan`). O
   SOLUTION dizia "o item usa a flag `adminOnly` que a rail já tem". Não tem.
   Este design a **cria**, mas só para itens-link, em uma lista separada
   (`RAIL_LINKS`), sem tocar em `SETTINGS_SECTIONS` (que alimenta
   `resolveSection` e o `Record<SettingsSection, ReactNode>` da página, e
   obrigaria a criar um painel).
2. **O `next.config.ts` aplica `Cache-Control: public, s-maxage=300,
stale-while-revalidate=86400` a toda rota que não seja `/_next/static`,
   `/_next/image` ou `/api`.** Para o manual do operador, uma página servidor
   com checagem de papel, isso permitiria que um CDN ou proxy compartilhado
   guardasse a resposta e a entregasse a quem não é admin. O design exclui
   `settings/manuals` dessa regra e acrescenta `private, no-store` (seção 5).
3. **O TOC não usa `github-slugger` diretamente.** Os ids das âncoras e os do
   índice saem do **mesmo pipeline `unified`** (`remark-parse` → `remark-gfm` →
   `remark-rehype` → `rehype-slug`), percorrendo a árvore para coletar `h2` e
   `h3`. Extrair o índice do Markdown cru erraria em títulos como
   ``### `ViewContent` `` (crases) e em títulos repetidos.
4. **As páginas públicas são estáticas com `dynamicParams = false`.** Slug
   desconhecido vira 404 sem tocar o disco em runtime. O `outputFileTracingIncludes`
   só é necessário para as rotas do operador, que leem em runtime por depender
   de cookies. A rota `/developers/openapi.yaml` usa `dynamic = 'force-static'`
   (desde o Next 15 um `GET` de route handler é dinâmico por padrão).
5. **`js-yaml` não é dependência direta** (aparece só em `overrides`). O teste
   de paridade M3 o adiciona como `devDependency`.
6. **Caminho do conteúdo (pergunta em aberto do SOLUTION):** `content/manuals/pt/`
   para os `.md` e `content/api/openapi.yaml` para o contrato, na raiz do repo.
   Os arquivos hoje em `docs/integracao-cardapio/` são movidos (`git mv`) e o
   manual é dividido em dois.

## 1. Contexto

O contrato de eventos da jornada de pedido (`POST /api/v1/journey/events`) tem
manual e `openapi.yaml`, mas só como arquivos do repositório, num único texto
que mistura o operador do CRM e o dev do cardápio. O dev externo (primeiro: a
Bella Capri) não tem login nem acesso ao repo. Não há no app hoje nenhum
renderizador de Markdown, nenhuma UI de OpenAPI e nenhuma página servidor na
área logada.

Restrições técnicas que moldam a solução:

- Next.js 16.3 (App Router), `output: "standalone"`; a imagem Docker final recebe
  só `.next/standalone`, `.next/static` e `public/`.
- O middleware protege uma lista fixa de prefixos (`/settings` está nela;
  `/developers` não); `src/middleware.test.ts` já testa esse comportamento.
- `/settings` é uma página cliente única (`?tab=`); um Server Component não
  cabe dentro dela.
- CSP `default-src 'self'` (hoje em report-only, com intenção de ser imposta).
- Locale fixo por deploy; os quatro catálogos `messages/*.json` exigem paridade
  (testada em `src/i18n/*.test.ts`).
- `NEXT_PUBLIC_SITE_URL` já existe (usada nos convites).

## 2. Solução Proposta

Conteúdo em **arquivos do repo** (Markdown puro e YAML), descritos por um
**registro** que dá a cada manual um slug e uma visibilidade. Um **carregador**
com duas funções (`getPublicManual`, `getAdminManual`) é o único código que lê
o disco. Um **componente de renderização** transforma Markdown em React no
servidor. Duas árvores de rota consomem o carregador: `/developers/**`
(pública, estática) e `/settings/manuals/**` (logada, owner/admin, dinâmica).
O Swagger é um componente cliente carregado só na sua rota, apontando para o
`openapi.yaml` servido pelo próprio app.

```
                          content/manuals/pt/*.md      content/api/openapi.yaml
                                     │                            │
                                     ▼                            │
                  src/lib/manuals/registry.ts  (slug, título, visibilidade)
                                     │                            │
                                     ▼                            │
                  src/lib/manuals/loader.ts                       │
                  ├─ getPublicManual(slug)  → null se não público   │
                  └─ getAdminManual(slug)                           │
                          │                         │               │
          ┌───────────────┘                         └───────┐       │
          ▼                                                 ▼       ▼
  /developers (estático, noindex)               /settings/manuals (dinâmico)
  ├─ /developers                  índice          ├─ /settings/manuals        lista
  ├─ /developers/[slug]           manual          └─ /settings/manuals/[slug] manual
  ├─ /developers/api-reference    Swagger UI          requireRole('admin') → notFound()
  └─ /developers/openapi.yaml     YAML bruto          Cache-Control: private, no-store
          │
          ▼
  <ManualView> (react-markdown + remark-gfm + rehype-slug) + <ManualToc>
```

Sem banco, sem migration, sem endpoint novo da API pública.

## 3. Arquitetura

### Componentes

| Componente                                                     | Responsabilidade                                                                                                                                                   | Tecnologia                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `content/manuals/pt/*.md`, `content/api/openapi.yaml`          | Fonte do conteúdo, versionada com o código                                                                                                                         | Markdown puro, OpenAPI 3.0.3                  |
| `src/lib/manuals/registry.ts`                                  | Lista os manuais: `slug`, `title`, `description`, `visibility: 'public' \| 'admin'`, `file`. Slug `api-reference` é reservado                                      | TypeScript                                    |
| `src/lib/manuals/loader.ts`                                    | Lê o arquivo, troca `{URL_BASE}` por `NEXT_PUBLIC_SITE_URL`, extrai os títulos. Expõe `getPublicManual`, `listPublicManuals`, `getAdminManual`, `listAdminManuals` | `node:fs/promises`, `unified`                 |
| `src/components/manuals/manual-view.tsx`                       | Renderiza o Markdown (Server Component). Mapa de componentes para tabela com rolagem, `code`/`pre`, links. Reescreve links relativos conhecidos                    | `react-markdown`, `remark-gfm`, `rehype-slug` |
| `src/components/manuals/manual-toc.tsx`                        | Índice lateral a partir dos títulos extraídos                                                                                                                      | Server Component                              |
| `src/app/developers/layout.tsx`                                | Layout mínimo (precedente: `/join`), `robots: noindex`                                                                                                             | Next.js layout                                |
| `src/app/developers/{page,[slug]/page,api-reference/page}.tsx` | Índice, manual público (`generateStaticParams` + `dynamicParams = false`), página do Swagger                                                                       | Server Components                             |
| `src/app/developers/openapi.yaml/route.ts`                     | Devolve o YAML (`application/yaml`, `Access-Control-Allow-Origin: *`, `dynamic = 'force-static'`)                                                                  | Route Handler                                 |
| `src/components/manuals/swagger-viewer.tsx`                    | Cliente: `next/dynamic(() => import('swagger-ui-react'), { ssr: false })`, `url="/developers/openapi.yaml"`, painel claro, sem persistir a chave                   | `swagger-ui-react`                            |
| `src/app/(dashboard)/settings/manuals/{page,[slug]/page}.tsx`  | Lista e leitura do manual do operador. `requireRole('admin')`; `ForbiddenError` → `notFound()`, `UnauthorizedError` → `redirect('/login')`                         | Server Components + `lib/auth/account.ts`     |
| `settings-sections.ts` + `settings-rail.tsx`                   | `RAIL_LINKS` (itens que navegam) e a flag `adminOnly`, filtrada na rail com `useCan('edit-settings')`                                                              | React cliente                                 |
| `next.config.ts`                                               | `outputFileTracingIncludes` para `/settings/manuals/*`; exclusão de `settings/manuals` da regra de cache pública e `private, no-store` para ela                    | Next config                                   |

### Fluxo principal: dev externo abre a documentação

```
Operador envia  https://<crm>/developers
        │
        ▼
Middleware: /developers não está em protectedPaths → passa (sem sessão)
        │
        ▼
/developers (estático)  ──►  lista getPublicManual-s + link "Referência da API"
        │                         │
        ▼                         ▼
/developers/integracao-cardapio   /developers/api-reference
(HTML pré-gerado no build)        (shell estático + SwaggerUI no cliente)
                                      │  GET /developers/openapi.yaml
                                      ▼
                          "Try it out" → servers: "/" → POST <mesma origem>/api/v1/journey/events
                                          (Authorization: Bearer colado pelo dev; não persiste)
```

### Fluxo secundário: operador abre o manual de configuração

```
Rail "Manuais" (só se useCan('edit-settings')) → /settings/manuals
        │
Middleware: /settings → sem sessão: redirect /login (já existe)
        ▼
page.tsx (servidor): requireRole('admin')
   ├─ Unauthorized → redirect('/login')
   ├─ Forbidden    → notFound()
   └─ ok           → getAdminManual(slug) ?? notFound() → <ManualView/>
Resposta: Cache-Control: private, no-store
```

## 4. Modelo de Dados

Não há tabela, migration nem RLS. As estruturas são de código:

```ts
// src/lib/manuals/registry.ts
export type ManualVisibility = 'public' | 'admin';

export interface ManualMeta {
  slug: string; // /developers/<slug> ou /settings/manuals/<slug>; 'api-reference' é reservado
  title: string; // conteúdo, não texto de interface: fica em português
  description: string;
  visibility: ManualVisibility;
  file: string; // relativo a content/manuals/<locale>/
}

export const MANUALS: readonly ManualMeta[] = [
  {
    slug: 'integracao-cardapio',
    title: 'Integração do cardápio digital',
    description: 'Contrato de eventos, consentimento, erros e reenvio.',
    visibility: 'public',
    file: 'integracao-cardapio.md',
  },
  {
    slug: 'configuracao-jornada-pedido',
    title: 'Configuração da jornada de pedido',
    description: 'Lojas, link do cardápio, chave de API, preset e agendador.',
    visibility: 'admin',
    file: 'configuracao-jornada-pedido.md',
  },
];

// src/lib/manuals/loader.ts
export interface Heading { id: string; text: string; depth: 2 | 3 }
export interface Manual { meta: ManualMeta; markdown: string; headings: Heading[] }

getPublicManual(slug: string): Promise<Manual | null>   // null se não existe OU não é público
getAdminManual(slug: string): Promise<Manual | null>
listPublicManuals(): ManualMeta[]
listAdminManuals(): ManualMeta[]
```

Regras de dados do conteúdo:

- `{URL_BASE}` é o único token do manual substituído. `NEXT_PUBLIC_SITE_URL`
  sem barra final; sem a variável, `https://SEU-CRM.exemplo.com`. Os tokens do
  produto (`{{menu_link}}`, `{{order_id}}`, `{{store_name}}`…) nunca são tocados.
- Idioma: `content/manuals/<locale>/`. Hoje só `pt`. Um deploy cujo locale não
  tenha pasta cai em `pt`, em vez de dar 404.
- `content/api/openapi.yaml` declara `servers: - url: /` (hoje está com um
  placeholder `https://SEU-CRM.exemplo.com`).

## 5. APIs / Interfaces

Nenhuma rota nova da API pública (`/api/v1`). As rotas de página:

| Rota                        | Método | Acesso               | Resposta                                                                                      |
| --------------------------- | ------ | -------------------- | --------------------------------------------------------------------------------------------- |
| `/developers`               | GET    | Público              | HTML estático: lista de manuais públicos e link para a referência da API                      |
| `/developers/[slug]`        | GET    | Público              | HTML estático do manual; `404` para slug não público ou inexistente (`dynamicParams = false`) |
| `/developers/api-reference` | GET    | Público              | HTML com o Swagger UI                                                                         |
| `/developers/openapi.yaml`  | GET    | Público              | `200 application/yaml`; `Access-Control-Allow-Origin: *`; corpo = `content/api/openapi.yaml`  |
| `/settings/manuals`         | GET    | Sessão + owner/admin | HTML dinâmico; sem sessão `307 → /login` (middleware); papel insuficiente `404`               |
| `/settings/manuals/[slug]`  | GET    | Sessão + owner/admin | HTML dinâmico do manual; `404` se o slug não for `admin`                                      |

Exemplo da rota do YAML:

```ts
// src/app/developers/openapi.yaml/route.ts
export const dynamic = 'force-static';

export async function GET() {
  const body = await readOpenApi(); // content/api/openapi.yaml
  return new Response(body, {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Access-Control-Allow-Origin': '*', // só este arquivo: público e somente leitura
    },
  });
}
```

`next.config.ts` (trechos novos):

```ts
outputFileTracingIncludes: {
  // Lidos em runtime (dependem de cookie). As rotas /developers são pré-geradas no build.
  '/settings/manuals/*': ['content/manuals/**/*'],
},

// em headers(): excluir settings/manuals da regra pública e fixar a privada
{ source: '/:path((?!_next/static|_next/image|api|settings/manuals).*)', headers: [/* public, s-maxage=300 … */] },
{ source: '/settings/manuals/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
```

Rail (cliente):

```ts
// settings-sections.ts
export const RAIL_LINKS = [
  {
    id: 'manuals',
    href: '/settings/manuals',
    icon: BookOpen,
    group: 'workspace',
    adminOnly: true,
  },
] as const;
// settings-rail.tsx: renderiza <Link> depois dos botões do grupo; filtra adminOnly com useCan('edit-settings')
```

Chaves de i18n novas (`Settings.sections.manuals`, `Manuals.*` para título do
índice, "Voltar às configurações", "Índice", "Referência da API") entram nos
quatro catálogos; o **conteúdo** dos manuais não passa por eles.

**Decisões registradas** (status Proposto; os dois ADRs que este design
marcou viraram três, porque o primeiro reunia mais de uma decisão):

- [ADR-001](./adr/ADR-001-manuais-como-arquivos-versionados-com-registro.md):
  manuais como arquivos Markdown versionados no repo, com a visibilidade
  declarada num registro e o carregador de duas funções.
- [ADR-002](./adr/ADR-002-swagger-ui-empacotado-e-mesma-origem.md): Swagger UI
  empacotado (`swagger-ui-react`) e regra de mesma origem (`servers: /`, sem
  CORS, sem persistir a chave).
- [ADR-003](./adr/ADR-003-duas-arvores-de-rota-publica-estatica-e-operador-privada.md):
  `/developers` pública e estática, `/settings/manuals` dinâmica com
  `requireRole`, `outputFileTracingIncludes` e `private, no-store`.

## 6. Alternativas Consideradas

| Alternativa                                                                      | Prós                                          | Contras                                                                                                             | Por que não                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Site de documentação separado** (Docusaurus, Nextra, Mintlify) ou GitHub Pages | Busca, versionamento e visual prontos         | Segundo deploy, outro domínio, outra autenticação; o manual do operador não teria como ficar atrás do login do CRM  | Duplica infraestrutura num template self-hosted; a URL pública teria de ser a do fork |
| **MDX** via `@next/mdx`                                                          | Componentes dentro do texto                   | `{{menu_link}}` e afins são expressões JSX e quebram o build; mais dependências                                     | O conteúdo é texto com tabelas; Markdown puro basta                                   |
| **Conteúdo em `public/`**                                                        | Sai na imagem Docker sem configuração         | Servido por URL direta, **inclusive o manual do operador**                                                          | Anula a restrição de acesso                                                           |
| **Conteúdo no banco** (tabela `manuals`, editor)                                 | Editável pela interface                       | Migration, RLS, editor, seed por instalação; conteúdo desvinculado do código que ele descreve                       | Requisito descartado (somente leitura)                                                |
| **Scalar** ou **Redoc** no lugar do Swagger UI                                   | Visual melhor (Scalar); leitura limpa (Redoc) | Scalar: fontes e proxy de terceiros por padrão, fere a CSP e passa a chave do dev por fora. Redoc: sem "Try it out" | Risco de segurança (Scalar) e requisito não atendido (Redoc)                          |
| **Ler o Markdown em runtime também nas rotas públicas**                          | Mesmo caminho de código das rotas do operador | Exige tracing para as duas árvores, perde o cache estático, abre disco por requisição pública                       | Estático no build é mais simples e mais seguro                                        |

## 7. Riscos

| #   | Risco                                                                                  | Prob. | Impacto | Mitigação                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `swagger-ui-react` 5.33 não funciona com React 19.2 / Next 16.3                        | Média | Alto    | **Spike na Fase 0.** Plano B: `swagger-ui-dist` montado num `useEffect` do componente cliente, sem depender da versão do React                                                                                 |
| R2  | Arquivos de conteúdo ausentes na imagem `standalone` (o CI só roda `next build`)       | Média | Alto    | Spike na Fase 0 com a stack Docker (skill `wacrm-stack`); item obrigatório no checklist de aceite; falha ruidosa no loader (lança erro, nunca devolve vazio)                                                   |
| R3  | Manual do operador cacheado em CDN/proxy por causa do `s-maxage=300` global            | Média | Médio   | Exclusão de `settings/manuals` da regra pública + `private, no-store`; verificação com `curl -I` na Fase 4. Se duas regras casarem a mesma chave e a ordem decidir, a exclusão no `source` evita depender dela |
| R4  | Manual público vazar segredo (já houve uma chave commitada em `.projects/`)            | Baixa | Alto    | Pasta própria de conteúdo, nunca `.projects/`; teste M5 (regex `wacrm_live_[A-Za-z0-9]{20,}`) no CI sobre todo manual `public` e sobre o YAML                                                                  |
| R5  | O `openapi.yaml` diverge do código                                                     | Alta  | Alto    | Teste M3: compara `name`/`status` com `JOURNEY_EVENT_NAMES`/`ORDER_EVENT_STATUSES` e exercita os limites (200/201 itens, `order_id`, E.164) contra os parsers de `event-payload.ts`                            |
| R6  | Um manual do operador acidentalmente servido como público                              | Baixa | Médio   | Carregador de duas funções; `getPublicManual` devolve `null` para `admin`; teste M4; `dynamicParams = false`                                                                                                   |
| R7  | Âncoras do índice não batem com os ids renderizados                                    | Média | Baixo   | Mesmo pipeline `unified` nos dois; teste que renderiza com `react-dom/server` e confere que cada id do índice existe no HTML                                                                                   |
| R8  | Links entre manuais quebram (referências `A.x`/`B.x`, `./openapi.yaml`) após a divisão | Alta  | Médio   | Tabela de reescrita no renderizador; teste que falha se um link relativo de qualquer manual não resolver no mapa ou para uma âncora existente; revisão manual das referências na Fase 1                        |
| R9  | O "Try it out" faz o dev colar uma chave de produção num navegador                     | Média | Médio   | `persistAuthorization` desligado; a página e o manual dizem que em produção a chamada sai do servidor                                                                                                          |
| R10 | Rótulos da interface e números de migration citados no manual do operador envelhecem   | Alta  | Baixo   | Risco aceito; regra no `CLAUDE.md` do projeto: mudar o contrato ou a UI citada exige tocar o manual no mesmo PR                                                                                                |
| R11 | Primeira página servidor da área logada sem precedente                                 | Baixa | Baixo   | Padrão registrado no ADR-003 e coberto por teste de `requireRole` simulado                                                                                                                                     |

## 8. Plano de Implementação

| Fase                                 | Entregas                                                                                                                                                                                                                                                                                             | Verificação                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **0. Spike (descartável)**           | Página mínima com `swagger-ui-react` carregando um YAML local; um `.md` lido em runtime numa rota logada; `outputFileTracingIncludes` mínimo; build da imagem Docker                                                                                                                                 | Swagger renderiza no React 19.2; o arquivo está na imagem; `curl -I` mostra o `Cache-Control` esperado   |
| **1. Conteúdo e carregador**         | `git mv` para `content/`; divisão do manual em dois, reescrevendo referências cruzadas; `servers: /` no YAML; `registry.ts` e `loader.ts`; devDependency `js-yaml`; testes M3, M5, links e "público não serve admin"                                                                                 | `npm test` verde; os dois `.md` não têm referência morta                                                 |
| **2. Renderização e rotas públicas** | `ManualView`, `ManualToc`, reescrita de links, `/developers` (layout `noindex`, índice, `[slug]`), `generateStaticParams` + `dynamicParams = false`                                                                                                                                                  | Teste de paridade índice×âncoras; abrir `/developers/integracao-cardapio` sem login                      |
| **3. Swagger e YAML**                | `swagger-viewer.tsx`, `/developers/api-reference`, `/developers/openapi.yaml`                                                                                                                                                                                                                        | Importar a URL do YAML no editor.swagger.io; "Try it out" contra `GET /api/v1/me` com uma chave de teste |
| **4. Área logada**                   | `RAIL_LINKS` + `adminOnly` na rail; `/settings/manuals` e `[slug]` com `requireRole`; regra de cache; chaves de i18n nos 4 catálogos; testes de middleware (`/developers` passa sem sessão; `/settings/manuals` redireciona)                                                                         | Owner/admin veem o item e a página; agent/viewer recebem 404; sem sessão vai a `/login`                  |
| **5. Verificação e documentação**    | Subir a stack Docker e percorrer `/developers/*` e `/settings/manuals`; atualizar `CLAUDE.md` (regra de manter manuais e contrato juntos, mapa de rotas), `docs/public-api.md` (link para `/developers`), `docs/order-journey.md`; aceitar os ADR-001 a ADR-003; remover `docs/integracao-cardapio/` | Checklist de aceite abaixo                                                                               |

Dependências novas: `react-markdown`, `remark-gfm`, `rehype-slug`, `swagger-ui-react`
(produção); `js-yaml` e `@types/js-yaml` (desenvolvimento). Os pacotes do
pipeline do índice (`unified`, `remark-parse`, `remark-rehype`, um utilitário
de texto de `hast`) já chegam transitivamente com `react-markdown`; devem ser
declarados explicitamente ao serem importados.

**Estratégia de testes** (vitest, ambiente `node`, colocados ao lado do código):

| Teste                                                                                | Métrica |
| ------------------------------------------------------------------------------------ | ------- |
| `/developers/*` passa sem sessão; `/settings/manuals` redireciona para `/login`      | M2, M4  |
| `getPublicManual` devolve `null` para um manual `admin`; `getAdminManual` o devolve  | M4      |
| `name`/`status`/limites do `openapi.yaml` batem com `event-payload.ts`               | M3      |
| Nenhum manual público nem o YAML contém `wacrm_live_[A-Za-z0-9]{20,}`                | M5      |
| Todo link relativo dos manuais resolve; todo id do índice existe no HTML renderizado | —       |
| `{URL_BASE}` é trocado e `{{menu_link}}` fica intacto                                | —       |

**Checklist de aceite da implementação** (além dos testes): subir a stack
Docker; abrir `/developers`, `/developers/integracao-cardapio`,
`/developers/api-reference` e `/developers/openapi.yaml` sem cookie; abrir
`/settings/manuals` como owner, como agent e sem sessão; `curl -I` em
`/settings/manuals` mostra `private, no-store`; o Swagger executa
`GET /api/v1/me` com uma chave de teste.

## 9. Observabilidade

Não há telemetria de produto neste app e esta feature não a introduz.

- **Logs.** `console.error` com o slug (nunca o conteúdo) quando o carregador
  falha ao ler um arquivo; para rotas públicas isso só ocorre no build, e o build
  deve falhar. Em runtime, a falha de leitura numa rota do operador devolve
  `500` com o log, em vez de uma página vazia. Slug desconhecido é `404`, sem log.
- **CSP.** A política está em `Report-Only`: durante a Fase 0 e a Fase 3,
  conferir o console do navegador por violações do Swagger UI (estilos inline e
  `eval` já são permitidos hoje). É a única verificação de CSP antes de a política
  ser imposta no futuro.
- **Métricas.** Nenhuma. Contar acessos ou medir "tempo até o primeiro evento"
  exigiria telemetria que o produto não tem; a M1 é qualitativa, medida pelo
  piloto da Bella Capri.
- **Alertas.** Nenhum em runtime. As proteções são os testes no CI (M3, M4, M5,
  links, índice×âncoras) e a verificação na stack Docker antes de cada release
  que mexa em `content/` ou em `next.config.ts`.
