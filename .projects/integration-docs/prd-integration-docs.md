# PRD: Manuais e Swagger na web (integration-docs)

## Introdução

O contrato de eventos da jornada de pedido (`POST /api/v1/journey/events`) tem manual e `openapi.yaml`, mas só como arquivos do repositório, num único texto que mistura dois públicos: o **operador do CRM** (configura lojas, chave de API, preset, templates e agendador) e o **dev do cardápio externo** (implementa os eventos). O dev externo, a começar pela Bella Capri, não tem login no CRM nem acesso ao repo.

Esta feature publica a documentação na web:

- **Público, sem login** (`/developers`): o manual de integração e o Swagger (referência da API com "Try it out"), mais o `openapi.yaml` bruto para importar em Insomnia ou Postman.
- **Logado, só owner e admin** (`/settings/manuals`): o manual de configuração do operador, acessado por um item novo na barra lateral de Configurações.

Os manuais são **somente leitura** e vivem como arquivos do repo, versionados com o código. O conteúdo é em **português**. Não há banco, migration nem endpoint novo da API pública.

Documentos de referência (leia antes de implementar):

- `.projects/integration-docs/SOLUTION.md` (decisões de produto e arquitetura)
- `.projects/integration-docs/design.md` (componentes, rotas, riscos, plano)
- `.projects/integration-docs/adr/ADR-001` a `ADR-003`
- `docs/integracao-cardapio/manual-integracao.md` e `openapi.yaml` (o conteúdo atual, a ser movido e dividido)

## Goals

- O operador envia **um único link** (`/developers`) ao time externo, que lê o manual e testa o contrato sem login.
- O operador lê o manual de configuração **dentro do CRM**, sem sair de Configurações.
- Uma mudança de contrato e a mudança do manual saem no mesmo PR e no mesmo deploy.
- Adicionar um terceiro manual exige um arquivo `.md` e uma linha no registro, sem mudar mais código.
- Nenhum conteúdo público contém segredo, e o `openapi.yaml` não diverge do código sem o CI falhar.

## User Stories

> Ordem estrita: cada história depende só das anteriores. Comandos de verificação do projeto: `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`. Textos de interface novos passam por `useTranslations` e entram nos **quatro** catálogos (`messages/{en,es,pt,ko}.json`); o **conteúdo** dos manuais não passa por eles.

### US-001: Mover o contrato OpenAPI para `content/api/`

**Description:** Como mantenedor, quero o `openapi.yaml` numa pasta de conteúdo própria e com servidor relativo, para o Swagger chamar sempre o CRM que o dev está vendo.

**Acceptance Criteria:**

- [ ] `docs/integracao-cardapio/openapi.yaml` é movido (`git mv`) para `content/api/openapi.yaml`
- [ ] O bloco `servers` do YAML passa a ser `- url: /`, com descrição explicando que o servidor é a própria origem
- [ ] O campo `contact.name` com o placeholder é removido, e a `description` do `info` diz que dúvidas devem ir à equipe do CRM que enviou o link
- [ ] O YAML continua carregando sem erro (`node -e` com `js-yaml`) e todos os `$ref` resolvem
- [ ] `docs/integracao-cardapio/manual-integracao.md` ainda existe neste ponto (a divisão é a US-002 e a US-003)
- [ ] `npm run format:check` passa

### US-002: Escrever o manual de integração público

**Description:** Como dev do cardápio externo, quero um manual só da integração, que não dependa do manual do operador, para implementar os eventos sem acesso ao CRM.

**Acceptance Criteria:**

- [ ] Criar `content/manuals/pt/integracao-cardapio.md` com o conteúdo da Parte B de `manual-integracao.md` (seções "Como funciona", B.1 a B.10, "Problemas comuns", "Limitações conhecidas"), em Markdown puro, sem MDX
- [ ] Nenhuma referência a seções do manual do operador (`A.1`…`A.11`); onde a Parte B citava o operador, o texto diz "peça ao operador do CRM" (por exemplo, a `store_key`, a URL base e a chave de API)
- [ ] Nenhum link relativo exceto `./openapi.yaml`, `./configuracao-jornada-pedido.md` (se citado) e âncoras `#…` para títulos do próprio arquivo, e todas as âncoras apontam para um título existente
- [ ] A URL base nos exemplos usa o token `{URL_BASE}`; `{{menu_link}}`, `{{order_id}}` e semelhantes aparecem como texto literal
- [ ] O texto diz que o contrato é **pré-estável** e que em produção a chamada sai do servidor, nunca do navegador
- [ ] Não contém nada que pareça uma chave real: `grep -E 'wacrm_live_[A-Za-z0-9]{20,}'` no arquivo não encontra nada
- [ ] `npm run format:check` passa

### US-003: Escrever o manual de configuração do operador

**Description:** Como operador do CRM, quero um manual só da configuração, para ligar a jornada de pedido sem misturar com instruções de desenvolvimento.

**Acceptance Criteria:**

- [ ] Criar `content/manuals/pt/configuracao-jornada-pedido.md` com o conteúdo da Parte A de `manual-integracao.md` (A.1 a A.11)
- [ ] O item "O que entregar ao time do cardápio" (A.9) passa a pedir ao operador que envie o link `{URL_BASE}/developers`, e lista o que mais entregar (chave de API, URL base, `store_key` de cada loja, `idtrack` de teste)
- [ ] Referências a "seção B.x" viram links para `./integracao-cardapio.md` (ou texto equivalente), sem números de seção do outro manual
- [ ] Os tokens `{{menu_link}}`, `{{order_id}}`, `{{order_status}}`, `{{order_value}}` e `{{store_name}}` aparecem como texto literal; `{URL_BASE}` só onde há URL do CRM
- [ ] Não contém chave real (mesma verificação da US-002)
- [ ] `docs/integracao-cardapio/` é removido por inteiro (os dois manuais agora vivem em `content/`)
- [ ] `grep -rn "integracao-cardapio/" --include=*.md --include=*.ts .` não aponta para o diretório removido (exceto o próprio nome do slug)
- [ ] `npm run format:check` passa

### US-004: Registro e carregador de manuais

**Description:** Como mantenedor, quero um registro tipado e um carregador de duas funções, para que servir um manual `admin` como público exija um erro deliberado.

**Acceptance Criteria:**

- [ ] Instalar `react-markdown`, `remark-gfm`, `rehype-slug` e os pacotes do pipeline que forem importados diretamente (`unified`, `remark-parse`, `remark-rehype`, um utilitário de texto de `hast`), declarados em `package.json`
- [ ] `src/lib/manuals/registry.ts` exporta `MANUALS` com os dois manuais (`integracao-cardapio` público, `configuracao-jornada-pedido` admin), `ManualMeta` e `ManualVisibility`; o slug `api-reference` é reservado e o registro rejeita (erro no carregamento do módulo ou teste) um manual com esse slug
- [ ] `src/lib/manuals/loader.ts` exporta `getPublicManual`, `getAdminManual`, `listPublicManuals`, `listAdminManuals`; `getPublicManual` devolve `null` para slug inexistente **ou** `admin`; `getAdminManual` devolve `null` para slug inexistente **ou** público
- [ ] O carregador troca o token `{URL_BASE}` por `NEXT_PUBLIC_SITE_URL` sem barra final, e por `https://SEU-CRM.exemplo.com` quando a variável não existe; `{{menu_link}}` e outros `{{…}}` ficam intactos
- [ ] O carregador lê de `content/manuals/<locale>/`, caindo em `pt` quando a pasta do locale não existe
- [ ] O carregador extrai `headings` (`h2` e `h3`, com `id` e `text`) usando o pipeline `unified` com `remark-gfm` e `rehype-slug`, de modo que títulos com crases e títulos repetidos recebam o mesmo `id` que o HTML renderizará
- [ ] O carregador **lança** erro se o arquivo de um manual do registro não existir (nunca devolve conteúdo vazio)
- [ ] Testes (`loader.test.ts`) cobrem: público×admin, `null` para slug inexistente, substituição de `{URL_BASE}` com e sem a variável, `{{menu_link}}` intacto, fallback de locale, `ids` de títulos com crases e repetidos, erro para arquivo ausente
- [ ] Typecheck, lint e `npm test` passam

### US-005: Reescrita de links entre manuais

**Description:** Como leitor, quero que os links entre os manuais e para o `openapi.yaml` levem à rota certa, para não cair em 404 ao clicar.

**Acceptance Criteria:**

- [ ] Função pura `resolveManualHref(href, { visibility })` em `src/lib/manuals/links.ts`
- [ ] `./openapi.yaml` → `/developers/openapi.yaml`
- [ ] `./<slug>.md` de um manual do registro → `/developers/<slug>` se público, `/settings/manuals/<slug>` se admin; um manual `admin` referenciado a partir de um manual **público** devolve `null` (o chamador mostra só o texto, sem link)
- [ ] `#âncora`, `http(s)://` e `mailto:` passam sem alteração
- [ ] Qualquer outro link relativo devolve `null`
- [ ] Testes (`links.test.ts`) cobrem os cinco casos acima
- [ ] Typecheck, lint e `npm test` passam

### US-006: Testes-guarda do conteúdo

**Description:** Como mantenedor, quero que o CI falhe quando o contrato, os manuais ou o YAML divergirem, para o dev externo nunca implementar em cima de documentação errada.

**Acceptance Criteria:**

- [ ] Adicionar `js-yaml` e `@types/js-yaml` como `devDependencies`
- [ ] **M3:** teste compara os `enum` de `name` e de `status` do `content/api/openapi.yaml` com `JOURNEY_EVENT_NAMES` e `ORDER_EVENT_STATUSES` exportados por `src/lib/journeys/event-payload.ts`
- [ ] **M3:** teste exercita os limites contra os parsers de `event-payload.ts` (200 itens aceitos e 201 recusados no carrinho; `quantity` 0 recusada; `order_id` com 201 caracteres recusado; telefone sem `+` recusado) e confere que o YAML declara os mesmos números (`maxItems: 200`, `minimum: 1`, `maxLength: 200`, `pattern` do telefone)
- [ ] **M5:** teste falha se qualquer manual com `visibility: 'public'` ou o YAML casar `wacrm_live_[A-Za-z0-9]{20,}`
- [ ] Teste falha se algum link relativo de qualquer manual não resolver por `resolveManualHref` (ou se uma âncora `#…` não existir como `id` nos `headings` do próprio manual)
- [ ] Teste falha se um manual do registro não tiver arquivo em `content/manuals/pt/`
- [ ] Typecheck, lint e `npm test` passam

### US-007: Componentes de leitura do manual

**Description:** Como leitor, quero o manual renderizado com tabelas, blocos de código, âncoras e um índice lateral, para navegar um documento de várias centenas de linhas.

**Acceptance Criteria:**

- [ ] `src/components/manuals/manual-view.tsx` (Server Component) renderiza o Markdown com `react-markdown`, `remark-gfm` e `rehype-slug`, **sem** HTML cru e sem `dangerouslySetInnerHTML`
- [ ] Tabelas ficam dentro de um contêiner com rolagem horizontal; `code` inline e `pre` usam fonte monoespaçada com fundo dos tokens do tema (claro e escuro funcionam)
- [ ] Links passam por `resolveManualHref`: link resolvido vira `<a>` (externo com `rel="noopener noreferrer"` e `target="_blank"`); link que devolve `null` é renderizado como texto simples
- [ ] `src/components/manuals/manual-toc.tsx` renderiza o índice a partir de `headings` (`h2` e `h3`), com links `#id`
- [ ] Classes `print:` escondem o índice na impressão
- [ ] Teste (`manual-view.test.tsx`) renderiza um manual com `react-dom/server` e confirma que **todo `id` do índice existe no HTML** e que `{{menu_link}}` aparece literal
- [ ] Typecheck, lint e `npm test` passam

### US-008: Rotas públicas: layout e página do manual

**Description:** Como dev do cardápio externo, quero abrir o manual de integração por uma URL pública, sem login.

**Acceptance Criteria:**

- [ ] `src/app/developers/layout.tsx` com layout mínimo (precedente: `src/app/join/layout.tsx`) e `metadata.robots = { index: false, follow: false }`
- [ ] `src/app/developers/[slug]/page.tsx` renderiza `<ManualView/>` e `<ManualToc/>` com `getPublicManual(slug)`; usa `generateStaticParams` a partir de `listPublicManuals()` e `export const dynamicParams = false`
- [ ] Slug de um manual `admin` (`/developers/configuracao-jornada-pedido`) e slug inexistente respondem **404**
- [ ] Os textos de interface da página (rótulo do índice, link "Referência da API") passam por `useTranslations` e existem nos quatro catálogos; `npm test` (paridade de chaves) passa
- [ ] Teste em `src/middleware.test.ts`: sem sessão, `/developers` e `/developers/integracao-cardapio` passam sem redirecionamento
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** abrir `/developers/integracao-cardapio` sem estar logado; tabelas rolam no celular; o índice leva às seções; o tema escuro fica legível

### US-009: Rotas públicas: índice de `/developers`

**Description:** Como operador, quero uma página de entrada que eu possa mandar ao time externo, listando o que há para ler.

**Acceptance Criteria:**

- [ ] `src/app/developers/page.tsx` lista os manuais de `listPublicManuals()` (título e descrição) com link para `/developers/<slug>`
- [ ] Mostra um cartão "Referência da API" com link para `/developers/api-reference`
- [ ] Nenhum manual `admin` aparece na lista
- [ ] Textos de interface em `useTranslations` nos quatro catálogos
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** abrir `/developers` sem login; a lista mostra só o manual de integração; os links funcionam

### US-010: Rota do `openapi.yaml`

**Description:** Como dev do cardápio, quero importar o contrato por URL no Insomnia, no Postman ou no editor.swagger.io.

**Acceptance Criteria:**

- [ ] `src/app/developers/openapi.yaml/route.ts` com `export const dynamic = 'force-static'` devolve o conteúdo de `content/api/openapi.yaml`
- [ ] Cabeçalhos: `Content-Type: application/yaml; charset=utf-8` e `Access-Control-Allow-Origin: *` (somente nessa rota)
- [ ] Teste do handler confirma status 200, os dois cabeçalhos e que o corpo é igual ao arquivo
- [ ] Typecheck, lint e `npm test` passam
- [ ] `npm run build` termina sem erro e `/developers/openapi.yaml` aparece como estática na saída do build

### US-011: Página do Swagger UI

**Description:** Como dev do cardápio externo, quero ler a referência da API e testar uma chamada com a minha chave.

**Acceptance Criteria:**

- [ ] Instalar `swagger-ui-react`; **antes** de qualquer outra coisa nesta história, confirmar que ele renderiza com React 19.2 e Next 16.3 (`npm run build` e abrir a página). Se falhar, registrar o erro em `progress.txt` e usar `swagger-ui-dist` montado num `useEffect` do mesmo componente cliente (plano B do ADR-002)
- [ ] `src/components/manuals/swagger-viewer.tsx` é um componente cliente que carrega o Swagger com `next/dynamic` (`ssr: false`), `url="/developers/openapi.yaml"`, `persistAuthorization` desligado, dentro de um painel de fundo claro
- [ ] `src/app/developers/api-reference/page.tsx` renderiza o viewer; o slug `api-reference` não colide com `[slug]`
- [ ] O Swagger não é carregado em nenhuma outra rota (conferir pela saída do build: o chunk só é referenciado por essa página)
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** abrir `/developers/api-reference` sem login; os endpoints `GET /api/v1/me` e `POST /api/v1/journey/events` aparecem com os 5 exemplos de evento; o botão Authorize aceita um Bearer; "Try it out" em `GET /api/v1/me` com uma chave de teste devolve 200; a chave **não** aparece no `localStorage` depois de recarregar a página; o console do navegador não mostra violação de CSP causada pelo Swagger

### US-012: Cache e entrega dos manuais da área logada

**Description:** Como mantenedor, quero que o manual do operador nunca seja guardado em cache compartilhado e que o conteúdo esteja na imagem Docker.

**Acceptance Criteria:**

- [ ] Em `next.config.ts`, a regra de `Cache-Control` pública (`s-maxage=300`) exclui `settings/manuals` no `source`, e uma regra nova aplica `Cache-Control: private, no-store` a `/settings/manuals/:path*`
- [ ] `outputFileTracingIncludes` declara `content/manuals/**/*` para `/settings/manuals/*`
- [ ] Nenhuma outra regra de cache ou de segurança existente é alterada
- [ ] Teste unitário importa a função `headers()` da configuração e confirma: existe a regra `private, no-store` para `/settings/manuals/:path*`, e o `source` da regra pública não casa `/settings/manuals/x` (usando o mesmo casamento de padrão do Next, ou, se isso for inviável em teste, documentando no `progress.txt` por que a verificação ficou para a US-017)
- [ ] `npm run build` passa
- [ ] Typecheck, lint e `npm test` passam

### US-013: Manual do operador: páginas servidor com checagem de papel

**Description:** Como owner ou admin, quero ler o manual de configuração dentro do CRM; como agent ou viewer, não devo vê-lo.

**Acceptance Criteria:**

- [ ] Helper `requireManualsAccess()` (em `src/lib/manuals/access.ts`) chama `requireRole('admin')`, converte `UnauthorizedError` em `redirect('/login')` e `ForbiddenError` em `notFound()`, e relança qualquer outro erro
- [ ] `src/app/(dashboard)/settings/manuals/page.tsx` lista `listAdminManuals()` com link para `/settings/manuals/<slug>` e um link de volta para `/settings`
- [ ] `src/app/(dashboard)/settings/manuals/[slug]/page.tsx` chama `requireManualsAccess()` primeiro, depois `getAdminManual(slug)` (`notFound()` se `null`) e renderiza `<ManualView/>` e `<ManualToc/>`
- [ ] `/settings/manuals/integracao-cardapio` (manual público) responde 404 nessa árvore
- [ ] Testes (`access.test.ts`, com `requireRole` simulado) cobrem: owner e admin passam; agent e viewer resultam em `notFound`; sem sessão resulta em redirecionamento para `/login`; erro inesperado é relançado
- [ ] Teste em `src/middleware.test.ts`: sem sessão, `/settings/manuals` redireciona para `/login`
- [ ] Textos de interface em `useTranslations` nos quatro catálogos
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** logado como owner, abrir `/settings/manuals/configuracao-jornada-pedido` e ver o manual; logado como agent (ou viewer), a mesma URL responde 404; sem sessão, redireciona para o login

### US-014: Item "Manuais" na barra lateral de Configurações

**Description:** Como owner ou admin, quero chegar ao manual a partir da barra lateral, e quem não tem permissão nem vê o item.

**Acceptance Criteria:**

- [ ] `src/components/settings/settings-sections.ts` exporta `RAIL_LINKS` (id `manuals`, `href: '/settings/manuals'`, ícone `BookOpen`, grupo `workspace`, `adminOnly: true`) e **não** adiciona `manuals` a `SETTINGS_SECTIONS` nem a `SECTION_META`
- [ ] `settings-rail.tsx` renderiza cada item de `RAIL_LINKS` como `<Link>` ao fim do seu grupo, com o mesmo estilo dos botões, e esconde os `adminOnly` quando `useCan('edit-settings')` é falso
- [ ] Chave `Settings.sections.manuals` presente nos quatro catálogos
- [ ] Os testes existentes de `settings-sections.test.ts` seguem passando e há um novo teste: `RAIL_LINKS` tem o item `manuals` com `adminOnly: true` e `SETTINGS_SECTIONS` não o contém
- [ ] O comentário desatualizado em `settings-sections.ts` ("`adminOnly` items are hidden for non-admins") passa a descrever o comportamento real
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** como owner, o item "Manuais" aparece em Configurações e leva a `/settings/manuals`; como agent ou viewer, o item não aparece

### US-015: Selo "pré-estável", suporte e aviso do Try-it-out

**Description:** Como dev externo, quero saber que o contrato ainda pode mudar e a quem recorrer, e ser avisado de que a chave não deve ser colada em produção no navegador.

**Acceptance Criteria:**

- [ ] O layout público (`/developers/**`) mostra um selo "Contrato pré-estável" e um texto de suporte: "Dúvidas? Fale com a equipe do CRM que enviou este link." Nenhum cliente é citado pelo nome
- [ ] A página do Swagger mostra um aviso curto: em produção, a chamada sai do servidor do cardápio; o "Try it out" é para testes com uma chave de teste
- [ ] O texto do selo vem de uma constante única, para ser trocado por "estável" num PR quando o piloto integrar
- [ ] Textos nos quatro catálogos
- [ ] Typecheck, lint e `npm test` passam
- [ ] **Verify in browser using dev-browser skill:** o selo, o texto de suporte e o aviso aparecem em `/developers`, no manual e no Swagger, em tema claro e escuro

### US-016: Documentação do projeto

**Description:** Como mantenedor, quero que a regra de manter contrato e manuais juntos esteja escrita, e que a documentação existente aponte para as novas páginas.

**Acceptance Criteria:**

- [ ] `CLAUDE.md` do projeto ganha uma nota curta: o contrato de eventos vive em `src/lib/journeys/event-payload.ts` e em `content/api/openapi.yaml`, e uma mudança num exige atualizar o outro e o manual correspondente em `content/manuals/pt/` no mesmo PR; descreve o mapa de rotas (`/developers/**` público, `/settings/manuals/**` owner/admin) e que `content/` nunca vem de `.projects/`
- [ ] `docs/public-api.md` (seção do endpoint de eventos) e `docs/order-journey.md` apontam para `/developers` como a documentação para o time do cardápio
- [ ] Os três ADRs não são alterados (a aceitação é uma decisão humana)
- [ ] `npm run format:check` passa

### US-017: Verificação na stack Docker

**Description:** Como mantenedor, quero confirmar que a feature funciona na imagem `standalone`, onde o CI não chega.

**Acceptance Criteria:**

- [ ] Subir a stack Docker (skill `wacrm-stack`) com `--build` e abrir `/developers`, `/developers/integracao-cardapio`, `/developers/api-reference` e `/developers/openapi.yaml` **sem cookie**: todas respondem 200
- [ ] Como owner, `/settings/manuals` e `/settings/manuals/configuracao-jornada-pedido` respondem 200 e mostram o manual (prova de que `content/` está na imagem)
- [ ] `curl -I` em `/settings/manuals/configuracao-jornada-pedido` mostra `Cache-Control: private, no-store`
- [ ] Como agent ou viewer, `/settings/manuals` responde 404; sem sessão, redireciona para `/login`
- [ ] No Swagger, "Try it out" em `GET /api/v1/me` com uma chave de teste devolve 200 na stack Docker
- [ ] O resultado de cada item acima é registrado em `.projects/integration-docs/verification.md`
- [ ] Se o Docker não estiver disponível no ambiente, a história fica **incompleta** e o motivo é registrado em `progress.txt`; ela não é marcada como concluída

## Functional Requirements

- FR-1: O sistema deve servir o manual de integração em uma rota pública, sem exigir login (`/developers/integracao-cardapio`).
- FR-2: O sistema deve servir a referência da API (Swagger UI) em uma rota pública, com botão Authorize para o Bearer e "Try it out" (`/developers/api-reference`).
- FR-3: O sistema deve servir o `openapi.yaml` bruto em `/developers/openapi.yaml`, importável por URL, com `Content-Type: application/yaml` e CORS aberto somente nessa rota.
- FR-4: O sistema deve ter um índice público em `/developers`, listando os manuais públicos e levando à referência da API.
- FR-5: O sistema deve servir o manual do operador sob `/settings/manuals`, exigindo sessão e papel owner ou admin; papel insuficiente resulta em 404.
- FR-6: A barra lateral de Configurações deve ter o item "Manuais", visível só para owner e admin, levando a `/settings/manuals`.
- FR-7: Cada manual deve ser registrado com `slug`, `title`, `description`, `visibility` (`public` ou `admin`) e `file`; só manuais `public` podem ser servidos por `/developers/**`, e o slug `api-reference` é reservado.
- FR-8: O manual deve exibir um índice lateral com os títulos `##` e `###`, cujos links coincidam com os `id` dos títulos renderizados.
- FR-9: O renderizador deve reescrever links relativos entre manuais e para o `openapi.yaml` nas rotas reais, e não linkar um manual `admin` a partir de um manual público.
- FR-10: O token `{URL_BASE}` do manual deve ser substituído por `NEXT_PUBLIC_SITE_URL` (sem barra final), ou por `https://SEU-CRM.exemplo.com` se a variável não existir; `{{menu_link}}` e demais `{{…}}` nunca são substituídos.
- FR-11: O conteúdo atual deve ser dividido em dois manuais, e o manual público não pode referenciar seções do manual do operador.
- FR-12: O `openapi.yaml` deve declarar `servers: - url: /`, e o Swagger não deve persistir a chave de API informada.
- FR-13: As páginas públicas devem declarar `noindex`.
- FR-14: As respostas de `/settings/manuals/**` devem ter `Cache-Control: private, no-store`.
- FR-15: Os arquivos de conteúdo dos manuais do operador devem estar presentes na imagem Docker `standalone`.
- FR-16: O CI deve falhar quando o `openapi.yaml` divergir de `event-payload.ts` (nomes de evento, status e limites), quando um manual público contiver algo com o formato de uma chave de API, ou quando um link relativo ou âncora de um manual não resolver.

## Non-Goals (Fora do Escopo)

- Edição de manuais pela interface (nem wiki, nem tabela no banco, nem permissão de autoria).
- Versões do conteúdo em outros idiomas (a estrutura `content/manuals/<locale>/` já prevê, mas só `pt` é entregue).
- Busca entre manuais.
- Destaque de sintaxe nos blocos de código e botão "copiar".
- Tema escuro no Swagger (fica em painel claro).
- Flag para desligar as páginas públicas.
- Documentar outros endpoints da API pública além de `POST /api/v1/journey/events` e `GET /api/v1/me`.
- Telemetria de acessos às páginas.
- Aceitar os ADRs (decisão humana, fora das histórias).
- Revogar a chave `wacrm_live_…` que está commitada em `.projects/order-journey-recovery/manual-configuracao.md` (assunto separado).
- Alterar a regra de cache pública que já afeta `/settings` (a página cliente); só `/settings/manuals` é tratada aqui.

## Design Considerations

- O layout público segue o precedente de `src/app/join/layout.tsx` (fora dos grupos de rota, layout próprio, `robots`).
- Usar os tokens de tema existentes (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary-soft`) para tabelas, `code` e `pre`, de modo que claro e escuro funcionem sem CSS novo; não instalar `@tailwindcss/typography`.
- Reutilizar o estilo dos botões da `SettingsRail` para o item-link "Manuais".
- O Swagger fica num contêiner de fundo claro e `color-scheme: light`.

## Technical Considerations

- Next.js 16.3 com `output: "standalone"`: arquivos lidos em runtime fora de `public/` só chegam à imagem se declarados em `outputFileTracingIncludes` (ADR-003). Antes de escrever código Next, ler o guia relevante em `node_modules/next/dist/docs/` (o `AGENTS.md` avisa que esta versão tem mudanças incompatíveis).
- `ssr: false` com `next/dynamic` só funciona em Componente Cliente; por isso o `swagger-viewer.tsx` é cliente e a página é servidor.
- Um `GET` de route handler é dinâmico por padrão desde o Next 15: a rota do YAML precisa de `dynamic = 'force-static'`.
- `dynamicParams = false` em `/developers/[slug]` faz slug desconhecido virar 404 sem tocar o disco em runtime.
- O índice e as âncoras saem do mesmo pipeline `unified` (`remark-gfm` + `rehype-slug`) para não divergirem.
- `NEXT_PUBLIC_SITE_URL` é incorporada no build; mudá-la exige rebuild, como qualquer `NEXT_PUBLIC_*`.
- `requireRole` e `getCurrentAccount` (`src/lib/auth/account.ts`) já existem para uso em servidor; a área logada não tem hoje nenhuma página servidor, e a US-013 estabelece o padrão.
- Os testes rodam em `vitest` no ambiente `node` e ficam ao lado do código (`foo.ts` + `foo.test.ts`); testes `.tsx` usam `react-dom/server`.
- O CI não constrói a imagem Docker: só a US-017 pega problemas de tracing.

## Success Metrics

- **M1:** a Bella Capri integra usando só o link público, sem pedir ajuda ao operador (qualitativo, medido pelo piloto).
- **M2:** `/developers` e `/developers/api-reference` respondem 200 sem cookie (US-008, US-011, US-017).
- **M3:** os valores fechados do contrato no YAML batem com o código (US-006).
- **M4:** o manual do operador não abre sem login nem sem papel owner ou admin (US-013, US-017).
- **M5:** nenhum conteúdo público contém algo que pareça `wacrm_live_…` (US-006).

## Open Questions

- O texto de suporte padrão ("Fale com a equipe do CRM que enviou este link") é suficiente, ou o dev externo precisa de um e-mail ou URL de suporte configurável por deploy? Adotado o texto simples, sem configuração nova; reavaliar depois do piloto.
- Quem troca o selo "pré-estável" por "estável" quando a Bella Capri integrar, e em que PR? A constante única da US-015 deixa a troca de uma linha.
- Se o `swagger-ui-react` não funcionar com React 19.2, o plano B (`swagger-ui-dist`) muda o componente da US-011; a escolha final precisa ser registrada em `progress.txt` e refletida no ADR-002 por um ADR novo (um ADR aceito não é editado).
- O manual do operador cita rótulos da interface (`messages/pt.json`) e números de migration (055 a 068). Quem revisa esses trechos quando eles mudarem? Hoje nada garante isso além da nota no `CLAUDE.md` (US-016).
- A regra de cache pública que já atinge a página `/settings` (cliente) permanece como está; vale uma revisão separada.
