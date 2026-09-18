# Linha de base — `react/jsx-no-literals` (ADR-001)

Data: 2026-09-18. Regra em `warn`, escopo `src/components/**` e `src/app/**` (testes excluídos).

Total de avisos da regra: **41**. Os outros 41 avisos do `npm run lint` são anteriores e não têm relação
(total do lint: 82 avisos, 0 erros).

| Diretório | Avisos |
|---|---|
| `src/app` | 10 |
| `src/components/agents` | 2 |
| `src/components/automations` | 3 |
| `src/components/broadcasts` | 5 |
| `src/components/contacts` | 2 |
| `src/components/flows` | 5 |
| `src/components/inbox` | 1 |
| `src/components/settings` | 13 |
| demais diretórios de `src/components` | 0 |

Reproduzir: `npx eslint . -f json` e filtrar `ruleId === "react/jsx-no-literals"`.
