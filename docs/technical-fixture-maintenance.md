# Remoção dos registros da verificação técnica

Cada autorização encerra uma verificação fictícia identificada por UUID antes da primeira importação. A etapa comprovada determina o conjunto exato de registros. Antes da emissão da credencial, saem a candidatura nunca enviada, a oportunidade e o mapeamento da candidatura. Após a emissão, a revogação pelo proprietário permite incluir a credencial e seu mapeamento. A sequência de exibição permanece consumida.

## Preparar a autorização

1. Encerre os clientes e as tentativas pendentes. Identifique no manifesto privado os clientes de criação, as chaves efetivamente tentadas, as respostas confirmadas, a auditoria de configuração original e o último resultado técnico concluído. Quando houver credencial emitida, revogue-a pelo proprietário e confirme a recusa. A expiração da credencial por si só exige a mesma revogação.
2. Um administrador independente confere o pacote, o proprietário, a instância, os papéis e associações com seus OIDs, as definições de auditoria e o inventário completo das 26 tabelas. Compare a candidatura, a oportunidade e a eventual credencial com o manifesto selado. A candidatura tem a situação `nao_enviado`, etapa e datas desconhecidas, e o UUID da verificação aparece nos campos fictícios conhecidos. Confira a ausência de dependências, a configuração original e todo o histórico retido de verificações anteriores.
3. Na mesma origem, o administrador compara o catálogo instalado com o catálogo revisado e atesta a etapa sob o bloqueio exclusivo da aplicação. A função interna `career_maintenance.baseline(run_id, prefix)` bloqueia as 26 tabelas em ordem fixa e resume as linhas, o catálogo e a sequência. Ela confere as transições de auditoria permitidas e confronta o histórico anterior com o resumo guardado após a última verificação concluída. O verificador da credencial participa apenas do cálculo interno. Um hash recém-calculado serve como referência após a conferência independente.
4. O administrador insere a autorização em `career_maintenance.approvals` com o proprietário, operação, UUID, etapa, identificador de exibição real, hash do pacote e da origem, IDs de negócio e mapeamentos existentes, cliente da candidatura, chaves efetivamente tentadas e uma nova chave do comando. Na etapa anterior à emissão, os dois campos da credencial ficam nulos. A validade máxima é de 30 minutos. Entregue os parâmetros ao proprietário por canal privado. A autorização e o resultado aceitam somente inclusão. Após a expiração, o administrador pode emitir outra autorização com nova chave e novo prazo. Um resultado confirmado encerra todas as autorizações daquela execução.

A instalação tem dois perfis. No perfil local, o administrador cria o executor sem associações. No perfil gerenciado ensaiado, o criador confiável `postgres` pode pré-criar exclusivamente o executor vazio. O PostgreSQL registra uma atribuição automática concedida pelo bootstrap `supabase_admin`, com `ADMIN` ativo e `INHERIT` e `SET` desativados. Isso conserva a autoridade administrativa do criador e impede que a atribuição, por si, permita executar comandos como executor. A migration verifica as quatro atribuições históricas e aceita exclusivamente essa quinta atribuição para o novo papel. Ela fixa os OIDs e o resumo desse perfil na função de admissão. O executor continua sem login, papéis herdados ou dispensa de RLS. O runtime recebe somente a invocação da operação.

O ensaio gerenciado usou um segundo administrador com autoridade já existente para instalar a migration em uma transação. O instalador comum precisa de autoridade sobre as tabelas para criar policies e triggers. A transferência de propriedade das funções por um instalador não superusuário também exige a capacidade de assumir o novo dono e o privilégio de criação desse dono no esquema de destino. A migration preserva as associações e recusa privilégios inesperados no esquema final. A disponibilidade de um instalador independente e suas capacidades no serviço hospedado exigem conferência separada. [Propriedade de funções no PostgreSQL](https://www.postgresql.org/docs/17/sql-alterfunction.html)

## Etapas reconhecidas

| Etapa aprovada | Versão e última nota da candidatura | Recibos de negócio | Linhas removidas | Auditorias de exclusão | Total final na primeira verificação |
| --- | --- | ---: | ---: | ---: | ---: |
| `application_only` | 1, nota inicial | 1 | 3 | 2 | 10 |
| `revoked_initial` | 1, nota inicial | 3 | 5 | 3 | 15 |
| `revoked_agent` | 2, nota do agente | 4 | 5 | 3 | 17 |
| `complete` | 3, nota final do proprietário | 5 | 5 | 3 | 19 |

Na primeira execução completa, o total final é de três registros de configuração, dez auditorias e seis recibos. Cada verificação posterior conserva o histórico anterior. No ensaio sequencial, a interrupção antes da emissão deixou 10 linhas. A interrupção seguinte, após expirar a credencial e antes da escrita do agente, deixou 21 linhas acumuladas. Uma verificação completa posterior deixou 36, seguida de uma interrupção após a escrita do agente que deixou 49. Um número de exibição consumido entre execuções continuou reservado.

## Executar e reconciliar

O proprietário autenticado envia `POST /api/v1/maintenance/technical-fixture` com `Idempotency-Key` igual à nova chave e o corpo JSON contendo apenas `approvalId`, `runId` e `packageHash`. O servidor estabelece a origem `maintenance` e um UUID de requisição. O login do banco continua sendo `career_api`. A operação toma o bloqueio consultivo exclusivo antes de ler a configuração e a prontidão. Um escritor concorrente impede a admissão. Sessões ociosas podem permanecer conectadas.

A consulta de replay precede a validação da autorização já utilizada. Uma resposta anterior válida exige correspondência entre chave, carga, recibo e resultado administrativo. Em uma execução nova, o banco compara o inventário antes de criar o recibo. A transação confere os três ou cinco IDs devolvidos, as duas ou três auditorias de exclusão e a validade da autorização. O banco confirma as mudanças junto com o recibo completo, o resultado administrativo e o novo resumo do histórico.

Após a confirmação, confira os IDs reais, a requisição, os campos da auditoria e todas as linhas remanescentes. Cada execução acrescenta uma autorização e um resultado fora das 26 tabelas. Guarde as evidências privadas pelo mesmo prazo do histórico de auditoria da aplicação. Registre os clientes e todas as chaves usadas como aposentados.

Se a conexão cair ou a resposta for inconclusiva, suspenda os envios. Em uma nova conexão de inspeção, confronte autorização, resultado, recibo, auditorias e inventário com os registros privados da etapa aprovada. Um resultado confirmado fornece os IDs e a requisição original. Uma transação revertida mantém integralmente o inventário anterior e a autorização sem resultado. Qualquer outro estado exige reconciliação independente.

O bloqueio das tabelas protege os registros da aplicação. Reserve a janela também para excluir alterações administrativas concorrentes de papéis, DDL e chamadas diretas à sequência de exibição. O administrador que confere a autorização e o processo que guarda o arquivo histórico são partes confiáveis desta operação.

## Recuperar o histórico

A exportação de negócio inclui a auditoria das entidades removidas. A restauração em um destino vazio reproduz essa história e acrescenta a auditoria da restauração. O manifesto registra o maior número consumido pela sequência, inclusive lacunas, e os digests SHA-256 dos IDs de cliente e das chaves aposentadas. A lista inclui tentativas recusadas e a chave da própria remoção. Antes da ativação, o destino ajusta a sequência para cima quando necessário e confere as duas listas. Os gatilhos usam os digests para recusar reutilização. O arquivo contém as listas de bloqueio e o histórico de negócio. O cache de respostas e a autoridade administrativa ficam na origem.

Uma exportação antiga sem o campo `continuity` permite prévia e consulta do histórico. A aplicação e a retomada exigem uma nova captura da origem com continuidade verificável. Se a origem estiver indisponível, mantenha o arquivo histórico e a recuperação operacional suspensa.

Arquive separadamente a autorização e o resultado como evidência histórica somente para leitura, com data de emissão e expiração, emissor, digests, chave do comando, IDs e correlação. Na recuperação, mantenha essa cópia em arquivo privado fora das tabelas operacionais. Após recuperação física ou retorno a um ponto anterior no tempo, mantenha o acesso à manutenção suspenso até confrontar todas as autorizações com o arquivo independente, aguardar o vencimento de todas as autorizações pendentes anteriores e verificar o catálogo e o estado da origem recuperada. Uma nova execução exige nova decisão administrativa.

O ensaio local usa PostgreSQL 17 em dois contêineres descartáveis. Execute `npm run test:fixture-maintenance` com o Docker disponível para testar a recusa de privilégios, a exclusão atômica, o replay e a restauração.
