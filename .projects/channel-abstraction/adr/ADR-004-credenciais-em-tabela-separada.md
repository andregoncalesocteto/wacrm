# ADR-004 — Credenciais das conexões em tabela separada, sem leitura por membros

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas) · Design Doc, seções 4 e 9

## 1. Contexto

- `whatsapp_config` guarda o token cifrado (AES-256-GCM, chave única `ENCRYPTION_KEY`), mas a política de leitura
  deixa **qualquer membro da conta** ler a linha, incluindo o texto cifrado.
- Com várias lojas e conexões, o número de segredos guardados cresce, e o Telegram acrescenta o token do bot, que
  é totalmente privilegiado.
- O texto cifrado só é protegido pela cifra: uma falha de política ou uma cópia do banco o expõe.
- A interface nunca precisa receber o segredo de volta; ela só mostra o estado.

## 2. Decisão

Vamos guardar as credenciais de cada conexão numa **tabela separada, sem política de leitura para membros**, lida
apenas pelo servidor com a chave de serviço.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Tabela separada `channel_connection_credentials`, sem política de leitura** | O segredo fica isolado por construção; provedor novo não muda a tabela | Uma tabela e uma junção no servidor | **Escolhida** |
| B | Coluna cifrada na tabela da conexão, como hoje | Simples | Qualquer membro lê o texto cifrado pela API do banco, dependendo só da cifra | Rejeitada |
| C | Cofre de segredos externo | Isolamento e rotação nativos | Dependência e infraestrutura novas sem demanda | Rejeitada |

## 4. Consequências

**Positivas**
- Nem um membro comum nem um erro de política expõem o texto cifrado.
- É barato agora e caro de mudar depois de haver dados.

**Negativas / trade-offs**
- A chave única `ENCRYPTION_KEY` do deployment continua: girá-la inutiliza todos os tokens, e com várias conexões o
  efeito de um erro é maior. A rotação de chave está **fora do escopo**.

**Obrigações**
- Segredos nunca voltam à interface nem vão para log ou para `messages.media_url`; a URL de arquivo do Telegram
  (que carrega o token do bot) nunca é gravada.
- No Telegram, o app gera um `secret_token` por conexão, guarda cifrado e o compara em tempo constante.
- Criar, editar e apagar lojas e conexões exige administrador ou acima.
