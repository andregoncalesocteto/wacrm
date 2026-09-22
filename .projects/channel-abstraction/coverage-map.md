# Mapa de cobertura de testes — WhatsApp oficial (baseline para US-002..004; no prd.json: US-002 = recebimento/webhook, US-003 = envio, US-004 = motores e broadcast)

Objetivo: saber o que os testes atuais garantem antes de refatorar o caminho do WhatsApp oficial para o contrato de provedor.
Levantamento feito por leitura dos arquivos `*.test.ts` (nomes de `describe`/`it`) e dos módulos de produção; nenhum código foi alterado.
Legenda: **Coberto** = há teste do comportamento; **Parcial** = só parte (helpers puros ou caminho feliz ausente); **Lacuna** = nenhum teste.

## 1. Envio

| Arquivo de teste | O que garante |
| --- | --- |
| `src/lib/whatsapp/send-message.test.ts` | Validação de parâmetros antes do banco (conversation_id/message_type, tipo inválido, texto/template/mídia obrigatórios, legenda longa, payload interativo inválido, áudio sem legenda); `SendMessageError` (código + HTTP); persistência do corpo de template (#483: corpo substituído, params estruturados, idioma da linha local, `content_text` nulo sem template local); destinatário BSUID vs. telefone (#519: BSUID sem telefone, telefone preferido, fallback com telefone inutilizável, 400 sem nenhum, `wa_user_id` mal formado ignorado). |
| `src/app/api/whatsapp/send/route.test.ts` | Rota `POST /api/whatsapp/send` no caminho de template por `contact_id`: cria conversa se não houver, reaproveita a existente, 404 para contato de outra conta, 400 sem `conversation_id`/`contact_id`; papel: viewer recebe 403 e nunca chega à Meta, agent passa. |
| `src/lib/whatsapp/meta-api.test.ts` | Validação e formato de `sendInteractiveButtons` / `sendInteractiveList` (limites da Meta: 3 botões, título 20/24, 10 linhas, ids duplicados, corpo/rótulo vazios, payload correto). |
| `src/lib/whatsapp/meta-api.media.test.ts` | Formato de `sendMediaMessage` (imagem com legenda, documento com legenda+filename, áudio sem legenda nem filename, erro sem link). |
| `src/lib/whatsapp/meta-api.recipient.test.ts` | Envelope `to`+`recipient_type` para telefone e campo `recipient` para BSUID em texto, mídia e template; BSUID pai; resto do payload intacto. |
| `src/lib/whatsapp/meta-api.typing.test.ts` | `sendTypingIndicator`: envelope read+typing para o wamid e propagação do erro da Meta. |
| `src/lib/whatsapp/interactive.test.ts` | `validateInteractivePayload` (botões e lista) e `interactivePayloadPreviewText`. |
| `src/lib/whatsapp/phone-utils.test.ts`, `wa-identity.test.ts` | Normalização de telefone; identidade inbound (telefone, BSUID, username, prioridade entre campos), alvo de envio e nome de exibição. |
| `src/lib/whatsapp/meta-api.resumable.test.ts`, `encryption.test.ts`, `registration.test.ts`, `waba-pairing.test.ts`, `meta-error-explain.test.ts` | Upload resumível, criptografia AES-256-GCM dos tokens, registro/verificação de número, pareamento de WABA, tradução de erros da Meta. |

**Lacunas de envio (US-003):**
- `sendMessageToConversation` no **caminho feliz** (texto, mídia, interativo, template): a chamada à Meta com credenciais da conta, o insert em `messages` (status `sent`, `message_id` = wamid, `content_type`, `media_url`), a atualização de `conversations` (last message/preview) e o comportamento quando a Meta falha (linha marcada `failed` + código de erro). Hoje só existem testes de validação e de destinatário.
- `POST /api/whatsapp/react` (`sendReactionMessage`): nenhum teste da rota nem da função de envio de reação.
- Rota `send` para `conversation_id` com texto/mídia (só o caminho de template por `contact_id` é testado), e a checagem de que uma conversa de outra conta é recusada.
- Rota `GET /api/whatsapp/media/[mediaId]` (proxy de mídia da Meta): sem teste.
- `resolveConversationByPhone` está coberto; `sendTextMessage`/`sendTemplateMessage` só indiretamente (formato do destinatário), sem teste de erro HTTP da Meta.

## 2. Webhook de entrada

Arquivo principal: `src/app/api/whatsapp/webhook/route.test.ts` (o módulo `webhook-signature` é mockado nele).

| Aspecto | Cobertura |
| --- | --- |
| Assinatura HMAC | **Coberto** em `webhook-signature.test.ts` (segredo correto/errado, corpo adulterado, header ausente/curto, vários segredos separados por vírgula, fail-closed sem segredo). Na rota ela é mockada, então **a rota rejeitando 401 com assinatura inválida não é testada**. |
| Verificação `GET` (`hub.mode`/`hub.verify_token`, upgrade de token legado) | **Lacuna**. |
| Mensagem de texto | **Parcial**: primeira entrega persiste uma vez e dispara o fan-out; reentrega é no-op sem bump de não lidas nem fan-out (#367); bump de não lidas atômico via RPC (#369). Não há teste de cada tipo de conteúdo (texto simples, localização, contatos, sticker, `unsupported`) em `parseMessageContent`. |
| Resposta interativa | **Coberto**: toque em botão de template vira resposta interativa, alimenta flows e o gatilho `interactive_reply`, fallback para o rótulo sem payload (#478). Botão/lista interativos (não-template): **lacuna**. |
| Mídia | **Coberto**: espelhamento para o bucket, fallback para proxy (recusa do upload, falha no download), mídia grande ignorada, nome do documento, opt-out da conta, coluna ausente pré-039, texto não espelhado (#466); unidades em `mirror-inbound-media.test.ts` (MIME, nome, mesmo caminho em reentrega, tamanho). |
| Status (sent/delivered/read/failed) | **Parcial**: `failed` guarda código/título/detalhes na linha, loga um aviso com wamid, propaga o motivo para `broadcast_recipients.error_message`, `failed` sem `errors` só muda o status, `delivered` não toca colunas de erro (#535). **Lacuna**: a escada `ladderLevel`/`isValidStatusTransition` (não regredir de `read` para `delivered`), status de mensagem desconhecida, contadores de entrega/leitura do broadcast, `flagBroadcastReplyIfAny`. |
| Reação | **Lacuna**: `handleReaction` (inserir em `message_reactions`, remover quando o emoji vem vazio, alvo não encontrado) não tem teste. |
| Identidade / contato | **Coberto** (#519): um contato por BSUID sem telefone, sem lookup por telefone quando não há telefone, reuso na segunda mensagem, backfill do BSUID em contato conhecido por telefone, backfill do telefone, descarte sem chave, payload legado só com telefone; nome editado nunca sobrescrito pelo telefone e username adotado quando é tudo o que há. |
| Fan-out (`after()`) | **Coberto**: todas as automações concluem antes do `after()` resolver (#368). Flows e IA no fan-out: só via o mock do primeiro item. |
| Webhooks de templates (`message_template_status_update` etc.) | **Coberto**: `template-webhook.test.ts` (status, motivo de rejeição, normalização PENDING_REVIEW, stub de template desconhecido por WABA, tenant ambíguo, retry em violação de unicidade, qualidade, components no-op, campo desconhecido) e a passagem de `entry.id` como `wabaId` na rota (#534). |
| Conversa / reabertura | `resolve-conversation.test.ts` (telefone inválido, sem config, existente, criação, corrida de unicidade), `conversations/reopen.test.ts`. `findOrCreateConversation` do webhook em si: **lacuna** direta. |

**Lacunas do webhook (US-002):** verificação GET, rota com assinatura inválida (401), tipos de conteúdo não cobertos (localização, contatos, sticker, interativo não-template, `unsupported`), escada de status e status fora de ordem, reação (inserir/remover/alvo ausente), atualização de contadores/`flagBroadcastReplyIfAny`, `findOrCreateConversation` (reabrir conversa fechada, resolução de canal/config por `phone_number_id`).

## 3. Templates

| Arquivo de teste | O que garante |
| --- | --- |
| `template-lifecycle.test.ts` | `submitMessageTemplate` (POST em `/{waba}/message_templates`, erro da Meta, id ausente), `editMessageTemplate` (apenas `components`, `category`, `success:false`), `deleteMessageTemplate` (por nome, por `hsm_id`, 404 vira no-op, outros erros lançam). |
| `template-send-builder.test.ts` | `buildSendComponents`: corpo, cabeçalho TEXT/IMAGE/vídeo/documento (URL de amostra, override, `media id`), botões (URL com variável, QR antes de URL, COPY_CODE, PHONE_NUMBER), ordem header, body, buttons. |
| `template-body.test.ts`, `template-components.test.ts`, `template-validators.test.ts`, `template-status-normalize.test.ts`, `template-header-handle.test.ts` | Substituição de variáveis no corpo, montagem de componentes, validadores, normalização de status, handle de cabeçalho. |
| `template-webhook.test.ts` | Ver seção 2. |

**Lacunas (US-003/US-004):** rotas `templates/submit`, `templates/sync` e `templates/[id]` (papéis, escopo por conta, sincronização com a Meta, atualização da linha local após submit/edit/delete) sem teste de rota.

## 4. Broadcast

| Arquivo de teste | O que garante |
| --- | --- |
| `broadcast-core.test.ts` | **Criar**: rejeita `template_name` ausente, lista vazia, mais de 1000 destinatários; criação atômica via RPC (nunca insert avulso do pai, sem pai órfão em falha, #370). **Finalizar**: `finalizeBroadcastStatus` (passe limitado fica `sending`, tudo falho vira `failed`, parcial vira `sent`, retomada sem novos envios não condena a campanha). |
| `broadcast-resume.test.ts` | **Retomar**: `claimBroadcastDelivery` (claim condicional, recusa com lock ativo, lock velho é abandono, escopo por conta), `releaseBroadcastDelivery`, `planBroadcastResume` (destinatários pendentes com params congelados, escopo failed/all, params malformados, linhas não enviáveis falham logo, teto por passe, 404 de outra conta, nada a retomar, linha do template para cabeçalho/botões). |
| `broadcast-csv.test.ts`, `broadcast-retry.test.ts`, `broadcast-status.test.ts`, `rate-limit.test.ts` | CSV de destinatários, regras de retry, rótulos de status, limite de taxa. |

**Lacunas (US-004):** `deliverBroadcast` (loop de entrega: `sendTemplateMessage` por destinatário, marca `sent`/`failed`, grava wamid e erro, chama `finalizeBroadcastStatus`, não bloqueia em erro de um destinatário) **sem teste direto**; `markBroadcastSending`; rotas `POST /api/whatsapp/broadcast`, `broadcast/[id]/resume` (papéis, 409 com lock, escopo da conta) e `POST /api/v1/broadcasts` (chave de API, filtro por `ctx.accountId`).

## 5. Motor de flows

| Arquivo de teste | O que garante |
| --- | --- |
| `flows/engine.test.ts` | Funções puras: `matchReplyId` (botões, seções da lista, sem correspondência), `matchesKeywordTrigger` (vazio, contains, exact, case_sensitive, várias palavras), classificação de nós (auto-avança, suspende, terminal, mutuamente exclusivas), `evaluateConditionPredicate` (present/absent/equals/contains); interpolação `{{vars.*}}` em `send_buttons`/`send_list` (#553), reprompt e falha de envio registrada. |
| `flows/dispatch.test.ts` | `entryTriggerTexts` e `dispatchInboundToFlows`: gatilho de keyword por toque de botão (título e reply id), texto digitado, toque sem correspondência vai para automações, flow manual não inicia por toque, `first_inbound_message` por toque (#490). |
| `flows/fallback.test.ts`, `edges.test.ts`, `layout.test.ts`, `validate*.test.ts`, `components/flows/*.test.ts` | Política de fallback (reprompt/handoff/end), arestas, layout, validação do grafo, estado do editor. |

**Lacunas (US-004):** execução ponta a ponta de `startNewRun`/`advanceFromNodeKey` nos nós `send_message`, `send_media`, `collect_input`, `set_tag`, `condition`, `handoff`, `end`; `handleReplyForActiveRun` (retomada, resposta desconhecida, esgotar reprompts, timeout); `isDuplicateInbound` (deduplicação); `loadAccountMetaCredentials` e `engineSendText/Media/Interactive*` de `flows/meta-send.ts` (o ponto por onde o motor sai para a Meta) sem teste.

## 6. Motor de automações

| Arquivo de teste | O que garante |
| --- | --- |
| `automations/engine.test.ts` | Isolamento de tenant (contato de outra conta recusado, GHSA-63cv-2c49-m5v3; escrita de `update_contact_field` escopada), log semeado como `failed` e promovido a `success` (#409), campos customizados (upsert, interpolação, recusa de campo de outra conta), guarda SSRF em `send_webhook`, `triggerMatches` para `interactive_reply`, `tag_added` (e política sem conversa) e `keyword_match` (contains/word/exact, metacaracteres, não-latino). |
| `automations/validate.test.ts`, `builder-tree.test.ts`, `trigger-meta.test.ts` | Validação, árvore do builder e metadados de gatilhos. |

**Lacunas (US-004):** ações que enviam mensagem (`send_message`/template/interativo via `automations/meta-send.ts`: `engineSendText`, `engineSendTemplate`, `engineSendInteractive`), passos com espera/retomada (`resumePendingExecution`), gatilhos `new_contact`/`message_received`/`status_change` fora do `triggerMatches`, e o roteamento do envio pela conexão da conversa.

## 7. Resposta por IA

| Arquivo de teste | O que garante |
| --- | --- |
| `ai/auto-reply.test.ts` | `dispatchInboundToAiReply`: caminho feliz (reserva o slot e envia), resposta ancorada em conhecimento, silêncio quando há automação ativa, perda da corrida do slot, IA desligada, auto-reply desligado na conta ou na conversa, agente humano atribuído, teto por conversa, nada a responder; indicador "digitando" (#527: antes do LLM, falha do indicador não impede o envio, sem credenciais, sem wamid, não dispara com gate curto); handoff (desativa auto-reply, grava resumo, não envia; roteia para o agente configurado). |
| `ai/handoff.test.ts`, `generate.test.ts`, `context.test.ts`, `config.test.ts`, `knowledge.test.ts`, `query.test.ts`, `usage.test.ts`, `chunk.test.ts`, `embeddings.test.ts` | Resumo de handoff, geração, contexto da conversa, configuração, base de conhecimento, consultas, uso e RAG. |

**Lacunas (US-004):** o texto do envio da resposta (qual função de envio e com quais credenciais/canal é chamada e como a mensagem da IA é gravada em `messages`), e a origem do wamid do indicador em um canal sem indicador (será relevante no Telegram).

## 8. Transversais úteis para a refatoração

- `lib/api/v1/conversations.test.ts`, `lib/inbox/conversations.test.ts`: API pública e listagem da caixa de entrada.
- `lib/webhooks/*.test.ts`: webhooks de saída (assinatura, SSRF, entrega, eventos). Não é o webhook da Meta.
- Não existe teste algum que rode o fluxo inteiro **webhook, contato/conversa, mensagem, fan-out** com um único payload real da Meta; os testes da rota mockam os módulos de fan-out.

## 9. Resumo das lacunas a cobrir

- **US-003 (envio):** `sendMessageToConversation` no caminho feliz e falha da Meta (texto, mídia, interativo, template), rota `send` com `conversation_id`, rota `react`, proxy de mídia.
- **US-002 (webhook; templates ficam a critério da US-003/US-004):** GET de verificação, 401 por assinatura inválida na rota, tipos de conteúdo restantes, escada de status/status fora de ordem, reação, contadores de broadcast, `findOrCreateConversation`, rotas de templates (`submit`, `sync`, `[id]`).
- **US-004 (broadcast, flows, automações, IA):** `deliverBroadcast` e `markBroadcastSending`, rotas de broadcast, execução de nós e retomada nos flows, `meta-send` de flows e automações, `resumePendingExecution`, envio da resposta da IA.
