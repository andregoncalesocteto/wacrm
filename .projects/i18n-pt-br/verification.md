# Verificação em português na stack Docker (US-019)

Ambiente: `.env.local` com `NEXT_PUBLIC_APP_LOCALE=pt` (gitignored; templates seguem `en`), stack sobe com
`docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local up --build -d --wait`,
todos os serviços saudáveis. Conta de QA criada por signup. Navegador em fuso -03.
Fora de escopo (non-goals do PRD): mensagens `{ error }` do servidor, erros da Meta, conteúdo criado pelo usuário,
e-mails do Supabase Auth.

Console: nenhum `MISSING_MESSAGE`, `INVALID_MESSAGE`, `FORMATTING_ERROR` nem aviso de hidratação em nenhuma tela.
O único erro visto foi `[PresenceHeartbeat] touch_presence failed: Failed to fetch`, causado por a navegação do
script abortar o fetch em voo (não é i18n).

| # | Tela | Inglês encontrado | Data/número fora do padrão | Console i18n |
|---|------|-------------------|----------------------------|--------------|
| 1 | Dashboard | Feed de atividade ("Deal ... in New Lead", "New contact: ...") vem de texto gravado no banco (fora de escopo). Donut mostra `$1,2k` (aceito, US-011) | Nenhuma | limpo |
| 2 | Inbox (lista, thread, sidebar) | Nenhum. Sidebar de negócios mostra `USD1.234` (código da moeda colado, comportamento anterior à feature, igual em `en`) | Nenhuma (18:39, "16 de setembro de 2026", Hoje) | limpo |
| 3 | Contatos (+ dialogs adicionar, importar, campos personalizados) | Nenhum | Nenhuma (18/09/2026) | limpo |
| 4 | Pipelines (+ dialogs pipeline e negócio) | **Achado, corrigido:** etapas padrão criadas em inglês ("New Lead"...) contradiziam o texto do dialog; agora vêm do catálogo. Etapas já gravadas não mudam (dado do usuário) | Nenhuma (US$ 1.234) | limpo |
| 5 | Broadcasts (lista, wizard passo 1) | Nenhum | Nenhuma | limpo |
| 6 | Automações (lista, novo, edição, logs) | **Achado, corrigido:** nome e descrição dos 4 templates da lista e do nome/descrição pré-preenchidos; pré-visualização dos passos do builder ("no text yet", "when time_of_day"). Texto das mensagens dos templates é conteúdo semeado (fora de escopo) | "última há 3h" (date-fns pt-BR, aceito) | limpo |
| 7 | Flows (lista, editor, execuções) | Painel de validação do editor traduzido por `code` + `params` (54 códigos; `message` em inglês intacto na API de ativação) | Nenhuma | limpo |
| 8 | Agents (Playground, Configuração, Uso) | Nenhum (nome do provedor "openai" é identificador) | Nenhuma | limpo |
| 9 | Notificações | Nenhum | Nenhuma | limpo |
| 10 | Configurações (11 abas + dialogs convidar, chave de API, template, resposta rápida) | **Achados, corrigidos:** modo "Dark" na rail e na visão geral; nomes de moedas ("US Dollar") em Negócios e moeda e na visão geral; descrições dos escopos de chave de API; valor "none" do Cabeçalho no dialog de template (o trigger mostrava o valor cru); `&lt;key&gt;` literal na descrição de chaves de API (escape ICU). "Função: user" no perfil é o valor legado da coluna `profiles.role` (não lido pelo app, aceito). Nomes dos temas (Violet etc.) são nomes próprios | 18 de setembro de 2026, 18/09/2026 | limpo |
| 11 | Login | Nenhum | n/a | limpo |
| 12 | Cadastro (e recuperar senha) | Nenhum | n/a | limpo |
| 13 | Convite (`/join/[token]`, token inválido) | Nenhum | (data do convite válido verificada em US-014) | limpo |

## Restante
Nada. Validação de fluxos: `ValidationIssue` ganhou `code`/`params` (aditivo), `IssueLine` traduz `Flows.validation.issues.<code>` com fallback em `message`. Verificado no Docker (pt) com um fluxo semeado: "O nó inicial aponta para um nó inexistente ...", "O botão 1 precisa de um título." etc.

## Correções desta story (todas re-verificadas no Docker)
Templates de automação (lista e novo), preview do builder, etapas padrão de pipeline, modo/tema na rail e overview,
nomes de moeda (`currencyName`), escopos de API keys, "Cabeçalho" do template, escape do `<key>`.
