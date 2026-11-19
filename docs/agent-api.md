# API para agentes de carreira

Use a API para consultar e registrar o trabalho de carreira autorizado pelo proprietário. O aplicativo registra ações informadas. Envio de candidaturas, mensagens a recrutadores, coleta de portais, execução de SQL, provisionamento e monitoramento em segundo plano ficam fora da integração. As tarefas registradas são internas ao aplicativo.

## Emissão e revogação

Em **Conta → Configurações → Acesso do agente**, o proprietário escolhe o nome, os escopos e uma expiração opcional. O navegador gera um UUID e 32 bytes aleatórios. Envia o SHA-256 do segredo e os metadados necessários. O token tem o formato `ct_agent_<uuid>.<base64url-secret>`. O UUID também é o `clientId` da criação. O prefixo exibido contém os oito primeiros caracteres do UUID.

A tela exibe o token completo uma vez após a criação confirmada. Guarde-o no armazenamento privado do agente. Mantenha-o fora de chats, arquivos de exemplo, documentos, Git, logs e argumentos de comandos. Se a emissão ficar incerta e a mesma tela autenticada continuar aberta, use **Repetir mesma criação** para reenviar o mesmo corpo e chave. Ocultar, navegar, recarregar, sair da conta, expirar a sessão, mudar de proprietário ou fechar a aba encerra a exibição. A credencial pode continuar ativa. Para recuperar o acesso do agente, releia o catálogo, confira nome, ID e prefixo, revogue a credencial anterior e emita outra. A aplicação não recupera o segredo para exibição posterior.

`GET /api/v1/agent-credentials?limit=20` é exclusivo do proprietário e devolve `{items,nextCursor}`. Cada item inclui ID, versão, nome, prefixo, escopos, expiração, revogação e data de criação, mesmo se a credencial estiver revogada ou expirada. O limite vai de 1 a 100. Use `cursor` com o valor opaco devolvido para avançar. O catálogo exclui hashes e aceita apenas esses parâmetros. `create_agent_credential` e `revoke_agent_credential` usam `/commands`. A revogação requer o `expectedVersion` atual da credencial. Repetir a criação com a mesma intenção e `clientId` mantém a credencial existente, inclusive sob nova chave HTTP.

## Escopos

| Escopo | Operações autorizadas |
| --- | --- |
| `career:read` | Consultar candidaturas e contatos por lista ou ID, Hoje, análises, lotes e revisões em JSON, configurações, referências de CV e saúde. |
| `career:write` | `save_application`, `create_resume_ref`, `confirm_submission`, `update_application`, `record_event`, `correct_event`, `save_contact`, `save_task`, `complete_task`, `archive_application`, `restore_application`, `resolve_duplicate`, `invalidate_submission`. |
| `career:reviews` | `close_review` e `revise_review`. |
| `career:export` | Exportar em `format=json` ou `format=csv` e baixar a revisão selecionada com `format=markdown`. Conceda somente quando necessário. |

Cada escopo é independente. `restore_application` restaura um registro arquivado. A administração de credenciais, `start_cycle`, `update_settings`, a prévia e a aplicação de importação e a prévia de recuperação exigem sessão do proprietário. A aplicação de recuperação exige manutenção local separada. O servidor determina a identidade do proprietário, o ator e a origem da operação. O comando só aceita os campos do contrato. [Rotas e permissões](http-api.md) · [Comandos compartilhados](../shared/commands.ts)

A autenticação consulta a credencial exata do proprietário configurado e compara o hash em tempo constante. A transação de negócio revalida validade, escopo e revogação sob lock compartilhado na linha da credencial. Uma transação que já obteve esse lock pode terminar antes da revogação. Após o commit da revogação, as transações seguintes falham. Credencial ausente, inválida, expirada ou revogada recebe 401 genérico. Escopo insuficiente recebe 403. Indisponibilidade ou manutenção recebe 503.

## Cliente local e repetição segura

`npm run agent --silent` lê `CAREER_AGENT_TOKEN` e `CAREER_API_URL` do ambiente privado do processo. Use uma origem HTTPS. HTTP em loopback serve para teste local. O cliente recusa redirects, credenciais na URL e argumentos posicionais. Envie um JSON UTF-8 de até 256 KiB pela entrada padrão. Uma consulta pode ser `{ "method": "GET", "path": "/api/v1/contacts?limit=20" }`. Uma gravação usa `{ "command": { ... }, "idempotencyKey": "a-stable-intention-key" }`. Em HTTP direto, envie o comando como corpo de `POST /api/v1/commands`, `Content-Type: application/json`, a chave no cabeçalho `Idempotency-Key` e a credencial em `Authorization` no formato Bearer. [Cliente local](../scripts/agent-client.ts) · [Contrato HTTP](http-api.md)

- Em 503 ou falha de rede com resultado incerto, repita a chave, o payload e todos os valores de `expectedVersion` do pedido original. O servidor recupera a resposta confirmada se a transação tiver sido gravada.
- Para uma intenção alterada, use nova chave. Em 409, releia os registros e suas versões, compare o que mudou e reaplique só as alterações autorizadas a partir dos valores atuais, com nova chave. Preserve as identidades dos registros já criados.
- Em 401, confira a credencial com o proprietário. Em 403, confirme o escopo necessário com ele. O cliente não repete pedidos automaticamente.

Nas criações com `clientId`, o mapeamento é único por proprietário, tipo de entidade e `clientId`. Ele vale entre atores e chaves HTTP. O mesmo conteúdo resolve a criação existente, enquanto conteúdo diferente para o mesmo `clientId` retorna 409. Preserve o `clientId` e a `Idempotency-Key` no retry do mesmo pedido. Se houver conflito de criação, releia o registro existente e use seu ID e sua versão nas atualizações autorizadas. Gere outro `clientId` só para uma criação realmente nova.

A saída contém resultados autorizados e limitados ou um erro seguro. Ela rejeita resultados com o token atual ou com o hash do segredo e valida novamente a integridade de exportações JSON completas. A codificação JSON protege o terminal e preserva, após decodificar, quebras de linha, acentos e hashes. O texto de evidência segue inalterado. Guarde a saída em local privado.

Pipelines nativos do PowerShell podem usar ASCII. Para enviar os bytes de um arquivo de comando UTF-8 privado, use um helper local como este. O processo herda as credenciais do ambiente.

```js
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-client.ts'], {
  windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'], env: process.env,
});
child.stdin.end(readFileSync(process.env.CAREER_COMMAND_FILE));
```

## Rotina com dados fictícios

1. **Conferir a identidade.** Consulte `/api/v1/applications?view=all&search=Empresa%20Fict%C3%ADcia`, inclua arquivados com `filters` igual ao JSON `{"archived":"include"}` codificado na URL, percorra a paginação e leia os resultados plausíveis. Compare provedor, tenant e código ou alias verificado, trilha e ocorrência da candidatura. Use o ID canônico quando houver correspondência. Alias ou nova ocorrência exigem evidência. Semelhança de empresa e cargo pede conferência.
2. **Confirmar um envio informado.** Preserve o texto da evidência, sua origem e a precisão da data. O exemplo registra um relato de envio para uma candidatura fictícia após leitura da versão atual.

```json
{
  "idempotencyKey": "fictional-confirm-v3",
  "command": {
    "operation": "confirm_submission",
    "application": { "id": "00000000-0000-4000-8000-000000000101", "expectedVersion": 3 },
    "submittedDate": { "precision": "unknown", "value": null },
    "cycleRelation": "unknown",
    "evidence": { "clientId": "00000000-0000-4000-8000-000000000201", "kind": "relato_usuario", "originalText": "Relato fictício: enviei minha candidatura; não lembro o dia.", "source": null, "occurredDate": { "precision": "unknown", "value": null }, "privateRef": null, "localRef": null }
  }
}
```

3. **Registrar uma próxima ação.** `save_task` recebe `target: {clientId}`, `parents: {application,contact}` com pelo menos um pai e as versões relevantes e `data: {title,dueDate}`. Um exemplo é `Revisar retorno informado` com prazo desconhecido. Leia o catálogo `/api/v1/contacts?limit=20` e consulte `/api/v1/contacts/<id>` antes de vincular um contato.
4. **Registrar um retorno ou etapa no mesmo processo.** `record_event` recebe novo `clientId`, referência atual da candidatura, `data` conforme `eventFields`, incluindo `data.evidence`, que pode ser `null`. Uma resposta de recrutamento que convida para entrevista pode usar `kind: "retorno_substantivo"`, `state: "informado"`, ocorrência desconhecida e a resposta em `sourceText`. Sem valores informados, `resultText`, `scoreValue` e `scoreUnit` recebem `null`. Um recibo automático tem sua própria categoria. Registre avaliações, entrevistas ou resultados separadamente conforme a evidência. Use `correct_event` com motivo e evidência para corrigir um evento. A atualização de etapa preserva o processo e a contagem do envio.
5. **Revisar um lote.** Leia `/api/v1/batches/<id>` e confira membros, população e lacunas. `close_review` usa `batch: {id,expectedVersion}`, `narrative` com texto ou `null` e a lista `decisions`. Para criar uma nova versão, encontre a revisão mais recente no lote, releia seu JSON em `/api/v1/reviews/<id>` e use o ID dela em `predecessorId`. `revise_review` exige também o tipo `revision` ou `rectification`, motivo e evidência. Ao relatar o resultado, identifique a população congelada e os resultados posteriores ou externos. Com `career:export`, exporte em `/api/v1/reviews/<id>?format=markdown` a versão selecionada, que pode ser histórica.

Substitua os dados fictícios pelos IDs e valores obtidos em leitura autorizada. Só confirme a conclusão após uma resposta de sucesso, indicando os IDs e versões retornados e o que foi registrado. [Campos de evento e datas](../shared/model.ts) · [Dicionário de dados](data-dictionary.md)
