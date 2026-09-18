# PRD: Idioma pt-BR completo

> Base: `SOLUTION.md` (v1), `design.md` e `adr/ADR-001` a `ADR-003` desta pasta.
> As histórias estão em ordem de execução, sem dependência para frente (cada uma só depende das anteriores).

## Introdução

O app já fala português do Brasil em quase toda a interface (`messages/pt.json` tem 1730 das 1736 chaves do
`en.json`), mas o resultado ainda parece meio traduzido: 6 chaves faltam (e deixam o CI da `main`
vermelho), há texto fixo em inglês no código, datas e números seguem o navegador em vez do idioma do app, e
a terminologia do `pt.json` é inconsistente. Esta feature fecha essas lacunas e coloca barreiras para o
problema não voltar.

O idioma continua **único por deployment**: `NEXT_PUBLIC_APP_LOCALE`, fixado no build. Não há mudança de
banco de dados.

## Goals

- `npm test` em `src/i18n` passa com 11 de 11 testes (hoje 9 de 11), e o CI da `main` volta a ficar verde.
- Nenhum texto de interface em inglês com `pt` ativo, em todas as telas do critério.
- Datas, números e moeda no formato brasileiro com `pt` ativo: `dd/mm/aaaa`, 24h, `1.234,56`.
- `en` continua com a mesma aparência de hoje.
- Formatação sem locale e texto fixo novo passam a ser barrados automaticamente.

## User Stories

### US-001: Completar as 6 chaves faltantes em `pt` e `es`
**Description:** Como mantenedor, quero o teste de paridade de chaves passando para que o CI da `main` volte
a ficar verde.

**Acceptance Criteria:**
- [ ] `messages/pt.json` contém `Contacts.importModal.resultInvalidPhone`, `resultInvalidPhone_plural`,
  `failedRowsHeading`, `unknownReason`, `toastInvalidPhone` e `toastInvalidPhone_plural`, traduzidas para
  português do Brasil e com os mesmos argumentos ICU do `en.json` (`{count}` etc.)
- [ ] `messages/es.json` contém as mesmas 6 chaves, traduzidas para espanhol
- [ ] `npx vitest run src/i18n` passa: 11 de 11 testes
- [ ] Typecheck/lint passes

### US-002: Traduzir o `quick-replies-manager.tsx`
**Description:** Como operador brasileiro, quero a tela de respostas rápidas em português para não ver
inglês nas configurações.

**Acceptance Criteria:**
- [ ] `quick-replies-manager.tsx` usa `useTranslations` para todo texto visível: títulos, botões, rótulos
  (ex.: "Name"), estado vazio ("No quick replies yet…"), placeholders e os toasts de erro
- [ ] As chaves novas existem em `en.json`, `pt.json`, `es.json` e `ko.json` (o teste de paridade exige os
  quatro), com o mesmo conjunto de argumentos ICU
- [ ] O texto de `en` fica idêntico ao atual
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (Configurações → Respostas rápidas, com `pt` ativo)

### US-003: Traduzir o toast de falha de envio de template
**Description:** Como operador, quero o erro de envio de template em português, com o motivo incluído.

**Acceptance Criteria:**
- [ ] O toast `Failed to send template: ${reason}` em `contact-detail-view.tsx` usa uma chave com argumento
  ICU `{reason}`
- [ ] A chave existe nos quatro catálogos e o texto de `en` fica idêntico ao atual
- [ ] `npm test` passa (paridade e ICU)
- [ ] Typecheck/lint passes

### US-004: Traduzir os textos dos componentes compartilhados `ui/*`
**Description:** Como operador, quero que botões como "Fechar" dos diálogos e painéis apareçam em português
em todas as telas.

**Acceptance Criteria:**
- [ ] `ui/sheet.tsx`, `ui/dialog.tsx` e `ui/gated-button.tsx` não têm texto de interface fixo (incluindo texto
  para leitores de tela, como o `sr-only` "Close")
- [ ] O texto vem de chaves de tradução nos quatro catálogos, e `en` fica idêntico ao atual
- [ ] Os componentes continuam funcionando quando usados dentro e fora de um provider do `next-intl` que já
  esteja na árvore (o layout raiz já o fornece)
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (abrir um diálogo e um painel lateral com `pt`
  ativo)

### US-005: Ativar `react/jsx-no-literals` em `warn` e registrar a linha de base
**Description:** Como mantenedor, quero que texto literal novo em JSX seja sinalizado, e conhecer o volume
atual de avisos para planejar a limpeza. (ADR-001)

**Acceptance Criteria:**
- [ ] `eslint.config.mjs` ativa `react/jsx-no-literals` em nível `warn` apenas para `src/components/**` e
  `src/app/**`, com `allowedStrings` para símbolos (`·`, `/`, `—`, `•`)
- [ ] Testes (`*.test.ts(x)`) não são afetados pela regra
- [ ] A contagem total de avisos, por diretório de primeiro nível em `src/components/` e para `src/app/`,
  fica registrada em `.projects/i18n-pt-br/lint-baseline.md`
- [ ] `npm run lint` termina sem **erros** (só avisos) e o CI continua verde
- [ ] Typecheck passes

### US-006: Resolver avisos de `jsx-no-literals` em inbox e contatos
**Description:** Como operador, quero inbox e contatos sem texto fixo em inglês.

**Acceptance Criteria:**
- [ ] Zero avisos de `react/jsx-no-literals` em `src/components/inbox/**` e `src/components/contacts/**`
- [ ] Toda chave nova existe nos quatro catálogos e `en` fica idêntico ao atual
- [ ] Textos que forem só nome de exemplo (ex.: `Ada Lovelace`) ficam como estão e são justificados no
  código com um comentário
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (inbox e contatos com `pt` ativo)

### US-007: Resolver avisos de `jsx-no-literals` em configurações, agents, dashboard e layout
**Description:** Como operador, quero configurações, agents, dashboard e o layout sem texto fixo em inglês.

**Acceptance Criteria:**
- [ ] Zero avisos de `react/jsx-no-literals` em `src/components/settings/**`, `src/components/agents/**`,
  `src/components/dashboard/**`, `src/components/layout/**`, `src/components/notifications/**`,
  `src/components/presence/**` e `src/components/auth/**`
- [ ] Toda chave nova existe nos quatro catálogos e `en` fica idêntico ao atual
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (configurações, agents, dashboard e login com `pt`
  ativo)

### US-008: Resolver avisos de `jsx-no-literals` em pipelines, broadcasts, automações, flows e interativo
**Description:** Como operador, quero pipelines, broadcasts, automações e flows sem texto fixo em inglês.

**Acceptance Criteria:**
- [ ] Zero avisos de `react/jsx-no-literals` em `src/components/pipelines/**`, `broadcasts/**`,
  `automations/**`, `flows/**` e `interactive/**` (e demais diretórios de `src/components/` que ainda tiverem
  avisos, exceto `ui/`, já tratado na US-004)
- [ ] Toda chave nova existe nos quatro catálogos e `en` fica idêntico ao atual
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (pipelines, broadcasts, automações e flows com `pt`
  ativo)

### US-009: Resolver avisos de `jsx-no-literals` nas páginas de `src/app`
**Description:** Como operador, quero as páginas (login, cadastro, convite e páginas do dashboard) sem texto
fixo em inglês.

**Acceptance Criteria:**
- [ ] Zero avisos de `react/jsx-no-literals` em `src/app/**`
- [ ] Toda chave nova existe nos quatro catálogos e `en` fica idêntico ao atual
- [ ] `npm run lint` mostra **zero avisos** de `react/jsx-no-literals` no repositório
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (login, cadastro, página de convite e notificações
  com `pt` ativo)

### US-010: Criar os presets de formatação e o mapa de locale do `date-fns`
**Description:** Como desenvolvedor, quero uma fonte única de formatação por locale para migrar os pontos
sem repetir padrões. (ADR-003)

**Acceptance Criteria:**
- [ ] `src/i18n/formats.ts` exporta presets nomeados de data (`date`, `dateTime`, `time`, `dayMonth`) e de
  número (`integer`, `compact`) por locale (`en`, `pt`, `es`, `ko`): `pt` em formato numérico
  (`dd/mm/aaaa`, 24h), os demais com `dateStyle: 'medium'`
- [ ] `src/i18n/request.ts` devolve `formats` junto com `locale` e `messages`
- [ ] `src/lib/i18n/date-fns-locale.ts` exporta `getDateFnsLocale(locale)`: `pt`→`ptBR`, `es`→`es`,
  `ko`→`ko`, qualquer outro→`enUS`
- [ ] Teste unitário confirma que `pt` formata `2026-09-18` como `18/09/2026` e que `en` continua
  "Sep 18, 2026"
- [ ] Ficou validado que o `NextIntlClientProvider` do layout raiz herda `formats` do `request.ts`; se não
  herdar, `formats` é passado explicitamente no provider (registrar o resultado em
  `.projects/i18n-pt-br/notes.md`)
- [ ] `npm test` passa
- [ ] Typecheck/lint passes

### US-011: Passar o locale às funções de moeda e número compacto
**Description:** Como operador, quero valores monetários com separadores brasileiros quando o app está em
`pt`, sem mudar a moeda da conta.

**Acceptance Criteria:**
- [ ] `formatCurrency`, `formatCurrencyShort` e `formatCompactNumber` em `src/lib/currency.ts` recebem um
  parâmetro `locale` opcional no fim (padrão `'en'`) e o repassam ao `Intl.NumberFormat`, sem usar
  `undefined`
- [ ] Os 7 arquivos que as chamam passam o locale obtido com `useLocale()`
- [ ] A moeda continua sendo a da conta ou do negócio: uma conta em `USD` com `pt` ativo mostra `US$ 1.234`
- [ ] Testes unitários cobrem `pt` (`R$ 1.234`) e `en` (saída inalterada) para os três formatadores
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (valores de negócios em pipelines e no dashboard)

### US-012: Passar o locale ao `formatRelative` de `trigger-meta.ts`
**Description:** Como operador, quero que a data de "última execução" das automações use o formato do app.

**Acceptance Criteria:**
- [ ] `formatRelative` em `src/lib/automations/trigger-meta.ts` recebe `locale` e, no ramo que hoje chama
  `new Date(iso).toLocaleDateString()`, usa o formato de data do app
- [ ] Os chamadores passam o locale
- [ ] Teste unitário cobre o ramo de data absoluta para `pt` e `en`
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (lista de automações)

### US-013: Migrar `toLocale*` dos componentes para `useFormatter`
**Description:** Como operador, quero datas e números dos componentes no formato do app.

**Acceptance Criteria:**
- [ ] Nenhum `toLocaleString`, `toLocaleDateString` ou `toLocaleTimeString` em `src/components/**`
  (inclui os `en-US` fixos de `pipelines/deal-card.tsx` e `contacts/contact-detail-view.tsx`, e os
  `undefined` de `settings/members-tab.tsx`, `settings/profile-form.tsx` e `settings/api-keys-settings.tsx`)
- [ ] As datas usam `useFormatter().dateTime(..., '<preset>')` e os números `useFormatter().number(...)`
- [ ] Com `en` ativo, a saída de cada ponto migrado fica igual à anterior
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (deal card, detalhe do contato, membros, perfil e
  chaves de API com `pt` ativo)

### US-014: Migrar `toLocale*` das páginas de `src/app` para `useFormatter`
**Description:** Como operador, quero datas e números das páginas no formato do app.

**Acceptance Criteria:**
- [ ] Nenhum `toLocaleString`, `toLocaleDateString` ou `toLocaleTimeString` em `src/app/**` (inclui
  `contacts/page.tsx` com `en-US` fixo, `join/[token]/page.tsx`, `broadcasts/**`, `dashboard/page.tsx`,
  `notifications`, `flows/[id]/runs`, `automations` e `automations/[id]/logs`)
- [ ] Onde a página renderiza no servidor, a data é formatada somente depois da montagem no cliente, para
  evitar diferença de fuso entre servidor e navegador (risco R3 do Design Doc)
- [ ] Com `en` ativo, a saída de cada ponto migrado fica igual à anterior
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (dashboard, broadcasts, contatos, notificações,
  flows, automações e convite com `pt` ativo; console do navegador sem erro de hidratação)

### US-015: Passar `locale` ao `date-fns` e trocar padrões em ordem inglesa
**Description:** Como operador, quero tempo relativo e datas de mensagens em português.

**Acceptance Criteria:**
- [ ] Todo `formatDistanceToNow`, `isToday`/`isYesterday`-baseado e `format` de `date-fns` que aparece na
  interface recebe `{ locale: getDateFnsLocale(locale) }` (`conversation-list.tsx`, `notifications/page.tsx`,
  `flows/[id]/runs/page.tsx`)
- [ ] Datas absolutas com padrão em ordem inglesa (`"MMM d, yyyy HH:mm"`, `"MMMM d, yyyy"`, `"MMM d"`,
  `"PP p"`) em `message-thread.tsx`, `contact-sidebar.tsx`, `media-lightbox.tsx`, `ai-usage.tsx` e
  `flows/[id]/runs/page.tsx` passam a usar os presets de `useFormatter()`
- [ ] Ficam como estão, por serem neutros de locale: `"HH:mm"` e `"HH:mm:ss"`, chaves de agrupamento
  (`"yyyy-MM-dd"`) e o nome de arquivo de `lib/media/filename.ts` (`"yyyyMMdd-HHmmss"`)
- [ ] Com `pt` ativo, o tempo relativo aparece como "há 3 horas" e a data absoluta como `18/09/2026`; com
  `en` ativo, a saída é igual à atual
- [ ] `npm test` passa
- [ ] Typecheck/lint passes
- [ ] **[UI]** Verify in browser using dev-browser skill (inbox, lista de conversas, notificações e runs de
  flows com `pt` ativo)

### US-016: Ativar a regra de formatação direta em `error`
**Description:** Como mantenedor, quero que o CI reprove `toLocale*String()` e `Intl.*Format` diretos.
(ADR-002)

**Acceptance Criteria:**
- [ ] `eslint.config.mjs` ativa, em nível `error`, `no-restricted-properties` para `toLocaleString`,
  `toLocaleDateString` e `toLocaleTimeString`, e `no-restricted-syntax` para `new Intl.DateTimeFormat` e
  `new Intl.NumberFormat`, em `src/**/*.{ts,tsx}`
- [ ] Testes e `src/lib/currency.ts` ficam de fora, com um comentário no config explicando a exceção de
  `currency.ts`
- [ ] `npm run lint` passa sem erros no estado atual do repositório
- [ ] Introduzir de propósito um `new Date().toLocaleDateString()` em um componente faz o lint falhar, e a
  mensagem indica `useFormatter()` (verificar e reverter)
- [ ] Typecheck passes

### US-017: Passada de consistência de terminologia no `pt.json`
**Description:** Como operador, quero termos consistentes no app para não achar que são coisas diferentes.

**Acceptance Criteria:**
- [ ] O glossário está registrado em `.projects/i18n-pt-br/glossary.md`: *pipeline*, *broadcast*, *inbox* e
  *template* ficam em inglês; *deal* vira "negócio" e *flow* vira "fluxo"
- [ ] `messages/pt.json` aplica o glossário: nenhuma ocorrência de "Deal" ou de "Flow" como termo isolado da
  interface, e "Template"/"Modelo" seguem a regra definida no glossário
- [ ] Nomes próprios e termos oficiais da Meta (como "template" de WhatsApp) não são alterados
- [ ] O tratamento "você" é mantido e o restante da tradução não é reescrito
- [ ] `npm test` passa (incluindo paridade de placeholders ICU)
- [ ] Typecheck/lint passes

### US-018: Documentar as convenções de i18n no `CLAUDE.md`
**Description:** Como quem mantém o repositório, quero que futuras sessões saibam as regras de i18n.

**Acceptance Criteria:**
- [ ] A seção i18n do `CLAUDE.md` registra: todo texto de interface usa `useTranslations`; datas e números
  usam `useFormatter()` (nunca `toLocale*`/`Intl` direto); chaves novas entram nos quatro catálogos; o
  idioma é definido por `NEXT_PUBLIC_APP_LOCALE` no build
- [ ] A seção cita a regra `error` de formatação e a regra `warn` de texto literal
- [ ] Nenhuma outra seção do `CLAUDE.md` é alterada

### US-019: Verificar tudo em português na stack Docker
**Description:** Como operador, quero confirmar que o app inteiro está em português no ambiente real.

**Acceptance Criteria:**
- [ ] O `.env.local` define `NEXT_PUBLIC_APP_LOCALE=pt` (os templates versionados continuam em `en`) e a
  stack sobe com `docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local
  up --build -d --wait`, com todos os serviços saudáveis
- [ ] Com uma conta criada por signup, as 13 telas foram percorridas: dashboard, inbox, contatos, pipelines,
  broadcasts, automações, flows, agents, notificações, configurações, login, cadastro e convite
- [ ] O resultado por tela está em `.projects/i18n-pt-br/verification.md`: texto em inglês encontrado
  (se houver), data ou número fora do formato brasileiro (se houver) e erros de i18n no console
- [ ] Toda sobra encontrada foi corrigida, e a tela afetada foi verificada de novo
- [ ] `docs/docker.md` menciona que o idioma é escolhido no `.env.local` e exige rebuild (sem mudar o padrão
  dos templates)
- [ ] `npm run lint`, `npm run typecheck`, `npm test` e `npm run build` passam
- [ ] **[UI]** Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: `messages/pt.json` e `messages/es.json` devem conter as 6 chaves `Contacts.importModal.*` que hoje
  faltam, com os mesmos argumentos ICU do `en.json`.
- FR-2: `quick-replies-manager.tsx`, o toast de template de `contact-detail-view.tsx` e os componentes
  `ui/sheet`, `ui/dialog` e `ui/gated-button` não devem ter texto de interface fixo; o texto vem de chaves de
  tradução.
- FR-3: Toda chave nova deve existir nos quatro catálogos (`en`, `pt`, `es`, `ko`), porque o teste de
  paridade os exige.
- FR-4: `react/jsx-no-literals` deve estar ativa em nível `warn` em `src/components/**` e `src/app/**`, e o
  repositório deve terminar com zero avisos dessa regra.
- FR-5: Nenhum ponto de `src/` deve chamar `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`,
  `new Intl.DateTimeFormat` ou `new Intl.NumberFormat` diretamente, exceto testes e `lib/currency.ts`. A
  regra de ESLint em `error` deve garantir isso.
- FR-6: Datas e números da interface devem usar o locale do app por `useFormatter()`, com presets nomeados
  em `src/i18n/formats.ts`; funções sem React recebem o `locale` por parâmetro.
- FR-7: Com `pt` ativo, a data deve aparecer como `dd/mm/aaaa`, a hora em 24h e os números com vírgula
  decimal e ponto de milhar.
- FR-8: Com `en` ativo, a saída de datas, números e textos deve ser idêntica à de antes desta feature.
- FR-9: Chamadas de `date-fns` que aparecem na interface devem receber o locale de `getDateFnsLocale()`.
  Formatos neutros de locale (`HH:mm`, `yyyy-MM-dd` como chave, nome de arquivo) não são alterados.
- FR-10: A moeda continua sendo a da conta; o idioma só muda a posição do símbolo e os separadores.
- FR-11: `messages/pt.json` deve aplicar o glossário (`pipeline`, `broadcast`, `inbox` e `template` em inglês;
  *deal* → "negócio", *flow* → "fluxo") sem retraduzir o restante.
- FR-12: Os arquivos versionados (`.env.docker.example`, `.env.local.example`, `Dockerfile` e compose)
  continuam com `en` como padrão.

## Non-Goals (Out of Scope)

- Idioma por usuário e seletor de idioma na interface; o idioma segue único por deployment.
- Tradução de conteúdo criado por usuários: templates de WhatsApp, respostas rápidas salvas e mensagens de
  automação.
- README e `docs/` em português.
- Revisão do `es` e do `ko` além das chaves que os testes de paridade exigem (as 6 do `es` e as chaves novas
  nos dois).
- Mudança de moeda: continua por conta (migration 021).
- Erros de servidor e da Meta (respostas `{ error }` das rotas e mensagens de erro da Meta).
- E-mails do Supabase Auth em português.
- Fuso horário por usuário (`timeZone` não é configurado no `next-intl`; vale o fuso do navegador).
- Trocar `NEXT_PUBLIC_APP_LOCALE` por `pt` nos templates versionados.

## Design Considerations

- O visual das telas não muda; só o texto e o formato de datas e números.
- Reaproveitar: `useTranslations`, `useFormatter` e `useLocale` do `next-intl` (89 arquivos já usam
  `useTranslations`), o padrão de chaves `Namespace.grupo.chave` e os testes existentes de paridade e ICU em
  `src/i18n/`.
- Termos que ficam em inglês por escolha do glossário (*pipeline*, *broadcast*, *inbox*, *template*) não são
  erro de tradução.

## Technical Considerations

- **`next-intl` v4.13.5.** `formats`, `timeZone` e `now` definidos em `src/i18n/request.ts` são herdados pelo
  `NextIntlClientProvider` quando ele é renderizado em um Server Component. O layout atual passa `messages` e
  `locale` explicitamente; a US-010 valida se `formats` chega aos componentes.
- **Fuso e SSR.** Componentes `'use client'` também são pré-renderizados no servidor, cujo fuso é o do
  contêiner. Datas devem ser formatadas depois da montagem quando a página renderiza no servidor (US-014).
- **Regras de ESLint.** Config em flat config (`eslint.config.mjs`); `eslint-plugin-react` 7.37.5 já vem com
  `eslint-config-next`, então não há dependência nova. A regra de formatação só vira `error` depois de
  US-011 a US-015, senão reprova o CI.
- **Paridade.** `src/i18n/messages.test.ts` exige as mesmas chaves em `pt`, `es` e `ko` em relação ao `en` e
  os mesmos argumentos ICU; `icu-safety.test.ts` exige `t.raw()`/`t.rich()` para mensagens com `{{…}}` ou
  HTML.
- **Sem migration e sem mudança de dados.** A reversão é `NEXT_PUBLIC_APP_LOCALE=en` e rebuild.
- **Ambiente.** `next build` e `npm run lint` precisam do `node_modules` instalado. O Next tem mudanças que
  quebram convenções antigas: consultar `node_modules/next/dist/docs/` antes de mexer em código específico do
  Next, conforme o `AGENTS.md`.
- **ADRs:** ADR-001 (`jsx-no-literals` em `warn`), ADR-002 (regra `error` de formatação), ADR-003 (presets
  por locale, aceito). Os ADR-001 e ADR-002 ainda estão como "Proposto".

## Success Metrics

- `npx vitest run src/i18n`: 11 de 11 testes passam (hoje 9 de 11).
- `npm run lint`: zero avisos de `react/jsx-no-literals` e zero erros da regra de formatação.
- Zero ocorrências de `toLocale*String`/`Intl.*Format` diretos em `src/` (fora de testes e `currency.ts`).
- As 13 telas verificadas com `pt` ativo, sem texto em inglês e sem data ou número fora do formato brasileiro
  (registrado em `verification.md`).
- Nenhuma regressão visível em `en`.

## Open Questions

- O volume real de avisos de `jsx-no-literals` só se conhece na US-005. Se o total por grupo das US-006 a
  US-009 for grande demais para uma sessão, dividir o grupo em mais histórias antes de executá-lo.
- Chaves novas precisam de tradução em `ko` só para o teste de paridade passar. Aceitar tradução automática
  simples para `ko` e `es` nas chaves novas, sem revisão nativa?
- ADR-001 e ADR-002 seguem como "Proposto": marcar como "Aceito" antes da implementação?
- A herança de `formats` pelo provider do layout (US-010) pode exigir passá-los explicitamente; isso não
  muda o restante do plano.
- O tratamento dos e-mails do Supabase Auth em português fica para uma versão futura.
