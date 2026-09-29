# Spec: Jornada de pedido com eventos do cardápio e retomadas

Vocabulário conforme `CONTEXT.md`. Decisão de arquitetura registrada em `docs/adr/0001-journey-events-server-to-server-with-tracking-token.md`. Triagem e contexto em `triage.md`.

## Problem Statement

Uma rede de pizzarias divulga um número de mensagens. O cliente inicia a conversa, e um dos caminhos é fazer um pedido: o CRM envia o link do **Digital menu** da loja e o pedido acontece inteiro fora do CRM, num sistema de outro time. Hoje o wacrm não sabe o que o cliente fez depois de receber o link. O operador não consegue ver quantos clientes abriram o cardápio, montaram um carrinho ou finalizaram o pedido, não consegue retomar quem sumiu no meio do caminho, e o cliente não recebe avisos sobre o andamento do pedido a partir do CRM. Quando a conversa esfria depois do envio do link, nada a retoma. Quando o cliente volta com um problema no pedido, quem atende não sabe em que ponto ele está.

## Solution

O CRM passa a acompanhar cada tentativa de pedido como uma **Journey**, representada por um deal num pipeline de jornada.

- Ao enviar o link do cardápio, o CRM cria um **Tracking token**, abre a Journey e inicia os relógios de retomada.
- O cardápio, do backend dele, informa ao CRM os **Journey events** (`ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`) e os **Order statuses** do pedido. Tudo usa o `idtrack` que voltou no link.
- O deal avança pelas etapas conforme os eventos chegam. O `Purchase` fecha a Journey como ganha e cria o **Order**.
- Se o cliente esfria, o CRM envia **Resumptions** aos 10 e aos 30 minutos, e para quem chegou ao carrinho sem comprar, a mensagem de carrinho abandonado. Tudo é interrompido por resposta do cliente, por avanço no funil ou por atendimento humano.
- Cada mudança de status do pedido pode disparar uma mensagem ao cliente, no canal por onde ele conversa, respeitando a janela de 24 h do WhatsApp.
- Quando o cliente volta e a conversa é transferida para um humano, a nota de transbordo inclui o estado da Journey e do pedido.

Tudo funciona em qualquer canal do CRM (hoje WhatsApp e Telegram). O núcleo não conhece canais específicos, então um canal futuro herda a jornada sem mudanças.

## User Stories

**Operador (configuração)**

1. Como operador, quero cadastrar o endereço do cardápio de cada loja, para que cada loja envie o link do próprio domínio.
2. Como operador, quero usar uma variável de mensagem para o link do cardápio, para que o CRM crie o token e comece a Journey sem eu montar URLs à mão.
3. Como operador, quero ser avisado de forma visível quando uma loja não tem endereço de cardápio cadastrado, para não enviar link quebrado ao cliente.
4. Como operador, quero criar uma chave de API com permissão exclusiva para eventos, para entregar ao time do cardápio sem dar acesso a contatos ou mensagens.
5. Como operador, quero ativar um preset "Jornada de pedido" já montado, para começar sem configurar cada regra do zero.
6. Como operador, quero editar os textos das retomadas e das notificações de pedido, por canal, para adequar o tom de cada marca.
7. Como operador, quero configurar um template aprovado para cada notificação de status no WhatsApp, para que os avisos cheguem mesmo fora da janela de 24 h.
8. Como operador, quero ver aviso na edição de uma regra quando um passo não é suportado pelo canal escolhido, para não descobrir a falha em produção.

**Operador (acompanhamento)**

9. Como operador, quero ver as Journeys num pipeline com as etapas Link enviado, Navegando, Carrinho, Checkout, Comprou e Perdido, para enxergar onde os clientes travam.
10. Como operador, quero medir a conversão da Journey por canal e por loja, para comparar lojas e canais.
11. Como operador, quero ver no deal quantas vezes o cliente adicionou itens e o valor do carrinho, para avaliar o tamanho da oportunidade perdida.
12. Como operador, quero ver o pedido e o status atual dentro da conversa e do deal, para responder o cliente sabendo o andamento.
13. Como operador, quero que cada tentativa de pedido seja um deal separado, para medir cada tentativa e não misturar clientes recorrentes.

**Cliente**

14. Como cliente, quero receber o link do cardápio da loja em que estou conversando, para pedir sem ter que procurar o site.
15. Como cliente, quero uma retomada se eu parar de responder depois de receber o link, para lembrar de concluir o pedido.
16. Como cliente, quero que a retomada não chegue se eu acabei de responder, para não ser incomodado sem motivo.
17. Como cliente, quero que a retomada pare assim que eu adicionar itens ao carrinho, iniciar o checkout ou comprar, para não receber lembrete de algo que já estou fazendo.
18. Como cliente, quero receber um agradecimento quando meu pedido for feito, para ter certeza de que ele foi recebido.
19. Como cliente, quero ser avisado quando meu pedido for recebido, estiver em preparo, ficar pronto, sair para entrega, puder ser retirado ou for entregue, para acompanhar sem perguntar.
20. Como cliente, quero ser avisado se meu pedido for cancelado, para agir a tempo.
21. Como cliente, quero receber os avisos no mesmo canal em que conversei com a loja, para não precisar de outro aplicativo.
22. Como cliente que já pediu antes, quero fazer um novo pedido pelo mesmo caminho sem dificuldade, para que meu segundo pedido também seja acompanhado.

**Atendente**

23. Como atendente, quero que as retomadas parem quando um humano assume a conversa, para não atrapalhar o atendimento.
24. Como atendente que recebe um transbordo, quero ver na nota o estado da Journey e do pedido (etapa, pedido ativo, status e último evento), para entender a situação sem perguntar de novo ao cliente.
25. Como atendente, quero que o cliente com pedido em preparo seja identificável na conversa, para priorizar problemas de entrega.

**Time do cardápio (integrador)**

26. Como integrador, quero enviar eventos com uma chave de API do meu servidor, para que a chave nunca fique exposta no navegador do cliente.
27. Como integrador, quero que o reenvio do mesmo evento seja seguro, para poder tentar de novo depois de uma falha de rede sem duplicar efeitos.
28. Como integrador, quero enviar vários `AddToCart` diferentes na mesma Journey, para refletir o carrinho real.
29. Como integrador, quero receber uma resposta clara quando o `idtrack` é inválido ou expirou, para saber que preciso corrigir o link e não repetir a chamada.
30. Como integrador, quero receber uma resposta clara quando o status enviado não pertence ao conjunto aceito, para corrigir o meu lado.
31. Como integrador, quero que um evento que chega fora de ordem não estrague o estado, para não me preocupar com a ordem de entrega da minha fila.
32. Como integrador, quero um contrato documentado com exemplos de chamada e respostas de erro, para implementar sem depender de suporte.
33. Como integrador, quero que um novo evento depois de um `Purchase` funcione com o mesmo `idtrack`, para que clientes recorrentes que reaproveitam a mesma sessão continuem sendo atribuídos.

**Administração e manutenção**

34. Como administrador, quero que os endpoints de evento só aceitem chaves com a permissão de eventos e que cada consulta seja limitada à minha conta, para que uma chave nunca leia dados de outra conta.
35. Como administrador, quero que o token expire depois de um tempo sem novo link, para limitar o estrago se um link vazar.
36. Como mantenedor, quero que o núcleo da jornada nunca dependa de um canal específico, para adicionar novos canais sem mexer nelas.
37. Como mantenedor, quero que os textos novos existam nos quatro idiomas do produto, para que os testes de paridade continuem passando.

## Implementation Decisions

**Escopo desta spec (fase 1).** Eventos de jornada, status de pedido, deal por Journey, retomadas de 10 e 30 minutos, mensagem de carrinho abandonado, notificações de pedido, envio consciente da janela de 24 h, nota de transbordo com estado da Journey. O CRM guarda a data da última compra do contato para uso futuro, mas nenhuma mensagem por inatividade de 30 dias faz parte desta fase.

**Dois conceitos, uma entrada.** Journey events (comportamento) e Order statuses (estado de um pedido) chegam pelo mesmo endpoint público de eventos. O `Purchase` cria o Order; os status seguintes o avançam. Os status vivem no Order, não como etapas do pipeline.

**Endpoint público de eventos (`/api/v1`).**
- Um evento por chamada. Campos comuns: identificador do evento (`event_id`), nome, `idtrack` e instante da ocorrência.
- `Purchase` leva identificador externo do pedido, valor, moeda e itens.
- `OrderStatusChanged` leva identificador externo do pedido e um status do conjunto fechado: `received`, `preparing`, `finished`, `out_for_delivery`, `ready_for_pickup`, `delivered`, `cancelled`. O agradecimento não é um status: é a mensagem enviada quando o `Purchase` chega. O cardápio traduz seus estados internos para este conjunto (mapa no PRD do contrato); o CRM não adota o vocabulário do integrador.
- Nomes de eventos de comportamento seguem o Meta Pixel (`ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`).
- Autenticação por chave de API com um novo escopo exclusivo de eventos (`events:write`), criado pelos mesmos papéis que hoje criam chaves de API; os escopos são texto livre no banco, então não há migration por isso. Toda consulta é filtrada pela conta da chave.
- Idempotência: o mesmo `event_id` na mesma conta devolve a resposta original e não repete efeitos. Como as rotas v1 ainda não têm idempotência, esta é a primeira.
- Erros documentados: token inválido, token expirado, status fora do conjunto, corpo inválido, escopo ausente. O contrato completo, com o caminho, os códigos de erro e os exemplos, está em `prd-menu-events-contract.md`.
- O contrato entra na documentação pública da API e fica sujeito ao congelamento pré-estável descrito nela.

**Tracking token.**
- Criado quando o CRM envia o link do cardápio; opaco; identifica contato, conversa e conexão; passa a ser uma identidade do contato do tipo `idtrack`. Isso exige permitir esse tipo de identidade na API de contatos, que hoje recusa tipos que nenhum canal declara.
- Validade de 30 dias, renovada a cada novo link enviado. Configuração por loja fica para depois.
- Um evento em um token cuja Journey já fechou abre uma nova Journey (decisão de reaproveitamento); não é rejeitado.

**Link do cardápio por loja.**
- A loja ganha um campo de endereço do cardápio, editável no cadastro de lojas. Migration nova.
- A variável de mensagem do link resolve, na hora do envio, pelo caminho conversa → conexão → loja; acrescenta o `idtrack`; cria o token; registra "link enviado" e abre a Journey.
- Loja sem endereço: a variável falha de forma visível e nada é enviado. A IA de resposta e as automações passam a usar a variável no lugar de URL fixa.

**Journey e deal.**
- Um deal por Journey, aberto no "link enviado" (ou no primeiro evento quando não há Journey aberta), com conversa e conexão gravadas.
- Etapas: Link enviado → Navegando → Carrinho → Checkout → Comprou / Perdido.
- O deal só avança pelo funil, nunca recua. `ViewContent` marca "Navegando" na primeira vez; as seguintes viram contador. Cada `AddToCart` atualiza a contagem de itens e o valor do carrinho, mesmo repetido e mesmo depois de `InitiateCheckout`, sem mudar a etapa.
- `Purchase` é terminal: fecha a Journey como ganha, cria o Order e grava a data da última compra do contato. O estado final vale mesmo se um evento intermediário nunca chegar.
- A Journey vira "Perdido" ao fim da última retomada sem engajamento ou 24 h após o último evento sem `Purchase`, o que ocorrer depois. Um `Purchase` posterior em Journey já perdida abre uma nova Journey (o funil da tentativa perdida não é reaberto).
- A criação do deal por Journey deduplica: não pode haver dois deals abertos para a mesma Journey.

**Automações.**
- Dois novos gatilhos genéricos: evento de jornada (filtrado por nome) e mudança de status do pedido (filtrada por status).
- Duas novas condições: "cliente respondeu desde o instante X" e "Journey aberta".
- Um preset "Jornada de pedido" com as retomadas, o carrinho abandonado, o agradecimento e as notificações de status, como ponto de partida. Não há tela própria de jornada.
- Retomadas: texto fixo e configurável por canal. Aos 10 e aos 30 minutos após o link, dispara-se apenas se o cliente não respondeu, não houve `AddToCart`/`InitiateCheckout`/`Purchase` e não há humano atribuído nem transbordo da IA. Todas essas condições são reavaliadas no momento do disparo, não só no agendamento.
- Quem já chegou ao carrinho ou checkout sem comprar recebe a mensagem de carrinho abandonado no lugar da retomada genérica, 10 minutos após o último `AddToCart`/`InitiateCheckout` sem `Purchase`, uma vez por Journey.
- O agendamento de espera depende de um agendador externo chamando o processador de pendências; a documentação deve dizer que o intervalo recomendado passa a ser de 1 a 2 minutos.

**Envio consciente da janela de 24 h.** A camada de envio conhece a janela do WhatsApp: se a última mensagem do cliente tem menos de 24 h, envia texto; se não, usa o template configurado; se não houver template, falha de forma visível. Vale para todos os envios de automação, retomada e notificação, não só para a jornada. Telegram não tem janela.

**Notificações de pedido.** O CRM é dono do texto. O cardápio só envia o status e os dados do pedido. O `Purchase` dispara o agradecimento; cada status dispara sua mensagem, por canal, pela automação configurada.

**Transbordo.** A nota deterministica de hoje é ampliada com o estado da Journey: etapa do deal, pedido ativo, seu status e o último evento. Sem LLM.

**Multicanal.** Nada da jornada importa módulo específico de canal. O que depende de canal (template, botões) usa as capacidades declaradas pelo canal, e a UI mostra o aviso informativo de passo não suportado. O tipo de identidade `idtrack` é do CRM, não de um canal.

**Internacionalização.** Todo texto novo passa pelo catálogo de mensagens nos quatro idiomas, com o glossário de português já existente.

## Testing Decisions

**O que é um bom teste aqui.** Testar o comportamento visível de fora (respostas da API, mensagens enviadas, estado do deal e do pedido) e não a forma como o código chega lá. Nenhum teste deve depender de detalhes internos como nomes de funções auxiliares.

**Três pontos de teste, nos níveis mais altos possíveis.**

1. **Rota pública de eventos** (nível HTTP, banco simulado). Cobre: resolução de token e erros; idempotência por `event_id`; `AddToCart` repetido; nunca recuar de etapa; `Purchase` terminal com Order e data da última compra; novo evento depois do `Purchase` abrindo nova Journey; status fora do conjunto; escopo ausente; isolamento por conta; transição de Journey e deal. Arte anterior: os testes de rota `v1` de mensagens e contatos.
2. **Motor de automações com os novos gatilhos** (nível motor, simulador de banco). Cobre: disparo por evento e por status; retomadas de 10 e 30 min só quando o cliente não respondeu; interrupção por resposta, por `AddToCart`/`InitiateCheckout`/`Purchase`; supressão por humano ou transbordo verificada na hora do disparo; mensagem de carrinho abandonado. Arte anterior: os testes do motor e o simulador de caracterização.
3. **Envio consciente da janela** (nível `sendOutbound`). Cobre: texto dentro da janela; template fora dela; falha visível sem template; Telegram sem janela. Arte anterior: os testes de fanout e de ingestão de canais.

A variável do link é testada pelo ponto 2 (resolução por loja, loja sem endereço, token criado, Journey aberta). A nota de transbordo é testada como parte do mesmo ponto quando o transbordo é exercitado.

## Out of Scope

- Mensagem por inatividade de 30 dias e régua de comunicação de recorrência (fase 2, com spec própria; a data da última compra já é gravada).
- Resumo do transbordo por LLM.
- Tela própria de jornada (só gatilhos genéricos e preset).
- Envio de eventos em lote; validade do token configurável por loja.
- Deals e pipelines na API pública; ferramentas no servidor MCP.
- Log completo de todos os `ViewContent` (só o primeiro e um contador); analytics de comportamento do cardápio.
- Corrigir o gatilho de agendamento (`time_based`), que hoje não é avaliado pelo motor.
- Novos canais (Instagram, SMS, e-mail); a jornada os herda quando existirem.

## Further Notes

**Decisões confirmadas** (ver também Implementation Decisions): a Journey vira "Perdido" ao fim da última retomada sem engajamento ou 24 h após o último evento sem `Purchase`, o que ocorrer depois; a mensagem de carrinho abandonado dispara 10 min após o último `AddToCart`/`InitiateCheckout` sem `Purchase`, uma vez por Journey; a chave `events:write` é criada pelos mesmos papéis que hoje criam chaves de API.

**Entregas derivadas.** (a) O PRD do contrato de eventos para o time do cardápio (`prd-menu-events-contract.md`), derivado desta spec; (b) `/to-tickets` para quebrar em tickets; (c) atualização de `docs/public-api.md` e da documentação de agendadores.

**Respostas do time do cardápio (registradas).** O cardápio consegue enviar o carrinho inteiro em `AddToCart`/`InitiateCheckout`. Os estados internos deles são PLACED, APPROVED, CANCELED, TODO, DOING, DONE, DISPACHED, READYTOPICKUP e DELIVERED; o mapa está no PRD, e a consequência foi incluir `delivered` no conjunto. O `idtrack` vive apenas em `sessionStorage` do navegador, e o backend deles não tem fila nem reenvio.

**Consequências dessas respostas.**
- Os status chegam horas depois, do backend, quando o `sessionStorage` já não existe: o cardápio precisa **gravar o `idtrack` junto do pedido** no momento do `Purchase`.
- Sem mecanismo de reenvio, uma falha transitória perde eventos. Perder `Purchase` é o pior caso, porque o CRM trataria o cliente como quem abandonou e enviaria retomada ou carrinho abandonado a quem já comprou. O contrato passa a exigir uma fila de saída (outbox) com reenvio para `Purchase` e `OrderStatusChanged`, e aceita perda pontual dos demais eventos. O time do cardápio implementará essa fila (decisão registrada).
- Um `Purchase` que chega depois de uma mensagem de carrinho abandonado já enviada fecha a Journey como ganha e cancela o que estiver pendente, mas a mensagem já enviada não se desfaz.
- Cliente que abre o cardápio sem `idtrack` (endereço direto, favorito) não gera eventos atribuíveis; o cardápio não deve enviar eventos sem `idtrack`.

**Riscos.** O intervalo do agendador externo limita a precisão das retomadas de 10 min; o envio consciente da janela muda um comportamento compartilhado por todos os envios (testar regressão); permitir o tipo de identidade `idtrack` toca o contrato de identidades e deve ser revisado com o mesmo cuidado que a API de contatos.
