# Notas de implementação — i18n pt-BR

## US-010 · Herança de `formats` pelo `NextIntlClientProvider` (risco R4)

**Resultado: `formats` É herdado.** Não é preciso passar `formats` no provider de `src/app/layout.tsx`.

- Leitura do código (next-intl 4.13.5): em Server Components o `NextIntlClientProvider` resolve para
  `react-server/NextIntlClientProviderServer.js`, que faz `formats: formats === undefined ? await getFormats() : formats`
  (idem `timeZone` e `now`). Passar só `messages` e `locale` explícitos não impede a herança do resto.
- Validação empírica: página temporária (removida depois) com um componente `'use client'` chamando
  `useFormatter().dateTime(d, 'date' | 'dateTime' | 'time' | 'dayMonth')` e `number(n)` / `number(n, 'compact')`
  no dev server pt (:3100). O HTML devolvido trouxe `18/09/2026 | 18/09/2026, 11:30 | 11:30 | 18/09 | 1.234,5 | 12,3 mil`
  e o log do dev server não teve nenhum `FORMATTING_ERROR` (um preset ausente lançaria esse erro).
- `formats` vem de `getFormats(locale)` em `src/i18n/formats.ts`, ligado em `src/i18n/request.ts`.

### Achado relacionado (R3): fuso horário
O provider também herda `timeZone` da request config e, como `request.ts` não define `timeZone`, o next-intl usa o fuso
do **servidor/contêiner** (`Intl.DateTimeFormat().resolvedOptions().timeZone`), não o do navegador. Na validação, `14:30Z`
saiu como `11:30` (fuso da máquina, -03). Ou seja, `useFormatter()` no cliente formatará no fuso do servidor, contrariando a
premissa do Design Doc ("sem timeZone mantém o fuso do navegador"). Para o navegador mandar, as stories de migração devem
passar `timeZone` do navegador ao formatar (ou o provider deve receber `timeZone` do cliente). Decidir antes de migrar os pontos.
