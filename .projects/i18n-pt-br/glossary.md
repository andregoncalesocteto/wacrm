# Glossário pt-BR (messages/pt.json)

Escopo: só valores de string do `pt.json`. Chaves, placeholders ICU, estrutura de plural, nomes próprios e termos oficiais da Meta não mudam. Tratamento: "você".

| Termo (en) | Forma em pt | Regra / notas |
|---|---|---|
| Pipeline | pipeline (mantido) | Masculino: "o pipeline", "novo pipeline". Plural: "pipelines". |
| Deal | negócio | "o negócio", "os negócios", "Novo negócio". Nunca "deal". |
| Flow | fluxo | "o fluxo", "um fluxo", "Fluxos". Identificadores técnicos (ex.: `flow_runs.vars`) não mudam. |
| Broadcast | broadcast (mantido em inglês) | Masculino: "o broadcast", "novo broadcast", plural "broadcasts". Substitui "disparo(s)". O verbo "disparar" (acionar uma automação) não é o termo e fica. |
| Inbox | inbox (mantido em inglês) | Masculino por padrão dos anglicismos: "no inbox", "do inbox". Vale para o inbox do CRM (menu, cabeçalho, textos de IA). A "caixa de entrada" de e-mail (telas de cadastro e recuperação de senha) NÃO é o Inbox do produto e continua em português. |
| Template | template (mantido em inglês) | UM só termo: "template". "Modelo" deixa de ser usado para esse conceito. Motivo: "template" é o termo oficial da Meta para mensagens do WhatsApp (o operador o vê igual no Gerenciador do WhatsApp da Meta), e usar "modelo" para o template de mensagem e "template" em outro lugar geraria dois nomes para a mesma coisa. Vale também para os templates iniciais de automação e de fluxo, para não ter dois termos. Masculino: "o template", "templates aprovados". |
| Modelo (de IA) | modelo | Exceção: "modelo" continua onde significa modelo de IA (`Settings.aiConfig.model`, `missingModel`, `Agents.usage.byModel`). |

Nome do produto: "CRM Template for WhatsApp" segue a regra e vira "Template de CRM para WhatsApp".

Estado medido antes da passada (ocorrências em valores): negócio 57, fluxo 25, Deal 0, Flow 0 isolado (só `flow_runs.vars`), modelo 83 (3 são modelo de IA), disparo 29, caixa de entrada 9 (2 são e-mail), pipeline 38. Deal e Flow já estavam aplicados; a passada trocou modelo, disparo e caixa de entrada (106 valores).
