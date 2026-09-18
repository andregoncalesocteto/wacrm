# Triagem — idioma pt-BR

> Originada do mesmo pedido que a abstração de canais (`../channel-abstraction/`). O scorecard combinado
> empatou 3–3; a decisão humana foi dividir os dois e tratar este item sem ferramenta de planejamento.

## Debate de features

- **Features candidatas:** completar e ativar o pt-BR. `messages/pt.json` já existe (commits #375) com
  1730 das 1736 chaves de `en.json` (6 faltando), e restam ~2 arquivos `.tsx` com texto fixo.
- **Incógnitas:** quais são as 6 chaves e os textos fixos; se o locale por deployment
  (`NEXT_PUBLIC_APP_LOCALE`, inlined no build) atende, ou se o pedido é troca de idioma por usuário.
- **Natureza do projeto:** brownfield; os testes `src/i18n/*.test.ts` já impõem paridade de chaves e
  segurança de ICU.
- **Reversibilidade:** barata.
- **Superfície de risco:** nenhuma.

## Recomendação

**Ferramenta escolhida:** nenhuma — decisão humana. Tarefa pequena e bem delimitada, executada direto.
**Justificativa:** todos os sinais relevantes apontam para o lado leve (escopo conhecido, mudança
barata de desfazer, dev solo).
