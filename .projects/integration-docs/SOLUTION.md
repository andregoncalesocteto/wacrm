# Solution — Manuais e Swagger na web (integration-docs)

> Versão 1 — Gerado após debate em 2026-10-09.
> Rodadas anteriores: 0

---

## PARTE 1 — PRODUTO (O QUÊ)

### 1. Problema

O contrato de eventos da jornada de pedido precisa chegar a times externos que mantêm cardápios digitais próprios, começando pelo piloto da **Bella Capri**. Hoje a documentação existe só como arquivos no repositório (`docs/integracao-cardapio/manual-integracao.md` e `openapi.yaml`), misturando dois públicos num mesmo texto: o **operador do CRM** (configura lojas, chave de API, preset, templates, agendador) e o **dev do cardápio** (implementa os eventos). O dev externo não tem login no CRM nem acesso ao repositório, então o operador teria de repassar arquivos manualmente. Cada repasse envelhece sem aviso.

### 2. Objetivos

**Goals:**

- Servir o **Swagger** (referência da API) e o **manual de integração** por uma URL pública, que o operador possa enviar ao time externo.
- Servir o **manual do operador** dentro de Configurações, só para owner e admin.
- Manter o conteúdo **versionado com o código**, de modo que uma mudança de contrato e a mudança da documentação saiam no mesmo PR.
- Permitir **mais de um manual** por área, sem mudar código para adicionar o próximo.

**Non-goals:**

- Editar manuais pela interface (nem wiki, nem tabela no banco, nem permissão de autoria).
- Versão em outros idiomas (só português na v1; a estrutura de pastas já prevê idiomas).
- Busca entre manuais.
- Destaque de sintaxe nos blocos de código e botão "copiar".
- Tema escuro no Swagger.
- Flag para desligar as páginas públicas.
- Documentar outros endpoints da API pública além de `POST /api/v1/journey/events` e `GET /api/v1/me`.

### 3. Usuários & Casos de Uso

| Usuário                              | Caso de Uso                                                                                                  | Prioridade |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------- |
| Dev do cardápio (externo, sem login) | Ler o manual de integração e consultar o Swagger por um link público; testar uma chamada com a própria chave | Alta       |
| Operador do CRM (owner/admin)        | Seguir o manual de configuração (lojas, chave de API, preset, templates, agendador) sem sair do CRM          | Alta       |
| Operador do CRM (owner/admin)        | Enviar ao time externo um único link (`/developers`) em vez de arquivos                                      | Alta       |
| Dev do cardápio                      | Importar o `openapi.yaml` por URL no Insomnia, Postman ou editor.swagger.io                                  | Média      |
| Mantenedor do CRM                    | Atualizar um manual ou o contrato num PR e ter a mudança publicada com o próximo deploy                      | Alta       |
| Agente / viewer do CRM               | Não vê o manual do operador                                                                                  | —          |

### 4. Requisitos Funcionais

- RF-01: O sistema deve servir o manual de integração em uma rota pública, sem exigir login.
- RF-02: O sistema deve servir a referência da API (Swagger UI) em uma rota pública, com botão Authorize para o Bearer e "Try it out".
- RF-03: O sistema deve servir o `openapi.yaml` bruto em uma rota pública, importável por URL.
- RF-04: O sistema deve ter um índice público que liste os manuais públicos e leve à referência da API.
- RF-05: O sistema deve servir o manual do operador sob Configurações, exigindo sessão e papel owner ou admin.
- RF-06: A barra lateral de Configurações deve ter o item "Manuais", visível só para owner e admin, que leva à lista de manuais do operador.
- RF-07: Cada manual deve ser registrado com título e visibilidade (pública ou admin); só manuais registrados como públicos podem ser servidos pelas rotas públicas.
- RF-08: O manual deve exibir índice lateral (títulos `##` e `###`) com âncoras que coincidam com os ids dos títulos.
- RF-09: O renderizador deve reescrever os links relativos entre manuais e para o `openapi.yaml` nas rotas reais.
- RF-10: O token `{URL_BASE}` do manual deve ser substituído por `NEXT_PUBLIC_SITE_URL`; sem a variável, permanece `https://SEU-CRM.exemplo.com`. Os tokens `{{menu_link}}`, `{{order_id}}` e semelhantes nunca são substituídos.
- RF-11: O conteúdo atual deve ser dividido em dois manuais (operador e integração), reescrevendo as referências cruzadas (`A.x`, `B.x`) de modo que o manual público não dependa do manual do operador.
- RF-12: O Swagger deve usar `servers: - url: /` e **não** persistir a chave de API informada pelo usuário.
- RF-13: As páginas públicas devem declarar `noindex`.

### 5. Requisitos Não-Funcionais

- RNF-01: Nenhum conteúdo público pode conter segredo (por exemplo, algo com o formato `wacrm_live_…`); isso é verificado automaticamente.
- RNF-02: As páginas públicas não dependem de sessão, conta nem banco de dados.
- RNF-03: O Swagger deve ser empacotado com o app (sem CDN), compatível com a CSP `default-src 'self'` do projeto.
- RNF-04: O peso do Swagger só é pago na rota da referência da API.
- RNF-05: O conteúdo deve funcionar na imagem Docker `standalone`, não só em `next build`.
- RNF-06: Os textos da interface (títulos, rótulos do índice) passam por `useTranslations` nos quatro catálogos; o conteúdo dos manuais fica só em português.
- RNF-07: O contrato é pré-estável; a página diz isso até o piloto integrar.

### 6. Métricas de Sucesso

- **M1** — A Bella Capri integra usando só o link público, sem pedir ajuda ao operador (qualitativo, medido pelo piloto).
- **M2** — `/developers` e `/developers/api-reference` respondem 200 sem cookie (teste de fumaça).
- **M3** — Os valores fechados do contrato no `openapi.yaml` (5 `name`, 7 `status`, limites) batem com o código (`event-payload.ts`), por teste no CI.
- **M4** — O manual do operador não abre sem login nem sem papel owner/admin (teste).
- **M5** — Nenhum conteúdo público contém algo que pareça `wacrm_live_…` (verificação no CI).

---

## PARTE 2 — ARQUITETURA (O COMO)

### Contexto técnico

Restrições extraídas da Parte 1 e do código atual:

- Next.js 16 (App Router) com `output: "standalone"`; a imagem final recebe só `.next/standalone`, `.next/static` e `public/`.
- O middleware (`src/middleware.ts`) exige sessão apenas para uma lista fixa de prefixos (`/dashboard`, `/inbox`, …, `/settings`); qualquer outra rota já é pública.
- `/settings` é uma página cliente única, com seções por `?tab=` (`SettingsRail`, `settings-sections.ts`, item `adminOnly`). Um Server Component não pode ser renderizado dentro dela.
- CSP em modo report-only com `default-src 'self'`, previsto para ser imposto.
- O idioma é fixo por deploy (`NEXT_PUBLIC_APP_LOCALE`) e os catálogos `messages/*.json` exigem paridade de chaves.
- Não há hoje renderizador de Markdown, UI de Swagger nem página servidor na área logada.
- `requireRole(min)` e `getCurrentAccount()` existem em `lib/auth/account.ts` para uso no servidor.

### Decisões Técnicas

#### Fonte do conteúdo

**Decisão:** Markdown puro (sem MDX) e YAML em arquivos do repositório, numa pasta própria de conteúdo (nunca `.projects/`), com um registro em TypeScript que define título e visibilidade de cada manual. Um arquivo por manual e por idioma (`…/pt/`).
**Alternativas consideradas:** MDX importado no build (`{{menu_link}}` e afins são expressões JSX e quebram o build); banco de dados (migration, RLS, editor, descartado por não ser requisito).
**Justificativa:** versionado e revisado em PR junto do código que muda, sem migration, e o conteúdo atual já está nesse formato.
[ADR RECOMENDADO]

#### Renderização do Markdown

**Decisão:** `react-markdown` + `remark-gfm` + `rehype-slug`, em Server Component, com componentes Tailwind próprios para tabela, `code` e `pre`; índice gerado no servidor com `github-slugger`; HTML cru desligado; um só componente de renderização usado pelas duas áreas.
**Alternativas consideradas:** `marked` ou `markdown-it` gerando HTML em string (exige `dangerouslySetInnerHTML` e sanitização); `unified` direto (mais código para o mesmo resultado); `@tailwindcss/typography` (dependência a mais, quando o repo já usa componentes shadcn).
**Justificativa:** elementos React, sem JS no cliente e sem HTML injetado, suportando as tabelas GFM que os manuais usam.

#### Servir o Swagger

**Decisão:** Swagger UI via `swagger-ui-react`, empacotado, em componente cliente com import dinâmico (`ssr: false`) apenas na rota da referência; `servers: - url: /` no `openapi.yaml`; `persistAuthorization` desligado; painel claro.
**Alternativas consideradas:** Scalar (visual melhor, mas fontes e proxy hospedados por terceiros por padrão, o que fere a CSP e expõe a chave do dev); Redoc (somente leitura, sem "Try it out").
**Justificativa:** é o "Swagger" que o time externo espera, permite testar uma chamada e, com servidor relativo, chama o próprio CRM sem CORS e sem depender do host de proxy.
[ADR RECOMENDADO]

#### Rotas, visibilidade e entrega

**Decisão:**

| Rota                        | Conteúdo                                                | Acesso               |
| --------------------------- | ------------------------------------------------------- | -------------------- |
| `/developers`               | Índice dos manuais públicos e da referência             | Público              |
| `/developers/api-reference` | Swagger UI                                              | Público              |
| `/developers/openapi.yaml`  | Arquivo bruto (`application/yaml`, CORS aberto só aqui) | Público              |
| `/developers/[slug]`        | Manual público (hoje `integracao-cardapio`)             | Público              |
| `/settings/manuals`         | Lista dos manuais do operador                           | Sessão + owner/admin |
| `/settings/manuals/[slug]`  | Manual do operador (hoje `configuracao-jornada-pedido`) | Sessão + owner/admin |

- A visibilidade vem do **registro**, não da pasta; `/developers/[slug]` devolve 404 para qualquer slug não público, e o slug `api-reference` é reservado.
- Páginas públicas têm layout próprio e mínimo (precedente: `/join`), com `robots: noindex`, e são estáticas (`generateStaticParams`).
- `{URL_BASE}` é resolvido por `NEXT_PUBLIC_SITE_URL`.
- O item "Manuais" da `SettingsRail` é um link para `/settings/manuals` (não um `?tab=`), com a flag `adminOnly`.
- Entrega no Docker: os arquivos de conteúdo são declarados em `outputFileTracingIncludes` do `next.config.ts`, por rota. Colocar o conteúdo em `public/` foi descartado, pois tornaria o manual do operador acessível por URL direta.

**Alternativas consideradas:** conteúdo em `public/` (anula a proteção do manual do operador); manual do operador como painel `?tab=` (impossível renderizar Server Component dentro da página cliente); detectar o host por cabeçalhos de proxy para o `{URL_BASE}` (frágil atrás de proxy ou Docker).
**Justificativa:** `/settings` já herda a exigência de login do middleware, as rotas fora da lista de prefixos protegidos já são públicas, e o tracing garante que os arquivos existam na imagem final.
[ADR RECOMENDADO]

#### Autorização

**Decisão:** duas camadas no manual do operador — sessão (middleware) e `requireRole('admin')` na própria página, com `notFound()` para papel insuficiente; o item na barra lateral usa `adminOnly` apenas como aparência. O carregador de conteúdo expõe duas funções distintas, `getPublicManual(slug)` (devolve `null` para manual não público) e `getAdminManual(slug)`. As páginas públicas não importam módulos de conta, sessão nem Supabase.
**Alternativas consideradas:** esconder só o item do menu (não é barreira); uma função única com parâmetro de visibilidade (basta esquecer um `if` para vazar o manual errado).
**Justificativa:** torna "servir o manual errado" um erro deliberado, e dá aos testes M4 e M5 um ponto único para verificar.

#### Navegação

**Decisão:** sem busca; índice em `/developers` e em `/settings/manuals`; índice lateral por manual; reescrita de links relativos entre manuais e para o `openapi.yaml` pelo renderizador; classes `print:` para esconder o índice na impressão (nice-to-have).
**Alternativas consideradas:** busca textual (dependência e índice para manter, com dois manuais curtos).
**Justificativa:** com dois manuais de ~250 linhas, o índice resolve; a busca é revisitada quando houver mais de ~5.

### ADRs a Formalizar

- [ ] ADR-001: Manuais como arquivos versionados no repo, rotas públicas sob `/developers` com visibilidade vinda do registro e entrega por `outputFileTracingIncludes`
- [ ] ADR-002: Swagger UI empacotado e regra de mesma origem (`servers: /`)

---

## PARTE 3 — ABERTO & RISCOS

### Suposições não validadas

- [SUPOSIÇÃO NÃO VALIDADA] `swagger-ui-react` 5.33 funciona com React 19.2 e Next 16.3. A faixa de peer dependency diz que sim. Validar em um spike no início da implementação; plano B: `swagger-ui-dist` montado em um componente cliente.
- [SUPOSIÇÃO NÃO VALIDADA] `outputFileTracingIncludes` coloca os arquivos de conteúdo na imagem `standalone`. O CI roda `next build`, não a imagem; validar subindo a stack Docker (skill `wacrm-stack`) e abrindo `/developers` e `/settings/manuals`.
- [SUPOSIÇÃO NÃO VALIDADA] As métricas M2 a M5 foram aceitas implicitamente, por não terem sido questionadas.

### Perguntas em aberto

- [PERGUNTA EM ABERTO] A chave `wacrm_live_…` commitada em `.projects/order-journey-recovery/manual-configuracao.md` (commit `0e21f26`) ainda precisa ser revogada e removida. Fora do escopo desta feature, mas é o motivo da M5.
- [PERGUNTA EM ABERTO] Caminho exato da pasta de conteúdo (por exemplo `content/manuals/pt/`).
- [PERGUNTA EM ABERTO] Canal de suporte que o dev externo deve usar. O `contact.name` do `openapi.yaml` está como placeholder, e a página pública precisa dizer a quem recorrer.
- [PERGUNTA EM ABERTO] Quando o piloto da Bella Capri integrar, o contrato congela: quem avisa e onde o selo "pré-estável" é trocado por "estável"?

### Tensões identificadas

- ⚠️ TENSÃO: Swagger UI sem tema escuro ([decisão técnica do tema 8]) destoa do CRM, que tem tema escuro. Aceita na v1.
- ⚠️ TENSÃO: o manual do operador será a primeira página servidor da área logada (`requireRole` + `notFound()`), sem padrão prévio no repositório; o padrão passa a ser definido por esta feature.
- ⚠️ TENSÃO: o manual do operador cita rótulos da interface (`messages/pt.json`) e números de migration (055–068), que envelhecem em silêncio quando a interface ou as migrations mudam.
- ⚠️ TENSÃO: publicar o contrato para times externos aproxima o congelamento da API (`v2` para qualquer quebra); o selo "pré-estável" e o piloto da Bella Capri são o amortecedor.

---

## Próximo passo

Execute `/gen-design` usando este SOLUTION.md como contexto para gerar o Design Doc detalhado. Os dois ADRs listados podem sair em seguida com `/gen-adr`.
