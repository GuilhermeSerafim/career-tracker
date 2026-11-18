# Autenticação e isolamento do proprietário

O navegador usa Supabase apenas para Auth. As tabelas de negócio pertencem ao schema privado `career`, ausente de `api.schemas` e de `extra_search_path` em `supabase/config.toml`. PUBLIC e os papéis `anon`, `authenticated` e `service_role`, quando existentes, não recebem acesso ao schema, tabelas, sequências ou funções privadas. Isso deve ser conferido novamente na configuração hospedada antes de receber dados reais.

O servidor valida cada Bearer humano com `supabase.auth.getUser(token)` e compara o ID retornado com `OWNER_USER_ID`. Não autoriza por email, `user_metadata`, owner informado no corpo ou claims apenas decodificadas. A checagem de formato JWT serve somente para recusar credenciais opacas/de agente antes da chamada ao Auth; a autenticidade vem da resposta do Auth. O SDK não persiste sessão nem renova tokens neste cliente de servidor. A documentação do [getUser](https://supabase.com/docs/reference/javascript/auth-getuser) descreve a consulta ao servidor de autenticação.

Sessão inválida recebe 401; usuário autenticado diferente recebe 403; indisponibilidade do Auth/banco e manutenção recebem 503 com texto seguro em português. A fronteira exportada em `server/auth.ts` permite testar o verificador separadamente. Apenas objetos imutáveis emitidos depois da validação abrem transações de negócio; um objeto com os mesmos campos não é suficiente. Para agentes, a autorização também verifica o escopo e a situação atual da credencial. Consulte as [instruções da integração](agent-api.md).

## Papéis e permissões

| Papel | Login | Responsabilidade |
| --- | --- | --- |
| `career_schema_owner` | Não | Proprietário do schema, tabelas, sequências, domínios e helpers comuns; migrations administrativas |
| `career_api` | Sim | Execução da aplicação, com RLS e privilégios mínimos |
| `career_restore` | Sim | Script local de manutenção; leitura de inspeção e inserção histórica condicionada |
| `career_audit_writer` | Não | Dono somente da função de auditoria; INSERT no audit e SELECT mínimo de metadados de configuração/manutenção |

Todos são NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS e não participam de outros papéis. Não basta NOINHERIT: associações que permitem SET ROLE também são removidas. API/restore não são donos de tabelas e não recebem CREATE, TRIGGER, TRUNCATE, DELETE ou privilégios com grant option. A [documentação de associação entre papéis](https://www.postgresql.org/docs/17/role-membership.html) distingue herança e capacidade de SET ROLE.

As 26 tabelas privadas têm ENABLE e FORCE RLS. SELECT exige proprietário da linha = contexto transacional = proprietário configurado. INSERT usa WITH CHECK; UPDATE usa USING e WITH CHECK, além da visibilidade de SELECT. Uma policy restritiva exclusiva de `career_api` exige manutenção em `ready`. Configuração ausente não permite acesso. As [policies PostgreSQL](https://www.postgresql.org/docs/17/sql-createpolicy.html) separam as condições de leitura e de gravação.

`owner_config` tem chave singleton e CHECK(singleton), leitura não recursiva e nenhuma gravação operacional. `maintenance_state` é legível mesmo em manutenção, sem escrita para a API. `review_versions` recebe SELECT/INSERT da API, nunca UPDATE/DELETE; o trigger de imutabilidade do modelo continua ativo. `audit_log` recebe somente SELECT da API. `creation_requests` recebe SELECT/INSERT. Em `mutation_keys`, a API recebe SELECT/INSERT e UPDATE somente de `http_status`/`safe_response`; uma resposta concluída é imutável. O restante das tabelas de negócio recebe SELECT/INSERT/UPDATE conforme a matriz explícita em `scripts/local-db.ts`.

Apenas os helpers necessários têm EXECUTE operacional: validação de datas, geração de display ID, consulta do proprietário e os predicados RLS do papel correspondente. Funções de trigger não têm EXECUTE público/operacional. O trigger existente de identidade forte usa INSERT ON CONFLICT DO NOTHING seguido de leitura, preservando a exclusão de aliases em READ COMMITTED sem exigir UPDATE de restore.

## Transações, pool e manutenção

`createDatabase(config)` expõe `assertReady`, `transaction` e `close`; não expõe o pool. A inicialização integrada deve chamar `assertReady`. Cada transação, inclusive leitura, obtém o lock compartilhado transacional `(1128354386, 1)` antes de conferir identidade PostgreSQL, configuração e estado de manutenção. Só depois da autenticação são definidos owner, actor, source e request UUID com `set_config(..., true)`. COMMIT/ROLLBACK removem o contexto automaticamente; o handle de consulta deixa de funcionar ao sair do callback.

Os caminhos de dados, incluindo exportação e consulta interna de credenciais, passam por esse controle. A recuperação obtém o lock exclusivo correspondente para drenar transações antes de persistir a transição.

O pool usa três conexões por padrão, limite configurável de uma a cinco, timeout de conexão e transação, consultas parametrizadas e nenhuma prepared statement nomeada. Produção exige `DATABASE_POOL_MODE=transaction` e `DATABASE_TLS=verify-full`, com `rejectUnauthorized: true`; `DATABASE_CA_CERT` permite CA PEM explícita. Parâmetros na URL são recusados para impedir que substituam TLS. Supabase documenta [pooler em modo transaction e prepared statements](https://supabase.com/docs/guides/database/connecting-to-postgres), e node-postgres explica [a interação entre connectionString e SSL](https://node-postgres.com/features/ssl).

Somente `NODE_ENV=test|development` com host loopback explícito permite `DATABASE_TLS=disable-local`. A URL da aplicação precisa usar `career_api` ou `career_api.<referência>`; a conexão confirma `session_user=current_user=career_api`. Não existe fallback para postgres/admin. **A identidade efetiva no pooler hospedado ainda precisa ser testada**, inclusive para a auditoria SECURITY DEFINER.

## Mutações e auditoria

`createMutation` recebe uma definição interna com schemas de comando/resposta e callback de serviço. Autentica o contexto, limita o JSON a 256 KiB e valida o comando antes da transação. O hash canônico ordena propriedades, preservando strings, arrays, null e chaves próprias como `__proto__`; request ID não participa do hash. A reserva é única por proprietário, tipo/ID de ator, operação e chave. Reserva, alterações de negócio, evidência/evento, audit e resposta segura são confirmados juntos. A constraint diferida impede COMMIT de reservas provisórias `102/{}`. Repetição concluída devolve a resposta armazenada sem nova alteração/auditoria; corpo diferente recebe 409.

O helper de agregados adquire locks por tabela/UUID em ordem estável e recusa aquisição incremental invertida. A atualização condicional de candidatura exige `expectedVersion`, incrementa a versão e diferencia ausência autorizada (404) de conflito (409). O conflito contém somente versão atual e nomes dos campos alterados do registro autorizado. Chaves HTTP por ator não substituem `creation_requests`.

O trigger deriva entidade, operação, OLD/NEW e diff; owner/ator/source/request vêm do contexto local confiável. Ele usa `SECURITY DEFINER`, dono `career_audit_writer`, search path fixo, tabelas qualificadas e policy de INSERT sujeita a FORCE RLS. A API não pode escrever no audit, executar a função diretamente nem desativar triggers. Credenciais são projetadas para metadados antes de construir qualquer JSON: hashes nunca entram em snapshots/diffs. Auditoria não se aplica à própria `audit_log` nem ao bookkeeping de replay/controle. Runtime sempre audita; flags `app.restore`/`app.audit_admin` não suprimem isso. Somente o login real de restore com run/manifesto/destino persistidos ativos suprime registros derivados históricos.

O principal administrativo é fixado pela migration na configuração da função. Provisionamento autorizado fornece contexto explícito e audita a criação das preferências. Fixtures/DDL desse administrador ficam fora da garantia de auditoria de aplicação; edições operacionais devem seguir os procedimentos de provisionamento/manutenção. A exceção administrativa não amplia a policy do audit writer para outros proprietários.

Erros têm texto seguro em português e request ID do servidor. Logs projetam exclusivamente `requestId`, `operation`, `status` e `elapsedMs`; nunca recebem SQL, Error, corpo, headers, URLs privadas ou credenciais. O request ID é o mesmo no contexto SQL, erro e log. Falha de conexão durante COMMIT pode deixar o resultado desconhecido: o servidor responde 503, sem prometer rollback; repetir a mesma chave recupera a resposta caso o COMMIT tenha ocorrido. Falha do sink de logs não transforma um COMMIT confirmado em erro.

## Base de permissões para restore

Restore pode ler linhas de outros proprietários para detectar destino ocupado. Não pode atualizar/apagar/truncar negócio. INSERT histórico exige proprietário configurado, destino correspondente, run persistido em `restoring`, maintenance em `restoring`, ID do run ativo e manifesto iguais. `app.restore_run_id` apenas seleciona esse run; uma GUC não cria autorização por si só. Ausência de controle, run inventado ou fase `verifying` bloqueiam inserções.

Restore recebe SELECT/INSERT e UPDATE limitado por colunas no bookkeeping. Não recebe escrita de `owner_config`. Em `agent_credentials`, lê apenas metadados para detectar credenciais ativas; não lê `token_hash` nem insere credenciais. `mutation_keys` não é restaurada. Audit/review históricos têm INSERT condicionado ao run. A supressão do trigger consulta esse mesmo run persistido; o [guia de recuperação](private-transfers.md) descreve a retomada, a conferência e a ativação final.

## Provisionamento local

`scripts/provision-owner.ts` aceita somente loopback e o banco dedicado `career_tracker_test`, reutilizando a proteção de `local-db.ts`. Recebe `LOCAL_TEST_DATABASE_URL` administrativa, `OWNER_USER_ID`, `CAREER_API_PASSWORD` e `CAREER_RESTORE_PASSWORD` exclusivamente por ambiente/arquivo privado. Não aceita argumentos, não cria senha nem usuário Auth e não imprime URL, senha ou verificador.

As duas senhas devem ser distintas, ter 24–128 caracteres ASCII sem espaços e ser fornecidas explicitamente. O script deriva verificadores SCRAM-SHA-256 antes de executar ALTER ROLE, evitando senha em claro no SQL. Toda operação é atômica e obtém o lock exclusivo de manutenção. Configura owner singleton/settings/estado inicial e credenciais dos papéis; preserva configuração e preferências existentes, recusando proprietário conflitante. Mantenha o mesmo `OWNER_USER_ID` no servidor e use a credencial `career_api` em `DATABASE_URL`.

Exemplo sem valores secretos na linha de comando, usando um arquivo privado ignorado pelo Git:

```powershell
node --env-file=.private/provision.env --import tsx scripts/provision-owner.ts
```

O provisionamento hospedado, Auth e recuperação operacional pertencem à etapa 23. Variáveis com prefixo `VITE_` nunca recebem credenciais PostgreSQL ou chaves secretas Supabase.

## Verificação e limites

`db:local:apply/check` preserva os hashes dos SQLs aplicados e verifica proprietário, flags de papéis, associações, FORCE RLS, privilégios de tabelas/colunas/sequências/funções e ausência de grants públicos. Também confere os grants mínimos do audit writer, search path do definer, cobertura/ativação de triggers e constraint de conclusão diferida.

Os testes da etapa 3 usam PostgreSQL 17.12 dedicado, logins reais `career_api`/`career_restore`, proprietários/credenciais sintéticos e limpeza restrita aos UUIDs criados pela suíte. Validam isolamento de leitura/lista/ID, INSERT/UPDATE/FKs, ausência de contexto, commit/rollback, reutilização de conexão, lock compartilhado, 503 de manutenção, políticas de restore com controle semeado pelo administrador, ausência de escrita em histórico/controle e desvio do catálogo. Testes de autenticação exercitam a função real com respostas controladas do verificador remoto; não comprovam o serviço Supabase Auth.

A etapa 4 acrescenta testes reais com duas conexões para replay idêntico, chave reutilizada com corpo diferente e edição de versão antiga; também verifica rollback de registro/evidência/evento/chave/audit, bootstrap auditado, redação de hashes, resposta segura de credenciais, reserva incompleta recusada no COMMIT e flags falsas de restore. Contextos sintéticos de atores apenas verificam namespaces de persistência; não comprovam autenticação de agentes.

A verificação local cobre a API HTTP, a concorrência dos serviços, a recuperação e os agentes em ambiente sintético. PostgREST, advisors, a lista de migrations da stack, o Auth do provedor e a identidade do pooler exigem conferência no destino. Consulte o [registro de verificação](verification.md).
