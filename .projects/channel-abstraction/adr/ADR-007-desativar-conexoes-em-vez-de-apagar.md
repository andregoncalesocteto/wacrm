# ADR-007 — Conexões com histórico são desativadas, não apagadas

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · Design Doc, ajuste 6 e seção "Interface de configuração"

## 1. Contexto

- Cada conversa pertence a uma conexão, e a chave estrangeira é `ON DELETE RESTRICT`: uma conexão com conversas
  **não pode ser apagada** sem perder o histórico.
- Hoje `DELETE /api/whatsapp/config` apaga a configuração sem essa restrição, porque a conversa não dependia dela.
- Uma loja pode trocar de número, encerrar um canal ou pausar uma conexão, e a central ainda precisa **ler o histórico**.
- Desativar uma conexão implica parar de receber e de enviar por ela, sem perder as credenciais nem o histórico.

## 2. Decisão

Vamos **desativar** as conexões com histórico (preservando as credenciais e mantendo as conversas visíveis em modo
somente leitura) e permitir **apagar apenas conexões sem nenhuma conversa**.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Desativar (com `disabled_at`), apagar só sem conversas** | Preserva o histórico e as credenciais; reativar é um clique | Uma conexão a mais na base e na lista | **Escolhida** |
| B | Apagar em cascata, levando as conversas | Simples | Destrói o histórico de atendimento e os dados do CRM ligados às conversas | Rejeitada |
| C | Apagar a conexão e desligar as conversas dela | Nada fica desativado | As conversas ficam sem conexão, sem loja e sem como responder, quebrando o modelo | Rejeitada |

## 4. Consequências

**Positivas**
- Nenhum histórico é perdido.
- A conexão desativada sai da verificação de saúde e deixa de contar para a regra "exatamente uma conexão ativa" da
  API.

**Negativas / trade-offs**
- Uma loja com conexões, mesmo desativadas, **não pode ser apagada**, e não há "arquivar loja" nesta versão.
- O atendente pode não entender por que não consegue responder numa conversa de conexão desativada.

**Obrigações**
- No inbox, o compositor fica desabilitado com uma explicação, e o selo indica "desativada" (risco R13).
- Desativar chama `provider.disconnect` (no Telegram, remove o webhook) e avisa quando há conversas abertas.
- A API devolve `409 has_conversations` ao tentar apagar uma conexão com conversas.
