# ADR-001 — Resolver de conexão e credenciais do broadcast: reaproveitar a infraestrutura de `sendOutbound`

- **Status:** Proposto
- **Data:** 2026-09-22
- **Feature:** broadcast-multi-channel · SOLUTION (Tema Técnico 1 e 4) · Design Doc, seções 3 e 5

## 1. Contexto

- Broadcast hoje resolve a conexão de envio automaticamente via
  `loadWhatsAppSendConnection` (`src/lib/channels/whatsapp-connection.ts`),
  hardcoded para o canal WhatsApp — não existe escolha de conexão nem de
  canal em nenhum ponto do fluxo (wizard nem API).
- `broadcast-resume.ts` importa a mesma função diretamente, então qualquer
  decisão tomada aqui precisa valer para os dois caminhos (envio inicial e
  retomada) ou a duplicação simplesmente se move de lugar.
- A infraestrutura de canal plugável já existe e já é usada por
  `automations`, `flows` e a ingestão de webhook: `getConnectionCredentials`
  (credenciais descriptografadas por `connection_id`), `getProvider`
  (resolve o `ChannelProvider` pelo `channel_type`) e `sendOutbound`
  (ponto único de envio, chama `provider.send`).
- `OutboundMessage` já tem os três formatos necessários
  (`{type: 'template'}`, `{type: 'text'}`, `{type: 'media'}`) e
  `SendOptions.credentials` já existe com um comentário no código dizendo
  explicitamente que serve a "um chamador que manda várias mensagens na
  mesma conexão (um broadcast) resolvê-las uma vez" — a intenção de
  reaproveitamento já estava prevista quando essa interface foi desenhada
  no `channel-abstraction`, só nunca foi conectada ao broadcast.
- RNF-01 (herdado do `channel-abstraction`): o comportamento do broadcast
  via WhatsApp Cloud API — retry de variante de telefone, resolução de
  template, contagem de `sent`/`delivered`/`read` — não pode mudar.

## 2. Decisão

Vamos substituir `loadWhatsAppSendConnection` por `getConnectionCredentials`
+ `getProvider` (a mesma infraestrutura que `sendOutbound`/`ingestInbound`
já usam) tanto no envio inicial (`broadcast-core.ts`) quanto na retomada
(`broadcast-resume.ts`), resolvendo conexão e credenciais uma única vez por
campanha/lote a partir de um `connection_id` explícito escolhido no wizard,
em vez de inferir automaticamente qual conexão usar.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Reaproveitar `getConnectionCredentials`/`getProvider`/`sendOutbound`** | Um único ponto de manutenção para credenciais/capabilities; broadcast ganha qualquer canal futuro registrado sem código novo; comportamento fino do WhatsApp (retry de telefone, etc.) já vive dentro do provider e não precisa ser reimplementado | Exige tocar `broadcast-core.ts`/`broadcast-resume.ts`, código hoje só-WhatsApp e sem testes de caracterização prévios | **Escolhida** |
| B | Resolver próprio e paralelo do broadcast (ex. `loadBroadcastConnection`, isolado) | Isola o raio de mudança do resto do app | Duplica lógica de credenciais/capabilities que já existe e é mantida em `send.ts`; um canal novo exigiria atualizar dois resolvers, não um | Rejeitada — reintroduz exatamente o tipo de duplicação que o `channel-abstraction` eliminou |
| C | Broadcast continua chamando a API da Meta diretamente, com um `if/else` por `channel_type` para outros canais | Menor mudança imediata no arquivo existente | Reintroduz acoplamento direto a uma plataforma no meio do core de broadcast — o núcleo (`send.ts`/`ingest.ts`) deixaria de ser o único ponto que conhece canais | Rejeitada — viola o contrato de provedor estabelecido em ADR-002 do `channel-abstraction` |

## 4. Consequências

**Positivas**
- Broadcast passa a se comportar, estruturalmente, como qualquer outro
  consumidor de `sendOutbound` — mesmo padrão que `automations`/`flows`.
- Um canal novo (ex. um futuro WhatsApp não-oficial) fica disponível para
  broadcast automaticamente, sem tocar em `broadcast-core.ts` de novo,
  desde que o provider declare as `capabilities` corretas.
- Erros de envio passam a vir como `ChannelError` tipado
  (`recipient_unreachable`, `auth`, …), não só erros brutos da Meta —
  melhora `broadcast_recipients.error_message`.

**Negativas / trade-offs**
- `broadcast-core.ts` e `broadcast-resume.ts` precisam ser refatorados
  tocando código que hoje só atende WhatsApp e nunca teve testes de
  caracterização — risco real de regressão se a cobertura não for feita
  antes.
- `connection_id` passa a ser obrigatório no payload de
  `POST /api/whatsapp/broadcast` — não é uma mudança de contrato público
  (a rota não é exposta na API pública hoje), mas é uma mudança de contrato
  interno que o client (`use-broadcast-sending.ts`) precisa acompanhar.

**Obrigações**
- Escrever testes de caracterização do fluxo WhatsApp de broadcast **antes**
  de qualquer refatoração de `broadcast-core.ts`/`broadcast-resume.ts`.
- `resolveTarget`/`buildTemplatePayload` (lógica hoje específica do
  WhatsApp) continuam vivendo dentro do provider WhatsApp — não migram para
  o core do broadcast.
