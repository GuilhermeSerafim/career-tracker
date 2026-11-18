# Verificação local e CI

Use Node 22.18.0, npm 10.9.3 e Docker. Na raiz do repositório:

```sh
npm run verify:local
```

O comando exige as portas locais 55432, 55434 e 4173 livres. Cria dois PostgreSQL 17.12 descartáveis, com imagem fixada por digest, nomes exclusivos e senhas sintéticas geradas em memória. Não adota bancos ou containers existentes. Ao terminar, verifica a identidade e remove somente os recursos criados por essa execução. Falhas de execução e de limpeza são relatadas juntas.

O roteiro executa `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:local:apply`, `npm run db:local:check`, `npm run test:integration`, `npm run build`, `npm run build:check` e `npm run test:e2e`, nessa ordem. Instala Chromium se `PLAYWRIGHT_CHANNEL` não estiver definido. Para usar Chrome já instalado, defina `PLAYWRIGHT_CHANNEL=chrome`. Não são necessários arquivos privados de ambiente, contas Supabase ou dados pessoais.

A configuração em `.github/workflows/checks.yml` reproduz os comandos com serviços PostgreSQL separados e descartáveis. Actions, imagem, Node, npm e dependências têm versões fixadas. O workflow foi preparado para execução futura; sua existência não comprova execução remota.

Execução local de 17/11/2026, em Windows e Chrome 157.0.8103.51, com dois clusters novos:

| Verificação | Resultado |
| --- | --- |
| Instalação limpa, TypeScript e lint | Passaram |
| Unitários | 34 arquivos, 531 testes; 138,93 s |
| SQL e integração | 18 arquivos, 258 testes; 276,92 s |
| Build e privacidade | 7 artefatos, 138 módulos iniciais, sem ECharts inicial |
| Navegador nativo | 23 testes; 3,1 min |
| Auditoria final e limpeza | Ambos os bancos vazios e sem outras sessões; recursos descartáveis removidos |

A sequência padrão terminou com código 0. O teste final de expiração com segredo visível entrou depois do lint inicial: o build conferiu seus tipos, o E2E o executou e o lint dos dois arquivos afetados passou ao final. Os testes unitários e de integração não dependem desse helper de navegador. O build mantém o aviso de chunks acima de 500 kB: a entrada tem cerca de 761 kB (218 kB gzip) e o gráfico adiado, 556 kB. A separação do gráfico foi comprovada; esses números não constituem uma medição de desempenho hospedado.

Após a revisão de Auth, duas falhas foram reproduzidas e corrigidas: uma segunda saída intencional durante outra pendente e a reentrada após recarregar tokens rotacionados sem `session_id` válido. A verificação específica passou em 75 testes de sessão com o SDK instalado (7,02 s) e sete cenários nativos (55,6 s). O cenário de segunda saída foi repetido após tornar a espera pela resposta de A exata: passou em 16 s. Os prazos comuns de 5 s e 30 s foram mantidos. A tabela acima registra a execução integrada anterior; os testes independentes de domínio e SQL não foram repetidos nessa correção restrita a Auth. A entrada atual tem 764 kB (219 kB gzip); a verificação com canários passou novamente com sete artefatos e sem ECharts inicial.

A correção seguinte cobriu a recuperação PKCE iniciada antes do logout, inclusive a espera inicial pelo lock e o intervalo entre primeira gravação e callback: 82 testes de sessão passaram em 6,74 s e os oito cenários nativos em 59,2 s. A compilação nova conferiu os tipos antes do preview; lint e privacidade foram repetidos. A entrada resultante tem cerca de 765 kB (219 kB gzip). Os prazos e os testes anteriores de F1/F2 foram preservados.

O ajuste final serializou o pedido de novo e-mail de recuperação na mesma aba: 83 testes de sessão passaram em 5,71 s. Sobre a nova compilação, os dois cenários nativos afetados — recuperação comum e recuperação automática atravessando logout — passaram em 21,2 s. Os oito cenários anteriores registram a compilação imediatamente anterior a esse ajuste restrito; não foram apresentados como uma nova execução completa.

A verificação mais recente acrescentou os quatro pontos de transição da recuperação e preservou sua geração durante a atualização dos metadados: 87 testes de sessão passaram em 7,19 s; os dois cenários nativos afetados passaram em 22,3 s sobre a nova compilação. O diagnóstico de logout após a terceira gravação confirmou que a sessão permanece ausente tanto no SDK atual quanto após recarregar.

## Isolamento e prazos

Os arquivos Vitest executam em série, assim como os consumidores dos bancos e os testes nativos. Cada teste de revisão prepara seu próprio estado; o encerramento aguarda as operações iniciadas antes de liberar o proprietário. Testes comuns mantêm 5 s em unitários e 15 s em integração. Seis cenários que gravam 30 ou 31 candidaturas têm prazo específico de 30 s, baseado em medições das transações reais. Não há repetição automática de testes falhos.

O fluxo integrado tem uma fixture identificada, com 45 s próprios, para login, início do ciclo pela interface e preparação das 29 candidaturas independentes. Na mesma página e conta, o teste com prazo de 60 s registra a 30ª, confirma que a repetição não duplica, registra avaliação e tarefa, conclui a tarefa, filtra, confere os 30 IDs do gráfico, fecha e revisa o lote, exporta e sai. Os limites de execução do produto não foram ampliados.

A preparação chegou a 32,769 s sob pressão de memória. Na medição completa, levou 10,534 s; a parte interativa alcançou o gráfico em 16,632 s, o fechamento em 20,877 s e terminou em 39,440 s. As falhas anteriores no prazo de 30 s foram preservadas no registro da verificação. O prazo específico não se aplica aos demais testes nativos, que continuam com 30 s.

O runner de E2E conclui a compilação antes de iniciar a contagem de 30 s para disponibilizar o preview. O Playwright encerra esse processo. Não reutiliza preview ou arquivos de build antigos na execução oficial.

## Evidências e limites

Os testes usam Auth sintético no navegador e a API local real com PostgreSQL restrito. A credencial descartável criada pela interface autentica o agente na mesma base; permissões, atores e revogação são verificados. O logout em duas abas, recuperação e a preservação de um login novo durante uma saída antiga são cenários nativos. Isso não comprova entrega de e-mail, callback ou revogação no provedor hospedado.

O adaptador inclui metadados sem segredos no próprio JSON de sessão do SDK: versão, geração de login, revisão da gravação, origem e bloqueio. Credenciais e metadados são gravados juntos sob o mesmo lock do SDK; não há cópia adicional dos tokens. A rotação mantém a geração; um login explícito validado ou uma recuperação atual estabelece outra. Sessões antigas sem metadados são adotadas somente dentro desse lock. `session_id` decodificado auxilia a comparação de armazenamento, mas nenhum desses marcadores autentica o usuário ou substitui a validação no servidor.

A saída captura sua geração e invalida recuperações já pendentes antes de aguardar trabalho remoto. Uma nova saída intencional de B descarta B mesmo enquanto a saída de A aguarda; nenhuma delas remove C comprovadamente posterior. Credenciais antigas são removidas; uma substituição ambígua, sem identidade válida, fica bloqueada inclusive após recarregar. Metadados inválidos também impedem a leitura pelo SDK. JSON corrompido é preservado e a saída informa que não confirmou a conclusão. Um novo login validado pode substituir esse estado.

A recuperação exige uma gravação real do SDK ainda não consumida e a mesma revisão após adquirir o lock. Adoção, bloqueio e outros ajustes de metadados não comprovam recuperação; callbacks atrasados não podem assumir uma revisão posterior só porque os tokens coincidem. O callback agenda essa conferência sem aguardar o lock que o próprio SDK pode estar segurando. Esses controles privilegiam bloquear uma sessão ambígua; nesse caso, o usuário precisa entrar novamente. A evidência nativa é de Chromium com Web Locks; o fallback de processo não comprova coordenação entre abas em navegadores sem esse recurso.

A origem da operação PKCE também é capturada quando o SDK pede o lock, antes de aguardar a inicialização ou a resposta da rede. Uma saída posterior invalida esse contexto: a resposta antiga não grava sessão nem cria prova de recuperação. Isso cobre a inicialização automática que ainda nem iniciou a requisição. Cada recuperação recebe uma geração própria desde a primeira gravação. Se o logout ocorrer entre essa gravação e o callback, captura essa geração para removê-la sob lock, mesmo com a interface ainda carregando; uma recuperação posterior recebe outra geração e é preservada. A limpeza antiga só remove o verificador originalmente observado se seu valor continuar igual; preserva verificadores e índices substituídos por um fluxo novo. Um pedido de novo e-mail de recuperação na mesma aba aguarda esse lock para gravar seu próprio verificador. O contexto é descartado ao encerrar a operação; um novo link de recuperação continua funcionando. Essa integração usa os caminhos de armazenamento da versão fixada do SDK e deve ser revisada ao atualizá-lo.

A primeira gravação, a repetição feita pelo SDK, a atualização dos metadados e a publicação do callback mantêm a mesma geração da recuperação. Atualizar os metadados muda apenas sua revisão; não transforma os mesmos tokens em um login posterior protegido contra a saída já solicitada. Os testes entregam e contam o logout em cada uma dessas etapas e conferem a interface atual, a sessão bruta do SDK e um novo controlador após recarregar, além de uma recuperação realmente posterior.

As verificações de acessibilidade incluem 320, 375, 768 e 1440 px, teclado, foco, alvos de 44 px, contraste AA, movimento reduzido, tabelas acessíveis e axe. A ampliação para 200% usa a fonte raiz a 32 px; não representa teste de zoom nativo ou leitor de tela do sistema. Tabelas largas têm regiões locais roláveis por teclado. A inspeção visual complementa as verificações automáticas.

`build:check` compila com canários sintéticos de servidor, verifica o conteúdo de `dist` e percorre o grafo estático dos módulos iniciais. Recusa segredos, URLs privadas, arquivos de origem e ECharts no carregamento inicial. Somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` são aceitas como configuração pública. Os testes também verificam texto HTML/Markdown literal, URLs inseguras, fórmulas CSV e rótulos de links privados.

Traces, vídeos, screenshots automáticos de erro e cópias automáticas do DOM estão desativados para evitar registrar a credencial de exibição única. Capturas explícitas usam telas sintéticas sem credenciais. O CI não publica esses artefatos. Os bancos devem terminar com 26 tabelas, zero registros, catálogo de segurança íntegro e nenhuma outra sessão cliente. Nenhum dado real, publicação ou migração hospedada faz parte desta verificação.

## Dependências

Em 17/11/2026, `npm audit --json` apontou 13 registros afetados no ambiente de desenvolvimento (6 moderados e 7 altos); `npm audit --omit=dev --json` terminou com zero vulnerabilidades. Os avisos partem de [minimatch 10.2.6](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249), usado pelo typescript-eslint, e [picomatch 4.0.7](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), propagado pela cadeia de Vite/Vitest. Não se trata de uma árvore de desenvolvimento livre de avisos.

A análise de alcance encontrou padrões glob fixos no repositório e nenhum caminho da aplicação/API que aceite glob fornecido pelo usuário ou execute o servidor de desenvolvimento. O aviso de minimatch exige `optimizationLevel >= 2`; a configuração atual de lint não habilita esse modo nem projetos TypeScript dinâmicos. O aviso atual de picomatch não informa versão corrigida. O lock foi preservado; não foram aplicados overrides, downgrades ou `audit fix --force` sem comprovação. Permanece o risco residual de padrões não confiáveis nas ferramentas de desenvolvimento. Reavalie essa condição ao atualizar a cadeia ou introduzir entrada de glob; esta análise de alcance não garante ausência de outros defeitos e não substitui a verificação do empacotamento hospedado.
