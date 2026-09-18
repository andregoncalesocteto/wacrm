# Design Doc — Idioma pt-BR

> Base: `.projects/i18n-pt-br/SOLUTION.md` (v1). O template `design-docs/templates/DESIGN_TEMPLATE.md`
> não existe neste repositório (ele vive nos projetos-alvo do `workflow_v1`); a estrutura abaixo segue as
> 9 seções pedidas pelo comando.
>
> Status: rascunho para revisão · 2026-09-18

## Correções ao SOLUTION.md

Ao abrir os arquivos para este design, três pontos da base mudaram:

- `lib/presence.ts` **não** formata data com locale (a busca só o listou por outra correspondência), e
  `lib/media/filename.ts` usa `date-fns` para montar um **nome de arquivo** (`yyyyMMdd-HHmmss`), que
  precisa ser neutro de locale. Os dois **saem** de RF-06. As funções puras que entram são
  `lib/currency.ts` e `lib/automations/trigger-meta.ts`.
- Componentes marcados `'use client'` também são **pré-renderizados no servidor** pelo Next. "A formatação
  roda no cliente" vale para o que é renderizado depois de um `fetch` no navegador, mas não para todo
  componente cliente. Isso muda o risco de fuso (seção 7, R3).
- Manter os formatos de `en` idênticos (RNF-02) e ainda entregar `dd/mm/aaaa` em pt (critério 3) exige um
  preset por locale, não um preset único. Decidido: D2 (seção 6, ADR-003).

---

## 1. Contexto

O app já fala pt-BR em ~99,7% (`messages/pt.json`: 1730 de 1736 chaves), com `next-intl` v4.13.5, 89
arquivos usando `useTranslations` e testes de paridade de chaves e de ICU em `src/i18n/`. O idioma é único
por deployment: `NEXT_PUBLIC_APP_LOCALE`, fixado no build, lido em `src/i18n/request.ts` e repassado ao
`NextIntlClientProvider` em `src/app/layout.tsx` (com `messages` e `locale`, sem `timeZone`).

O que falta, do ponto de vista técnico:

1. **CI vermelho na `main`:** `messages.test.ts` falha para `pt` e `es` (6 chaves
   `Contacts.importModal.*` faltando em cada; 2 testes falham e 9 passam).
2. **Texto fixo em inglês:** `quick-replies-manager.tsx` inteiro (não usa `useTranslations`), o toast
   `Failed to send template: ${reason}` em `contact-detail-view.tsx` e `ui/sheet`, `ui/dialog` e
   `ui/gated-button`.
3. **Formatação sem locale:** 44 pontos em ~28 arquivos:
   - 13 `toLocaleString()` sem argumentos (números);
   - 6 `toLocaleDateString()` sem locale ou com `undefined` (seguem o navegador);
   - 3 `toLocaleDateString('en-US', …)` fixos: `deal-card.tsx`, `contact-detail-view.tsx` e
     `contacts/page.tsx`;
   - `Intl.NumberFormat(undefined, …)` em `currency.ts`;
   - 9 arquivos com `date-fns`, todos sem `locale` e com padrões em ordem inglesa
     (`"MMM d, yyyy HH:mm"`, `"MMMM d, yyyy"`, `"MMM d"`, `"PP p"`).
4. **Terminologia inconsistente** no `pt.json` (Deal 22× / Negócio 14×; Template 17× / Modelo 22×).
5. **Nenhuma barreira contra regressão:** o ESLint (`eslint.config.mjs`) só carrega
   `eslint-config-next/core-web-vitals` e `typescript`, sem regra de i18n.

Restrições herdadas: sem migration; `en`, `ko` e `es` não podem regredir; o teste de ICU (`icu-safety`) e
o de paridade continuam valendo.

## 2. Solução Proposta

Quatro frentes independentes, entregues em fases pequenas. A `main` volta a ficar verde na primeira.

```
                     NEXT_PUBLIC_APP_LOCALE=pt  (build)
                                  │
                       src/i18n/request.ts
              ┌───────────────────┼──────────────────────┐
              ▼                   ▼                      ▼
        messages/*.json      formats (por locale)   (timeZone: não definido,
        (chaves + glossário)   dateTime / number      = fuso do navegador)
              │                   │
              ▼                   ▼
   useTranslations()        useFormatter() / getFormatter()
   (textos fixos → chaves)  (datas e números nos componentes)
                                  │
              funções puras  ◄────┘  recebem `locale` por parâmetro
              (currency.ts, trigger-meta.ts)
                                  │
                  date-fns ──► só onde há lógica de tempo relativo
                               (formatDistanceToNow, isToday…), com
                               `{ locale }` vindo de getDateFnsLocale()

   CI:  vitest (paridade + ICU)  ·  eslint: jsx-no-literals (warn)
                                          + formatação direta (error)
```

Resumo das decisões (do SOLUTION):

- **Textos:** `useTranslations` por componente; regra `jsx-no-literals` em `warn`.
- **Formatação:** `useFormatter()` / `getFormatter()` do `next-intl`, com presets nomeados em `formats`;
  `date-fns` só para tempo relativo, agora com `locale`.
- **Funções puras:** recebem `locale` como parâmetro; sem hooks.
- **CI:** 6 chaves em `pt` e `es`; regra estreita em `error` para `toLocale*String()` e
  `Intl.DateTimeFormat`/`Intl.NumberFormat` diretos.
- **Ativação:** `pt` só no `.env.local` de quem quer, com rebuild; templates versionados seguem em `en`.

## 3. Arquitetura

### Componentes

| Componente | Responsabilidade | Tecnologia | Mudança |
|---|---|---|---|
| `messages/{en,pt,es,ko}.json` | Catálogos de texto | JSON, ICU | +6 chaves em `pt` e `es`; +chaves de `quick-replies-manager`, do toast de template e dos primitivos `ui/*`; passada de glossário em `pt` |
| `src/i18n/request.ts` | Resolve locale e mensagens por request | `next-intl/server` | Passa a devolver também `formats` |
| `src/i18n/formats.ts` (novo) | Presets nomeados de data e número por locale | TS | Novo |
| `src/lib/i18n/date-fns-locale.ts` (novo) | Mapa `locale → Locale` do `date-fns` | `date-fns/locale` | Novo |
| `src/app/layout.tsx` | Provider do `next-intl` | React | Sem `timeZone` (mantém o fuso do navegador); verificar herança de `formats` |
| Componentes com data/número (~28 arquivos) | Exibir valores formatados | `useFormatter` | Trocar `toLocale*` e `date-fns format` |
| `lib/currency.ts`, `lib/automations/trigger-meta.ts` | Formatação sem React | TS | Parâmetro `locale` |
| `quick-replies-manager.tsx`, `contact-detail-view.tsx`, `ui/{sheet,dialog,gated-button}.tsx` | Interface | React | Texto fixo → `useTranslations` |
| `eslint.config.mjs` | Barreira de regressão | ESLint 9 (flat config) | 2 regras novas |

### Fluxo principal (build → render)

```
build ─ NEXT_PUBLIC_APP_LOCALE=pt ─► request.ts: locale='pt', messages=pt.json, formats=FORMATS.pt
   │
   ▼
RootLayout (server) ─► <NextIntlClientProvider messages locale>   (herda formats do request.ts)
   │
   ▼
componente cliente
   ├─ t('chave')                        → texto em português
   ├─ format.dateTime(d, 'short')       → 18/09/2026
   ├─ format.number(1234.5)             → 1.234,5
   └─ formatDistanceToNow(d,{locale})   → "há 3 horas"
```

## 4. Modelo de Dados

Não há tabela, migration nem dado persistido (RNF-01). As estruturas relevantes:

```ts
// src/i18n/formats.ts — presets nomeados, por locale (ver alternativa D)
export type FormatPresets = {
  dateTime: Record<'date' | 'dateTime' | 'time' | 'dayMonth', Intl.DateTimeFormatOptions>;
  number: Record<'integer' | 'compact', Intl.NumberFormatOptions>;
};
export const FORMATS: Record<'en' | 'pt' | 'es' | 'ko', FormatPresets>;

// src/lib/i18n/date-fns-locale.ts
import type { Locale } from 'date-fns';
export function getDateFnsLocale(locale: string): Locale;   // pt→ptBR, es→es, ko→ko, default→enUS
```

Catálogos: nada muda na forma (árvore de chaves aninhadas, plural com o sufixo `_plural`). As chaves novas
seguem o padrão existente `Namespace.grupo.chave`, por exemplo
`Settings.quickReplies.*`, `Contacts.detail.toastTemplateFailed` (com `{reason}`) e `Ui.common.close`.

## 5. APIs / Interfaces

Não há endpoint novo. As interfaces internas que mudam:

**Formatação em componente**
```tsx
const format = useFormatter();
format.dateTime(new Date(note.created_at), 'dateTime');   // antes: format(d, "MMM d, yyyy HH:mm")
format.number(count);                                      // antes: count.toLocaleString()
```

**Funções puras** (parâmetro novo no fim, com padrão para não quebrar chamadas existentes)
```ts
formatCurrency(value: number, currency = DEFAULT_CURRENCY, locale = 'en'): string
formatCurrencyShort(value: number, currency = DEFAULT_CURRENCY, locale = 'en'): string
formatCompactNumber(value: number, locale = 'en'): string
formatRelative(iso, t, locale = 'en')     // trigger-meta.ts: o ramo final deixa de usar toLocaleDateString()
```
Os 7 arquivos que chamam `formatCurrency*` passam o locale obtido com `useLocale()`.

**Regras de ESLint** (flat config, `eslint.config.mjs`)
```js
{
  files: ['src/components/**/*.tsx', 'src/app/**/*.tsx'],
  plugins: { react },                               // já carregado por eslint-config-next
  rules: { 'react/jsx-no-literals': ['warn', { noStrings: true, allowedStrings: ['·', '/', '—', '•'] }] },
},
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/**/*.test.*', 'src/lib/currency.ts'],   // currency.ts usa Intl com locale explícito
  rules: {
    'no-restricted-properties': ['error',
      { property: 'toLocaleString',     message: 'Use useFormatter() ou passe o locale.' },
      { property: 'toLocaleDateString', message: 'Use useFormatter().dateTime.' },
      { property: 'toLocaleTimeString', message: 'Use useFormatter().dateTime.' }],
    'no-restricted-syntax': ['error', {
      selector: "NewExpression[callee.object.name='Intl'][callee.property.name=/^(DateTimeFormat|NumberFormat)$/]",
      message: 'Use useFormatter() ou passe o locale.' }],
  },
},
```
As opções exatas (`allowedStrings`, exceções de arquivo) se fecham na implementação, com o volume real de
avisos. O `react` já vem com `eslint-config-next` (`eslint-plugin-react` 7.37.5), então não há dependência
nova.

## 6. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Decisão |
|---|---|---|---|---|
| A | Util próprio `lib/format.ts` para datas e números | Independe de hook; serve às funções puras | Segunda fonte de locale ao lado do `next-intl`; código novo para manter | Rejeitada |
| B | Hack global de `Intl`/`toLocale*` para forçar o locale | Zero mudança nos 44 pontos | Frágil, oculta o problema e afeta bibliotecas | Rejeitada |
| C | Extração automática de textos (codemod) | Rápida em volume | Exagero para poucos arquivos; chaves fora do padrão do projeto | Rejeitada |
| D1 | **Preset único** de data numérica (`{day:'2-digit',month:'2-digit',year:'numeric'}`) para todos os locales | Simples, uma configuração | Muda a saída de `en` (de "Sep 18, 2026" para "09/18/2026"), contra RNF-02 | Rejeitada |
| D2 | **Preset por locale** em `formats.ts`: `pt` numérico (`dd/mm/aaaa`); `en`, `ko` e `es` com `dateStyle:'medium'` | Cumpre o critério 3 sem mexer em `en` | Uma tabela pequena a manter | **Aceita** (ADR-003) |
| E | `date-fns` também para datas absolutas, com `locale` | Sem `useFormatter` nesses pontos | Padrões em ordem inglesa (`MMM d, yyyy`) continuam errados em pt; duas formas de formatar | Rejeitada |
| F | Regra `jsx-no-literals` já em `error` | Barreira total | Exige zerar todos os avisos existentes de uma vez | Adiada |

🔴 **ADR NEEDED:** (i) regra `jsx-no-literals` em `warn` e o caminho para `error`; (ii) regra estreita
`error` para formatação direta de data e número; (iii) preset por locale em `formats.ts` (D2).

## 7. Riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | Textos fixos que a varredura não achar (strings montadas em código, `aria-label`, `title`) | Média | Médio | `jsx-no-literals` em `warn` + navegação com `pt` ativo em todas as telas do critério; corrigir e repetir |
| R2 | `date-fns` com `locale` muda a saída de `en` (ex.: `formatDistanceToNow`) | Baixa | Baixo | O `enUS` é o padrão do `date-fns`; teste de fumaça para `en` antes e depois |
| R3 | Componentes cliente pré-renderizados no servidor formatam data com o fuso do contêiner (UTC) e divergem do navegador (erro de hidratação) | Média | Médio | Os componentes de tela buscam os dados no navegador (`fetch` após montar), então a data só aparece depois da hidratação. Confirmar por arquivo na fase 2; onde houver renderização no servidor, formatar após montar (`useEffect`) ou usar `suppressHydrationWarning` no nó |
| R4 | `NextIntlClientProvider` do layout recebe `messages` e `locale` explícitos e pode não herdar `formats` do `request.ts` | Média | Alto | Validar na fase 2 com um preset de teste; se não herdar, passar `formats` no `<NextIntlClientProvider>` do layout (o `formats` é serializável) |
| R5 | `next-intl` reporta erro de ambiente por `timeZone` ausente (`ENVIRONMENT_FALLBACK`) | Baixa | Baixo | Não definir `timeZone` de propósito (fuso por usuário está fora do escopo); se o aviso incomodar, tratar no `onError` |
| R6 | Regra de ESLint `error` acusa falso positivo em código legítimo (teste, `currency.ts`) | Média | Baixo | `ignores` de testes e de `currency.ts`; medir os avisos na fase 4 antes de promover a `error` |
| R7 | Terminologia trocada no `pt.json` quebra o sentido em algum contexto | Baixa | Médio | Passada de glossário com revisão sua; só troca a forma entre chaves já existentes, sem retradução |

## 8. Plano de Implementação

Ordem pensada para a `main` ficar verde primeiro e para a regra `error` só entrar depois de a formatação
estar limpa.

| Fase | Entregas | Verificação |
|---|---|---|
| **F0 · CI verde** | 6 chaves `Contacts.importModal.*` em `pt.json` e `es.json` | `npx vitest run src/i18n`: 11 de 11 passam |
| **F1 · Textos fixos** | Chaves e `useTranslations` em `quick-replies-manager.tsx`, no toast de `contact-detail-view.tsx` e em `ui/{sheet,dialog,gated-button}.tsx`; varredura de outros textos; paridade nos 4 catálogos | `npm test`, `npm run typecheck`, `npm run lint` |
| **F2 · Formatação** | `formats.ts` e `request.ts`; `getDateFnsLocale`; migrar os pontos de `toLocale*` e de `date-fns` (exceto `filename.ts`); parâmetro `locale` em `currency.ts` e `trigger-meta.ts` e nos 7 chamadores; validar R3 e R4 | Testes unitários de `currency` e do mapa de locale; `en` inalterado |
| **F3 · Glossário** | Passada de consistência no `pt.json` (*deal*→negócio, *flow*→fluxo; *pipeline*, *broadcast*, *inbox*, *template* mantidos) | Paridade de placeholders (teste existente) |
| **F4 · Barreiras** | `jsx-no-literals` em `warn`; regra de formatação em `error` (só depois de F2 limpa) | `npm run lint` sem `error`; contagem de avisos registrada |
| **F5 · Verificação e docs** | `.env.local` com `NEXT_PUBLIC_APP_LOCALE=pt` e `up --build`; navegação com `dev-browser` pelas 13 telas do critério; ADRs 001–003; nota em `docs/docker.md` sobre o idioma | Lista de sobras em inglês zerada; conferência final do português por você |

F0 pode virar um PR isolado e imediato. F1 a F3 são independentes entre si. F4 depende de F2. F5 fecha.

## 9. Observabilidade

É uma mudança de build e de interface, sem serviço em produção a monitorar; a observabilidade é de
desenvolvimento e de CI.

- **Logs:** erros do `next-intl` (`MISSING_MESSAGE`, `INVALID_MESSAGE`, `ENVIRONMENT_FALLBACK`) aparecem no
  console do navegador e do servidor. Na verificação da F5, percorrer as telas com o console aberto e
  registrar qualquer ocorrência. Um `onError` no provider só entra se o volume justificar.
- **Métricas:** número de testes de i18n passando (11 de 11); contagem de avisos de `jsx-no-literals` por
  fase, com tendência a zero; número de pontos com `toLocale*` ou `Intl` direto (meta: 0, garantido pela
  regra em `error`).
- **Alertas:** o próprio CI. Qualquer chave faltando em `pt`, `es` ou `ko`, ou formatação direta nova,
  reprova o PR.
