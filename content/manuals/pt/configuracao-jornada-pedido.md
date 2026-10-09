# Configuração da jornada de pedido

Para quem administra o CRM (perfil proprietário ou administrador): passo a passo para colocar a jornada de pedido para funcionar. Os nomes de telas são os do idioma português.

O time do cardápio recebe, ao final, o link da documentação de integração (seção [9](#9-o-que-entregar-ao-time-do-cardápio)): `{URL_BASE}/developers`. O que o time do cardápio lê está em [Integração do cardápio](./integracao-cardapio.md).

---

## Como funciona

```
Cliente ──(conversa)──► CRM ──(envia o link com ?idtrack=…)──► Cliente
                                                                  │
Cliente abre o cardápio, monta o carrinho e faz o pedido ◄────────┘
        │
        ▼
Backend do cardápio ──(eventos, servidor a servidor)──► CRM
                                                         │
CRM move o negócio no funil e envia mensagens ao cliente ┘
```

O cardápio **informa** o que acontece; quem **envia as mensagens** é o CRM, por automações que você configura nas seções abaixo. Os eventos sozinhos não mandam mensagem nenhuma.

### Os dois modos de identificar o cliente

| Modo                | Quando usar                                                                                        | Como o evento identifica o cliente           |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Com link do CRM** | O cliente recebeu o link do cardápio numa conversa do CRM (`https://<cardápio>/?idtrack=<token>`). | `idtrack`                                    |
| **Direto**          | O cliente chegou por outro caminho (Instagram, link antigo, endereço digitado).                    | `store_key` + `customer.phone` (+ `consent`) |

Um evento precisa trazer **`idtrack`**, **ou** **`store_key` junto com `customer.phone`**. Sem nenhum dos dois, a resposta é `400`. Se vierem os dois, o `idtrack` manda.

Vale implementar os dois: o primeiro cobre o fluxo conversa → link → pedido; o segundo, todos os demais pedidos.

### Os cinco eventos

| `name`               | Quando enviar                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| `ViewContent`        | O cliente abriu o cardápio ou um produto (primeiro acesso da sessão).    |
| `AddToCart`          | O cliente mudou o carrinho. Pode repetir. Sempre o **carrinho inteiro**. |
| `InitiateCheckout`   | O cliente iniciou o fechamento do pedido. Carrinho inteiro.              |
| `Purchase`           | O pedido foi feito. Encerra a jornada como ganha e cria o pedido no CRM. |
| `OrderStatusChanged` | O pedido mudou de estado depois de feito.                                |

A jornada do cliente só avança: Link enviado → Navegando → Carrinho → Checkout → Comprou.

---

## 1. Antes de começar

Tenha em mãos:

- O endereço (`https://…`) do cardápio de **cada loja**.
- Pelo menos um canal conectado por loja (WhatsApp ou Telegram), em **Configurações → Canais**. Para pedidos diretos, a loja precisa de uma conexão de **WhatsApp**.
- Templates do WhatsApp aprovados na Meta, se as mensagens saírem depois de 24 horas da última mensagem do cliente (seção 7).
- Acesso ao servidor onde o CRM roda, para as migrations e o agendador (seções 2 e 8).

## 2. Aplicar as migrations

A funcionalidade precisa das migrations **055 a 069** de `supabase/migrations/`. Elas **não são aplicadas sozinhas** em uma instalação existente.

- **Stack Docker com Supabase:** o serviço `migrate` aplica tudo ao subir (`docker compose … up --build -d`).
- **Supabase externo:** aplique os arquivos de 055 a 069, em ordem.

| Migrations | Para quê                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 055 a 062  | Jornada com link do CRM (endereço do cardápio, jornadas, pedidos, histórico de status).                                                                                       |
| 063 a 068  | Eventos diretos (chave da loja, consentimento, jornadas sem link). Só são necessárias se o cardápio enviar eventos sem `idtrack`. São aditivas: nada do que já existe muda.   |
| 069        | Marcar o negócio como ganho ou perdido à mão (ou arrastá-lo para Comprou ou Perdido) encerra também a jornada. Veja a seção 11. Necessária para quem usa a jornada de pedido. |

Aplique primeiro num ambiente de teste ou faça backup. Para conferir: as lojas ganham o campo **Endereço do cardápio digital** (seção 3) e a tela de Pipelines abre sem erro.

## 3. Cadastrar as lojas

Em **Configurações → Lojas**, edite cada loja (ou crie uma nova).

**Endereço do cardápio digital** (`https://…`). Cada loja usa o seu próprio domínio. Uma loja sem endereço não consegue enviar o link do cardápio: a mensagem **não é enviada** e a falha aparece no log da automação.

**Chave da loja** (necessária para eventos diretos). Preencha três campos, sem `/` e com no máximo 40 caracteres:

| Campo            | Exemplo |
| ---------------- | ------- |
| Código           | `89`    |
| Sigla da loja    | `RPA`   |
| Sigla do negócio | `BLC`   |

A tela mostra a chave composta, por exemplo **`89/RPA/BLC`**. É exatamente esse valor que o cardápio envia em `store_key`.

- A chave é única na conta (maiúsculas e espaços nas pontas não importam).
- Duas marcas no mesmo local são **duas lojas**: `89/RPA/BLC` e `89/RPA/PZA`, cadastradas separadamente.
- Chave repetida é recusada ("Outra loja já usa esta chave.").
- Lojas antigas ficam sem chave e só recebem eventos por `idtrack` até os três campos serem preenchidos.

**Conexão do WhatsApp para avisos** (eventos diretos). O aviso a quem nunca escreveu sai por **uma** conexão de WhatsApp da loja:

- a loja tem **uma** conexão ativa: ela é usada, nada a fazer;
- a loja tem **duas ou mais**: ao editar a loja aparece **Conexão do WhatsApp para avisos**; escolha uma. Sem escolha, nenhuma mensagem sai e o log diz "sem conexão de avisos da loja";
- a loja **não tem** WhatsApp: o evento é aceito e o pedido registrado, mas nada é enviado (a resposta traz `messaging: no_connection`). Telegram não serve para isso, porque não se alcança um bot por telefone.

## 4. Fazer o CRM enviar o link do cardápio

Esta etapa vale para o modo **com link do CRM**. O preset de automações (seção 6) não responde à primeira mensagem do cliente: ele só cuida do que acontece **depois** que o link foi enviado. Sem uma resposta configurada aqui, quem escreve "quero fazer um pedido" fica sem resposta.

O link é escrito como a variável **`{{menu_link}}`**. O CRM a troca pelo endereço da loja, acrescenta `?idtrack=<token>` e abre a jornada do cliente. Escolha **uma** das opções.

### Opção 1: automação por palavra-chave (resposta fixa)

1. **Automações** → nova automação.
2. **Gatilho:** Palavra-chave, com as palavras separadas por vírgula (`pedido, cardápio, cardapio, pizza`).
3. Passo **Enviar mensagem**, por exemplo: `Olá! Faça seu pedido pelo nosso cardápio: {{menu_link}}`
4. Salve e **ative**.

Enquanto existir qualquer automação ativa com gatilho **Palavra-chave** ou **Nova mensagem recebida**, a resposta automática da IA fica desligada para a conta inteira, para não responder duas vezes.

### Opção 2: assistente de IA (conversa livre)

1. **Agentes de IA → Configuração:** informe provedor, modelo e chave de API (use **Testar chave**).
2. Em **Contexto do negócio e instruções**, diga quando enviar o cardápio, por exemplo: `Quando o cliente quiser fazer um pedido, envie o cardápio com o link {{menu_link}}.`
3. **Remova qualquer endereço de cardápio fixo** desse texto e da base de conhecimento. A IA deve usar só `{{menu_link}}`, senão o link sai sem rastreio.
4. Ative **Ativar assistente de IA** e **Responder automaticamente a mensagens recebidas**.
5. Não deixe ativa nenhuma automação de Palavra-chave ou Nova mensagem recebida.

### Vale para as duas

- O canal da conversa precisa pertencer a uma loja **com endereço do cardápio** (seção 3).
- `{{menu_link}}` funciona em mensagens de texto. **Não** funciona em botões, listas, templates nem Flows.
- Para conferir: o link recebido tem `?idtrack=` e o negócio aparece em **Pipelines → Jornada de Pedido**, na etapa "Link enviado".

## 5. Criar a chave de API do cardápio

1. **Configurações → Chaves de API → Nova chave de API.**
2. Dê um nome que identifique o cardápio (por exemplo, `cardápio-loja-x`).
3. Marque **somente** o escopo `events:write` ("Enviar eventos da jornada de pedido a partir do cardápio digital"). Essa chave envia eventos e nada mais: não lê contatos, conversas nem mensagens.
4. **Copie a chave na hora**: ela é mostrada uma única vez (o CRM guarda só um hash). Se perder, revogue e crie outra.

Crie **uma chave por time/cardápio**, para poder revogar uma sem afetar as outras. Se a chave vazar, revogue na mesma tela (vale a partir da próxima requisição). Com telefone nos eventos, uma chave vazada pode criar contatos e disparar templates para quem tem consentimento registrado: trate-a como segredo de servidor.

## 6. Instalar o preset "Jornada de pedido"

1. **Automações** → cartão **Jornada de pedido** → **Adicionar o preset Jornada de pedido**.
2. Ele cria **dez automações, todas desligadas**:
   - retomadas 10 e 30 minutos depois do link (só se o cliente não respondeu, não tem carrinho, não tem atendente e a IA não transferiu; não valem para pedidos diretos);
   - carrinho abandonado, 10 minutos depois do último item adicionado ou do início do fechamento, uma vez por jornada;
   - agradecimento, quando o `Purchase` chega;
   - uma mensagem por status do pedido: `received`, `preparing`, `finished`, `out_for_delivery`, `ready_for_pickup`, `delivered` e `cancelled`.
3. O cartão lista o que ainda falta (lojas sem endereço, automações desligadas, mensagens sem template).
4. **Revise cada texto** (vêm no idioma do sistema) e ajuste o tom da marca. Variáveis disponíveis: `{{order_id}}`, `{{order_status}}`, `{{order_value}}` e `{{store_name}}` (nome da loja da conversa).
5. **Ligue** as que quiser. A de `delivered` pode ficar desligada se não quiser avisar nesse momento.

Instalar de novo só recria o que você apagou; nunca sobrescreve suas edições.

**Consentimento de cada passo de envio** (eventos diretos). Cada passo "Enviar mensagem/botões/lista/template" tem o campo **Consentimento para quem nunca escreveu**: **Avisos do pedido** ou **Marketing**. Para quem nunca escreveu à loja, o passo só envia se a finalidade estiver ativa; senão é **ignorado** e o log diz "ignored: sem consentimento: …". No preset, agradecimento e status são **Avisos do pedido**; o carrinho abandonado é **Marketing**. Um passo sem valor conta como **Marketing** (estrito por padrão).

**Várias marcas.** Use um só conjunto de automações para todas. Para variar só o nome, use `{{store_name}}`. Só quando uma marca precisa de texto realmente diferente, duplique a automação e adicione a condição **Sigla do negócio da loja é** (por exemplo, `PZA`). Se duas WABAs diferentes usarem templates de **mesmo nome**, o CRM resolve pelo número que envia; essa convenção ainda **não foi testada com duas WABAs reais**, então valide com um pedido de teste de cada marca.

## 7. Templates do WhatsApp (fora da janela de 24 horas)

O WhatsApp só permite texto livre até 24 horas depois da última mensagem do cliente. Retomadas, carrinho abandonado e avisos de status costumam sair depois disso. Para **pedidos diretos**, a primeira mensagem a quem nunca escreveu é **sempre** um template aprovado.

1. Crie e aprove os templates em **Configurações → Templates**.
2. Em cada automação do preset, no passo "Enviar mensagem", preencha **Template fora da janela de 24 h (WhatsApp)** e, se o template tiver variáveis, as **Variáveis do template** (uma por linha, em ordem; valores fixos).
3. Sem template, o envio fora da janela **falha de forma visível** (log da automação e mensagem com erro na conversa). Nada se perde em silêncio.

No Telegram não existe janela e o campo não tem efeito. Uma mensagem com `{{menu_link}}` ignora o template alternativo (ele não levaria o link): fora da janela, falha.

A conversa de quem nunca escreveu é criada já **fechada** (não polui o filtro "Aberta" do Inbox) e reabre para um atendente quando o cliente responde.

## 8. Configurar o agendador (obrigatório)

Retomadas, carrinho abandonado e o fechamento de jornadas abandonadas só andam se um agendador externo chamar o CRM. O CRM não agenda nada sozinho.

1. Faça o agendador chamar `GET /api/automations/cron` **a cada 1 a 2 minutos**, com o cabeçalho `x-cron-secret` igual ao valor de `AUTOMATION_CRON_SECRET` do servidor.
2. Com intervalo de 5 minutos, uma retomada de "10 minutos" pode sair até 5 minutos atrasada.
3. A mesma chamada marca como **Perdido** as jornadas sem atividade por 24 horas.

Teste: `curl -H "x-cron-secret: <segredo>" https://<seu-crm>/api/automations/cron` deve responder com sucesso.

## 9. O que entregar ao time do cardápio

Entregue, por um canal seguro (nunca por e-mail aberto nem chat público):

| Item                                             | Observação                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Link da documentação**                         | `{URL_BASE}/developers`: o manual de integração e a referência da API (Swagger), abertos sem login. |
| **URL base do CRM**                              | Por exemplo, `https://crm.suaempresa.com.br`, sem barra no final.                                   |
| **Chave de API** (`wacrm_live_…`)                | A criada na seção 5. Segredo de servidor.                                                           |
| **Lista de lojas com a `store_key` de cada uma** | Só para eventos diretos (seção 3).                                                                  |
| **Um `idtrack` de teste**                        | Envie o link a um número seu e entregue o token do link recebido (modo com link).                   |

## 10. Testar de ponta a ponta

Antes de liberar para clientes, com um número seu:

1. Envie a mensagem que dispara o link. Confirme que ele tem `?idtrack=` e é o da loja certa. O negócio aparece em **Pipelines → Jornada de Pedido**, em "Link enviado".
2. Peça ao time do cardápio (ou siga a seção 11 de [Integração do cardápio](./integracao-cardapio.md)) para enviar `ViewContent`, `AddToCart`, `InitiateCheckout` e `Purchase`. O negócio deve avançar de etapa e o pedido aparecer no painel da conversa.
3. Envie os status, um a um, e confira cada mensagem no canal do cliente.
4. Teste de abandono: receba o link e não responda; confirme a retomada aos 10 e aos 30 minutos. Depois responda logo após o link e confirme que a retomada **não** sai.
5. **Eventos diretos:** use a `store_key` real e o **seu** telefone.
   - _Com consentimento:_ `Purchase` com `consent.notifications: true`. Esperado: `200` com `messaging: eligible`, contato e pedido criados, uma conversa **fechada** no Inbox e o template de agradecimento no WhatsApp. Ao responder, a conversa passa a **Aberta**.
   - _Sem consentimento:_ telefone desconhecido e `Purchase` sem `consent`. Esperado: pedido registrado, `messaging: no_consent`, nenhuma mensagem e nenhuma conversa.
   - _Revogação:_ `consent.notifications: false` com `given_at` novo. Nenhum aviso depois disso.
   - _PARAR:_ responda "PARAR" no WhatsApp e confira o painel de consentimento.
6. Em **Pipelines → Jornada de Pedido**, pedidos diretos aparecem como "Direto do cardápio".

## 11. Como ler o resultado

- **Pipelines → Jornada de Pedido:** negócios por etapa, com itens e valor do carrinho; filtros de canal, loja e origem.
- **Fechar o negócio à mão encerra a jornada.** Em **Pipelines**, ao marcar o negócio como ganho ou perdido, ou ao arrastar o cartão para **Comprou** ou **Perdido**, a jornada é encerrada com o mesmo resultado. Os lembretes e o carrinho abandonado que estavam agendados deixam de sair, e o **próximo link ou evento desse cliente abre uma jornada nova, com um negócio novo**. Uma jornada encerrada nunca é reaberta: reabrir o negócio não reabre a jornada. Por isso, se você marcar um negócio de teste como perdido, os eventos seguintes aparecem em um **novo** cartão, em "Navegando" ou "Carrinho", e não no cartão antigo.
- **Pedido cancelado não é venda.** Quando o cardápio avisa que o pedido foi **cancelado**, o negócio dele vai para **Perdido** (status perdido) e deixa de contar em "Ganhos" e no valor do pipeline; ele mantém o valor do pedido. A **jornada continua ganha**, então a conversão do funil não muda: o cliente chegou a comprar. O cliente ainda recebe a mensagem de cancelamento, se a automação estiver ligada. Um cancelamento que chega depois de o pedido ser entregue é recusado e não muda nada.
- **Conversão da jornada:** quantas jornadas chegaram a cada etapa (nela ou além), quantas foram perdidas e a taxa de "link enviado" a "comprou", no geral, por canal e por loja, separando **Link do CRM** de **Direto do cardápio**. Jornada direta nunca passa por "link enviado", então a taxa de link até compra só existe para as jornadas com link.
- **Contato → Consentimento de mensagens:** estado, data e origem (Cardápio ou Chat) de cada finalidade. "Sem registro" também aparece para quem já escreveu à loja, que tem consentimento implícito.

---

## Problemas comuns

| Sintoma                                     | Causa provável                                                                       | O que fazer                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A mensagem com `{{menu_link}}` não sai      | Loja sem endereço do cardápio                                                        | Seção 3                                                               |
| Erro "fora da janela" no log ou na conversa | Falta o template alternativo do WhatsApp                                             | Seção 7                                                               |
| Retomada atrasada ou que não sai            | Agendador parado ou muito espaçado                                                   | Seção 8                                                               |
| Eventos rejeitados com `401` ou `403`       | Chave errada, revogada ou sem `events:write`                                         | Seção 5                                                               |
| `messaging: no_consent`                     | Sem consentimento ativo para avisos e o cliente nunca escreveu                       | Conferir o bloco de consentimento do contato e o que o cardápio envia |
| `messaging: no_connection`                  | Loja sem WhatsApp, ou com várias conexões e nenhuma escolhida                        | Seção 3                                                               |
| O evento entrou, mas nada foi enviado       | Automação desligada, passo ignorado por finalidade, sem template ou agendador parado | Ver o **log** da automação: a mensagem do passo diz o motivo          |
| Funil com poucos "Link enviado"             | Jornadas diretas nunca passam por "link enviado"                                     | Esperado; use "Compradas / Jornadas" para as diretas                  |
