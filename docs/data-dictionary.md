# Dicionário de dados

## Registros e vínculos

Os nomes abaixo são tabelas do esquema privado `career`. Os contratos de API e exportação usam camelCase. As chaves e restrições estão nas [migrações SQL](../supabase/migrations), com [tipos compartilhados](../shared/model.ts), [comandos](../shared/commands.ts) e [envelopes de transferência](../shared/transfer.ts) no código.

| Entidades | Significado e vínculos |
| --- | --- |
| `owner_config`, `owner_settings` | A primeira identifica o único proprietário permitido pelo servidor. A segunda guarda meta diária e fuso `America/Sao_Paulo`. Os vínculos de negócio respeitam `owner_id`. |
| `opportunities`, `opportunity_identities`, `applications` | Oportunidade descreve o anúncio, empresa, cargo, tecnologias e tipo. Identidades fortes associam códigos ou aliases verificados à oportunidade. A candidatura pertence à oportunidade e registra trilha, ocorrência, data e estado do envio, etapa, canal, plataforma e situação de arquivo. |
| `links`, `contacts`, `resume_refs`, `application_resumes` | Links preservam endereço ou referência original e, quando aplicável, chave de comparação. Podem se vincular a oportunidades, candidaturas ou contatos. Contatos são opcionais. Referências de CV guardam metadados. Cada associação ativa (`is_active`) identifica um CV informado como enviado. Uma candidatura pode ter vários CVs associados. |
| `events`, `evidence`, `tasks` | Cada evento pertence a uma candidatura e pode apontar para evidência e para o evento que substitui. Evidência preserva texto literal, tipo, origem, ocorrência e referências privadas ou locais. A tarefa tem pelo menos um vínculo com candidatura ou contato, um prazo e situação `pending`, `completed` ou `cancelled`. |
| `cycles`, `batches`, `batch_members`, `review_versions` | O ciclo tem marco explícito. Seus lotes percorrem `open`, `pending` e `closed`. Membros ligam candidaturas a um lote com a ordem capturada, alocação `counted` ou `excluded` e marca de elegibilidade. Versões preservam balanço, evidências e decisões. |
| `import_runs`, `source_files`, `import_rows` | A execução identifica a versão do importador e o conjunto de origem por hash. Arquivos guardam bytes originais e SHA-256. Linhas guardam posição, hash, texto bruto, ID legado, registro de destino e resultado, com decisões e pendências. |
| `audit_log`, `creation_requests`, `mutation_keys` | Auditoria preserva antes, depois, diferenças e contexto do servidor. Registros de criação estabilizam `clientId`. Chaves de mutação identificam repetições de pedidos e suas respostas confirmadas. |
| `agent_credentials`, `maintenance_state`, `restore_runs`, `restore_row_ledger` | Credenciais registram escopos, expiração e revogação. Os controles de manutenção e recuperação autorizam a execução de destino e acompanham as linhas confirmadas. O snapshot de negócio não carrega essa autoridade. |

## Envio, atividade, resultado e datas

- `submission_status` aceita `confirmado`, `nao_confirmado` e `nao_enviado`. Só a confirmação válida baseada em evidência contabiliza um envio único. Uma repetição do mesmo pedido recupera a resposta guardada. Evidência nova de um envio já confirmado pode entrar como nota, sem outro envio lógico.
- `stage` indica a situação atual do processo. Aceita `desconhecida`, `candidatura_enviada`, `triagem`, `avaliacao`, `entrevista`, `proposta`, `contratacao`, `rejeicao`, `desistencia` e `processo_encerrado`. O histórico continua disponível após mudanças de etapa.
- `events.kind` diferencia `envio_confirmado`, `etapa_alterada`, `retorno_substantivo`, `confirmacao_automatica`, `avaliacao`, `entrevista`, `proposta`, `contratacao`, `rejeicao`, `desistencia`, `encerramento`, `nota` e `correcao`. `state` permite `convidado`, `agendado`, `concluido` ou `informado`. Resultado e nota usam `result_text`, `score_value` e `score_unit`. Um convite ou uma pontuação não fundamenta inferência de conclusão ou aprovação. Uma correção conserva o evento anterior e identifica a substituição.
- `evidence.kind` aceita `relato_usuario`, `portal_observado`, `email`, `arquivo_local`, `texto_legado` e `outro`. Relato conserva sua procedência mesmo quando comprova o envio.
- `DateValue` tem `precision` em `unknown`, `day`, `month`, `year` ou `instant`. Para `unknown`, `value` é `null`. As demais precisões têm `certainty` igual a `exact` ou `approximate`. O envio (`submitted_date`), a ocorrência (`occurred_date`), o registro legado (`legacy_registered_date`), a captura da evidência (`captured_at`) e os instantes de criação/atualização têm significados distintos. Só dias exatos e instantes exatos convertidos em `America/Sao_Paulo` podem entrar na meta diária. As lacunas aparecem na cobertura dos indicadores.

## Identidade e contagem

`opportunities.kind` aceita `vaga`, `banco_talentos`, `pipeline` ou `desconhecido`. A identidade forte usa o proprietário, `provider`, `tenant` e um `identity_kind` com `identity_value`. Os tipos são `job_code` e `verified_alias`. Empresa e cargo parecidos geram aviso. A chave de comparação dos links retira apenas parâmetros conhecidos de rastreamento. O link original permanece disponível.

A identidade canônica de candidatura é única por proprietário, oportunidade, trilha normalizada e `application_instance`, inclusive em registros arquivados. A ocorrência padrão é `initial`. Uma ocorrência diferente exige evidência. Trilhas diferentes podem representar candidaturas distintas no mesmo anúncio. A resolução de duplicata preserva registros físicos e histórico, ligando o alias ao canônico em `canonical_application_id`. Contagens usam a candidatura elegível sem duplicar seus aliases.

O `id` é o UUID usado na API. O `display_id` é o identificador visível e imutável. Importações mantêm `legacy_id` com prefixo `V` e os dígitos originais. Registros nativos usam `N` com pelo menos seis dígitos da sequência `application_display_sequence`. Um número reservado pode ser consumido sem produzir registro. Saltos são esperados e a sequência não reutiliza números. `cycle_order` é uma ordem de alocação, com significado distinto do UUID ou do número N. [Identidade, normalização e correções](application-services.md)

`cycle_relation` admite `before_reset`, `after_reset` ou `unknown`. Só entram no lote os envios únicos confirmados e elegíveis com relação posterior explícita. A meta padrão do lote é 30. O fechamento grava a versão `original` e congela os IDs e o balanço. Resultados posteriores e de ciclos anteriores ficam separados do denominador. Uma `revision` revisa a análise. Uma `rectification` usa motivo e evidência para recalcular sobre os IDs já capturados e cria uma versão sem sobrescrever a anterior. `populationIds` guarda a composição original e `eligiblePopulationIds` a composição elegível daquela versão. [Fechamento e retificações](reviews.md)

## Autoria, concorrência e acesso

O servidor deriva proprietário, ator (`owner`, `agent` ou `import`), origem (`source`) e `request_id` da autenticação e do contexto da operação. O `requestId` associa erro, log seguro e auditoria. Nas criações que usam `clientId`, `creation_requests` guarda um mapeamento único por proprietário, tipo de entidade e `clientId`, válido entre atores e chaves HTTP. O mesmo conteúdo resolve a criação existente. Conteúdo diferente com o mesmo `clientId` retorna 409. O histórico conserva metadados de credenciais sem seus hashes.

`expectedVersion` protege contra edição concorrente. Um 409 pede releitura e nova intenção com as versões atuais. `Idempotency-Key` protege repetição de uma intenção idêntica dentro do namespace de proprietário, tipo/ID de ator e operação. A mutação e a auditoria são atômicas. Repetição concluída devolve a resposta guardada. Preserve a chave HTTP e o `clientId` ao repetir uma criação. Em conflito, releia e trabalhe com o registro existente. Uma nova intenção recebe outra chave, e só uma criação realmente nova recebe outro `clientId`. [Contrato HTTP](http-api.md) · [Auditoria e permissões](security.md)

Escopos do agente são `career:read`, `career:write`, `career:reviews` e `career:export`, concedidos separadamente. Cada transação verifica validade, escopo e revogação. O proprietário administra as credenciais. [Escopos e revogação](agent-api.md)

## Origem e recuperação

A prévia preserva bytes, campos literais e suas lacunas. O parser mantém a atribuição de fonte integral. Na aplicação, atribuição selecionada acima do limite de 500 unidades UTF-16 deixa `evidence.source` nulo, registra `unprojected_source_attribution` e conserva a linha original exata em evidência (`original_text`), `import_rows.original_text` e nos bytes de `source_files`. Um campo curto nulo pode assim coexistir com a origem inteira arquivada. [Prévia e conferência da importação](legacy-preview.md)

O JSON privado v1 inclui entidades, manifesto, contagens e hashes. O CSV é uma projeção para consulta com os campos legados. Para restaurar, use um JSON com `continuity`. O campo `displayHighWater` guarda o maior número N consumido. `retiredClients` e `retiredKeys` levam os digests de bloqueio de `career_maintenance.retired_identities`. Essa continuidade preserva o piso de numeração e as negações, sem carregar recibos de `mutation_keys`, sessões, tokens, hashes de credenciais nem as aprovações e resultados operacionais de `career_maintenance.approvals` e `career_maintenance.outcomes`. O destino precisa de provisionamento e autorização próprios. Um arquivo v1 anterior sem continuidade serve para prévia e consulta. Capture outro da origem para aplicar. [Formato privado e recuperação](private-transfers.md)
