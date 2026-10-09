# Verificação final: Manuais e Swagger na web (integration-docs)

Verificação da feature na branch `ralph/integration-docs`, contra os critérios da US-017 de `prd.json`, as métricas M1 a M5 de `SOLUTION.md` e o plano de aceite da seção 8 de `design.md`.

**Leia primeiro os limites.** O que depende do código foi provado por testes automatizados (a suíte inteira, `TZ=UTC npm test`, passa com 2576 testes) e, para a entrega, **numa imagem Docker construída desta branch**. Três verificações exigem um **login de owner/admin**, um **login de agent ou viewer** e uma **chave de API real**, e o agente que implementou não tinha nenhum dos três. Elas estão na seção 3, marcadas como **PENDENTE**, com o passo exato para fechá-las. Por causa delas a US-017 **não** foi marcada como concluída.

## 1. Como foi verificado

- Imagem construída com `docker build` usando os argumentos de build do `.env.local` e a tag `wacrm-docs-verify`, **à parte** da imagem `wacrm-app:latest` e da stack em execução do usuário (nada dela foi derrubado ou recriado). Container na porta 3200.
- Requisições com `curl`, **sem cookie nenhum**, contra `http://localhost:3200`.
- Tamanho da imagem: 233 MB contra 228 MB da imagem atual da `main` (sem inchaço). O build não imprimiu o aviso do Turbopack sobre rastreamento do projeto inteiro.

## 2. Resultado dos itens da US-017

| #   | Critério                                                                                                                            | Resultado    | Evidência                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/developers`, `/developers/integracao-cardapio`, `/developers/api-reference` e `/developers/openapi.yaml` respondem 200 sem cookie | **OK**       | Quatro `HTTP/1.1 200 OK`; o YAML sai com `content-type: application/yaml; charset=utf-8`.                                                                                  |
| 2   | Como owner, `/settings/manuals` e o manual do operador respondem 200 e mostram o manual                                             | **PENDENTE** | Sem login. Parte provada: os arquivos estão na imagem (item 6) e o caminho de leitura funciona a partir do `cwd` do container (`/app/content/manuals/pt/…`, 18553 bytes).  |
| 3   | `curl -I` em `/settings/manuals/…` mostra `Cache-Control: private, no-store`                                                        | **OK**       | `307 → /login` com `Cache-Control: private, no-store` nas duas rotas. O `404` de uma página dinâmica sai com `private, no-cache, no-store, …`.                             |
| 4   | Como agent ou viewer, `/settings/manuals` responde 404; sem sessão, redireciona para `/login`                                       | **PARCIAL**  | Sem sessão: **OK** (307 para `/login`). Agent/viewer: **PENDENTE** em navegador; coberto por `access.test.ts` e `manuals-pages.test.tsx`, que rodam o `requireRole` real.  |
| 5   | No Swagger, "Try it out" em `GET /api/v1/me` com uma chave de teste devolve 200 na stack Docker                                     | **PENDENTE** | Sem chave. Parte provada (no `next dev`): a chamada vai para a mesma origem e devolve 401 com chave falsa; a chave não é gravada em `localStorage` nem `sessionStorage`.   |
| 6   | O conteúdo está na imagem e o rastreamento não puxou o projeto inteiro                                                              | **OK**       | `/app/content` contém `api/openapi.yaml` e os dois `.md`; `/app` contém só `.next content node_modules package.json public server.js` (sem `src/`, `.projects/`, `docs/`). |
| 7   | Slug do manual do operador e slug inexistente em `/developers/**` são 404                                                           | **OK**       | `/developers/configuracao-jornada-pedido` e `/developers/nao-existe`: `HTTP/1.1 404 Not Found`.                                                                            |
| 8   | Nenhum conteúdo enviado tem algo com formato de chave de API                                                                        | **OK**       | `grep -rEn 'wacrm_live_[A-Za-z0-9]{20,}' /app/content` dentro do container: `none`.                                                                                        |

## 3. O que falta, e como fechar

Cada passo leva poucos minutos. Use `http://localhost:3200` (container já descrito acima, recriável com o comando da seção 5) ou o seu ambiente atualizado com esta branch.

1. **Owner/admin vê o manual** (item 2). Entre com um usuário owner ou admin e abra `/settings/manuals`. Esperado: a lista com **um** manual ("Configuração da jornada de pedido"); ao abri-lo, o texto com o índice lateral. Na barra lateral de Configurações, o item **Manuais** no grupo de workspace.
2. **Agent/viewer não vê** (item 4). Entre com um usuário agent ou viewer. Esperado: o item **Manuais** não aparece na barra lateral, e `/settings/manuals` e `/settings/manuals/configuracao-jornada-pedido` respondem 404.
3. **Try it out com chave real** (item 5). Crie, em **Configurações → Chaves de API**, uma chave de teste (escopo `events:write` serve; só `GET /api/v1/me` é chamado e ele não exige escopo). Abra `/developers/api-reference`, **Authorize**, cole a chave, abra `GET /api/v1/me`, **Try it out**, **Execute**. Esperado: `200` com a conta e a chave. Revogue a chave depois.

## 4. Métricas de `SOLUTION.md`

| Métrica                                                            | Situação                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** a Bella Capri integra só com o link público                 | **Em aberto, por definição**: é medida pelo piloto. A feature entrega o que ela precisa: `/developers`, manual, Swagger e YAML sem login. |
| **M2** `/developers` e `/developers/api-reference` abrem sem login | **OK**: teste de middleware (`middleware.test.ts`) e `curl` sem cookie na imagem Docker.                                                  |
| **M3** valores fechados do contrato batem com o código             | **OK**: `content.test.ts` (12 testes). Verificado que ele falha quando o YAML diverge (status removido, limite alterado).                 |
| **M4** o manual do operador só abre logado e como owner/admin      | **OK em teste e sem sessão**; **PENDENTE** em navegador logado (seção 3).                                                                 |
| **M5** nenhum segredo no conteúdo público                          | **OK**: teste no CI e `grep` dentro da imagem. Verificado que o teste falha quando se cola uma chave falsa num manual.                    |

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
