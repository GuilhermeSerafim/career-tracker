# Verificação local e CI

## Execução local

Use Node 22.18.0, npm 10.9.3 e Docker com as portas 55432, 55434 e 4173 livres. Na raiz do repositório, execute

```sh
npm run verify:local
npm run test:fixture-maintenance
```

`verify:local` cria dois PostgreSQL 17.12 descartáveis com imagem fixada por digest, nomes exclusivos e senhas sintéticas em memória. Exige portas livres e remove somente os recursos identificados como seus. Relata falhas de execução e limpeza.

O agregador executa `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:local:apply`, `npm run db:local:check`, `npm run test:integration`, `npm run build`, `npm run build:check`, `npm run test:e2e` e `node --import tsx scripts/audit-local.ts`. Instala Chromium quando `PLAYWRIGHT_CHANNEL` estiver ausente. Para usar Chrome já instalado, defina `PLAYWRIGHT_CHANNEL=chrome`. O segundo comando é a suíte nativa de manutenção de registros fictícios. Roda separadamente e cria seus próprios containers Docker com portas locais dinâmicas. As verificações usam dados fictícios e dispensam contas hospedadas e arquivos privados. [Agregador local](../scripts/verify-local.mjs) · [Workflow de CI](../.github/workflows/checks.yml)

## Evidência pública de 19/11/2026

A execução `44615781682` do GitHub Actions concluiu com sucesso para o commit `490148ce145fec9abfd1962deb569cb8b2f8443d`. O workflow usa PostgreSQL descartável, testa manutenção dos registros técnicos separadamente e audita os dois bancos ao terminar. Para consultar o log em uma cópia local do repositório público, execute `gh run view 44615781682 --log`.

| Verificação | Resultado |
| --- | --- |
| Instalação, TypeScript e lint | Passaram |
| Unitários | 668 passaram |
| Banco, catálogo de segurança e integração | 262 testes de integração passaram, com aplicação e conferência do esquema concluídas |
| Manutenção de registros fictícios | 5 testes nativos passaram |
| Build e verificações de privacidade e runtime | Passaram |
| Navegador | 27 testes passaram |
| Auditoria final dos dois bancos | Passou |

A execução local integrada de 17/11/2026, em Windows e Chrome 157.0.8103.51, registrou 531 unitários, 258 testes de integração e 23 de navegador, além de TypeScript, lint, build, privacidade e limpeza. Essa é uma medição histórica de uma versão anterior.

## Cobertura e limites

- A API local usa PostgreSQL com papéis restritos e Auth sintético nos testes de navegador. A credencial descartável do agente acessa a mesma base de teste, com verificação de escopo, autoria e revogação. O fluxo integrado confirma um envio uma única vez, registra avaliação e tarefa, explica o gráfico com os IDs do lote, fecha e revisa o lote e exporta.
- As suítes de dados cobrem divergência da origem, lacunas e evidências, colisão de identidade, versões concorrentes e repetição de pedidos. A transferência passa por prévia, aplicação, retomada e conferência em destino local separado. A auditoria final confere catálogo, bancos vazios e ausência de outras sessões.
- Os cenários nativos de Auth cobrem duas abas, logout concorrente, recuperação PKCE e preservação de um login posterior. A coordenação entre abas foi verificada em Chromium com Web Locks. O fallback de processo tem uma fronteira própria. A recuperação usa o armazenamento da versão fixada do SDK e merece nova verificação ao atualizar essa dependência.
- As verificações de acessibilidade incluem larguras de 320, 375, 768 e 1440 px, teclado, foco, alvos de 44 px, contraste AA, movimento reduzido, tabelas e axe. O cenário de ampliação de 200% ajusta a fonte raiz para 32 px. Zoom nativo e leitores de tela são verificações separadas.
- `build:check` usa canários sintéticos para conferir `dist`, a configuração pública, o grafo dos módulos iniciais e o runtime da API. ECharts carrega sob demanda. As verificações do produto também cobrem texto literal, URLs inseguras, fórmulas CSV e rótulos de links privados. Traces, vídeos e capturas automáticas de erro ficam desativados para preservar o segredo exibido uma vez.

Essas evidências correspondem às versões e aos ambientes indicados. A entrega de e-mail e o acesso ao provedor hospedado, a aplicação de migrações no destino, a importação real e a troca da fonte operacional exigem conferência própria. [Roteiro de implantação e corte](operations.md)

## Dependências

Em 17/11/2026, `npm audit --json` registrou 13 avisos na árvore de desenvolvimento, sendo seis moderados e sete altos. Naquela data, `npm audit --omit=dev --json` informou zero vulnerabilidades. O exame da versão então instalada encontrou padrões glob fixos e nenhum caminho da aplicação hospedada que aceitasse um padrão fornecido pelo usuário ou executasse as ferramentas de desenvolvimento. O risco residual permanece nas ferramentas de desenvolvimento. Reavalie a árvore e o alcance dos avisos ao atualizar dependências. [Aviso de minimatch](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) · [Aviso de picomatch](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
