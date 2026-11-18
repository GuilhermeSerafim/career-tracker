# Career agent API

Use this API only to read and record the owner's authorized career work. It records reported actions; it does not send applications or recruiter messages, scrape URLs, execute SQL, provision resources, or monitor in the background. Obtain a credential through a private channel after owner issuance. Never put credentials in chat, documents, source control, logs, command arguments, or example files.

## Credential lifecycle

In Settings, the authenticated owner chooses a label, scopes and optional expiry. The browser creates a UUID and 32 random bytes, hashes those bytes with SHA-256, and sends only the hash and safe metadata. The token format is `ct_agent_<uuid>.<base64url-secret>`. The UUID is also the creation `clientId`; the displayed prefix is its first eight characters, unrelated to the secret.

The browser shows the complete token once, after confirmed creation. An uncertain 503 can repeat the exact body and key while the same authenticated screen remains open. Hiding it, navigating away, session expiry, logout, owner switch, reload or closing the tab discards the secret. **Discarding browser memory does not revoke a credential: creation may already have committed.** Reopen Settings, reconcile the label/ID/prefix with the owner-only catalog, explicitly revoke the old credential, and then issue a replacement. No server-side retrieval exists. Runtime memory is transient, not a claim of secure erasure from browser/process memory.

Owner-only `GET /api/v1/agent-credentials?limit=20` returns `{items,nextCursor}` with ID, version, label, prefix, scopes, expiry, revocation and creation timestamp. `limit` is 1–100; pass the opaque returned `cursor` for the next page. The catalog includes expired/revoked credentials, excludes hashes, and accepts no extra filters. Credential creation/revocation use the existing `/commands` operations; revocation requires the credential's current `expectedVersion`. Same creation `clientId` and intention do not create another credential, even under a new retry key.

## Scope map

| Scope | Allowed operations |
| --- | --- |
| `career:read` | GET applications (list/detail), contacts (bounded list/detail), today, analytics, batches (list/detail), review JSON, settings, resume-refs, health |
| `career:write` | `save_application`, `create_resume_ref`, `confirm_submission`, `update_application`, `record_event`, `correct_event`, `save_contact`, `save_task`, `complete_task`, `archive_application`, `restore_application`, `resolve_duplicate`, `invalidate_submission` |
| `career:reviews` | `close_review`, `revise_review` |
| `career:export` (optional) | GET exports with `format=json` or `format=csv`; selected review with `format=markdown` |

Each operation needs its own scope; write/reviews/export do not imply read. Review JSON does not imply Markdown export. `restore_application` only unarchives a career application; it grants no backup restoration capability. `start_cycle`, `update_settings`, credential management, imports (including preview/apply), restore preview, owner/schema management and provisioning remain owner-only. Unknown operations are closed. Inputs cannot supply ownerId, actor, source, SQL or alternative credentials.

Opaque token verification uses an exact-ID internal lookup for the configured owner under the maintenance gate, then a constant-length hash comparison including the missing-row path. Business transactions recheck expiry, revocation and the required current scope while holding a credential SHARE row lock. Revocation takes UPDATE: a transaction that acquired SHARE can finish before revocation; after revocation commits, later transactions fail. A previously authenticated object cannot bypass this check. Invalid/missing/expired/revoked credentials return generic 401, valid insufficient scopes return 403, and unavailable dependencies/maintenance return 503.

## CLI transport and retries

`npm run agent --silent` reads `CAREER_AGENT_TOKEN` and `CAREER_API_URL` from the private process environment. The URL is an HTTPS origin (loopback HTTP is allowed for local tests); redirects and URL credentials are rejected. Stdin is a UTF-8 JSON byte stream, up to 256 KiB. No positional command or credential arguments are accepted. A read takes `{ "method": "GET", "path": "/api/v1/contacts?limit=20" }`. A mutation takes `{ "command": { ... }, "idempotencyKey": "a-stable-intention-key" }`.

Preserve the complete JSON command, key and `expectedVersion` for an unchanged intention. On 503 or an uncertain network result, retry those same values. On 409, reread the relevant aggregate, compare changes, obtain an explicit corrected intention and use a new key/version; never blindly increment a version or generate new identities to bypass a conflict. 401 needs owner credential reconciliation; 403 needs an owner-approved scope decision. No retry happens automatically.

The CLI prints only bounded authorized results or a generic status/error, never raw headers or driver errors. It rejects output containing the current credential/token/secret hash instead of rewriting business history. The server excludes credential storage; opaque historical/source keys remain intact. Complete JSON exports are validated again, including manifest integrity. JSON escaping neutralizes terminal controls while preserving decoded multiline evidence/CSV, technology stacks and source/manifest hashes. Command evidence itself is sent unchanged. Keep output private because authorized business data remains private.

Windows PowerShell native pipelines may default to ASCII. Use a byte-safe pipe from an existing UTF-8 private command file, without putting credentials in arguments:

```js
// Local helper outside the repository; inherits the private environment.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-client.ts'], {
  windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'], env: process.env,
});
child.stdin.end(readFileSync(process.env.CAREER_COMMAND_FILE));
```

The integration suite exercises native process stdin bytes with accented Portuguese against real local HTTP/PostgreSQL. This guarantees that tested path, not arbitrary shell pipeline encoding.

## Recording workflow and fictional examples

1. **Resolve identity before confirming.** Read `/api/v1/applications?view=all&search=Empresa%20Fict%C3%ADcia`, follow pagination and read candidate details. Compare provider/tenant/job-code or verified aliases, track and application instance. Text similarity alone is insufficient. Existing matching identity uses its canonical application ID; new instance/alias decisions need evidence. Strong identity is also deduplicated atomically across browser/agent writers.
2. **Record the report faithfully.** Preserve the user's original evidence text, source and uncertain date. An unknown date is `{ "precision": "unknown", "value": null }`; never invent a date or change “reported” into “performed by the agent”. The following fictional command records a reported submission for an existing application after a current-version read:

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

3. **Create an internal next action.** `save_task` uses `target: {clientId}`, versioned `parents: {application,contact}` with at least one non-null parent, and `data: {title,dueDate}`. For example, title `Revisar retorno informado` and unknown dueDate create an internal task. Read optional contacts through `/contacts?limit=20` and `/contacts/<id>` before selecting them. A task is not a calendar notification or recruiter message.
4. **Classify a substantive response.** `record_event` uses a new `clientId`, the current application reference and `data` from `shared/model.ts`'s `eventFields`, with nullable evidence. A fictional reply inviting an interview can be `kind: "retorno_substantivo", state: "informado"`, unknown `occurredDate`, the literal reply in `sourceText`, nullable `resultText/scoreValue/scoreUnit`, and reported evidence. An automatic receipt is not a substantive response. Assessments/interviews can be recorded separately without counting a planned invitation as a completed event. Corrections use `correct_event` with reason and evidence, retaining history.
5. **Review the captured batch.** Read `/batches/<id>` and its prospective snapshot, population and gaps. `close_review` takes `batch:{id,expectedVersion}`, nullable narrative and an array of decisions. For an existing review, read its selected JSON version; `revise_review` also needs predecessorId, type (`revision` or `rectification`), reason and evidence. Explain the frozen population separately from later/external results. Optional private Markdown export needs `career:export`; browser saved-file confirmation adds no agent operation.

All IDs/evidence above are fictional and must be replaced only after an authorized read. Report completion only after a confirmed API result, using returned IDs/versions and what was recorded. Check `shared/commands.ts` for exact strict field contracts; unexpected fields fail validation. This document does not claim production credentials, a live Manager handoff or hosted deployment.
