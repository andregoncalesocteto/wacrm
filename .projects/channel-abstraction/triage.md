# Triagem — abstração de canais (WhatsApp não oficial, Telegram, Discord)

> Originada de um pedido único junto com pt-BR (`../i18n-pt-br/`). O scorecard abaixo é do pedido combinado (empate 3–3); a decisão humana foi dividir os dois.

## Debate de features

- **Features candidatas**
  - Idioma pt-BR. **Já existe** `messages/pt.json` (commits #375; 1730 de 1736 chaves de `en.json`,
    6 faltando) e restam ~2 arquivos `.tsx` com texto fixo. É fechar a última milha, não criar do zero.
  - Abstração de canais: interface de provedor, tabela `channels`, identidade de contato por canal,
    `channel_id` em `conversations`, `messages.external_id`, UI ciente de capacidades.
  - Três canais novos: WhatsApp não oficial (via gateway externo), Telegram, Discord.
- **Incógnitas**
  - Como falar com o WhatsApp não oficial: gateway externo (Evolution/WAHA) ou biblioteca própria com worker.
  - Discord: viabilidade real como canal de atendimento (DM exige servidor em comum; gateway é WebSocket).
  - Modelo de identidade: como migrar `contacts.phone NOT NULL` sem quebrar API v1, MCP e webhooks de saída.
  - Templates, broadcasts e janela de 24h em canais que não os têm.
  - Aceitar ou não o risco de ToS/banimento do WhatsApp não oficial (o README vende a API oficial).
- **Natureza do projeto** — brownfield, com convenções documentadas (`CLAUDE.md` / `AGENTS.md`), ~70
  arquivos acoplados a `lib/whatsapp` e boa cobertura de testes.
- **Reversibilidade** — a parte de i18n é barata de reverter. A abstração muda schema e contrato
  público; as migrations são histórico entregue (não se edita), então o custo de errar é alto.
- **Superfície de risco** — sem regulação nova. Risco de ToS do WhatsApp não oficial e dados de clientes
  (LGPD) já presentes; nada novo em compliance.

## Scorecard

| Sinal | Voto | Motivo |
|---|---|---|
| Ambiguidade do escopo | BMAD | Várias decisões de design em aberto (provedor não oficial, Discord, identidade) |
| Tamanho | BMAD | Vários épicos: i18n, abstração, três canais |
| Codebase | Spec Kit | Brownfield com convenções claras |
| Reversibilidade | BMAD | Schema + contrato da API pública são caros de desfazer |
| Colaboração | Spec Kit | Dev solo (fork pessoal) |
| Compliance/regulação | Spec Kit | Ausente |

## Recomendação

**Desfecho (decisão humana):** dividir o pedido em dois. pt-BR segue direto, sem ferramenta de
planejamento; a abstração de canais + três canais segue pelo **BMAD** (ainda não instalado neste projeto).

**Ferramenta escolhida:** pendente — decisão humana (resolvida acima)
**Placar:** 3 votos BMAD vs 3 votos Spec Kit (0 abstenções) — margem 0
**Força:** decisão humana (empate)
**Justificativa:** os sinais se dividem porque o pedido junta duas coisas de pesos diferentes. Triado
separadamente, pt-BR é pequeno, bem delimitado e barato de reverter (Spec Kit em todos os sinais
relevantes); a abstração de canais concentra a ambiguidade, o tamanho e o custo de reversão (BMAD).
**Sinais contrários:** BMAD (ambiguidade, tamanho, reversibilidade) contra Spec Kit (codebase,
colaboração, compliance).
