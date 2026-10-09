# ADR-004 — A recusa de papel no manual do operador é um _soft 404_ (HTTP 200 com a tela de "não encontrado")

- **Status:** Aceito (decisão do responsável do projeto, 2026-10-09)
- **Data:** 2026-10-09
- **Feature:** integration-docs · refina o ADR-003 num ponto · verificação em `verification.md`, seção 3

## 1. Contexto

- O ADR-003, o design e o PRD dizem que quem não é owner/admin "recebe 404" ao abrir `/settings/manuals/**`. A decisão de fundo era: o manual do operador **não é servido** a quem não tem o papel.
- A verificação com sessões reais, numa imagem Docker da branch, mostrou que a recusa sai com **HTTP 200**, com a tela de "não encontrado" e `<meta name="robots" content="noindex">`. Foi testado com um owner, com um agent criado para o teste e com slugs inexistentes ou de manual público.
- Isso não é um defeito do código. A documentação do Next 16 (`not-found`) diz que, numa resposta em _streaming_, o status já foi enviado quando o `notFound()` é lançado, e que só se obtém um `404` de verdade checando **antes** de o stream começar (por exemplo, no `proxy`/middleware). O dashboard faz streaming, e a página precisa ler o cookie de sessão, então não pode ser pré-renderizada.
- No HTML da resposta recusada **não aparece nenhum trecho** do manual (conferido com frases do manual e com um padrão de chave de API), e a resposta sai com `Cache-Control: private, no-store`.
- O middleware (`src/middleware.ts`) hoje só prova que há sessão. Levar a checagem de papel para lá exigiria uma consulta de perfil por requisição às rotas `/settings/manuals/**`.
- As páginas públicas (`/developers/**`) são estáticas e continuam com **404 de verdade** (`dynamicParams = false`); o caso aqui é só a área logada.
- Os testes unitários chamam o Server Component direto e por isso não enxergam o status HTTP.

## 2. Decisão

Vamos aceitar que a recusa de papel em `/settings/manuals/**` seja um _soft 404_ (HTTP 200 com a tela de "não encontrado", `noindex` e nenhum conteúdo do manual), e manter a checagem de papel na própria página em vez de movê-la para o middleware.

## 3. Alternativas Consideradas

| #   | Alternativa                                                                                 | Prós                                                                                                                                          | Contras                                                                                                                                                               | Motivo                                                                          |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A   | **Manter a checagem na página; aceitar o soft 404**                                         | Nenhuma consulta extra ao banco; o middleware continua só provando sessão; o conteúdo não é servido; `noindex` evita indexação; já está feito | O status HTTP é 200, não 404; um monitor ou proxy que leia o status não distingue; os testes unitários não cobrem o status                                            | **Escolhida**                                                                   |
| B   | Mover a checagem de papel para o middleware, só em `/settings/manuals/**`, para um 404 real | Status 404 correto; a página nem chega a renderizar                                                                                           | Uma consulta de perfil por requisição a essas rotas; o middleware passa a conhecer papéis (hoje só sessão); duplica a regra de `requireRole` e exige mantê-las iguais | Rejeitada: custo e acoplamento para um ganho que só aparece no código de status |
| C   | Responder com `redirect('/settings')` para quem não tem o papel                             | O usuário cai numa tela útil                                                                                                                  | Também é uma resposta em _streaming_ (mesmo limite de status); revela que a rota existe; esconde o motivo                                                             | Rejeitada: não resolve o status e piora o sinal para quem sonda a rota          |
| D   | Mostrar o manual a todos os membros e esconder só o item da barra                           | Sem recusa para tratar                                                                                                                        | Contraria a regra decidida (só owner/admin) e o requisito M4                                                                                                          | Rejeitada: viola o requisito                                                    |

## 4. Consequências

**Positivas**

- A regra de acesso fica num lugar só, a página (`requireManualsAccess`), com testes que rodam o `requireRole` real.
- Sem custo extra por requisição e sem novo acoplamento no middleware.
- A tela de recusa é a mesma de qualquer rota inexistente do app, então não revela se o manual existe.

**Negativas / trade-offs**

- O código de status da recusa é 200. Qualquer ferramenta que dependa do status (monitoramento, proxy, scanner) vai ver sucesso numa rota que o usuário não pode abrir.
- Os testes unitários não pegam o status; só uma requisição real o mostra.

**Obrigações**

- A redação do PRD e do design passa a dizer "tela de não encontrado (soft 404)" para o papel insuficiente na área logada. As páginas públicas continuam com 404 real.
- O texto do ADR-003 que diz "404" para a recusa de papel deve ser lido como a tela de "não encontrado" descrita aqui; este ADR prevalece nesse ponto.
- Se um dia o status HTTP passar a importar (por exemplo, para um monitor), a saída é a alternativa B, num ADR novo que substitua este.
- A tela de "não encontrado" do app usa as cores do tema (`src/app/not-found.tsx`), para que a recusa seja legível nos dois modos.
