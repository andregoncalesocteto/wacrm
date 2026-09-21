# Solution — Idioma pt-BR

> Versão 1 — Gerado após debate em 2026-09-18.
> Rodadas anteriores: 0

---

## PARTE 1 — PRODUTO (O QUÊ)

### 1. Problema

O app já fala português do Brasil quase por inteiro (`messages/pt.json` tem 1730 das 1736 chaves do
`en.json`), mas o resultado ainda parece meio traduzido:

- 6 chaves de `Contacts.importModal.*` faltam em `pt` (e as mesmas 6 em `es`), o que **deixa o CI da
  `main` vermelho** hoje (`src/i18n/messages.test.ts`: 2 testes falham, 9 passam).
- Há texto fixo em inglês no código. O caso mais grave é `quick-replies-manager.tsx`, que não usa
  tradução em nenhum ponto. Há também um toast dinâmico em `contact-detail-view.tsx` e texto fixo nos
  primitivos compartilhados `ui/sheet`, `ui/dialog` e `ui/gated-button`.
- Datas e números não seguem o idioma do app. São 44 pontos de formatação em ~28 arquivos; 23 usam
  `toLocale*()` sem locale (seguem o navegador, não o app), 3 usam `"en-US"` fixo e 9 usam `date-fns`
  sem locale (saída em inglês).
- A terminologia do `pt.json` é inconsistente (ex.: "Deal" 22× e "Negócio" 14×).

### 2. Objetivos

**Goals:**
- pt-BR completo, com a definição de pronto abaixo cumprida e verificável.
- CI da `main` verde novamente.
- Impedir a regressão: novos textos fixos e formatação sem locale devem ser pegos automaticamente.

**Definição de pronto:**
1. Nenhuma chave de `en.json` falta em `pt.json`; o teste de paridade roda e passa.
2. Nenhum texto de interface em inglês com `pt` ativo (telas, toasts, placeholders e `aria-label`).
3. Datas, números e moeda no formato brasileiro: `dd/mm/aaaa`, hora em 24h, `1.234,56`.
4. A stack Docker sobe com `NEXT_PUBLIC_APP_LOCALE=pt` e o app abre em português.

**Non-goals:**
- Idioma por usuário e seletor de idioma na interface (o idioma segue único por deployment).
- Tradução de conteúdo criado por usuários: templates de WhatsApp, respostas rápidas salvas e
  mensagens de automação.
- README e `docs/` em português.
- Revisão do `es` e do `ko`, exceto as 6 chaves do `es` exigidas pelo teste de paridade.
- Moeda: a moeda padrão continua por conta (migration 021, `currency.ts`). Trocar o idioma não muda a
  moeda; só a posição do símbolo e os separadores passam a seguir o idioma.
- Erros de servidor e da Meta (respostas `{ error }` das rotas e mensagens de erro da Meta).
- E-mails do Supabase Auth em português (pendência futura).

### 3. Usuários & Casos de Uso

| Usuário | Caso de Uso | Prioridade |
|---------|-------------|------------|
| Operador brasileiro do app (a equipe do deployment) | Usar todas as telas em português, com datas e números no formato brasileiro | Alta |
| Quem mantém o repositório | CI verde e regressões de i18n barradas automaticamente | Alta |
| Quem faz fork do template | Continuar recebendo o template neutro, com `en` como padrão nos arquivos versionados | Média |

### 4. Requisitos Funcionais

- RF-01: `pt.json` e `es.json` contêm as 6 chaves `Contacts.importModal.*` que faltam
  (`resultInvalidPhone`, `resultInvalidPhone_plural`, `failedRowsHeading`, `unknownReason`,
  `toastInvalidPhone`, `toastInvalidPhone_plural`).
- RF-02: `quick-replies-manager.tsx` usa chaves de tradução em todo o texto visível (títulos, botões,
  rótulos, estado vazio, toasts e placeholders).
- RF-03: O toast dinâmico de `contact-detail-view.tsx` (`Failed to send template: ${reason}`) usa uma
  chave com argumento ICU.
- RF-04: `ui/sheet`, `ui/dialog` e `ui/gated-button` não têm texto fixo; o texto vem de chaves de
  tradução.
- RF-05: Uma varredura procura outros textos fixos (JSX, `placeholder`, `title`, `aria-label`, toasts) e
  os move para chaves.
- RF-06: Todo ponto que formata data, hora, número ou moeda usa o locale do app, não o do navegador nem
  `"en-US"`.
- RF-07: Uma passada de consistência no `pt.json` aplica o glossário: *pipeline*, *broadcast*, *inbox* e
  *template* ficam em inglês; *deal* vira "negócio" e *flow* vira "fluxo". O restante da tradução é
  mantido, sem retradução completa, e o tratamento "você" também.
- RF-08: Uma regra de ESLint contra texto literal em JSX, em nível `warn`, para `src/components` e
  `src/app`.
- RF-09: Uma regra de ESLint estreita, em nível `error`, proíbe `toLocale*String()` e `Intl.*Format`
  diretos.
- RF-10: Com `NEXT_PUBLIC_APP_LOCALE=pt`, a stack Docker sobe e o app abre em português.

### 5. Requisitos Não-Funcionais

- RNF-01: Sem migration nem alteração de dados. A reversão é voltar `NEXT_PUBLIC_APP_LOCALE` para `en` e
  rebuildar.
- RNF-02: Nenhum efeito no comportamento de quem usa `en`, `ko` ou `es`.
- RNF-03: `npm run lint`, `npm run typecheck`, `npm test` e `npm run build` passam.
- RNF-04: A formatação de datas continua no cliente, com o fuso do usuário; o fuso por usuário está fora
  do escopo.

### 6. Métricas de Sucesso

- `npm test` em `src/i18n` passa: 11 de 11 testes (hoje 9 de 11).
- Zero avisos de `error` da regra de formatação e nenhum texto em inglês nas telas verificadas com `pt`
  ativo.
- Telas percorridas com `pt` ativo: dashboard, inbox, contatos, pipelines, broadcasts, automações,
  flows, agents, notificações, configurações, login, cadastro e convite.

---

## PARTE 2 — ARQUITETURA (O COMO)

### Contexto técnico

- O idioma é único por deployment: `NEXT_PUBLIC_APP_LOCALE`, fixado no build (`src/i18n/request.ts`,
  `Dockerfile` e `docker-compose.yml`). Não existe seleção de idioma por usuário.
- O projeto usa `next-intl`. 89 arquivos já usam `useTranslations`, e há testes de paridade de chaves e de
  segurança de ICU em `src/i18n/`.
- O ESLint não tem nenhuma regra de i18n hoje, e o CI roda `lint`, `typecheck`, `test` e `build`.
- Funções puras sem React formatam valores (`lib/currency.ts`, `lib/presence.ts`, `lib/media/filename.ts`,
  `lib/automations/trigger-meta.ts`) e não podem usar hooks.

### Decisões Técnicas

#### Textos fixos no código
**Decisão:** chaves por componente com `useTranslations` (o padrão do projeto), mais uma regra de ESLint
contra texto literal em JSX em nível `warn`, limitada a `src/components` e `src/app`. O `error` fica para
depois, quando o volume de avisos estiver zerado.
**Alternativas consideradas:** ferramenta de extração automática (exagero para poucos arquivos e gera
chaves fora do padrão); só o teste de paridade atual (não pega texto fixo); a regra em `error` já (exigiria
limpar todos os avisos de uma vez).
**Justificativa:** segue o padrão já consolidado e barra novos textos fixos sem travar o CI.
[ADR RECOMENDADO]

#### Formatação de data, número e moeda
**Decisão:** `useFormatter()` e `getFormatter()` do `next-intl` nos componentes; funções puras recebem o
locale por parâmetro; `date-fns` ganha um mapa de locale (`pt`→`ptBR`, `es`, `ko`, `en`→`enUS`). A
formatação fica no cliente. Padrão brasileiro: `dd/mm/aaaa`, 24h, `1.234,56`.
**Alternativas consideradas:** um util próprio `lib/format.ts` (uma segunda fonte de verdade ao lado do
`next-intl`); sobrescrever o locale global com um hack de `Intl` (frágil).
**Justificativa:** uma só fonte de locale, sem código novo de formatação para manter.

#### Garantia no CI
**Decisão:** completar as 6 chaves em `pt` e `es` para o teste de paridade existente passar, e adicionar
uma regra de ESLint estreita em nível `error` que proíbe `toLocale*String()` e `Intl.*Format` diretos.
**Alternativas consideradas:** só completar as chaves (não impede a volta ao formato americano); um teste
que varre o código atrás de `"en-US"` (redundante com a regra).
**Justificativa:** como todos os 44 pontos são limpos nesta feature, a regra estreita pode ser `error` sem
gerar ruído.
[ADR RECOMENDADO]

#### Ativação e rollout
**Decisão:** os templates versionados (`.env.docker.example`, `.env.local.example`, `Dockerfile` e compose)
continuam em `en`. O `pt` é definido só no `.env.local` de quem quer o idioma, seguido de
`docker compose … up --build`. A verificação dos critérios 2 e 3 é feita com a skill `dev-browser` no
Docker com `pt` ativo, e uma conferência final do português é feita pelo dono do projeto.
**Alternativas consideradas:** trocar o padrão versionado para `pt` (mudaria o template para todo fork);
verificação só manual.
**Justificativa:** o repositório continua um template neutro, e a adoção do `pt` por padrão é uma linha
que pode ser feita depois.

### ADRs a Formalizar
- [ ] ADR-001: regra de ESLint contra texto literal em JSX (`warn`) e caminho para `error`
- [ ] ADR-002: regra estreita de ESLint (`error`) para formatação de data e número

---

## PARTE 3 — ABERTO & RISCOS

### Suposições não validadas
- [SUPOSIÇÃO NÃO VALIDADA] O "Close" dos primitivos `ui/*` aparece em todas as telas com dialog ou sheet.
  Só li a busca por texto, sem abrir os arquivos.
- [SUPOSIÇÃO NÃO VALIDADA] Todos os pontos de formatação de data rodam no cliente. Só li a lista de
  linhas, sem abrir cada arquivo.
- [SUPOSIÇÃO NÃO VALIDADA] A `dev-browser` consegue logar e percorrer todas as telas com uma conta criada
  por signup no Docker (auto-confirmação de e-mail ligada).
- [SUPOSIÇÃO NÃO VALIDADA] Quem usa o app aceita ver alguns erros de servidor em inglês.

### Perguntas em aberto
- [PERGUNTA EM ABERTO] Os e-mails do Supabase Auth em português entram numa versão futura? Hoje só o e-mail
  de recuperação de senha sai, em inglês.
- [PERGUNTA EM ABERTO] A varredura de textos fixos é best-effort: os textos que ela deixar passar só
  aparecem na navegação com `pt` ativo.

### Tensões identificadas
- ⚠️ TENSÃO: o `es` estava fora do escopo, mas o teste de paridade exige as mesmas 6 chaves nele. Resolvida
  incluindo apenas essas 6 chaves.
- ⚠️ TENSÃO: o `next-intl` exige um `timeZone`, e formatar no servidor (fuso do contêiner) divergiria do
  navegador. Resolvida mantendo a formatação no cliente.

---

## Próximo passo
Execute `/gen-design` usando este SOLUTION.md como contexto para gerar o Design Doc detalhado, ou vá
direto para `/ralph:prd` para gerar o PRD desta feature.
