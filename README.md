# Carreira

Aplicativo em português para acompanhar candidaturas, próximas ações e revisões de um único proprietário. O acesso exige autenticação. O banco, os currículos referenciados, os contatos e as exportações são privados.

## Usar o aplicativo

- **Hoje** reúne os envios do dia e as tarefas pendentes. Ao registrar um envio, informe a data com a precisão conhecida e guarde a evidência. Datas e tarefas ficam no aplicativo, sem notificações de calendário.
- **Vagas** permite salvar oportunidades, confirmar candidaturas, registrar etapas no mesmo processo e acompanhar contatos e tarefas.
- **Análises** mostra a população, a cobertura e os registros usados em cada indicador. Selecione um resultado para consultar as candidaturas correspondentes.
- **Revisões** reúne lotes de 30 candidaturas únicas confirmadas e elegíveis no ciclo. O fechamento preserva os membros e o resultado do período. Uma retificação guarda o motivo e a versão anterior.
- **Conta → Configurações** concentra preferências e credenciais de agente com escopos e revogação.

Consulte o [guia de operação](docs/operations.md) para recuperar acesso, corrigir registros, gerenciar o agente e guardar cópias privadas.

## Desenvolvimento local

Use Node 22.18.0 e npm 10.9.3. A partir da raiz do repositório, execute:

```sh
npm ci
npm run dev
```

Abra `http://127.0.0.1:5173`. O Vite encaminha a API para `127.0.0.1:3001`. Prepare o Auth, o proprietário e o PostgreSQL com os comandos do [guia de operação](docs/operations.md#executar-localmente). O arquivo `.env.example` lista as variáveis. O Vite lê `.env.local`. Os comandos de servidor recebem a configuração pelo ambiente do processo.

Somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` pertencem ao navegador. A API verifica a sessão e usa a conexão privada `DATABASE_URL` como `career_api`. Consulte o [guia de segurança](docs/security.md) para os papéis, RLS, TLS e o provisionamento local do proprietário.

## Verificar com dados fictícios

Com Docker disponível e as portas 55432, 55434 e 4173 livres, `npm run verify:local` instala as dependências, cria dois bancos descartáveis e executa verificações de tipos, lint, testes unitários, integração, build, privacidade e navegador. Execute `npm run test:fixture-maintenance` separadamente para testar a manutenção de registros técnicos. O [roteiro de verificação](docs/verification.md) reúne pré-requisitos e evidências da CI pública.

## Conferir o conteúdo para publicação

Na raiz de uma cópia Git completa, configure `PUBLICATION_TERMS_FILE` com o caminho absoluto de um arquivo UTF-8 privado, fora dos diretórios de trabalho e de metadados do Git. Use um termo real por linha para nomes, empresas, contatos, endereços e identificadores privados relevantes. Para nomes curtos que também aparecem dentro de palavras comuns, o prefixo `word:` seleciona a palavra inteira. Mantenha esse arquivo no ambiente de revisão.

Se uma ocorrência tiver sido revisada, o arquivo JSON opcional indicado por `PUBLICATION_EXCEPTIONS_FILE` segue as mesmas restrições de localização. Cada item da lista contém `path` (caminho aprovado), `term` (termo literal do dicionário em minúsculas), `fragment` (um campo no formato `chave: 'amostra'`, com um identificador e um rótulo ASCII que aceita letras, números, ponto, hífen e sublinhado) e `sourceSha256` (SHA-256 do conteúdo UTF-8, convertendo CRLF para LF). A aprovação vale para uma única ocorrência do termo no rótulo, nesse fragmento e nessa versão do arquivo. Alterações no arquivo exigem nova revisão.

```sh
npm run publication:check -- --ref HEAD
```

Use o identificador exato do commit a publicar no lugar de `HEAD` para selecionar outra referência. A verificação exige que os arquivos locais e o índice correspondam à árvore escolhida. Ela percorre todos os ancestrais desse commit e confere autores, mensagens, nomes, modos e conteúdo. A saída informa identificadores, contagens e classes de achados. Um erro de leitura ou um achado resulta em código de saída 1. A lista de caminhos aprovados está em `scripts/publication-check.ts`. Revise o conteúdo de cada novo caminho antes de incluí-lo.

A revisão editorial cobre também o contexto de exemplos e documentos. A fixture CSV e sua revisão em `tests/fixtures/` são fictícias. Currículos, relatórios, dumps, credenciais e capturas privadas devem ficar fora da árvore de publicação. O conteúdo de um commit pode estar limpo e ainda ter informações pessoais na autoria ou em versões anteriores.

## Referências

- [Produto e arquitetura](docs/design.md) e [dicionário de dados](docs/data-dictionary.md)
- [API HTTP](docs/http-api.md) e [instruções para agentes](docs/agent-api.md)
- [Prévia do legado](docs/legacy-preview.md) e [exportação e recuperação privadas](docs/private-transfers.md)
- [Candidaturas](docs/application-services.md), [atividades](docs/activity-services.md) e [revisões](docs/reviews.md)

A execução local documentada usa dados sintéticos. Hospedagem, acesso ao provedor Auth e importação de registros reais exigem verificação no ambiente de destino.
