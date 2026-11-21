# API privada

As rotas em `/api/v1` exigem autenticação Bearer. Para uma sessão humana, o servidor verifica o usuário com `getUser`. Para um agente, confere a credencial, o escopo da operação e a revogação. O servidor determina o proprietário, o ator e a origem. Consulte as [instruções para agentes](agent-api.md).

| Método | Rota | Resultado |
| --- | --- | --- |
| GET | `/applications` | Candidaturas paginadas, filtros e total |
| GET | `/applications/:id` | Candidatura, oportunidade com versão, links, evidências, eventos originais/substituídos, tarefas, contatos associados e CVs informados |
| GET | `/resume-refs` | Metadados de CV, sem upload ou leitura de arquivos |
| GET | `/contacts` | Catálogo privado paginado de contatos independentes e associados, para seleção opcional e reabertura |
| GET | `/contacts/:id` | Contato do proprietário por UUID, com versão, nome, notas e referências informadas |
| GET | `/today?date=YYYY-MM-DD` | Envios do dia local, meta, tarefas, atividade e resultados históricos |
| GET | `/analytics?query=<JSON>` | Cálculo, filtros normalizados, cobertura, populações e IDs explicativos |
| GET | `/batches` | Estado do ciclo e lotes paginados |
| GET | `/batches/:id` | Lote, membros e versões de revisão |
| GET | `/reviews/:id` | Versão congelada e resultados posteriores separados |
| GET | `/settings` | Meta, fuso e disponibilidade segura da integração |
| GET | `/exports?format=json\|csv` | Exportação completa dentro do limite HTTP |
| GET | `/health` | Saúde do gate de banco, sem configuração |
| POST | `/commands` | Comando estrito do contrato compartilhado |
| POST | `/imports/preview` | Prévia somente leitura de CSV Base64, envio de Vagas ou `runId` |
| POST | `/imports/apply` | Uma confirmação de CSV ou unidade histórica limitada |
| POST | `/restores/preview` | Validação estrutural de snapshot; prontidão do destino não verificada |

`/commands` recebe o comando diretamente no corpo, com `Content-Type: application/json` e `Idempotency-Key` obrigatório. `create_resume_ref`, `start_cycle`, `update_settings` e as alterações de candidatura/atividade/revisão usam essa mesma fronteira. Referências editáveis incluem `expectedVersion`; o patch da oportunidade usa sua própria versão. Campos extras como `ownerId`, `actor` ou `source` no envelope são recusados. Campos de origem de evidências continuam sendo dados, não identidade de auditoria.

`Authorization` e `Content-Type` são campos únicos. Duplicatas observáveis nas linhas recebidas ou em `headersDistinct`, inclusive valores idênticos ou nomes com caixa diferente, retornam 400 antes da autenticação e da interpretação do corpo. Não há reserva de chave, gravação ou auditoria para essa entrada. Um provedor que descarte campos antes da função limita o que a aplicação consegue observar; esse comportamento exige conferência na implantação.

Sucesso vem depois do COMMIT. Repetir a mesma intenção reutiliza a chave e o corpo. Um 503 pode significar que o COMMIT não foi reconhecido: a repetição da mesma chave recupera o resultado persistido. Alterar a intenção exige outra chave e versões atuais. Eventos e identidade durável de importação continuam protegidos mesmo com outra chave HTTP.

## Listas e análises

`applications`, `contacts`, `resume-refs` e `batches` aceitam `limit` entre 1 e 100, padrão 50, e `cursor` opaco retornado em `nextCursor`. `items` e `total` descrevem a consulta; a ordenação crescente é por `createdAt` e UUID, preservando microssegundos. O cursor é vinculado à rota e à seleção. Mudar filtros exige reiniciar a paginação.

`contacts` aceita somente `limit` e `cursor`, sem busca ou filtros. Cada item reutiliza a projeção de contato: `id`, `version`, `name`, `notes`, `links`; nomes ausentes continuam nulos. A leitura não altera versão nem gera auditoria. Salvar um contato independente não o associa a uma candidatura; a associação opcional existente usa os dois pais de `save_task`, com suas versões. As mesmas proteções de proprietário, manutenção e cache privado se aplicam. O agente precisa do escopo `career:read` para consultar o catálogo.

`applications` aceita `search` literal, `sort=createdAt`, `view=confirmed|saved|unknown|all` e `filters` como JSON do contrato compartilhado. A visão padrão contém confirmações únicas elegíveis, exclui aliases/invalidações e arquivadas. O filtro `archived=include|exclude|only` controla arquivo. Empresa, cargo, stack, senioridade, modalidade, canal, plataforma, status, etapa e lote têm allowlists explícitas. `%`, `_`, SQL e HTML na busca são texto literal.

O JSON de `analytics.query` contém `operation: "metrics"`, `period: { from, to }`, `population`, `dimension`, `submissionScope` e filtros opcionais. O servidor acrescenta `asOf` e a meta atual quando ausentes. A resposta conserva o resultado de domínio completo, com `query`, `asOf`, `population_label`, `coverage`, `metrics` e IDs em cada população/grupo/indicador. A identidade de grupo é `(key, isMissing)`.

Para preservar exatamente a população de um cálculo já mostrado, mantenha seus IDs em memória, divida-os em grupos de no máximo 100 UUIDs e envie cada grupo em `applications?ids=<JSON>&limit=...`. Percorra `nextCursor` antes do próximo grupo. Esse modo retorna os IDs físicos autorizados, inclusive arquivados, redirecionados ou invalidados posteriormente; ele recusa busca, visão restritiva ou filtros que reinterpretariam a população. IDs inexistentes não geram registros fictícios. Links e evidências nunca pertencem à URL.

Para uma consulta **ao estado atual**, `applications` também aceita a `query` normalizada da análise e `explain` em JSON. Seleções: `{ kind: "population", name: "selected" }` (também `allConfirmed`, `submissionCohort`, `conversionCohort`, `cycle`), `{ kind: "conversion", category }`, `{ kind: "group", collection, key, isMissing }`, `{ kind: "eventsInPeriod" }` ou `{ kind: "series", collection: "daily"|"weekly", day }`. As coleções de grupo são `stack`, `discoveryChannel`, `submissionPlatform`, `sentCv` e `selectedGrouping`. Esse modo recalcula: se a população mudar entre páginas, o cursor é recusado. Use os IDs capturados para manter a população original.

Seletores adicionais de leitura usam os IDs já calculados, sem aumentar o limite de `ids` nem recalcular indicadores na interface:

As chaves de grupo preservam o texto exato, inclusive vazio, com o limite de 500 caracteres de `shortTextSchema`. `isMissing` continua obrigatório: chave vazia ou literal não equivale a ausência.

O seletor `group` aceita `category` opcional, somente `response|assessment|interview|offer`. Sem esse campo retorna o grupo completo; com ele retorna exatamente os IDs de `group.conversions[category]`, sem trocar pelo total do grupo ou por acontecimentos do período.

- `{ kind: "firstReturn", selection: "eligible" }`: casos elegíveis para a mediana.
- `{ kind: "firstReturnDistribution", days }`: intervalo inteiro de dias corridos, entre 0 e 3652058; intervalo válido ausente retorna lista vazia.
- `{ kind: "firstReturnExclusion", reason }`: somente `imprecise_submission`, `uncertain_response`, `response_before_submission` ou `no_recorded_response`.
- `{ kind: "coverage", collection, key }`: `precision` aceita `unknown|day|month|year|instant`; `certainty` aceita `unknown|exact|approximate`; `missing` aceita `submittedDay|sentCv`. Um bucket válido ausente retorna lista vazia. Chaves desconhecidas, incompatíveis, propriedades extras e nomes de protótipo são recusados.
- `{ kind: "completed", category }` e `{ kind: "eventsCategory", category }`: `category` aceita somente `response|assessment|interview|offer`. O primeiro usa conclusões na base de conversão; o segundo usa acontecimentos no período, inclusive de candidaturas antigas. Cada seleção retorna seus próprios IDs, mesmo quando os totais coincidem; conjuntos válidos vazios retornam lista vazia.

Todos os seletores conservam autorização do proprietário, `query` normalizada, corte de conhecimento `asOf`, paginação e cursor vinculado aos IDs derivados. Tanto `ids` quanto `query/explain` recusam `search` não vazio, `filters` não vazio ou `view` diferente de `all`: a lista não pode reduzir silenciosamente a população explicada. São consultas ao estado atual; alterar a população invalida o cursor. As leituras não gravam nem geram auditoria.

A interface mantém a análise exibida no cache em memória do runtime, limitado à geração de autenticação e ao período de acesso já autorizado. Voltar da lista preserva a mesma consulta exibida enquanto ela estiver nesse cache. “Atualizar análises” e aplicar filtros, inclusive os mesmos filtros, solicitam uma resposta nova e seu `asOf`. Uma falha aparece com repetição disponível, sem substituir os números por zeros. Logout ou troca de proprietário seguem a limpeza de cache e o gate de acesso existentes; não há armazenamento persistente de snapshots no navegador.

Hoje conta somente envios elegíveis com data exata correspondente a America/Sao_Paulo. `unknownDateApplicationIds` indica ausência de **dia exato utilizável**, incluindo precisões parciais e aproximações. Tarefas separam atraso, hoje, futuro e prazo não exato. Resultados históricos usam relação histórica explícita e categorias de recrutamento, independentemente de confirmação do envio; notas e confirmações antigas não viram resultados. Contatos associados vêm de tarefas/links, inclusive no histórico de aliases e oportunidades. Para uma tarefa vinculada somente a uma conversa, `contacts/:id` recupera o contato autenticado exato: não aceita parâmetros de consulta, exige UUID válido e não grava ou audita uma leitura. Ausência e contato de outro proprietário retornam 404; os mesmos gates de sessão, manutenção e privacidade das demais leituras continuam aplicáveis. Referências privadas permanecem no detalhe autenticado, com rótulos genéricos na interface.

Em revisões, `laterResults` resolve tanto os IDs congelados quanto os eventos efetivos pela mesma cadeia canônica do proprietário e compara suas raízes atuais. Cada evento conserva `applicationId` físico, ID e horário originais; `canonicalApplicationId` indica a atribuição atual. A atribuição permanece em ambas as direções de reconciliação: alias para membro e membro para um registro canônico externo. Essa comparação viva não substitui os IDs armazenados nem recalcula o denominador congelado. Eventos substituídos ficam fora dessa lista viva, mas permanecem no histórico e na versão capturada. Raízes sem relação com os membros continuam excluídas. A versão, os IDs capturados e os membros congelados permanecem intactos; cadeia canônica corrompida retorna 503 seguro.

## Transferências e limites

- Comandos: 256 KiB; envelopes e respostas de transferência: 4.000.000 bytes, com margem abaixo dos [4,5 MB documentados pela Vercel](https://vercel.com/docs/functions/limitations). A contagem usa os bytes reais do stream antes de JSON.parse, mesmo sem comprimento declarado. JSON inválido, NUL e surrogates isolados são recusados sem substituir texto válido.
- Importação aplica `{ unit: "prepare"|"application"|"review"|"complete", data: ... }` com `Idempotency-Key`. `prepare.data` usa o manifesto/arquivos Base64/ciclo do importador local; depois cada candidatura, revisão ou conclusão forma uma unidade retomável. Não há caminho que abra arquivos enviados pelo cliente. O conjunto de fontes precisa caber integralmente no envelope de preparação; conjuntos maiores usam o fluxo local, sem truncamento ou upload ilimitado.
- Arquivos fontes podem ser maiores que o texto de uma revisão. A unidade de revisão aceita no máximo 50.000 unidades de código UTF-16, conforme o contrato existente de narrativa/auditoria, incluindo BOM. Acima disso retorna 413 antes de criar lote, revisão ou auditoria; o arquivo fonte já preparado fica completo e exportável, sem truncamento. Outras unidades aplicadas continuam preservadas.
- Para a tela Vagas, `imports/preview` recebe `{ format: "csv_upload", fileName, bytesBase64 }` (CSV UTF-8 de até 1 MiB e 500 registros). Responde com totais, situações por linha e `confirmation` quando houver linhas prontas. A prévia é privada, somente leitura e não cria run nem auditoria.
- A confirmação usa `imports/apply` com `{ unit: "csv", data: { fileName, bytesBase64, confirmation } }` e `Idempotency-Key`. A seleção é recalculada antes da escrita. Mudança na seleção retorna 409 e exige nova prévia. Uma resposta bem-sucedida contém `runId`, `imported`, `unchanged` e `review`. Para recuperar uma resposta perdida, repita o corpo e a chave originais.
- A prévia histórica e a conferência nas configurações usam `imports/preview` com `{ bytesBase64 }` ou `{ runId }`.
- `restores/preview` recebe `{ snapshot }` e retorna `validation: "structural_only"`, `destinationReady: null`, `destinationSqlPreflight: "not_performed"` e `nextAction: "local_owner_maintenance_preview"`. Tipos/CHECKs/unicidade/hashes reais do destino exigem a prévia local com sessão do proprietário e credencial privada de manutenção. Essa credencial nunca entra na API/Vercel.
- JSON é o formato completo de recuperação; CSV mantém a projeção legada com proteção de fórmulas. Se a resposta completa ultrapassar o limite HTTP, a API retorna 413 `EXPORT_TOO_LARGE`, indicando a exportação local privada documentada em [transferências](private-transfers.md). Nenhuma resposta 200 contém backup truncado. O fluxo local mantém seus próprios limites explícitos.

## Erros, privacidade e publicação

Erros retornam somente `error: { code, message, requestId }`, com detalhes autorizados de conflito quando disponíveis. Códigos HTTP: 400 entrada inválida, 401 sessão ausente/inválida, 403 outro proprietário, 404 ausente, 405 método incorreto, 409 conflito, 413 tamanho, 429 limite e 503 dependência/manutenção/configuração. Falha nunca vira lista vazia, zero ou gravação confirmada.

Sucessos e erros da aplicação têm `Cache-Control: private, no-store`, `Vary: Authorization`, request ID gerado no servidor, `nosniff`, `no-referrer` e CSP restritiva. Logs recebem apenas ID, operação, status e duração. O limitador local permite 240 solicitações autenticadas por minuto por instância e retorna `Retry-After`; não é uma quota global distribuída. Rejeições anteriores à função por limites HTTP do provedor têm contrato próprio e precisam de verificação na implantação.

O adaptador Node da Vercel precisa de `NODEJS_HELPERS=0`, conforme a [configuração oficial](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration). Sem essa configuração, a API hospedada falha fechada. Ela nunca acessa `request.body`. Desenvolvimento e função hospedada compartilham o roteador; somente testes locais injetam o verificador de Auth. Previews Vercel mantêm a API indisponível; não configure neles credenciais do banco de produção.

O build gera a meta CSP como primeiro elemento de `head`, antes de qualquer recurso. `connect-src` permite somente a própria origem e a origem exata validada de `VITE_SUPABASE_URL`. O cabeçalho estático restringe scripts/estilos/objetos/base/formulários e `frame-ancestors`, sem `default-src` ou `connect-src` que bloqueariam o Auth por interseção. A [especificação CSP](https://www.w3.org/TR/CSP3/#meta-element) explica o momento da meta e as restrições que precisam do cabeçalho. Não há wildcard, service worker ou analytics externo.

Build local sem origem Auth mantém `connect-src 'self'`; origem inválida interrompe o build. Publicação Vercel exige origem pública válida e HTTPS; em produção o build e o runtime conferem coincidência com `SUPABASE_URL`. Configuração privada inválida retorna 503 seguro. Reinicie o build ao mudar a origem pública. Não injete segredos por variáveis `VITE_`.

O preview de build encaminha `/api` ao servidor local antes do fallback SPA. As quatro rotas `/`, `/vagas`, `/analises` e `/revisoes` foram verificadas com navegação direta/refresh e CSP efetiva em Chromium, usando Auth sintético apenas para conferir a política. Roteamento, CSP, Auth/pooler reais e limites anteriores à função na hospedagem continuam pendentes da implantação.

## Versões para correções de candidaturas

`GET /api/v1/applications/:id` inclui `affectedBatches: [{ id, version, status }]`: lotes distintos vinculados ao ID físico dessa candidatura, dentro do proprietário autenticado. Não agrega lotes de descendentes canônicos ou de `historyApplicationIds`. Para resolver uma duplicata, leia origem e destino e una os IDs dos lotes; se duas leituras observarem versões diferentes do mesmo lote, releia antes de preparar a correção. As versões são uma fotografia: uma alteração concorrente continua recebendo HTTP 409 na mutação.
