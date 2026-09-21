# ADR-002 — Contrato do provedor de canal em registro em processo, com capacidades e ciclo de vida da conexão

- **Status:** Proposto
- **Data:** 2026-09-21
- **Feature:** channel-abstraction · SOLUTION (Decisões Técnicas) · Design Doc, seções 2, 3 e 5

## 1. Contexto

- O envio ao WhatsApp está **copiado em três lugares** (`send-message.ts`, `flows/meta-send.ts`,
  `automations/meta-send.ts`) e no broadcast, todos falando com `meta-api.ts` (1.225 linhas). O código pede a
  consolidação nos próprios comentários.
- O webhook do WhatsApp (1.447 linhas) mistura o formato da Meta com regra de negócio.
- Um segundo canal (Telegram, canal de prova) **não tem** templates, janela de 24h, lista de opções nem recibos de
  leitura, e o WhatsApp não oficial (versão seguinte) mantém uma **sessão contínua** (QR, reconexão).
- A métrica de sucesso 3 exige que um canal novo entre **sem alterar o núcleo**.
- Não há cliente e a hospedagem pode ser gerenciada, então infraestrutura nova por canal tem custo real.

## 2. Decisão

Vamos definir um **contrato de provedor** (capacidades declaradas por tipo de canal, entrada normalizada, saída,
erros normalizados e ciclo de vida da conexão) e ligá-lo ao núcleo por um **registro em processo** de objetos de
provedor, mantendo o gateway HTTP externo como caminho futuro.

## 3. Alternativas Consideradas

| # | Alternativa | Prós | Contras | Motivo |
|---|---|---|---|---|
| A | **Registro em processo de objetos de provedor** | Simples, tipado, testável, sem serviço novo; um provedor pode chamar um gateway externo por dentro | Um canal com sessão contínua precisará de um processo à parte quando chegar | **Escolhida** |
| B | Um gateway HTTP por canal, com contrato REST e webhook | Isola processos persistentes | Serviço, deploy e observabilidade novos já na versão 1 | Adiada |
| C | Herança de classes abstratas | Estrutura conhecida | Acopla os provedores a uma base e dificulta o teste isolado | Rejeitada |
| D | Sem abstração: ramificações por canal no código atual | Nada a projetar | Cada canal novo altera o núcleo, contra a métrica 3 | Rejeitada |

## 4. Consequências

**Positivas**
- Um canal novo é **um provedor mais um registro**.
- As capacidades declaradas alimentam a interface, a validação ao ativar automações e flows e o núcleo de envio.
- O contrato já prevê conectar, QR, saúde e reconectar, então o WhatsApp não oficial entra sem refazê-lo.

**Negativas / trade-offs**
- A hipótese de que o contrato serve ao WhatsApp não oficial só será testada na versão seguinte
  `[SUPOSIÇÃO NÃO VALIDADA]`.
- As capacidades valem por **tipo** de canal, e não por conexão.

**Obrigações**
- Mover `lib/whatsapp/*` para o provedor do WhatsApp **sem mudar comportamento** (RNF-01).
- Escrever, no Design Doc, como o WhatsApp não oficial se encaixaria no contrato, sem código.
