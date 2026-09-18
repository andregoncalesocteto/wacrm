# ADR-001 — Regra de ESLint contra texto literal em JSX, em nível `warn`

- **Status:** Proposto
- **Data:** 2026-09-18
- **Feature:** i18n pt-BR (`.projects/i18n-pt-br/`) · Design Doc, seção 6 (alternativa F) e seção 8 (F4)

## 1. Contexto

- O projeto usa `next-intl`; 89 arquivos já traduzem seu texto com `useTranslations`.
- Mesmo assim, `quick-replies-manager.tsx` não usa tradução em nenhum ponto e está inteiro em inglês, e há
  um toast dinâmico e três primitivos compartilhados (`ui/sheet`, `ui/dialog`, `ui/gated-button`) com texto
  fixo. Nada no repositório impediu que isso entrasse.
- O único controle atual é `src/i18n/messages.test.ts`, que garante paridade de **chaves** entre os
  catálogos. Ele não vê texto que nunca virou chave.
- O `eslint.config.mjs` só carrega `eslint-config-next/core-web-vitals` e `typescript`, sem regra de i18n.
  O `eslint-plugin-react` (7.37.5) já está instalado via `eslint-config-next`, então a regra
  `react/jsx-no-literals` está disponível sem dependência nova.
- Ligar a regra hoje produziria avisos em todo o código existente que ainda não foi varrido (a varredura de
  textos fixos é best-effort).

## 2. Decisão

Vamos ativar `react/jsx-no-literals` em nível `warn` para `src/components/**` e `src/app/**`, e promovê-la
a `error` apenas quando a contagem de avisos chegar a zero.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | Nenhuma regra; só o teste de paridade e revisão de PR | Zero custo | Foi assim que `quick-replies-manager.tsx` passou; depende de atenção humana | Rejeitada |
| B | **`jsx-no-literals` em `warn`, com caminho para `error`** | Barra texto novo na revisão sem travar o CI; volume de avisos vira métrica | Aviso pode ser ignorado; falsos positivos (nomes de exemplo, símbolos) precisam de `allowedStrings` | **Escolhida** |
| C | `jsx-no-literals` já em `error` | Barreira total imediata | Exige zerar todos os avisos existentes de uma vez, o que não cabe nesta feature | Adiada (destino final) |
| D | Ferramenta de extração automática de textos | Rápida em grande volume | Gera chaves fora do padrão do projeto; exagero para poucos arquivos | Rejeitada |

## 4. Consequências

**Positivas**
- Texto fixo novo em JSX é sinalizado no `npm run lint`, sem bloquear o CI.
- O total de avisos vira uma métrica de progresso rumo a `error`.

**Negativas / trade-offs**
- Um aviso não reprova o PR: a proteção real só chega com o `error`.
- A regra cobre JSX; textos montados em código (toasts, `aria-label` em variável) continuam exigindo a
  navegação manual com `pt` ativo.
- Falsos positivos (nomes de exemplo como `"Ada Lovelace"`, símbolos como `·`) exigem `allowedStrings` ou
  comentários pontuais.

**Obrigações**
- Registrar a contagem de avisos ao ligar a regra.
- Abrir um novo ADR (que substitui este) ao promover a regra a `error`.
