# Verificação final: Manuais e Swagger na web (integration-docs)

Verificação da feature na branch `ralph/integration-docs`, contra os critérios da US-017 de `prd.json`, as métricas M1 a M5 de `SOLUTION.md` e o plano de aceite da seção 8 de `design.md`.

**Leia primeiro os limites.** O que depende do código foi provado por testes automatizados (a suíte inteira, `TZ=UTC npm test`, passa com 2576 testes) e, para a entrega, **numa imagem Docker construída desta branch**, depois com **sessões reais** (um owner e uma chave de teste, fornecidos pelo responsável do projeto). **Falta uma coisa:** ver, num navegador logado, um usuário **agent ou viewer de verdade** sem acesso ao manual. A conta de teste que foi dada como "agent" é, na verdade, **proprietária da própria conta** (outra conta, 1 membro), então ela corretamente vê o manual. Além disso, a verificação encontrou que a recusa não é um `404` de status HTTP, e sim um _soft 404_ (seção 3). Por essas duas razões a US-017 **não** foi marcada como concluída.

## 1. Como foi verificado

- Imagem construída com `docker build` usando os argumentos de build do `.env.local` e a tag `wacrm-docs-verify`, **à parte** da imagem `wacrm-app:latest` e da stack em execução do usuário (nada dela foi derrubado ou recriado). Container na porta 3200.
- Requisições com `curl`, **sem cookie nenhum**, contra `http://localhost:3200`.
- Depois, num navegador (dev-browser) contra o mesmo container, com o login de um **owner** e com a **chave de teste** fornecida. As sessões foram encerradas ao fim e o container removido; nenhuma credencial foi gravada em arquivo ou commit.
- Tamanho da imagem: 233 MB contra 228 MB da imagem atual da `main` (sem inchaço). O build não imprimiu o aviso do Turbopack sobre rastreamento do projeto inteiro.

## 2. Resultado dos itens da US-017

| #   | Critério                                                                                                                            | Resultado   | Evidência                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/developers`, `/developers/integracao-cardapio`, `/developers/api-reference` e `/developers/openapi.yaml` respondem 200 sem cookie | **OK**      | Quatro `HTTP/1.1 200 OK`; o YAML sai com `content-type: application/yaml; charset=utf-8`.                                                                                                                                                                                                                         |
| 2   | Como owner, `/settings/manuals` e o manual do operador respondem 200 e mostram o manual                                             | **OK**      | Sessão real de owner na imagem Docker: item **Manuais** na rail (grupo Espaço de trabalho), lista com 1 manual, manual com 6 tabelas, índice de 28 links, `{{menu_link}}` literal, `{URL_BASE}` trocado pela URL do deploy e link para o manual público reescrito.                                                |
| 3   | `curl -I` em `/settings/manuals/…` mostra `Cache-Control: private, no-store`                                                        | **OK**      | Na resposta **200** da sessão de owner: `Cache-Control: private, no-store`, com os cabeçalhos de segurança (`X-Content-Type-Options`, `Strict-Transport-Security`) presentes. Sem sessão: `307 → /login` com o mesmo cache.                                                                                       |
| 4   | Como agent ou viewer, `/settings/manuals` responde 404; sem sessão, redireciona para `/login`                                       | **PARCIAL** | Sem sessão: **OK**. Agent/viewer real: **PENDENTE** (não há um). O mesmo `notFound()` foi exercitado numa sessão real com um slug inválido: ver a seção 3 (a resposta é um _soft 404_). Coberto por `access.test.ts` e `manuals-pages.test.tsx`, que rodam o `requireRole` real.                                  |
| 5   | No Swagger, "Try it out" em `GET /api/v1/me` com uma chave de teste devolve 200 na stack Docker                                     | **OK**      | Na imagem Docker: Authorize com a chave de teste, Try it out, Execute: **HTTP 200** pela mesma origem (`http://localhost:3200/api/v1/me`), corpo com a conta e `scopes: ["events:write"]`. A chave não aparece em `localStorage` nem `sessionStorage`; o `curl` exibido pelo Swagger usa a origem do próprio CRM. |
| 6   | O conteúdo está na imagem e o rastreamento não puxou o projeto inteiro                                                              | **OK**      | `/app/content` contém `api/openapi.yaml` e os dois `.md`; `/app` contém só `.next content node_modules package.json public server.js` (sem `src/`, `.projects/`, `docs/`).                                                                                                                                        |
| 7   | Slug do manual do operador e slug inexistente em `/developers/**` são 404                                                           | **OK**      | `/developers/configuracao-jornada-pedido` e `/developers/nao-existe`: `HTTP/1.1 404 Not Found`.                                                                                                                                                                                                                   |
| 8   | Nenhum conteúdo enviado tem algo com formato de chave de API                                                                        | **OK**      | `grep -rEn 'wacrm_live_[A-Za-z0-9]{20,}' /app/content` dentro do container: `none`.                                                                                                                                                                                                                               |

## 3. Achado: a recusa é um _soft 404_, e o que ainda falta

**O que a sessão real mostrou.** Dentro do dashboard, quando a página chama `notFound()` (papel insuficiente, slug de um manual público na árvore do operador, slug inexistente), a resposta é **HTTP 200** com a tela de "não encontrado" e `<meta name="robots" content="noindex">`. Não é um bug da implementação: a documentação do Next 16 (`not-found`) diz que, em respostas em _streaming_, o status já saiu como 200 quando o `notFound()` é lançado, e só dá um `404` de verdade quando a checagem acontece **antes** de o stream começar (por exemplo, no `proxy`/middleware).

**O que isso significa para a feature.**

- **A barreira funciona:** no HTML da resposta de um caminho recusado (testado com `/settings/manuals/integracao-cardapio`), **nenhum** texto do manual aparece ("Regras de ouro", "Antes de começar…", "Coletar o consentimento", o título do manual do operador), nem algo com formato de chave de API.
- **O que não bate com os documentos:** o PRD (US-013, FR-5), o design (seção 5) e o ADR-003 dizem que o papel insuficiente "responde 404". O que sai é um soft 404 (status 200). Os testes unitários chamam o componente direto e por isso não enxergam o status.
- **M4** ("o manual só abre para owner/admin") continua verdadeira: o conteúdo não é servido a quem não tem o papel.

**Decisão necessária (do responsável do projeto).**

- **A. Aceitar o soft 404 (recomendado).** Ninguém sem papel lê o manual, não há consulta extra ao banco, e o `noindex` já evita indexação. Basta ajustar a redação do PRD/design ("não é exibido; tela de não encontrado") e registrar a decisão num ADR novo (o ADR-003 está **Proposto**; se for aceito como está, ele afirma "404").
- **B. Exigir um `404` de verdade.** A checagem de papel passa para o middleware (`src/middleware.ts`) só para `/settings/manuals/**`, o que acrescenta uma consulta de perfil por requisição a essas rotas e muda o "só prova sessão" que o ADR-003 descreve.

**O que ainda falta provar (precisa de uma conta agent/viewer real).**

1. Entrar com um usuário **agent ou viewer da mesma conta do owner**. Esperado: o item **Manuais** não aparece na barra lateral, e `/settings/manuals` e `/settings/manuals/configuracao-jornada-pedido` mostram a tela de "não encontrado" sem nenhum texto do manual.
2. Para isso é preciso que alguém **convide** a segunda conta como agent na conta do owner (Configurações → Membros da equipe) ou forneça um usuário que já seja agent. O agente que implementou **não alterou membros** da conta de ninguém.

## 4. Métricas de `SOLUTION.md`

| Métrica                                                            | Situação                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1** a Bella Capri integra só com o link público                 | **Em aberto, por definição**: é medida pelo piloto. A feature entrega o que ela precisa: `/developers`, manual, Swagger e YAML sem login.              |
| **M2** `/developers` e `/developers/api-reference` abrem sem login | **OK**: teste de middleware (`middleware.test.ts`) e `curl` sem cookie na imagem Docker.                                                               |
| **M3** valores fechados do contrato batem com o código             | **OK**: `content.test.ts` (12 testes). Verificado que ele falha quando o YAML diverge (status removido, limite alterado).                              |
| **M4** o manual do operador só abre logado e como owner/admin      | **OK**: sem sessão (curl), como owner (sessão real) e por testes; o caminho recusado não serve o texto. **PENDENTE** só o agent/viewer real (seção 3). |
| **M5** nenhum segredo no conteúdo público                          | **OK**: teste no CI e `grep` dentro da imagem. Verificado que o teste falha quando se cola uma chave falsa num manual.                                 |

## 5. Para repetir

```bash
# imagem e container desta branch, à parte da stack em execução (porta 3200)
get() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2-; }
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(get NEXT_PUBLIC_SUPABASE_URL)" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$(get NEXT_PUBLIC_SUPABASE_ANON_KEY)" \
  --build-arg NEXT_PUBLIC_SITE_URL="$(get NEXT_PUBLIC_SITE_URL)" \
  --build-arg NEXT_PUBLIC_APP_LOCALE="$(get NEXT_PUBLIC_APP_LOCALE)" \
  --build-arg SUPABASE_PUBLIC_URL="$(get SUPABASE_PUBLIC_URL)" \
  -t wacrm-docs-verify .
docker run -d --name wacrm-docs-verify --env-file .env.local -e PORT=3000 -p 3200:3000 wacrm-docs-verify

# limpar
docker rm -f wacrm-docs-verify && docker rmi wacrm-docs-verify
```

## 6. Riscos que a verificação não elimina

- **Rastreamento no Docker** só foi provado para esta imagem; qualquer mudança em `next.config.ts` ou em `content/` pede repetir a seção 2 (o CI roda só `next build`).
- **A chave de API commitada** em `.projects/order-journey-recovery/manual-configuracao.md` continua no repositório e no histórico. Está fora do escopo desta feature, mas precisa ser revogada.
- **Falhas de fuso horário**: `src/lib/dashboard/date-utils.test.ts` tem 2 testes que falham fora de UTC (esta máquina está em -03). Não têm relação com esta feature; passam com `TZ=UTC`.
