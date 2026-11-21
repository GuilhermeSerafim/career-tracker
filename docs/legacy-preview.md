# Prévia privada do legado

## Importar novas candidaturas em Vagas

1. Entre como proprietário, abra **Vagas → Importar CSV** e selecione um CSV legado em UTF-8. O limite por arquivo é 1 MiB e 500 registros. Para testar localmente, use [legacy.csv](../tests/fixtures/legacy.csv), que contém dados fictícios.
2. Clique em **Conferir arquivo** e revise os registros prontos, os já importados e os que precisam de atenção. Datas e campos vazios, conflitos de ID ou de ordem e sinais de duplicidade aparecem na prévia. Um erro de formato exige corrigir o arquivo e gerar outra prévia. A prévia é somente leitura.
3. Marque a confirmação e clique em **Importar**. Uma transação privada arquiva os bytes originais e grava as linhas prontas, com seus IDs, ordem documentada, evidências e referências compatíveis. O recibo informa quantas linhas entraram, já estavam importadas ou ficaram para revisão.
4. Se a resposta cair, clique em **Repetir confirmação** na mesma aba. Em uma nova aba ou após recarregar, selecione o mesmo arquivo e confira a prévia atual. O servidor compara os IDs e a versão dos registros antes de gravar.

O CSV aceita importação em uma conta sem ciclo iniciado. Datas omitidas e relação com o ciclo ficam desconhecidas, e a etapa narrativa permanece como texto de origem. Casos ambíguos ou divergentes ficam pendentes. Use o processo de reconciliação local abaixo para interpretar identidades, etapas, lotes ou revisões históricas e resolver divergências com decisões explícitas.

## Capturar e conferir o legado localmente

Esta etapa captura controles para revisão local. A fonte operacional continua em uso. Não há importação no banco nem mudança de fonte operacional.

Crie previamente um diretório privado fora do repositório principal, de seus worktrees e do diretório de origem. Selecione exatamente um CSV e, opcionalmente, controles Markdown/texto com `--file` repetido. Os nomes devem ser simples, sem caminhos. Exemplo com arquivos inteiramente fictícios:

```sh
npm run import:legacy -- preview --source-dir tests/fixtures --private-dir <diretorio-privado-existente> --file legacy.csv --file review.md
```

Cada execução cria `legacy-preview-AAAA-MM-DD-<sufixo>` no destino privado, com cópias em `sources/`, `manifest.json` e `diff.json`. O manifesto contém texto integral privado e referências originais: mantenha toda a pasta fora de publicação. A CLI imprime apenas contagens. Código de saída 0 indica captura sem erros bloqueantes; 2 indica captura com erros de validação para revisão; 1 indica falha de execução. Uma pasta parcial sem manifesto válido não é uma captura concluída.

Somente controles explicitamente selecionados são lidos. Diretórios, symlinks/junctions e arquivos de outras extensões são rejeitados. Não há busca recursiva, abertura de links nem coleta de CVs/PDFs referenciados. BOM UTF-8, CRLF, aspas, quebras de linha e espaços são preservados nos bytes e campos arquivados. A fixture tem normalização de texto desativada no Git para conservar esses bytes.

O parser mantido `csv-parse` está fixado em 7.0.3 no pacote e lockfile. A sintaxe e o BOM seguem a [documentação oficial](https://csv.js.org/parse/options/bom/); as fronteiras de registro usam a [contagem de bytes do parser](https://csv.js.org/parse/options/info/). Os hashes SHA-256 de linhas são calculados sobre fatias dos bytes originais, incluindo o terminador presente. O BOM pertence ao arquivo/cabeçalho, não à primeira linha de dados.

O teto é 50 MiB (52.428.800 bytes) por arquivo e para a soma de todos os controles selecionados, reutilizando o limite de arquivo-fonte da transferência. São permitidos até 100.000 registros de dados CSV, além do cabeçalho, e até 50.000 unidades UTF-16 por registro bruto, contando aspas, delimitadores e terminador presente, conforme o limite de `import_rows.originalText`. Não há truncamento: exceder qualquer teto bloqueia a entrada. O parser limita seus buffers de campo/registro antes de acumular campos enormes; usa margem de bytes UTF-8 para aceitar texto multibyte e confere o comprimento bruto exato a cada registro. Também limita a quantidade de campos antes de acumular campos vazios ilimitados. A CLI verifica tamanhos e soma antes de carregar arquivos, aloca somente o tamanho verificado dentro do teto e detecta crescimento durante a leitura.

O manifesto v2 versiona parser/importador e registra caminhos, horários de leitura, tamanhos, hashes, IDs, quantidades e proveniência por coluna. A identidade do conjunto usa somente versões e pares ordenados de nome/hash originais; horários, caminhos absolutos, base de comparação e pastas de destino ficam separados. Mudança em qualquer controle selecionado muda a identidade. Copiar os mesmos bytes novamente com as mesmas versões mantém a identidade. O importador `legacy-preview/2` exige a base de comparação explícita do formato v2; prévias v1 devem ser geradas novamente.

O CSV exige o cabeçalho exato do legado. UTF-8/CSV inválidos, cabeçalho divergente, estados/datas/ordens inválidos e IDs/ordens repetidos bloqueiam aplicação futura. Lacunas não são erros: envio sem data continua com precisão `unknown`; data de registro não vira envio. Narrativa de etapa, plataforma, fonte, CVs e observações continuam literais. Canal, plataforma de envio, tenant e relação com o ciclo ficam pendentes de reconciliação explícita. Nenhuma narrativa gera aprovação, evento ou data. Possíveis duplicatas geram avisos.

Referências mantêm o texto original e classificação de esquema (`web`, `private`, `local`, `dangerous`, `unknown`). `web` identifica HTTP(S), sem garantir que o recurso seja público ou acessível. Referências inseguras/desconhecidas geram avisos. Nenhuma referência é visitada.

`compareLegacyRows` aceita estado anterior tipado: ID legado, hash da linha importada, versão importada e versão da aplicação capturada pelo chamador. Distingue novo, inalterado, fonte alterada, aplicação alterada e conflito; também sinaliza remoção da fonte. Versão diferente protege a alteração no app mesmo quando a fonte também mudou. IDs repetidos tornam a comparação ambígua. A base admite até 100.000 registros distintos, IDs `V` seguidos de dígitos com até 500 caracteres, hashes SHA-256 e versões inteiras positivas até 2.147.483.647; seu JSON compacto tem teto independente de 50 MiB. A base é validada e copiada antes da leitura assíncrona, inclusive quando a fonte acaba bloqueada.

O manifesto persiste `comparison.mode` e `comparison.basis`. Sem estado anterior, o modo é `source_only` e a base obrigatoriamente vazia. Com `previous` fornecido à API, o modo é `captured_prior_state`, inclusive para uma base explicitamente vazia. A CLI continua usando somente `source_only`: apresenta registros válidos como novos e não lê o banco. Erros bloqueantes exigem diff exatamente vazio, preservando os dados e problemas no manifesto.

A validação do manifesto reinterpreta cada registro CSV bruto para conferir os campos, a projeção e a proveniência, e recalcula o diff exato com a base persistida. Alterar em conjunto os campos editáveis e suas cópias de proveniência não altera a evidência original e é rejeitado. `verifyPreviewArtifact(manifest)` verifica o artefato privado completo: relê somente as cópias selecionadas dentro dos tetos, confere tamanhos e hashes, reinterpreta todo o CSV original copiado e compara a análise semântica inteira. Também recalcula o diff a partir desse CSV reinterpretado e da base capturada, antes de conferir os arquivos canônicos `manifest.json` e `diff.json`. Omitir IDs, inserir IDs sem relação com fonte/base ou trocar classificações é rejeitado mesmo com edições coordenadas nas duas cópias do diff. Recebe o manifesto a verificar e usa seu diretório privado registrado; lança erro diante de divergência. Não abre referências externas.

A consistência da base capturada não comprova a verdade atual do banco nem autentica um histórico editado externamente. Antes de aplicar decisões, o servidor consulta o estado atual do destino e recalcula a comparação.

A captura de vários arquivos não congela escritores. Cada cópia é conferida byte a byte, e as fontes são relidas antes da conclusão. `findOriginalSourceDrift(manifest)` confere separadamente os hashes dos arquivos na origem operacional e lista os nomes alterados/ausentes. Essa checagem de origem não substitui a verificação do artefato copiado. Antes da reconciliação, repita as verificações da origem e da cópia. A aplicação exige decisões explícitas e validação independente no servidor.

## Conferência local após a importação

```sh
npm run cutover:check -- --manifest <pasta-da-previa>/manifest.json --export <exportacao-privada-json>
```

Use o manifesto na pasta da captura original, com `sources/` e `diff.json`, e um JSON completo da exportação privada. Ambos devem estar fora do repositório e do worktree. A conferência lê somente esses artefatos. Ela valida hashes, compara os bytes arquivados e confere cada ID, posição, ordem, evidência, texto, data, CV e referência contra a importação concluída. Uma alteração de etapa registrada na mesma candidatura é contabilizada separadamente.

Para uma revisão vinculada, o comando confere o Markdown arquivado, a proveniência, os membros, os eventos e o hash do pedido de importação reconstruído a partir do export. Quando existem arquivos Markdown e nenhum vínculo verificável, a conferência fica pendente. Com uma revisão vinculada, outros controles Markdown são contados como arquivos de origem. A leitura desses controles e a validação das decisões históricas fazem parte da reconciliação manual.

Os códigos de saída são 0 para conferência aprovada, 2 para divergências ou pendências e 1 para entradas inválidas ou falha de execução. O resultado exibe somente contagens e categorias. Uma decisão explícita que mantém um valor atual diferente da fonte aparece como pendência com o original preservado. Candidaturas nativas, alterações de etapa auditadas e referências legadas que só cabem no original são contadas. O resultado se aplica ao par de artefatos apresentado. A etapa operacional ainda exige a comparação com a origem atual e a decisão de corte.

Quando a aplicação seleciona uma atribuição de fonte que excede o limite de 500 unidades UTF-16 do campo curto, a evidência mantém a linha original inteira e o campo curto fica nulo. O CSV arquivado conserva os bytes e a linha aplicada registra o aviso `unprojected_source_attribution`. A conferência só conta essa preservação depois de verificar a evidência integral, o aviso e o valor nulo. A prévia mantém a atribuição literal.
