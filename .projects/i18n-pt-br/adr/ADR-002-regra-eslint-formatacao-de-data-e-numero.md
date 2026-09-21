# ADR-002 — Regra de ESLint estreita, em `error`, contra formatação direta de data e número

- **Status:** Proposto
- **Data:** 2026-09-18
- **Feature:** i18n pt-BR (`.projects/i18n-pt-br/`) · Design Doc, seções 5 e 6

## 1. Contexto

- Existem 44 pontos de formatação em ~28 arquivos, sem lugar único: 13 `toLocaleString()` sem argumentos,
  6 `toLocaleDateString()` sem locale ou com `undefined` (seguem o navegador, não o idioma do app), 3
  `toLocaleDateString('en-US', …)` fixos, `Intl.NumberFormat(undefined, …)` em `currency.ts` e 9 arquivos
  com `date-fns` sem `locale`.
- O idioma do app é único por deployment (`NEXT_PUBLIC_APP_LOCALE`). Formatar sem passar esse locale faz o
  app exibir datas e números segundo o navegador de cada pessoa, ou em formato americano.
- O critério de pronto 3 do projeto exige formato brasileiro, e a feature limpa **todos** os 44 pontos.
- Não há nenhuma barreira contra a volta desse padrão: o próximo `toLocaleDateString()` passaria sem aviso.

## 2. Decisão

Vamos proibir, em nível `error` no ESLint, o uso direto de `toLocaleString`, `toLocaleDateString`,
`toLocaleTimeString`, `Intl.DateTimeFormat` e `Intl.NumberFormat` em `src/`, com exceção dos testes e do
`lib/currency.ts`.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | Só migrar os 44 pontos, sem regra | Nenhum custo de manutenção | Nada impede a regressão; o problema volta sem ninguém notar | Rejeitada |
| B | Teste que varre o código atrás de `"en-US"` e `toLocale*` | Independe do ESLint | Redundante com a regra, roda só no `vitest`, mensagem menos útil que a do ESLint | Rejeitada |
| C | **Regra ESLint estreita (`no-restricted-properties` e `no-restricted-syntax`) em `error`** | Erro aponta a linha e a alternativa no editor e no CI; estreita, então poucos falsos positivos | Exige exceção para `currency.ts` (usa `Intl` com locale explícito) e testes | **Escolhida** |
| D | Módulo próprio `lib/format.ts` como caminho obrigatório, sem regra | Uma só porta de entrada | Cria uma segunda fonte de locale ao lado do `next-intl`; ainda depende de disciplina | Rejeitada |

## 4. Consequências

**Positivas**
- Formatação sem locale deixa de entrar no repositório: o CI reprova.
- A mensagem do erro ensina o caminho certo (`useFormatter()` ou passar o locale).

**Negativas / trade-offs**
- Só pode ser `error` **depois** de os 44 pontos serem migrados; ligar antes reprova o CI.
- `lib/currency.ts` precisa de exceção explícita, porque chama `Intl.NumberFormat` com o locale recebido por
  parâmetro.
- Quem realmente precisar de formatação sem locale (por exemplo, um nome de arquivo) terá de usar um
  comentário de desativação, com justificativa.

**Obrigações**
- Ligar a regra na fase F4 do plano, depois da F2.
- Registrar em comentário, no `eslint.config.mjs`, por que `currency.ts` é exceção.
