---
name: wacrm-stack
description: Sobe, derruba, recria, recria do zero, reconstrói e inspeciona a stack Docker do wacrm (app Next.js + Supabase auto-hospedado), aplica migrations, verifica o schema e dispara os crons. Use quando o usuário pedir para subir/baixar/reiniciar/recriar o ambiente, resetar o banco, rodar migrations, ver logs/status ou trocar variáveis NEXT_PUBLIC_*.
---

# wacrm-stack

Operações da stack Docker do wacrm. Fonte da verdade: `docs/docker.md`,
`docker-compose.yml`, `docker-compose.supabase.yml`, `docker/supabase/`.
Rode sempre da raiz do repositório.

## Passo 0 — descobrir o modo

- **Stack completa** (app + Supabase local): existe `docker-compose.supabase.yml` e o
  usuário não tem um projeto Supabase hospedado. Use `$FULL` abaixo.
- **Só o app** (Supabase externo/hospedado): `NEXT_PUBLIC_SUPABASE_URL` no `.env.local`
  aponta para um `*.supabase.co` ou outro host externo. Use `$APP`. Nesse modo o
  container **não** roda migrations nem tem banco local.

Se o `.env.local` não existir, o modo completo o cria (abaixo); no modo só-app copie
`.env.local.example` e peça ao usuário para preencher Supabase + Meta. Nunca invente
valores de segredo nem imprima o conteúdo do `.env.local`.

```bash
FULL="docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local"
APP="docker compose --env-file .env.local"
```

O `--env-file .env.local` é obrigatório: o Compose só lê `.env` por padrão.

## Rotinas

### Criar do zero (primeira vez)
```bash
./docker/supabase/generate-env.sh    # cria .env.local com segredos novos; recusa se já existir
# pedir ao usuário: META_APP_SECRET (e SMTP_* se ENABLE_EMAIL_AUTOCONFIRM=false)
$FULL up --build -d --wait
```
O serviço `migrate` roda sozinho e aplica `supabase/migrations/*.sql` (42+ arquivos);
`app` só sobe depois que ele termina com sucesso. Confirme com `$FULL ps` e
`curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/login` (espera 200).

### Subir
`$FULL up -d --wait` (ou `$APP up -d --wait`). Acrescente `--build` se o código do app
mudou.

### Baixar (preserva dados)
`$FULL down` — remove containers e rede, **mantém** os volumes `db-data` e `storage-data`.

### Reiniciar / recriar containers (sem perder dados)
- Um serviço: `$FULL restart app` · logs depois com `$FULL logs -f --tail 100 app`
- Recriar do zero os containers: `$FULL up -d --force-recreate --wait`
- Mudou só variável de runtime (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …): `$FULL up -d --force-recreate app` — sem rebuild.

### Reconstruir o app
Obrigatório ao mudar qualquer `NEXT_PUBLIC_*` (inclusive `NEXT_PUBLIC_APP_LOCALE`, que
fixa o idioma por imagem) ou o código:
`$FULL up -d --build --wait app`

### Resetar tudo — DESTRUTIVO
`$FULL down -v` apaga os volumes: **banco, usuários, contatos, mensagens e arquivos do
Storage**. Não use `-q` (não existe em `down`). **Peça confirmação explícita ao
usuário** antes, dizendo o que será perdido. Depois:
```bash
$FULL down -v && $FULL up --build -d --wait
```
Se o usuário também quer segredos novos, apague o `.env.local` **só com pedido
explícito** (rotacionar `JWT_SECRET` invalida sessões e API keys; `ENCRYPTION_KEY`
orfana os tokens de WhatsApp) e rode `generate-env.sh` de novo.

### Aplicar migrations
```bash
$FULL run --rm -T migrate          # aplica só as que faltam; idempotente
$FULL exec -T db psql -U postgres -c "select name, applied_at from public.wacrm_migrations order by 1 desc limit 5"
```
- Migration nova: `supabase/migrations/NNN_nome.sql`, com NNN = maior existente + 1.
  Nunca edite uma já aplicada — crie outra.
- Cada arquivo roda numa transação; se falhar, nada é registrado e corrigir o arquivo e
  repetir o comando tenta de novo.
- O `migrate` roda como `postgres` e depende de `auth` e `storage` saudáveis, porque as
  migrations referenciam `auth.*` e `storage.buckets`.
- Modo só-app (Supabase hospedado): o container não migra. Use a Supabase CLI
  (`supabase link` + `supabase db push`) e confirme com o usuário o projeto-alvo antes.

### Verificar o schema
```bash
$FULL exec -T db psql -U postgres -v ON_ERROR_STOP=1 < supabase/ci/verify-schema.sql
```
Espera `schema verification passed`.

### Status, saúde e logs
```bash
$FULL ps -a --format '{{.Service}} {{.Status}}'
$FULL logs --tail 100 <auth|db|kong|rest|realtime|storage|migrate|app>
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/login          # app
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $(grep ^ANON_KEY= .env.local | cut -d= -f2)" \
  http://supabase.localtest.me:8000/auth/v1/health                     # gateway → auth
```
Porta do app: `HOST_PORT` (padrão 3000). Gateway: `SUPABASE_HTTP_PORT` (padrão 8000).

### Shell no banco
`$FULL exec db psql -U postgres` (interativo; peça ao usuário para rodar com `!` se
precisar de TTY).

### Crons (Wait steps de automações e flows)
Nada agenda dentro do container. Para disparar manualmente (ou configurar um agendador
externo), com `AUTOMATION_CRON_SECRET` do `.env.local`:
```bash
S=$(grep ^AUTOMATION_CRON_SECRET= .env.local | cut -d= -f2)
curl -s localhost:3000/api/automations/cron -H "x-cron-secret: $S"   # {"processed":N}
curl -s localhost:3000/api/flows/cron       -H "x-cron-secret: $S"   # {"swept":N}
```
Sem a variável definida, ambos respondem 503.

### Docker puro (sem Compose)
```bash
docker build --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... -t wacrm .
docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Diagnóstico rápido

| Sintoma | Causa provável |
|---|---|
| `auth`/`storage` reiniciando com "must be owner" ou "password authentication failed" | O volume `db-data` foi criado com um init quebrado ou com outra `POSTGRES_PASSWORD`. Mudar a senha no `.env.local` **não** altera um banco já criado → `down -v` (confirmar) ou `ALTER USER`. |
| Kong reiniciando com "error parsing declarative config" | Faltam `KONG_ROUTER_FLAVOR=expressions` ou o plugin `post-function` em `KONG_PLUGINS`. |
| App não alcança o Supabase / browser sim (ou vice-versa) | `SUPABASE_HOST`, `SUPABASE_PUBLIC_URL` e `NEXT_PUBLIC_SUPABASE_URL` divergem; ou `localtest.me` sem DNS público (usar `/etc/hosts` + as três variáveis). Lembrar de rebuild do app. |
| Realtime não conecta (503 no WebSocket) | O container `realtime-dev.supabase-realtime` não está no ar: `$FULL up -d --wait`. |
| Login funciona mas não confirma email | `ENABLE_EMAIL_AUTOCONFIRM=false` sem `SMTP_*` preenchido. |
| Porta ocupada | Trocar `HOST_PORT` / `SUPABASE_HTTP_PORT`. **Não** use `PORT` (é a porta interna). |

## Regras

- Ações destrutivas (`down -v`, apagar `.env.local`, `docker volume rm`, `system prune`)
  só com confirmação explícita do usuário no turno atual.
- Nunca imprima segredos do `.env.local` (`grep` de uma chave para usar em `curl` é ok;
  `cat` do arquivo não).
- Nada aqui faz commit ou push.
- Mudou algo na stack (compose, `docker/supabase/`, variáveis)? Atualize também
  `docs/docker.md` e a seção "Docker" do `CLAUDE.md`.
