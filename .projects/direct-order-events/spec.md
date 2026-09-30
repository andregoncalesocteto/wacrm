# Spec: Eventos diretos do cardápio (sem link do CRM) com consentimento

Nova feature que estende a jornada de pedido (`../order-journey-recovery/spec.md`, já implementada e mesclada). Vocabulário em `CONTEXT.md` desta pasta (Store key, Business acronym, Consent), mais o da jornada em `../order-journey-recovery/CONTEXT.md`. Decisão de arquitetura: `adr/0001-direct-events-identified-by-phone-and-consent.md`, que flexibiliza a `../order-journey-recovery/adr/0001-journey-events-server-to-server-with-tracking-token.md`.

## Problem Statement

Hoje o CRM só acompanha o cliente que recebeu um link do cardápio com `idtrack`. Todo pedido que chega ao cardápio por outro caminho (Instagram, link antigo, endereço direto, site) é invisível: não entra no funil, não gera pedido, não atualiza a data da última compra e não permite avisar o cliente sobre o pedido. O cardápio sempre tem o telefone do cliente cadastrado, mas o CRM não tem como usá-lo. Isso também bloqueia a recuperação de clientes inativos, que precisa do histórico de compra de todos.

## Solution

O cardápio passa a enviar os mesmos eventos identificando o cliente pela chave da loja e pelo telefone, quando não há `idtrack`. O CRM cria o contato se ele não existir, abre uma jornada de origem "direta", e acompanha o pedido como qualquer outro. Mensagens só saem com o consentimento do cliente, informado pelo cardápio por finalidade (avisos do pedido e marketing). Quem nunca escreveu ao CRM recebe o primeiro contato por template aprovado, numa conversa criada já fechada. Sem consentimento, o evento alimenta pedido e funil, mas nenhuma mensagem é enviada.

## User Stories

**Operador (configuração)**

1. Como operador, quero cadastrar em cada loja o código, a sigla da loja e a sigla do negócio, para que o cardápio identifique a loja pela chave.
2. Como operador, quero que a chave `CÓDIGO/SIGLA/NEGÓCIO` seja única na conta, para que duas lojas nunca compartilhem a mesma chave.
3. Como operador, quero duas lojas do mesmo local com negócios diferentes (`89/RPA/BLC` e `89/RPA/PZA`) cadastradas separadamente, para tratar cada marca como uma loja.
4. Como operador, quero indicar qual conexão de WhatsApp de uma loja envia os avisos do pedido quando ela tem mais de uma, para que o número certo seja usado.
5. Como operador, quero usar o nome da loja como variável nos textos, para que um único conjunto de automações sirva a todas as marcas e lojas.
5b. Como operador, quero duplicar uma automação e escolher a sigla do negócio numa condição, para que uma marca com um texto realmente diferente tenha o seu.
5c. Como operador, quero usar o mesmo nome de template nas WABAs das marcas, para que uma só automação sirva a todas.
6. Como operador, quero ver no painel de pedidos se a jornada veio de um link do CRM ou direto do cardápio, para medir a contribuição do CRM.
7. Como operador, quero que o funil separe as jornadas por origem, para comparar as duas.

**Cliente**

8. Como cliente que fez um pedido sem nunca falar com a loja, quero receber o aviso do meu pedido no WhatsApp se eu aceitei receber mensagens no cardápio, para acompanhar a entrega.
9. Como cliente, quero não receber nenhuma mensagem se não aceitei, para que meu telefone não seja usado sem permissão.
10. Como cliente, quero aceitar avisos do pedido sem aceitar ofertas, para receber só o que pedi.
11. Como cliente, quero poder parar de receber mensagens respondendo "PARAR" no WhatsApp, para recuperar o controle.
12. Como cliente que abandonou o carrinho e aceitou ofertas, quero receber um lembrete, para concluir o pedido.
13. Como cliente que já conversou com a loja, quero que a minha conversa continue como hoje, sem precisar de consentimento novo para os avisos do pedido.
14. Como cliente que responde a um aviso, quero que a conversa se reabra para um atendente, para ser atendido.

**Atendente**

15. Como atendente, quero que conversas criadas só para avisos nasçam fechadas, para que o filtro "Aberta" não fique cheio de conversas sem atendimento.
16. Como atendente, quero que a conversa reabra sozinha quando o cliente responder, para não perder o retorno.
17. Como atendente, quero ver o pedido e a jornada do cliente também quando ele veio direto do cardápio, para atendê-lo sabendo o contexto.

**Time do cardápio (integrador)**

18. Como integrador, quero enviar o evento identificando o cliente por `store_key` e `customer.phone` quando não tenho `idtrack`, para que todos os pedidos sejam registrados.
19. Como integrador, quero continuar usando o `idtrack` quando o tenho, para atribuição precisa.
20. Como integrador, quero enviar o consentimento por finalidade, com a data em que foi dado, para que o CRM guarde a prova.
21. Como integrador, quero revogar o consentimento enviando `false`, para refletir o pedido do cliente no cardápio.
22. Como integrador, quero que omitir o consentimento não o revogue, para não precisar reenviá-lo em todo evento.
23. Como integrador, quero receber `store_not_found` com uma chave desconhecida, para corrigir a configuração sem laço de reenvio.
24. Como integrador, quero saber na resposta se houve possibilidade de envio (consentimento e canal), para tratar o cliente corretamente.
25. Como integrador, quero que um telefone fora do formato internacional seja recusado com erro claro, para não gerar contatos duplicados.

**Administração**

26. Como administrador, quero que um conflito entre `idtrack` e telefone nunca envie mensagem ao número errado, para evitar avisos enganados.
27. Como administrador, quero que o CRM guarde quando, por onde e para qual finalidade o consentimento foi dado, para poder comprová-lo.

## Implementation Decisions

**Loja e chave.**
- A loja ganha três campos (código, sigla da loja, sigla do negócio), editáveis em Configurações → Lojas e devolvidos pela API de lojas. A chave é `código/sigla da loja/sigla do negócio`, única por conta, sem diferenciar maiúsculas de minúsculas e sem espaços nas pontas. Migration aditiva; lojas existentes ficam sem chave (só recebem eventos por `idtrack` até preencherem os três campos).
- Uma loja pode indicar a conexão de WhatsApp padrão para avisos. Com uma conexão de WhatsApp ativa, ela é usada; com mais de uma, vale a padrão indicada (sem padrão, não há envio); sem nenhuma, o evento é aceito e nenhuma mensagem sai. Telegram não é alcançado por telefone.

**Eventos (mudança no contrato v1 de eventos).**
- Campos novos, opcionais quando há `idtrack`: `store_key` (a chave inteira em um campo), `customer` (`phone` em formato internacional E.164; `name` opcional) e `consent` (`notifications`, `marketing`, `given_at`). Todo evento pode trazê-los.
- O evento precisa trazer `idtrack`, ou `store_key` mais `customer.phone`; senão `400`. Telefone fora de E.164: `400`. Chave desconhecida: `404 store_not_found` (não repetir). Loja conhecida sem conexão de WhatsApp: aceito, sem envio.
- Se vierem `idtrack` e telefone e eles resolverem contatos diferentes, o `idtrack` atribui a jornada; `customer` e `consent` do evento são ignorados, e o conflito é registrado no log. Nenhum consentimento é atualizado por esse evento.
- A resposta ganha um campo `messaging` indicando se o cliente é elegível para mensagens: elegível, sem consentimento ou sem conexão.

**Contato e jornada.**
- O contato é encontrado pela identidade de telefone (reaproveitando a resolução e a deduplicação de telefone já existentes). Se não existir, é criado com a origem "cardápio" e o nome enviado, se houver; um nome já existente nunca é sobrescrito.
- A jornada ganha um campo de origem (`crm_link` ou `menu_direct`). Em jornadas diretas o envio do link não existe: a data do link passa a ser opcional e a etapa inicial é a da primeira etapa que o evento alcançar. As retomadas de 10 e 30 minutos (que dependem do link) **não** se aplicam a elas. O carrinho abandonado se aplica.
- O funil separa as jornadas por origem.

**Consentimento.**
- Guardado no contato, por finalidade (`notifications`, `marketing`), com a data em que foi dado, a origem ("cardápio") e, se houver, a data de revogação. Um evento atualiza o consentimento quando o `given_at` é mais novo que o guardado; `false` explícito revoga; ausência não altera nada.
- Quem já escreveu ao CRM (há mensagem recebida dele) tem consentimento implícito para avisos do pedido e recuperação, como hoje. O consentimento explícito é exigido só de quem nunca escreveu.
- "PARAR" recebido do cliente revoga as duas finalidades. Tem de passar por um ponto do núcleo que não importe módulo de canal.

**Envio para quem nunca escreveu.**
- Cada passo de envio de automação declara a finalidade (`notifications` ou `marketing`). Para contatos sem mensagem recebida, o motor só envia se o consentimento daquela finalidade estiver ativo; senão o passo é ignorado com motivo registrado no log.
- A conversa é criada no primeiro envio permitido, já com status fechado, e o primeiro contato é sempre por template aprovado (a janela de 24 h conta como fechada sem mensagem recebida, regra já existente). Sem template configurado, o envio falha de forma visível.
- No preset: agradecimento e status usam `notifications`; carrinho abandonado usa `marketing`.

**Automações por marca.** A regra geral é **um conjunto só** de automações para todas as marcas. Duas ferramentas: (1) uma variável `{{store_name}}` (o nome da loja da conversa, por exemplo a loja da marca) nos textos das automações, e (2) uma condição "a sigla do negócio da loja é X" para o caso raro em que uma marca precisa de um texto realmente diferente (a automação é duplicada e recebe a condição). Os templates do WhatsApp usam o **mesmo nome em cada WABA** (cada marca tem o seu conteúdo); o envio sai pela conexão da loja e a Meta resolve o nome na WABA dela. Isto é uma convenção de nomes e não foi testado com duas WABAs reais.

**Multicanal.** Nada disto importa módulo específico de canal; o envio por telefone só existe onde o provedor declara essa capacidade (WhatsApp).

**Internacionalização e migrations.** Todo texto novo nos quatro idiomas; migrations só adiante.

## Testing Decisions

Mesmos pontos de teste da spec original, no nível mais alto possível:

1. **Rota pública de eventos** (HTTP, banco simulado): identificação por chave e telefone, contato criado e nome preservado, `store_not_found`, telefone inválido, conflito com `idtrack`, origem da jornada, atualização e revogação do consentimento, campo `messaging`, isolamento por conta.
2. **Motor de automações**: bloqueio por falta de consentimento, finalidade correta por passo, conversa criada fechada, template primeiro, retomadas de 10/30 min ignoradas em jornada direta, carrinho abandonado com `marketing`, condição por sigla do negócio.
3. **Camada de envio**: primeiro contato por template sem mensagem recebida.

Arte anterior: `journey.integration.test.ts`, os testes de rota v1 e as fixtures do motor.

## Out of Scope

- Captura de consentimento fora do cardápio (por exemplo, botão no chat).
- Mensagens para Telegram por telefone.
- Campanhas (broadcast) para contatos com `marketing`; a recuperação de inativos de 30 dias (agora desbloqueada, mas com spec própria).
- Limite de primeiros contatos por dia na conta; fica registrado como risco.

## Further Notes

- **Risco de spam por chave vazada:** com telefone, uma chave de eventos pode criar contatos e disparar templates para quem tiver consentimento registrado. Freios desta versão: limite por chave, só template no primeiro contato e consentimento exigido. Recomendo avaliar depois um teto diário de primeiros contatos por conta (a Meta limita conversas iniciadas pela empresa por faixa de qualidade).
- **Mudança de privacidade (LGPD):** o contrato passa a carregar telefone, nome e consentimento. O time do cardápio é dono de coletar e provar o consentimento.
- **A jornada original (tickets #1 a #16) já está concluída e mesclada.** Esta feature tem o seu próprio conjunto de tickets.
