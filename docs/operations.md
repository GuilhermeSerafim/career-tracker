# Operação do Carreira

## Executar localmente

Use Node 22.18.0 e npm 10.9.3. Instale as dependências com `npm ci`. Para conferir a aplicação inteira sem configurar uma conta, use `npm run verify:local` com Docker e os pré-requisitos do [roteiro de verificação](verification.md).

Para uso interativo, prepare PostgreSQL 17 local com o banco dedicado `career_tracker_test` e uma instância local do Supabase Auth. A stack deste repositório pode ser iniciada com `npx supabase start`, com Docker disponível. Crie pelo painel local a conta fictícia que será o único proprietário. Para ensaiar a recuperação local, autorize `http://127.0.0.1:5173/recuperar-senha` no Auth local. O provisionador do repositório usa o UUID dessa conta para configurar os papéis e o proprietário no banco de carreira.

Carregue `LOCAL_TEST_DATABASE_URL` no ambiente administrativo privado para executar os comandos de banco. Provisione com o arquivo privado indicado no exemplo. Ele contém a conexão administrativa local, `OWNER_USER_ID`, `CAREER_API_PASSWORD` e `CAREER_RESTORE_PASSWORD`.

```powershell
npm run db:local:apply
node --env-file="C:\privado\provision.env" --import tsx scripts/provision-owner.ts
npm run db:local:check
```

Configure `.env.local` com as duas variáveis `VITE_` da [referência de ambiente](../.env.example). No ambiente do processo que inicia `npm run dev`, defina `NODE_ENV=development`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OWNER_USER_ID` e `DATABASE_URL` com o papel `career_api`. `DATABASE_TLS=disable-local` só vale para desenvolvimento ou teste com host explícito de loopback. Abra `http://127.0.0.1:5173`. O Vite encaminha a API local à porta 3001. Guarde segredos fora do Git, do frontend, dos argumentos e dos logs. [Provisionamento, TLS e permissões](security.md)

## Entrar e recuperar o acesso

Entre com o e-mail e a senha do proprietário provisionado. O cadastro público e o acesso anônimo ficam desativados. A API também exige que a sessão corresponda ao proprietário configurado no servidor.

Em **Entrar**, use **Esqueci minha senha** e **Enviar link de recuperação**. Se receber vários e-mails, abra o link da solicitação mais recente. Use o mesmo dispositivo, navegador e perfil de onde você enviou esse pedido. O fluxo PKCE depende do verificador guardado ali. Se o link expirar ou o verificador se perder, faça um novo pedido e abra o link do e-mail desse pedido no mesmo dispositivo, navegador e perfil. Em **Definir nova senha**, altere a senha, saia da conta e faça um novo login com a nova senha. Mantenha a senha e o link no canal privado. [Fluxo PKCE do Supabase](https://supabase.com/docs/guides/auth/sessions/pkce-flow#limitations)

## Registrar e acompanhar candidaturas

A Tabela é paginada. O Quadro abre com todos os registros ativos e carrega todas as páginas do filtro. Cada coluna agrupa pela etapa registrada. O cartão mostra separadamente o status do envio. Um envio confirmado pode estar em **Etapa não informada** quando o histórico não informa o andamento. Arraste o cartão entre colunas ou use **Mover para…**. Atualizar a etapa mantém o status e a data do envio.

1. Em **Vagas**, pesquise a oportunidade antes de criar um registro. Compare empresa, anúncio, plataforma, organização no portal, código, links e trilha. Guarde os links originais e vincule anúncios equivalentes à candidatura existente quando houver evidência.
2. Salve a oportunidade para acompanhar depois ou registre o envio já realizado. **Confirmado** exige relato ou evidência de envio. **Não confirmado** indica informação insuficiente. **Não enviado** indica ausência de envio conhecida. Informe o CV efetivamente usado se souber. Deixe o dia desconhecido ou registre a precisão disponível quando a data for parcial. O dia em que você preencheu o formulário fica no histórico de registro.
3. No detalhe da mesma candidatura, atualize a etapa e registre retornos, entrevistas, avaliações e resultados com a evidência e a data do acontecimento, quando conhecidas. Mudanças de etapa, uma confirmação automática do portal e o reenvio de um teste mantêm a candidatura existente e não acrescentam um envio à contagem. Um relato do proprietário continua identificado como relato.
4. Adicione tarefas de follow-up com prazo e vínculo à candidatura ou ao contato e conclua cada tarefa quando realizada. **Hoje** reúne pendências e a meta diária em `America/Sao_Paulo`. A meta inicial é de cinco candidaturas e pode ser alterada em **Conta → Configurações → Meta de candidaturas**. As datas e tarefas são internas ao Carreira, sem notificações de calendário. A aplicação não envia candidaturas ou mensagens a recrutadores, não coleta dados de portais e não executa sincronização de calendário ou monitoramento em segundo plano.
5. Use **Arquivar registro** para tirar uma candidatura da rotina ativa sem apagar histórico ou alterar a contagem de envios válidos. As tarefas vinculadas continuam com seu estado registrado. **Restaurar registro** desfaz o arquivamento. Para ajustar datas, evidência, duplicata ou um envio contado indevidamente, use a edição ou a correção correspondente, informe o motivo e a evidência quando solicitados e confira o impacto no lote. Registros e ordens anteriores continuam consultáveis.

Em **Revisões**, inicie um ciclo com o marco acordado se ainda não houver ciclo. Cada lote chega a **Revisão pendente** ao atingir 30 candidaturas únicas confirmadas e elegíveis após o marco. Confira os membros e as lacunas, registre análise e próximos passos e feche o lote. A versão inicial preserva o balanço e os membros capturados. Resultados posteriores aparecem separadamente e uma retificação explícita gera outra versão com motivo e evidência. Use a exportação Markdown para guardar a revisão selecionada. [Estado dos lotes e versões](reviews.md)

## Emitir e revogar acesso do agente

Em **Conta → Configurações → Acesso do agente**, informe um nome e escolha apenas as permissões necessárias. Consulta, gravação, fechamento/revisão de lotes e exportação são permissões independentes. Defina uma expiração quando possível. Copie o token de exibição única para o armazenamento privado do agente. Mantenha o token fora de documentos, chat, argumentos, logs e Git.

Use **Credenciais emitidas** para reler o catálogo e revogar o acesso pelo ID, nome e prefixo. Ocultar ou perder o token não revoga seu acesso. Se a emissão tiver resultado incerto e a tela autenticada permanecer aberta, use **Repetir mesma criação**. Se perder a tela ou o token, confira o catálogo, revogue a credencial emitida e só então crie outra.

Em falha incerta de gravação, preserve o mesmo conteúdo, versões e chave para repetir. Se a intenção mudar, use nova chave. Em conflito 409, releia os registros e suas versões, confira o que mudou e reaplique somente as alterações escolhidas com os dados atuais e nova chave. [Escopos, transporte e repetição](agent-api.md)

## Exportar e restaurar dados privados

Em **Conta → Configurações → Exportações privadas**, baixe o JSON para recuperação e o CSV para consulta. Confirme o salvamento só depois de verificar o arquivo em pasta privada fora do repositório. O limite da exportação web é de 4.000.000 bytes. Para a cópia completa acima desse limite, carregue a sessão vigente do proprietário e a configuração privada do servidor e execute o exportador local.

```powershell
node --env-file="C:\privado\career.env" --import tsx scripts/export-private.ts --private-dir "C:\privado\copias" --format both
```

Guarde uma segunda cópia protegida. O JSON contém o histórico e a continuidade, além do manifesto e dos hashes. O CSV é uma projeção dos campos legados. O JSON exclui senhas, sessões, tokens e a autoridade administrativa. Prepare o Auth e o proprietário do destino separadamente. Aplique a recuperação por manutenção local somente em banco vazio preparado para isso, com a sessão do proprietário e a conexão privada `career_restore`. A conferência web é estrutural. Para verificar o destino, rode a prévia local antes de aplicar. Retome interrupções com o mesmo arquivo e a mesma execução, mantendo o bloqueio de manutenção até a verificação final.

```powershell
node --env-file="C:\privado\destino.env" --import tsx scripts/restore-private.ts preview --file "C:\privado\copias\snapshot.json"
node --env-file="C:\privado\destino.env" --import tsx scripts/restore-private.ts apply --file "C:\privado\copias\snapshot.json"
node --env-file="C:\privado\destino.env" --import tsx scripts/restore-private.ts resume --file "C:\privado\copias\snapshot.json" --run-id UUID-DA-EXECUCAO
```

Um JSON v1 antigo sem `continuity` ainda serve para consulta e prévia. Para aplicar ou retomar, capture novo JSON diretamente da origem. A continuidade preserva o maior número N consumido, inclusive quando uma transação desfeita deixou um salto, e mantém o bloqueio de identificadores e chaves aposentados. A recuperação considera também o maior número do destino e do histórico. Se já não houver próximo ID disponível, a recuperação é recusada antes de gravar. [Requisitos, limites e retomada da recuperação](private-transfers.md)

## Preparar uma implantação

1. Use Supabase Free e Vercel Hobby para uso pessoal com o endereço gratuito do provedor. Confira a capacidade nas contas antes de criar recursos e mantenha o custo recorrente em R$ 0. Evite adquirir assinaturas, upgrades ou domínios pagos.
2. No Supabase Auth, mantenha o cadastro público e o login anônimo desativados. Configure a origem de produção e autorize o endereço exato de recuperação em `/recuperar-senha`. Associe `OWNER_USER_ID` ao usuário provisionado.
3. Aplique as migrações revisadas ao destino e confira o catálogo, RLS, papéis e versão da base.
4. Pelo procedimento autorizado para o ambiente hospedado, um administrador com autoridade sobre os objetos do banco provisiona o login restrito `career_api` e a configuração inicial do proprietário. Confira no destino se `career.owner_config` e `career.maintenance_state` correspondem ao UUID de `OWNER_USER_ID`, se o estado está `ready` e se as preferências iniciais estão em `career.owner_settings` com sua auditoria de provisionamento. O script `scripts/provision-owner.ts` é exclusivo de bancos locais em loopback.
5. Mantenha a configuração verdadeira em **Production** e use configuração isolada e fictícia ou login indisponível em **Preview**. Para o build de produção, `VITE_SUPABASE_URL` e `SUPABASE_URL` devem apontar para a mesma origem HTTPS. Somente a origem e a chave publicável, ambas com prefixo `VITE_`, vão ao navegador. O servidor usa também `SUPABASE_PUBLISHABLE_KEY`, `OWNER_USER_ID`, `NODEJS_HELPERS=0` e a conexão privada `DATABASE_URL`. [Variáveis e contrato do servidor](../.env.example) · [Validação da configuração](../server/config.ts)
6. Use o pooler compartilhado em modo de transação com porta 6543, usuário `career_api` com o sufixo do projeto exigido pelo pooler, `DATABASE_POOL_MODE=transaction` e `DATABASE_TLS=verify-full`. Configure `DATABASE_CA_CERT` com a CA adequada e comece com `DATABASE_POOL_MAX=1`. Mantenha a exigência de SSL. Em conexão nova com o papel da aplicação, confirme que o cliente validou a cadeia e o nome do host e execute a consulta abaixo na mesma conexão. Ela cobre o trecho entre pooler e banco. Espere `session_user=current_user=career_api`, `ssl=true` e uma versão TLS. [Conexão ao Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Exigência de SSL](https://supabase.com/docs/guides/platform/ssl-enforcement)
7. Publique o artefato revisado e confira o commit e a implantação associados ao domínio. Verifique login, saída, recuperação por e-mail, links diretos e acesso no computador e no celular. Na API da aplicação, confirme 401 ao consultar `/api/v1/applications` sem sessão e com token de sessão expirado. Confira também a recusa de uma sessão válida de outro usuário. Na Data API do Supabase, confira separadamente a recusa de acesso direto ao esquema privado com a chave publicável sem sessão e com sessão de outro usuário. Antes de criar ou alterar qualquer registro fictício, registre o inventário de partida, incluindo a configuração e a auditoria que devem permanecer. Use uma única candidatura fictícia identificada pelo UUID da verificação, com estado `nao_enviado`, etapa e datas desconhecidas. Na etapa `complete`, altere apenas as observações dessa mesma candidatura, primeiro com uma credencial de agente de escopo autorizado e depois pela interface com a sessão do proprietário. Use a versão atual da candidatura em cada gravação. Confira na mesma base as duas alterações e os atores `agent` e `owner` na auditoria, com os IDs da credencial e do proprietário. Encerre o ensaio e reconcilie os registros técnicos e a auditoria pelo procedimento de manutenção da etapa alcançada antes de importar dados reais. [Etapas reconhecidas e remoção autorizada](technical-fixture-maintenance.md#etapas-reconhecidas)

```sql
SELECT session_user, current_user, ssl, version
FROM pg_stat_ssl
WHERE pid = pg_backend_pid();
```

### Planos gratuitos e pausa

| Plano | Cotas publicadas, consultadas em 18/11/2026 |
| --- | --- |
| Supabase Free | Dois projetos ativos, 500 MB de banco por projeto, 1 GB de arquivos, 5 GB de tráfego de saída e 5 GB de tráfego em cache. Pode pausar após uma semana de inatividade. |
| Vercel Hobby | Até 200 projetos e 100 implantações por dia. A franquia inclui 100 GB de transferência rápida, 10 GB de transferência de origem e um milhão de invocações de funções. |

Confira as cotas vigentes e o consumo do projeto e da equipe antes de publicar. Ao atingir um limite, confira o prazo de renovação aplicável ou continue localmente. [Preços do Supabase](https://supabase.com/pricing) · [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Limites da Vercel](https://vercel.com/docs/limits)

Se for necessário pausar ou retomar, selecione a organização e o projeto corretos no painel do Supabase e use o controle manual disponível. Para retomar um projeto pausado, escolha **Resume project**, aguarde o estado saudável e refaça as verificações de conexão e acesso. Em 18/11/2026, o provedor documentava retomada pelo painel por até um ano após a pausa. Mantenha cópias privadas independentes. A operação Free pode ficar indisponível e não inclui garantia de disponibilidade ou backup diário automático. Evite pings e tarefas agendadas para manter o projeto ativo. [Pausa e retomada](https://supabase.com/docs/guides/platform/free-project-pausing) · [Backups do Supabase](https://supabase.com/docs/guides/platform/backups)

## Conferir a origem e efetuar o corte

1. Identifique os escritores do controle de origem e coordene a janela de pausa com os responsáveis. Até o corte aprovado, o controle existente é a fonte operacional. Preserve os originais e uma cópia datada. A prévia copia os arquivos selecionados e confere sua integridade, mas deixa os escritores ativos.
2. Gere a prévia privada e confira IDs, estados, ordens, lacunas, links, duplicatas, evidências e revisões. Em atribuição de fonte acima de 500 unidades UTF-16 selecionada para aplicação, o campo curto fica nulo, `unprojected_source_attribution` fica registrado e a evidência mantém a linha integral. O parser permanece inalterado. A atribuição literal e os bytes arquivados permanecem íntegros. Corrija o mapeamento ou as decisões de importação quando houver erro e mantenha datas e campos desconhecidos. [Formato e validação da prévia](legacy-preview.md)
3. Antes de aplicar dados reais, conclua no ambiente de destino as verificações de acesso e recuperação e a reconciliação dos registros técnicos e da auditoria do ensaio fictício. Aplique apenas unidades preparadas, revisadas e autorizadas, conforme o [contrato de importação](http-api.md#transferências-e-limites). Confira a repetição segura, exporte o JSON, rode a conferência abaixo e ensaie a recuperação em um destino local isolado e vazio. Resolva diferenças ou registre as lacunas justificadas.
4. Na janela acordada, suspenda as escritas na origem, releia seus hashes e reconcilie qualquer delta. Se houver alteração, repita a captura e a conferência do delta antes de declarar o banco fonte operacional. Guarde em registro privado `cutover_at`, hashes, commit, versão de esquema, contagens, lacunas e responsáveis. Após o corte, as escritas vão para o banco e novos CSVs e JSONs são exportações. Encaminhe separadamente os escritores antigos que ainda apontam para o controle. Preserve as automações existentes e evite sincronização bidirecional.
5. Se a troca não ocorrer, o controle anterior segue em uso. Depois de escritas no banco, antes de voltar ao controle anterior, exporte e reconcilie o delta para preservar os registros novos e alterados.

Os caminhos abaixo são fictícios. Use uma pasta privada existente para a prévia e informe os caminhos reais do manifesto gerado e do JSON exportado na conferência.

```powershell
npm run import:legacy -- preview --source-dir tests/fixtures --private-dir "C:\privado\previas" --file legacy.csv --file review.md
npm run cutover:check -- --manifest "C:\privado\previas\legacy-preview-exemplo\manifest.json" --export "C:\privado\copias\snapshot.json"
```
