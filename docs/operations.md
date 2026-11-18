# Operação da aplicação hospedada

Em 18/11/2026, a produção exibia **Acesso indisponível**. A interface abria por link direto no computador e no celular, e a API respondia com HTTP 503 e `NOT_CONFIGURED`. O banco estava vazio. O acesso do proprietário, a recuperação por e-mail e a importação real continuam pendentes. Até a aprovação da migração, o CSV de origem continua sendo a referência.

## Planos, cotas e pausa

| Serviço confirmado | Limites publicados em 18/11/2026 |
| --- | --- |
| Supabase Free | Até dois projetos ativos, 500 MB de banco por projeto, 1 GB de arquivos, 5 GB de tráfego de saída e 5 GB de tráfego em cache. O projeto pode ser pausado após uma semana de inatividade. |
| Vercel Hobby para uso pessoal | Até 200 projetos e 100 implantações por dia. A franquia inclui 100 GB de transferência rápida, 10 GB de transferência da origem e um milhão de invocações de funções. |

Consulte o consumo da equipe antes de publicar. As franquias são limites do plano. O saldo mensal disponível depende do uso dos projetos. Mantenha o custo recorrente em R$ 0. Ao atingir um limite, aguarde a renovação aplicável ou continue o trabalho local. [Preços do Supabase](https://supabase.com/pricing) · [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Limites da Vercel](https://vercel.com/docs/limits)

Se o banco estiver pausado, selecione a organização e o projeto corretos no painel do Supabase e confirme **Resume project**. A retomada pelo painel está disponível por até um ano após a pausa. Aguarde o estado saudável e repita as verificações de conexão e acesso abaixo. Retome o projeto quando precisar da aplicação, sem agendar pings para evitar a pausa. O plano Free não inclui backup diário automático. Guarde cópias privadas independentes. [Retomada pelo painel](https://supabase.com/docs/guides/platform/free-project-pausing) · [Backups do Supabase](https://supabase.com/docs/guides/platform/backups)

## Preparar os ambientes

Para compilar na Vercel, defina uma origem HTTPS válida em `VITE_SUPABASE_URL`. No build de produção, `SUPABASE_URL` deve indicar a mesma origem. O build falha se faltar a origem exigida ou se as duas divergirem. Na implantação verificada, ambas apontavam para a mesma origem fictícia, sem chave publicável, proprietário ou conexão de banco configurados. Foi nessa configuração que a interface exibiu **Acesso indisponível** e a API retornou HTTP 503.

1. Em **Preview**, mantenha o login indisponível ou use uma configuração fictícia isolada. Restrinja as credenciais reais ao ambiente **Production**. Confira o destino de cada variável antes de aplicar.
2. No Supabase Auth, mantenha o cadastro público e as sessões anônimas desativados. Configure a origem de produção e autorize apenas o endereço exato de recuperação em `/recuperar-senha`. Use o e-mail indicado pelo proprietário e associe ao servidor o identificador da conta criada.
3. Para ativar o login real, use a origem do Auth do projeto nas duas variáveis de origem. Forneça ao navegador apenas `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`. Com uma origem e uma chave publicável válidas, o navegador pode inicializar o Auth mesmo quando a API ainda está indisponível.
4. A função Node na Vercel exige `NODEJS_HELPERS=0`. Configure também a chave publicável do servidor, o identificador do proprietário e as variáveis privadas do banco conforme o contrato do servidor. Reserve as credenciais administrativas para provisionamento e manutenção. Guarde os valores no armazenamento de segredos, fora do Git, dos argumentos de comandos e dos logs. [Variáveis de ambiente](../.env.example) · [Contrato do servidor](../server/config.ts) · [Configuração e permissões](security.md)
5. Publique o artefato revisado. Confira a implantação associada ao endereço de produção, os links diretos após atualização de página e o comportamento da API. Antes de liberar dados reais, conclua os testes de acesso e recuperação abaixo.

## Validar a conexão do banco

No painel do projeto, consulte o host do pooler compartilhado em modo de transação e obtenha o certificado da autoridade do Supabase. Na configuração privada do servidor, use a porta 6543, o papel `career_api` com o sufixo do projeto exigido pelo pooler, `DATABASE_POOL_MODE=transaction`, `DATABASE_TLS=verify-full` e a CA em `DATABASE_CA_CERT`. Comece com `DATABASE_POOL_MAX=1`. O driver deve validar a cadeia e o nome do host. [Conexão ao Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)

Mantenha ativa a exigência de SSL do projeto. Alterar essa opção reinicia o banco e pode interromper conexões por alguns minutos. Em um cliente PostgreSQL privado, abra uma conexão nova com o papel real e as mesmas opções de conexão e TLS da aplicação. Confirme que o cliente validou a cadeia e o nome do host do pooler e execute a consulta na mesma conexão. [Exigência de SSL](https://supabase.com/docs/guides/platform/ssl-enforcement)

```sql
SELECT session_user, current_user, ssl, version
FROM pg_stat_ssl
WHERE pid = pg_backend_pid();
```

O resultado esperado é uma linha com os dois usuários iguais a `career_api`, `ssl=true` e uma versão TLS. A consulta mede a criptografia entre o pooler e o banco. Na verificação do banco hospedado, o cliente privado confirmou TLS 1.3 nos dois trechos e a recusa de conexão sem criptografia antes da autenticação. O teste foi executado fora da função Vercel, que continuava sem credenciais de banco.

## Liberar o acesso e proteger a recuperação

1. Depois do provisionamento, registre por tabela a configuração e a auditoria aprovadas que deverão permanecer ao final dos testes. Use dados sintéticos identificáveis. Na **API da aplicação**, confirme login, saída, expiração e permissões do proprietário, além do ator de cada operação na auditoria. Verifique a recusa de acesso a dados privados tanto sem sessão quanto com uma sessão válida de outro usuário.
2. Na **Data API do Supabase**, confira separadamente a recusa de acesso direto ao esquema privado com a chave publicável sem sessão e com uma sessão válida do usuário que não é proprietário. A tentativa anônima recebeu HTTP 406. A verificação direta com a sessão desse outro usuário e os testes autenticados da API da aplicação continuam pendentes.
3. Solicite a recuperação para o endereço autorizado e confirme o recebimento real. Abra o link no mesmo dispositivo, navegador e perfil que fizeram a solicitação, onde o verificador PKCE está armazenado. Confira o endereço de recuperação, altere a senha e teste o novo login. Enquanto faltar a entrega ou a troca de senha, mantenha os dados reais fora do serviço. [Fluxo PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow#limitations)
4. Pelo procedimento de manutenção autorizado, remova somente os registros identificados dos testes. Confira as contagens e os registros remanescentes de cada tabela. Antes da primeira importação, deve restar apenas a configuração aprovada e a auditoria prevista, inclusive os eventos dos testes que devem ser preservados. Se houver divergência, reconcilie-a antes de prosseguir. Faça a prévia do CSV e examine o resultado com o proprietário. Combine a interrupção das escritas na origem e a mudança da fonte oficial somente após aprovação. [Prévia do legado](legacy-preview.md)
5. Para recuperar dados, mantenha a exportação JSON e uma segunda cópia privada. Confira o manifesto e ensaie a restauração em um destino vazio preparado para isso. As credenciais e sessões precisam de provisionamento próprio. Siga as etapas de prévia, aplicação e conferência antes de promover o destino. [Exportação e restauração privadas](private-transfers.md)
