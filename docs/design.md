# Produto e arquitetura

Carreira registra o que o proprietário sabe sobre cada oportunidade. Uma vaga salva pode receber uma confirmação de envio mais tarde. A evidência de um envio, a data de registro e a data do acontecimento têm campos próprios. Quando o dia é desconhecido, a aplicação conserva essa incerteza.

## Da candidatura à revisão

Hoje ajuda a decidir o que fazer em seguida. Em Vagas, o proprietário pode abrir um registro, acrescentar um retorno e dar prazo à próxima ação. As análises mostram os critérios do indicador, quantos registros têm informação suficiente e quais candidaturas compõem o resultado. Isso permite conferir um total a partir das evidências disponíveis.

O fechamento de um lote captura seus membros e a versão da revisão. Um retorno posterior continua associado à candidatura. Correções e retificações preservam a versão que o proprietário viu ao fechar o lote.

## Fluxo de dados

O navegador usa React, TypeScript e Vite. O React Router organiza as telas e o TanStack Query mantém consultas em memória durante a sessão autorizada. A área de análises carrega a biblioteca de gráficos sob demanda e oferece uma tabela para leitura por teclado e tecnologia assistiva.

Os adaptadores de desenvolvimento e de função hospedada compartilham o roteador em `server/`. Requisições humanas passam pela verificação do Supabase Auth e do proprietário configurado. Credenciais de agente têm escopos explícitos, expiração opcional e revogação. O servidor valida os comandos, confere a versão do registro e usa transações PostgreSQL. As políticas RLS restringem o acesso às linhas do proprietário.

As referências a currículos ficam como metadados. A importação de controles selecionados começa com uma prévia privada. A exportação JSON permite recuperar o histórico, incluindo a evidência de origem e as versões das revisões. Arquivos exportados contêm informações pessoais e ficam em armazenamento privado definido pelo proprietário.

## Verificação

Os testes usam candidaturas, contatos e serviços de autenticação sintéticos. A integração local usa PostgreSQL com os papéis reais da aplicação. O roteiro de navegador cobre fluxos de trabalho, navegação por teclado e estados de autenticação. A entrega de e-mails do provedor e o acesso no ambiente hospedado dependem de verificação própria. Consulte o [roteiro de verificação](verification.md) e o [guia de segurança](security.md).
