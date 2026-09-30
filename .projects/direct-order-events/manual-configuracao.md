# Manual de configuração: eventos diretos do cardápio

Passo a passo para o operador (perfil proprietário ou administrador) colocar para funcionar o acompanhamento dos pedidos que **não** vieram de um link do CRM: o cardápio envia os eventos identificando o cliente pela **chave da loja** e pelo **telefone**, e o CRM só manda mensagem a quem **consentiu**. Os nomes de telas são os do idioma português. Este manual **complementa** o da jornada de pedido (`../order-journey-recovery/manual-configuracao.md`), que precisa estar feito antes (preset, agendador, templates). A referência técnica, em inglês, está em `docs/order-journey.md`; o contrato para o time do cardápio, em `prd-menu-events-addendum.md`.

## Antes de começar

- A jornada de pedido já funciona (passos 1 a 7 do manual dela).
- As migrations **055 a 066** estão aplicadas (as duas features juntas). Na stack Docker o serviço `migrate` aplica tudo ao subir; em Supabase externo, aplique 063, 064, 065 e 066 em ordem. Ainda **não** foram aplicadas num banco de produção: teste num ambiente de teste ou faça backup antes.
- Um **telefone seu** para testar (passo 6).

## Passo 1. Cadastrar os três campos da loja

1. Vá em **Configurações → Lojas** e edite a loja (ou **Nova loja**).
2. No bloco **Chave da loja**, preencha **Código** (ex.: `89`), **Sigla da loja** (ex.: `RPA`) e **Sigla do negócio** (ex.: `BLC`). Não use `/` nem passe de 40 caracteres.
3. A tela mostra **Chave da loja: 89/RPA/BLC**. É exatamente esse valor que o time do cardápio envia em `store_key`. Maiúsculas e espaços nas pontas não importam.
4. Duas marcas no mesmo local são **duas lojas**: `89/RPA/BLC` e `89/RPA/PZA`, cadastradas separadamente. Se repetir uma chave, aparece "Outra loja já usa esta chave."
5. Lojas antigas ficam sem chave: só recebem eventos por `idtrack` até você preencher os três campos.

## Passo 2. Definir a conexão de avisos da loja

O aviso a quem nunca escreveu sai por **uma** conexão de WhatsApp da loja:

- a loja tem **uma** conexão de WhatsApp ativa: nada a fazer, ela é usada;
- a loja tem **duas ou mais**: ao editar a loja aparece **Conexão do WhatsApp para avisos**; escolha uma. Sem escolha, **nenhuma mensagem sai** e o log da automação diz "sem conexão de avisos da loja";
- a loja **não tem** WhatsApp: o evento é aceito, o pedido é registrado, nada é enviado (a resposta traz `messaging: no_connection`). Telegram não serve para isso (não se alcança um bot por telefone).

## Passo 3. Dar ao time do cardápio a chave `events:write`

1. **Configurações → Chaves de API → Nova chave de API**.
2. Marque **somente** "Enviar eventos da jornada de pedido a partir do cardápio digital" (`events:write`). Com telefone, uma chave vazada pode criar contatos e disparar templates para quem tem consentimento registrado: guarde como segredo de servidor.
3. Entregue ao time do cardápio: a chave, a URL do CRM, o adendo (`prd-menu-events-addendum.md`) e a lista de chaves de loja (`GET /api/v1/stores` com uma chave de `connections:read`, ou copie da tela de lojas).

O cardápio precisa coletar o consentimento no pedido, separando **avisos do pedido** e **ofertas e lembretes**, e enviar a data em que o cliente aceitou (`consent.given_at`, nunca no futuro).

## Passo 4. Conferir o consentimento no contato

Depois do primeiro evento de um cliente:

1. Abra **Contatos**, o contato (criado com origem "cardápio") e procure o bloco **Consentimento de mensagens**. O mesmo bloco aparece no painel lateral da conversa no **Inbox**.
2. Cada finalidade mostra **Avisos do pedido** e **Ofertas e lembretes**, com "Ativo desde <data> · origem: Cardápio", "Revogado em <data> · origem: Cardápio/Chat" ou "Sem registro".
3. "Sem registro" também aparece para quem **já escreveu** para a loja: esse cliente tem consentimento implícito para as duas finalidades (como antes), mesmo sem registro. Uma revogação explícita vale acima do implícito.
4. O cliente que responde **PARAR** (ou `stop`, `parar mensagens`, `cancelar envio`, entre outras) tem as duas finalidades revogadas (origem "Chat") e recebe uma confirmação. A mensagem tem de ser só a palavra; "cancelar" e "sair" sozinhos não valem: "cancelar" é como se cancela um pedido e "sair" é a saída habitual de menus e fluxos. Um novo consentimento do cardápio, com data mais nova, reativa.

## Passo 5. Escolher a finalidade nos passos de envio

1. **Automações**, abra uma automação e cada passo **Enviar mensagem**, **Enviar botões**, **Enviar lista** e **Enviar template**.
2. O campo **Consentimento para quem nunca escreveu** tem duas opções: **Avisos do pedido** e **Marketing**. O passo só envia a quem nunca escreveu se aquela finalidade estiver ativa; senão é **ignorado** e o log mostra "ignored: sem consentimento: …".
3. No preset: agradecimento e os avisos de status já vêm como **Avisos do pedido**; o carrinho abandonado vem como **Marketing**. Um passo sem valor salvo conta como **Marketing** (padrão estrito). Rodar o preset de novo preenche a finalidade das automações já instaladas sem mexer nos textos.
4. **Templates.** A primeira mensagem a quem nunca escreveu é sempre **template aprovado**, enviado numa conversa criada **fechada** (não aparece no filtro "Aberta"; quando o cliente responde, ela reabre para um atendente). Preencha **Template fora da janela de 24 h (WhatsApp)** em cada passo (passo 6 do manual da jornada). Sem template o envio **falha de forma visível** no log e na conversa.
5. O lembrete de carrinho abandonado vale também para pedidos diretos, mas as **retomadas de 10 e 30 minutos depois do link** não (não existe link).

## Passo 6. Duplicar automações por marca (só quando o texto muda)

A regra é **um conjunto só** de automações para todas as marcas.

- Para variar só o nome, escreva `{{store_name}}` no texto (vira o nome da loja da conversa, por exemplo "Bella Capri Centro"). Sem loja, o texto sai com a variável vazia e o log registra um aviso.
- Só quando uma marca precisa de **um texto realmente diferente**: em **Automações**, use **Duplicar** na automação, edite o texto e adicione a condição **Sigla do negócio da loja é** com a sigla (ex.: `PZA`). Mantenha a original com a condição da outra marca, ou ela vai disparar para as duas.
- **Templates do WhatsApp:** use o **mesmo nome de template em cada WABA** (cada marca com o seu conteúdo). O passo usa um nome só, o envio sai pela conexão da loja e a Meta resolve o nome na WABA dela. **Esta convenção NÃO foi testada com duas WABAs reais**: valide com um pedido de teste de cada marca antes de liberar.
- Nesses casos o texto do passo não é usado quando o envio cai no template: vale o conteúdo do template.

## Passo 7. Testar com um telefone seu

1. Use a chave de loja real (`STORE_KEY`) e o **seu** telefone (`PHONE`, `+5511...`) no arquivo `eventos-diretos-curl.sh` (ou importe `eventos-diretos-insomnia.json` no Insomnia). Rode os comandos **um a um**.
2. **Com consentimento:** envie o `Purchase` direto com `consent.notifications: true`. Confira: resposta `200` com `messaging: eligible`; o contato e o pedido criados; em **Inbox**, uma conversa **fechada**; no WhatsApp, o template de agradecimento. Responda no WhatsApp: a conversa passa a **Aberta**.
3. Envie os status do pedido (`OrderStatusChanged` com o mesmo `order_id`) e confira cada aviso.
4. **Sem consentimento:** troque por um telefone que o CRM não conhece e envie o `Purchase` sem `consent`. Esperado: pedido registrado, `messaging: no_consent`, **nenhuma** mensagem e nenhuma conversa criada.
5. **Revogação:** envie `consent.notifications: false` (com `given_at` novo). Esperado: nenhum aviso de status depois disso.
6. **PARAR:** responda "PARAR" no WhatsApp e confira o painel de consentimento.
7. Em **Pipelines → Jornada de Pedido** o negócio aparece com "Direto do cardápio"; o quadro **Conversão da Jornada** separa as linhas por origem (**Link do CRM** e **Direto do cardápio**).

## Problemas comuns

| Sintoma                                                                           | Causa provável                                                                                            | O que fazer                                                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `404 store_not_found`                                                             | A chave enviada não existe no CRM                                                                         | Conferir o que está em **Configurações → Lojas** (três campos preenchidos) e o que o cardápio envia. Não adianta reenviar |
| `400` com "customer.phone"                                                        | Telefone sem `+` ou fora do formato E.164                                                                 | O cardápio deve normalizar antes do envio (`+5511999998888`)                                                              |
| `400` "consent.given_at is in the future"                                         | Relógio do cardápio adiantado mais de 5 minutos                                                           | Corrigir o relógio ou enviar o momento real do aceite                                                                     |
| `400` "given_at is required"                                                      | Enviou `consent` com finalidade mas sem data                                                              | Sempre enviar `given_at` junto                                                                                            |
| `messaging: no_consent`                                                           | Sem consentimento ativo para avisos, e o cliente nunca escreveu                                           | Conferir o bloco de consentimento do contato e o que o cardápio envia                                                     |
| `messaging: no_connection`                                                        | Loja sem WhatsApp, ou com várias conexões e nenhuma escolhida                                             | Passo 2                                                                                                                   |
| O evento entrou mas nada foi enviado                                              | Passo ignorado por finalidade, sem template, automação desligada ou fora do agendador                     | Ver o **log** da automação: a mensagem do passo diz o motivo                                                              |
| Consentimento "não atualiza"                                                      | O `given_at` enviado não é mais novo que o guardado                                                       | Enviar a data real do último aceite/revogação do cliente                                                                  |
| Um evento com `idtrack` e telefone de outro cliente não atualizou o consentimento | Conflito: o `idtrack` manda, `customer` e `consent` são ignorados (fica no log, com o telefone mascarado) | Esperado; corrigir o que o cardápio envia                                                                                 |
| Conversas "Abertas" cheias de avisos                                              | Não deveria: conversas de avisos nascem fechadas                                                          | Conferir se a conversa foi criada antes desta versão                                                                      |
| Cliente recebe aviso depois de responder PARAR                                    | O consentimento do cardápio mais novo reativou                                                            | Esperado: vale o mais recente; conferir a data no contato                                                                 |
| Funil com poucas "Link enviado"                                                   | Jornadas diretas nunca passam por "link enviado"                                                          | Esperado: use "Compradas / Jornadas" para as diretas                                                                      |

## O que este manual não cobre

- Duas WABAs reais com templates de mesmo nome: **não testado** (passo 6).
- Mensagens para inativos e campanhas (broadcast) a quem deu consentimento de marketing: fora desta versão.
- Limite diário de primeiros contatos por conta: não existe ainda (risco registrado na spec); os freios são o limite por chave (120/min), só template no primeiro contato e o consentimento.
