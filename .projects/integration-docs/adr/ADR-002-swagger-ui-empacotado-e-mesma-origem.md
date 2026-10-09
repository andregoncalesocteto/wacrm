# ADR-002 — Servir o contrato com Swagger UI empacotado, apontando para o próprio app (`servers: /`)

- **Status:** Proposto
- **Data:** 2026-10-09
- **Feature:** integration-docs · SOLUTION (Tema Técnico 8) · Design Doc, seções 3, 5 e 7

## 1. Contexto

- O dev externo precisa de uma referência da API pública, acessível sem login, em
  que consiga **testar uma chamada** com a própria chave (o requisito foi
  expressamente "swagger").
- O `next.config.ts` define `Content-Security-Policy-Report-Only` com
  `default-src 'self'` e `connect-src 'self' https://*.supabase.co`, e o próprio
  arquivo diz que a política será imposta. Qualquer UI carregada de CDN
  violaria essa política.
- O `openapi.yaml` tinha `servers: https://SEU-CRM.exemplo.com`, um placeholder
  que o leitor teria de trocar a cada instalação. Atrás de proxy ou Docker, o app
  também não sabe de forma confiável qual é o seu host público.
- Uma chamada do navegador para outro domínio exige CORS na API; hoje a API
  pública não o habilita.
- O Swagger UI não tem tema escuro; o CRM tem. `swagger-ui-react` 5.33 declara
  suporte a `react <20`, mas a compatibilidade real com React 19.2 e Next 16.3
  ainda não foi exercitada.
- Algumas UIs de OpenAPI usam por padrão fontes e um proxy hospedados por
  terceiros, por onde passaria a chave que o dev cola.

## 2. Decisão

Vamos servir o contrato com o Swagger UI (`swagger-ui-react`) empacotado no
próprio app e carregado só na sua rota, lendo o `openapi.yaml` servido pelo
próprio app, que declara `servers: - url: /`, de modo que o "Try it out" chame a
mesma origem e a chave informada não seja persistida.

## 3. Alternativas Consideradas

| #   | Alternativa                                           | Prós                                                                                                                                                          | Contras                                                                                                                                                                                   | Motivo                                                     |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A   | **Swagger UI empacotado, `servers: /`, mesma origem** | É o "Swagger" que o time externo espera; permite testar uma chamada; sem CORS; sem placeholder de URL; compatível com a CSP; sem terceiro no caminho da chave | Visual datado e sem tema escuro; ~7,5 MB não empacotado (carregados só nessa rota); compatibilidade com React 19 a confirmar                                                              | **Escolhida**                                              |
| B   | Scalar (`@scalar/api-reference-react`)                | Visual moderno e tema escuro nativo                                                                                                                           | Por padrão usa fontes e um proxy da Scalar, o que fere a CSP e põe um terceiro no caminho da chave; puxa uma dependência de ~47 MB; exigiria desligar essas opções e mantê-las desligadas | Rejeitada: risco para a chave do dev e configuração frágil |
| C   | Redoc                                                 | Leitura limpa                                                                                                                                                 | Somente leitura, **sem "Try it out"**; exige `styled-components` e `mobx`                                                                                                                 | Rejeitada: não atende o requisito de testar uma chamada    |
| D   | Swagger UI carregado de CDN (unpkg/jsdelivr)          | Nenhuma dependência no app                                                                                                                                    | Viola `default-src 'self'` assim que a política for imposta; dependência de terceiro em runtime                                                                                           | Rejeitada: incompatível com a CSP planejada                |

## 4. Consequências

**Positivas**

- O dev testa `GET /api/v1/me` ou um evento direto da página, contra o CRM que
  está vendo, sem configurar URL nem CORS.
- Nenhum terceiro recebe a chave ou serve código para a página.
- A mesma URL do YAML serve ao Swagger e à importação no Insomnia ou no Postman.

**Negativas / trade-offs**

- O Swagger destoa do tema escuro do CRM; fica num painel claro na v1.
- Uma dependência grande entra no projeto, ainda que só carregada nessa rota.
- O "Try it out" convida o dev a colar uma chave num navegador.

**Obrigações**

- `persistAuthorization` permanece desligado; a página e o manual dizem que, em
  produção, a chamada sai do servidor do cardápio.
- Spike no início da implementação para confirmar o `swagger-ui-react` com
  React 19.2 e Next 16.3; se falhar, o plano B é o `swagger-ui-dist` montado num
  componente cliente.
- Conferir no console do navegador as violações da CSP em modo report-only.
- O `openapi.yaml` passa de `servers: https://SEU-CRM.exemplo.com` para
  `servers: - url: /`.
