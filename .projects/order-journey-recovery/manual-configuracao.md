# Manual de configuração: Jornada de pedido

Passo a passo para colocar a jornada de pedido para funcionar no CRM. Feito para quem administra o sistema (perfil proprietário ou administrador). Os nomes de telas abaixo são os do idioma português. A referência técnica, em inglês, está em `docs/order-journey.md`; o contrato para o time do cardápio, em `prd-menu-events-contract.md`.

## Antes de começar

Tenha em mãos:

- O endereço (`https://…`) do cardápio de cada loja.
- Pelo menos um canal conectado por loja (WhatsApp ou Telegram), em **Configurações → Canais**.
- Templates aprovados na Meta para o WhatsApp, se as mensagens forem sair depois de 24 horas da última mensagem do cliente (passo 6).
- Acesso ao servidor onde o CRM roda, para as migrations e o agendador (passos 1 e 7).

## Passo 1. Aplicar as migrations

A feature precisa das migrations **055 a 062**. Elas não são aplicadas sozinhas em uma instalação existente.

- **Stack Docker com Supabase:** o serviço `migrate` aplica tudo ao subir (`docker compose … up --build -d`).
- **Supabase externo:** aplique os arquivos de `supabase/migrations/` de 055 a 062, em ordem.

Como conferir: as lojas ganham o campo "Endereço do cardápio digital" (passo 2) e a tela de Pipelines não dá erro.

A migration 062 ainda não foi testada num Postgres de produção. Aplique primeiro num ambiente de teste ou faça um backup antes.

## Passo 2. Cadastrar o endereço do cardápio de cada loja

1. Vá em **Configurações → Lojas**.
2. Edite a loja e preencha **Endereço do cardápio digital** (`https://…`).
3. Repita para todas as lojas. Cada loja envia o seu próprio domínio (por exemplo, `rpa.bellacapri.com.br` numa loja e `rpv.pizzaagora.com.br` em outra).

Uma loja sem endereço não consegue enviar o link do cardápio: a mensagem **não é enviada** e a falha aparece no log da automação. O cartão do preset (passo 5) lista as lojas que faltam.

## Passo 3. Colocar o link do cardápio nas mensagens

O link é escrito como a variável `{{menu_link}}`. O CRM troca a variável pelo endereço da loja, acrescenta o identificador de rastreio (`?idtrack=…`) e abre a jornada do cliente.

- **Automações:** escreva `{{menu_link}}` no texto de um passo "Enviar mensagem" (por exemplo, na automação que responde "quero fazer um pedido").
- **IA de resposta:** ela já é instruída a usar `{{menu_link}}`. **Remova qualquer endereço de cardápio fixo** que esteja no prompt do negócio ou na base de conhecimento da IA, senão ela pode enviar um link sem rastreio.

Onde a variável não funciona: botões, listas, templates e Flows. Nesses casos, envie o link em uma mensagem de texto.

## Passo 4. Criar a chave de API para o time do cardápio

1. Vá em **Configurações → Chaves de API** e clique em **Nova chave de API**.
2. Marque **somente** o escopo `events:write` ("Enviar eventos da jornada de pedido a partir do cardápio digital"). Essa chave envia eventos e não lê contatos, conversas nem mensagens.
3. Copie a chave na hora: ela não é mostrada de novo.
4. Entregue ao time do cardápio como segredo de servidor (nunca no navegador), junto com a URL do CRM e o resumo do contrato (`prd-menu-events-summary.md`).

Se a chave vazar, revogue na mesma tela. A revogação vale na próxima requisição.

## Passo 5. Instalar o preset "Jornada de pedido"

1. Vá em **Automações**. No topo há o cartão **Jornada de pedido**.
2. Clique em **Adicionar o preset Jornada de pedido**. Ele cria 10 automações, todas **desligadas**:
   - retomadas 10 e 30 minutos depois do link;
   - carrinho abandonado (10 minutos depois do último item adicionado ou do início do fechamento, uma vez por jornada);
   - agradecimento, quando o pedido é feito;
   - uma mensagem por status do pedido: recebido, em preparo, finalizado, saiu para entrega, pronto para retirada, entregue e cancelado.
3. O cartão mostra o que ainda falta: lojas sem endereço, automações desligadas e mensagens sem template do WhatsApp.
4. **Revise cada texto** (eles vêm no idioma do sistema) e ajuste o tom da sua marca. Variáveis disponíveis nos textos de pedido: `{{order_id}}`, `{{order_status}}` e `{{order_value}}`.
5. **Ligue** as automações que quiser usar. A de "entregue" pode ficar desligada, se você não quiser avisar o cliente nesse momento.

Instalar o preset de novo só recria o que você apagou; nunca sobrescreve o que você editou.

## Passo 6. Templates do WhatsApp para fora da janela de 24 horas

O WhatsApp só permite texto livre até 24 horas depois da última mensagem do cliente. As retomadas, o carrinho abandonado e os avisos de status costumam sair depois disso.

1. Crie e aprove os templates em **Configurações → Templates** (a Meta aprova).
2. Em cada automação do preset, no passo "Enviar mensagem", preencha **Template fora da janela de 24 h (WhatsApp)** com o template correspondente e, se ele tiver variáveis, as **Variáveis do template** (uma por linha, em ordem; são valores fixos).
3. Sem esse template, o envio fora da janela **falha de forma visível** (log da automação e mensagem com erro na conversa). Nada é perdido em silêncio.

Observações:
- No Telegram não existe janela, então o campo não faz efeito.
- Uma mensagem que contém `{{menu_link}}` ignora o template alternativo (o template não levaria o link). Fora da janela, ela falha.

## Passo 7. Configurar o agendador (obrigatório)

As esperas (retomadas e carrinho abandonado) e o fechamento de jornadas abandonadas só andam se um agendador externo chamar o CRM. O CRM não agenda nada sozinho.

1. Configure o agendador para chamar `GET /api/automations/cron` **a cada 1 a 2 minutos**, com o cabeçalho `x-cron-secret` igual ao valor de `AUTOMATION_CRON_SECRET` do `.env.local`.
2. Com um intervalo de 5 minutos, uma retomada de "10 minutos" pode sair até 5 minutos atrasada.
3. A mesma chamada fecha como "Perdido" as jornadas sem atividade por 24 horas.

Exemplo de conferência: `curl -H "x-cron-secret: <segredo>" https://<seu-crm>/api/automations/cron` deve responder com sucesso.

## Passo 8. Testar de ponta a ponta

Antes de liberar para clientes, teste com um número seu e uma chave de teste:

1. Envie a mensagem que dispara o link. Confirme que o link recebido tem `?idtrack=` e é o da loja certa.
2. Em **Pipelines → Jornada de Pedido**, o negócio aparece em "Link enviado".
3. Peça ao time do cardápio (ou envie você mesmo, pela API) `ViewContent`, `AddToCart`, `InitiateCheckout` e `Purchase`. Confirme que o negócio avança de etapa e que o pedido aparece no painel da conversa.
4. Envie os status do pedido, um a um. Confirme que a mensagem correspondente chega no canal do cliente.
5. Faça um teste de abandono: receba o link e não responda. Confirme a retomada aos 10 e aos 30 minutos.
6. Responda o cliente logo após o link e confirme que a retomada **não** sai.

## Como ler o resultado

- **Pipelines → Jornada de Pedido:** o quadro mostra os negócios por etapa, com quantidade de itens e valor do carrinho. Use os filtros de **canal** e **loja**.
- O painel **Conversão da jornada** mostra quantas jornadas chegaram a cada etapa (na etapa ou além dela), quantas foram perdidas e a taxa de "link enviado" até "comprou", no geral, por canal e por loja.
- No transbordo para um atendente, a nota da conversa inclui a etapa da jornada, o pedido ativo, o status e o último evento.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| A mensagem com `{{menu_link}}` não sai | Loja sem endereço do cardápio | Passo 2 |
| Erro "fora da janela" no log ou na conversa | Sem template alternativo no WhatsApp | Passo 6 |
| Retomada atrasada ou não sai | Agendador parado ou muito espaçado | Passo 7 |
| Eventos do cardápio rejeitados (401/403) | Chave errada ou sem o escopo `events:write` | Passo 4 |
| Erro 404 `idtrack_not_found` | O cardápio perdeu o `idtrack` ou o link não veio do CRM | Conferir o link e o que o cardápio guarda |
| Erro 410 `idtrack_expired` | O link tem mais de 30 dias sem renovação | Enviar um novo link ao cliente |
| Cliente que já comprou recebe lembrete de carrinho | O `Purchase` se perdeu no caminho | O cardápio precisa de fila de saída com reenvio (contrato) |

## Limitações conhecidas

- A precisão das retomadas depende do intervalo do agendador.
- O preset cria uma automação por etapa, não por canal. Para textos diferentes por canal, duplique a automação e ajuste.
- O funil não tem filtro de datas.
- A nota de transbordo e mensagens de erro do motor estão em inglês.
- Não há mensagem para clientes inativos há 30 dias. A data da última compra já é guardada para uma fase futura.
