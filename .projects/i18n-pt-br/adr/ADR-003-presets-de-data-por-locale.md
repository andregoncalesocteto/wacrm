# ADR-003 — Presets de data e número por locale, definidos em `formats`

- **Status:** Aceito
- **Data:** 2026-09-18 (proposto e aceito no mesmo dia; a decisão D2 foi confirmada por quem mantém o projeto)
- **Feature:** i18n pt-BR (`.projects/i18n-pt-br/`) · Design Doc, seção 6 (alternativas D1, D2 e E)

## 1. Contexto

- O critério de pronto 3 exige data `dd/mm/aaaa`, hora em 24h e números `1.234,56` em pt-BR.
- O requisito RNF-02 exige que `en` não mude. Hoje `en` mostra datas como "Sep 18, 2026" (padrão
  `"MMM d, yyyy"` do `date-fns`) e `ko` e `es` também mostram o mês em inglês, o que é parte do problema.
- O `next-intl` v4 aceita `formats` nomeados na configuração de request (`src/i18n/request.ts`), que os
  componentes usam com `useFormatter()`, e o provider os herda quando é renderizado em um Server Component.
  O `RootLayout` atual passa `messages` e `locale` explicitamente, então a herança de `formats` ainda
  precisa ser validada.
- Um único formato numérico para todos os idiomas, como `{ day: '2-digit', month: '2-digit',
  year: 'numeric' }`, faria `en` mostrar "09/18/2026", o que muda o comportamento que RNF-02 quer preservar.

## 2. Decisão

Vamos definir os presets de data e número por locale em `src/i18n/formats.ts`, com `pt` em formato numérico
(`dd/mm/aaaa`) e `en`, `es` e `ko` em `dateStyle: 'medium'`, e entregá-los aos componentes pelo `formats` do
`next-intl`.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | Preset único numérico para todos os locales | Uma só configuração | Muda a saída de `en` ("Sep 18, 2026" → "09/18/2026"), contra RNF-02 | Rejeitada |
| B | **Preset por locale em `formats.ts` (`pt` numérico, demais `medium`)** | Cumpre o critério 3 sem mexer em `en`; presets nomeados, sem padrões de data espalhados pelo código | Uma tabela pequena a manter; um locale novo precisa de uma entrada | **Escolhida** |
| C | `date-fns` também para datas absolutas, com `locale` | Sem `useFormatter` nesses pontos | Os padrões (`MMM d, yyyy`) continuam em ordem inglesa e saem errados em pt; duas formas de formatar coexistem | Rejeitada |
| D | Deixar o padrão do `Intl` de cada locale (`dateStyle: 'short'` para todos) | Nenhuma tabela | Muda `en` ("9/18/26") e produz ano de 2 dígitos | Rejeitada |

## 4. Consequências

**Positivas**
- `en` permanece igual e `pt` passa a exibir `dd/mm/aaaa` e 24h, com uma única fonte de locale (`next-intl`).
- `ko` e `es` passam a ter o mês na própria língua, como efeito colateral desejável.

**Negativas / trade-offs**
- O comportamento de formatação de `ko` e `es` muda em relação ao atual (o mês deixa de estar em inglês).
  Isso vai além do que o RNF-02 previa e deve ser registrado nas notas da entrega.
- Um locale novo no futuro exige uma entrada em `FORMATS`.
- Se o provider do layout não herdar `formats` (risco R4 do Design Doc), será preciso passá-los
  explicitamente no `<NextIntlClientProvider>`.

**Obrigações**
- Validar a herança de `formats` do `request.ts` pelo provider do layout na F2.
- Cobrir `FORMATS` com um teste que confirme a saída de `pt` (`18/09/2026`) e a de `en` (inalterada).
