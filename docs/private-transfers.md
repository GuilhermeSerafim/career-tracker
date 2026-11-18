# Exportação privada e recuperação

O JSON é o formato de recuperação. Ele inclui as 20 tabelas de negócio: configurações do proprietário, oportunidades, candidaturas, contatos, links, referências de currículo, associações de currículo, evidências, eventos, tarefas, ciclos, lotes, membros, versões de revisão, execuções de importação, arquivos-fonte, linhas importadas, auditoria, identidades fortes e mapeamentos duráveis de criação.

O arquivo contém `manifest` e `entities`. O manifesto informa `formatVersion: 1`, `exportedAt`, `sourceOwnerId` e inventário completo com contagem e SHA-256 de cada tabela. Cada entidade tem envelope tipado com versão, tabela e dados. Os hashes usam objetos com chaves ordenadas e linhas ordenadas por tabela/ID; arrays e textos históricos mantêm sua ordem e conteúdo. SHA-256 detecta alterações, mas não autentica quem produziu o arquivo: aceite somente cópias privadas de procedência conhecida.

IDs, versões, frações de microssegundos dos timestamps PostgreSQL, datas com precisão, bytes originais, decisões de importação, revisões e proveniência são preservados. Datas históricas que só identificam um dia continuam com `closedAt: null` e sua proveniência de calendário. Recuperação não inventa meia-noite nem escolhe outro ciclo atual. A ordenação de timestamps das importações não substitui a versão realmente aplicada.

## Conteúdo de acesso excluído

Não entram senhas, tokens, hashes de credenciais, linhas de `agent_credentials`, sessões Auth, `mutation_keys`, `owner_config` ou controles de manutenção. De `creation_requests`, somente as linhas com `entity_type='agent_credential'` e seu vínculo de provisionamento de acesso são excluídas. Todos os outros mapeamentos de negócio permanecem. A auditoria histórica de credenciais com campos sensíveis omitidos continua no JSON. Reprovisione login e acesso do agente depois da recuperação; o arquivo não é cópia da configuração de acesso.

## Guarda dos arquivos

Escolha uma pasta privada existente fora de todos os worktrees e do repositório principal, com permissões restritas ao proprietário. Os scripts recusam gravar ou ler um snapshot dentro do repositório. No Windows, confira também as permissões herdadas da pasta; o modo de arquivo do Node não substitui as ACLs do sistema.

Mantenha o JSON e uma segunda cópia protegida em um local escolhido pelo proprietário, preferencialmente com criptografia e acesso restrito. Confira a leitura dessa cópia pelo procedimento de prévia antes de precisar recuperá-la. Os scripts não enviam arquivos a outro serviço. Não há alegação de backup automático incluído no Supabase Free. Arquivos `.partial` indicam uma escrita não concluída e não são backups.

## Exportar localmente

A configuração privada usual do servidor identifica o proprietário, Supabase Auth e conexão `career_api`. `OWNER_SESSION_TOKEN` deve conter a sessão humana vigente; sua identidade é verificada por `getUser`, não por claims decodificados localmente. Nunca coloque valores de credenciais em argumentos, logs ou arquivos versionados. Carregue-os de um arquivo privado de ambiente fora do repositório.

Exemplo com caminhos fictícios:

```powershell
node --env-file="C:\privado\career.env" node_modules/tsx/dist/cli.mjs scripts/export-private.ts --private-dir "C:\privado\copias" --format both
```

`--format` aceita `json`, `csv` ou `both` e o padrão é `both`. Nomes novos evitam substituir arquivos anteriores. A leitura de todas as tabelas usa uma única instrução SQL dentro do gate autenticado de manutenção, preservando uma fotografia consistente mesmo com gravações concorrentes.

## CSV e seus limites

O CSV usa UTF-8, cabeçalho legado exato, aspas RFC4180 e apóstrofo protetor antes de fórmulas ou controles iniciais perigosos. Abrir, editar e salvar novamente numa planilha pode remover ou alterar essa proteção.

O CSV reflete os campos estruturados atuais, incluindo empresa, cargo, estado do envio, observações, dia exato de envio em America/Sao_Paulo e ordem atribuída. Precisões desconhecida, aproximada, mês ou ano deixam `data_envio` vazia. Etapa estruturada não desconhecida e rótulos dos CVs associados ativamente à própria candidatura são valores registrados e substituem esses campos; os rótulos têm ordenação determinística. Referências de CV sem associação ativa não comprovam envio. Plataforma legada e narrativas de etapa, fonte e currículo permanecem literais como fallback quando não existe substituição registrada semanticamente equivalente. Não se inferem canais, currículo enviado ou resultados de processo a partir de narrativas. Os campos brutos originais continuam disponíveis no JSON.

Todas as linhas de candidatura entram, inclusive arquivadas e aliases de duplicatas, usando seus próprios campos. O CSV não representa o vínculo canônico, todos os eventos ou a história completa; não serve como formato de recuperação nem como denominador independente dos indicadores.

## Preparar um destino vazio

O destino deve ter migrations revisadas, Auth, proprietário configurado e controle de manutenção provisionados. Um bootstrap para recuperação não cria `owner_settings` nem ciclo. O provisionador local aceita `LOCAL_RESTORE_READY=true` e, nesse modo, usa exclusivamente `LOCAL_RESTORE_TEST_DATABASE_URL`; sem essa opção, o provisionamento normal mantém seu comportamento. Os auxiliares de teste aceitam somente destinos locais dedicados e a identidade exata configurada para o teste de recuperação.

O script de recuperação usa conexão privada separada `career_restore`, sem BYPASSRLS, propriedade de tabelas, DDL, DELETE, UPDATE de negócio ou TRUNCATE. RLS permanece ENABLE/FORCE. Ele inspeciona todos os proprietários para recusar negócio existente, inclusive configurações de negócio. Credenciais de agente ativas bloqueiam a operação; o script não as revoga nem apaga. Configuração do proprietário e Auth não são sobrescritos.

## Prévia, aplicação e retomada

Além da configuração de Auth e da sessão humana, carregue `PRIVATE_RESTORE_DATABASE_URL` com o login de manutenção e `PRIVATE_RESTORE_DATABASE_TLS=verify-full`, usando `PRIVATE_RESTORE_DATABASE_CA_CERT` quando necessário. `disable-local` só é aceito com loopback explícito em desenvolvimento/teste. `DATABASE_URL` continua sendo a configuração `career_api` e nunca recebe a credencial de manutenção. Essa última não deve ser configurada no runtime/Vercel. Não existe endpoint privilegiado de recuperação.

```powershell
node --env-file="C:\privado\destino.env" node_modules/tsx/dist/cli.mjs scripts/restore-private.ts preview --file "C:\privado\copias\snapshot.json"
node --env-file="C:\privado\destino.env" node_modules/tsx/dist/cli.mjs scripts/restore-private.ts apply --file "C:\privado\copias\snapshot.json"
node --env-file="C:\privado\destino.env" node_modules/tsx/dist/cli.mjs scripts/restore-private.ts resume --file "C:\privado\copias\snapshot.json" --run-id UUID-DA-EXECUCAO
```

A leitura local do arquivo confere formato, limites, inventário, hashes, bytes/fontes e referências; ela não substitui a prévia no destino. A prévia executa somente consultas PostgreSQL sob o mesmo gate exclusivo, antes de qualquer escrita de controle ou história. Os tipos, colunas geradas, NOT NULL, CHECKs, índices únicos (inclusive parciais) e FKs compostas são verificados usando apenas as tabelas fixas e expressões do catálogo revisado. Nenhum SQL, identificador ou expressão vem do conteúdo do arquivo. A projeção SQL tipada precisa reproduzir exatamente os valores e hashes: representações que sofreriam arredondamento ou mudança são recusadas, sem normalização histórica. Uma recusa mantém bootstrap, manutenção, controles, história, ledger e auditoria inalterados e permite uma operação válida posterior.

Isso inclui os formatos nativos de timestamps PostgreSQL em UTC (`+00:00`, com a fração que o próprio banco exporta), UUIDs SQL e seus arrays em minúsculas, limites dos inteiros de cada coluna e representabilidade de texto/JSONB. NUL e surrogates Unicode isolados não são texto/JSONB representável no PostgreSQL. Instantes `Z`, offsets ou nove dígitos dentro de JSON histórico e DateValue continuam preservados quando válidos: a restrição de fidelidade aplica-se às colunas SQL tipadas, não a essas strings históricas. Bytes de arquivo-fonte continuam arbitrários, inclusive NUL binário e BOM. Use o JSON produzido pela exportação; não edite grafia de timestamps/UUIDs nem recalculhe hashes para contornar a prévia.

A aplicação drena transações runtime com o mesmo advisory lock exclusivo usado em modo compartilhado pela API, verifica o destino antes de qualquer escrita, persiste manutenção e autorização da execução antes de inserir história e confirma cada chunk junto com seu ledger. Cada retomada exige o mesmo arquivo, manifesto, execução, destino e hashes das linhas já confirmadas. Linhas estranhas ou ausência de ledger bloqueiam a retomada.

Durante recuperação parcial, o runtime retorna manutenção/503. Em falha ou interrupção, não altere esse estado manualmente. Se a confirmação do COMMIT inicial se perder, o script informa resultado incerto e um handle; isso não afirma que o COMMIT ocorreu. Reexecute `apply` com o mesmo arquivo: somente uma execução persistida que corresponda ao proprietário autenticado, manifesto e destino pode ser descoberta e retomada. Esse caminho também funciona se o processo morreu antes de imprimir qualquer ID, sem consulta privilegiada ao banco. Se o início não ocorreu, o mesmo comando pode iniciar normalmente. Falhas confirmadas antes do COMMIT não criam um handle de execução.

`resume` com o mesmo JSON e ID continua disponível. Repetir `apply` ou `resume` após conclusão é idempotente se o destino ainda corresponde à execução verificada; dados novos ou estranhos fazem a conferência falhar, sem sobrescrita. Somente a verificação final de todas as linhas, contagens, hashes e referências permite ativar o destino. Ela preserva os registros de identidade e os IDs visíveis, avança a sequência acima dos IDs N restaurados e acrescenta exatamente uma auditoria de recuperação. Uma nova exportação inclui essa auditoria além de toda a história original.

Por padrão, proprietário da origem e do destino devem coincidir. `--reassign-owner UUID-DO-PROPRIETARIO-CONFIGURADO` autoriza explicitamente a associação ao proprietário verificado do destino. Essa opção não altera textos, atores ou IDs históricos dentro da proveniência; a auditoria da recuperação registra ambos os proprietários.

## Limites locais e hospedagem

O formato local aceita até 100.000 entidades e 256 MiB de JSON canônico, com leitura de arquivo limitada também a 256 MiB. A consulta rejeita previamente orçamentos acima de 256 MiB menos 20.000 bytes, incluindo estimativa conservadora de 100 bytes por envelope. A serialização final valida o limite exato. Cada arquivo-fonte admite até 50 MiB de bytes e 50 MiB de texto UTF-8; a auditoria admite esses valores apenas nos campos conhecidos `original_bytes`/`original_text` de `source_files` e seus espelhos `before`/`after`. Hex bytea é validado em varredura linear, com teto de 100 MiB mais prefixo. JSON histórico comum mantém profundidade 16, strings de 50.000 caracteres, até 1.000 chaves por objeto e 100.000 itens por array. Outros limites tipados de cada entidade continuam em vigor.

Base64, texto e cópias de auditoria podem fazer uma seleção de origem menor que 50 MiB exceder o orçamento agregado. A operação então falha explicitamente; não trunca, elimina auditorias ou oferece uma cópia parcial como completa. A ferramenta local materializa dados e representações de validação em memória: reserve memória e tempo compatíveis e faça nova verificação com um destino sintético antes de aumentar limites.

Esses limites locais não prometem transportar o mesmo arquivo por uma função hospedada. A [documentação de limites das Vercel Functions](https://vercel.com/docs/functions/limitations) informa limite de 4,5 MB para corpo de requisição/resposta, sujeito a verificação na configuração efetiva antes da publicação. A recuperação completa é executada localmente com conexão PostgreSQL privada. Os testes desta entrega usam somente dois bancos sintéticos locais; não comprovam recuperação hospedada, restauro de dados reais, corte da fonte operacional ou backup automático do provedor.
