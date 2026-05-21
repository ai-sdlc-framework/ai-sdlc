# Transcript Management

**RFC-0042 Phase 1 — AISDLC-383.1**

This runbook covers the lifecycle of reviewer subagent transcripts: what they are, where they live, how long to keep them, and how to GC or upload them to remote storage.

## What are transcripts?

Each reviewer subagent (code-reviewer, test-reviewer, security-reviewer, and their Codex variants) captures its full conversation to a JSONL file:

```
.ai-sdlc/transcripts/<task-id>/<reviewer-name>.jsonl
```

Every line is a structured event:

```json
{"role":"user","content":"...","timestamp":"2026-05-21T10:00:00.000Z","event":"prompt-received"}
{"role":"assistant","content":"...","timestamp":"2026-05-21T10:01:30.000Z","event":"verdict-formed"}
```

Fields:

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"user" \| "assistant" \| "tool" \| "tool_result"` | Speaker role |
| `content` | string | Text of the turn |
| `timestamp` | ISO-8601 string | When the event was emitted |
| `event` | string (optional) | Event type (`prompt-received`, `verdict-formed`, `tool-call`) |
| `toolName` | string (optional) | For `tool` events: the tool that was invoked |
| `harness` | string (optional) | Cross-harness events carry `"codex"` here |

## Why transcripts?

Transcripts are the proof-of-execution layer for RFC-0042's Merkle attestation design. The transcript's content is content-addressed (SHA-256 hash committed to `.ai-sdlc/transcript-leaves.jsonl`). The hash proves a real reviewer ran — forging it requires generating ~5-10K coherent tokens analyzing the specific diff, which costs as much as actually running the reviewer.

Transcripts are gitignored because:

1. They are large (typically 3-10KB per reviewer per PR)
2. They may contain PR diff content (sensitive internal code)
3. The cryptographic chain (Merkle leaves + root signature) is the durable artifact, not the raw transcript

## Default retention policy: 90 days

Per RFC-0042 OQ-1 resolution (2026-05-20): **90-day local retention**.

This aligns with:
- AWS CloudTrail default retention
- GitHub Actions log retention
- SOC 2 evidence-window minimum

The 90-day window covers the realistic incident-response window for forgery investigations. Beyond 90 days, the Merkle root (committed to `.ai-sdlc/transcript-leaves.jsonl`, never GC'd) proves the attestation existed — the raw transcript content is no longer available for spot-checks, but that is expected behavior (see RFC-0042 OQ-3: soft-fail on GC'd transcripts).

### Override per-repo

To extend retention, add to `.ai-sdlc/config.yaml`:

```yaml
# Retain transcripts for 1 year (SOC 2 full-year compliance)
retention:
  transcripts_days: 365
```

Valid values: any positive integer. Operators with HIPAA requirements should set `3650` (10 years). There is no maximum.

## GC: deleting old transcripts

Transcripts older than the retention window can be deleted. No built-in GC daemon is shipped in Phase 1 (AISDLC-383.1). The operator must run GC manually or via cron.

### Manual GC (bash one-liner)

Delete transcripts older than 90 days from the default local path:

```bash
find .ai-sdlc/transcripts/ -name "*.jsonl" -mtime +90 -delete
# Then prune empty task directories
find .ai-sdlc/transcripts/ -type d -empty -delete
```

To dry-run first (list what would be deleted):

```bash
find .ai-sdlc/transcripts/ -name "*.jsonl" -mtime +90 -print
```

### Cron GC (example)

Add to your system crontab or launchd plist to run GC daily at 03:00:

```cron
0 3 * * * find /path/to/repo/.ai-sdlc/transcripts/ -name "*.jsonl" -mtime +90 -delete && find /path/to/repo/.ai-sdlc/transcripts/ -type d -empty -delete
```

## Inspecting transcripts

Use the `cli-attestation` CLI:

```bash
# List all captured transcripts (all tasks)
node pipeline-cli/bin/cli-attestation.mjs transcripts list

# List transcripts for a specific task
node pipeline-cli/bin/cli-attestation.mjs transcripts list aisdlc-383.1

# JSON output for scripting
node pipeline-cli/bin/cli-attestation.mjs transcripts list --json
node pipeline-cli/bin/cli-attestation.mjs transcripts list aisdlc-383.1 --json
```

Example output:

```
Transcripts for task: aisdlc-383.1
(from /path/to/repo/.ai-sdlc/transcripts/)

TASK-ID                   REVIEWER                    EVENTS     BYTES  WELL-FORMED
-------------------------------------------------------------------------------
aisdlc-383.1              code-reviewer                    3      1024  yes
aisdlc-383.1              security-reviewer                2       640  yes
aisdlc-383.1              test-reviewer                    3       980  yes

Summary: 3 file(s), 8 event(s), 2644 bytes
```

### What "WELL-FORMED" means

`yes` — every line in the file parsed as valid JSON with the required `{role, content, timestamp}` fields.

`no (N malformed)` — N lines failed validation. This can happen if:
- A reviewer exited mid-turn (partial write)
- The transcript file was manually edited
- The reviewer agent used an unsupported event shape

Malformed transcripts can still be kept for forensic purposes. The Merkle leaf hash covers the entire file byte-content, so a malformed transcript will fail hash verification if it was supposed to be well-formed at sign time.

## Remote storage (opt-in)

For distributed teams where cross-machine spot-checks are needed, configure a remote storage URL in `.ai-sdlc/config.yaml`:

```yaml
# Remote storage for transcript upload/fetch
transcript_storage_url: "s3://my-bucket/ai-sdlc-transcripts"
```

Supported URL schemes (Phase 1 — planned, not yet implemented):

- `s3://bucket/prefix` — AWS S3 (requires `aws` CLI on PATH, ambient credentials)
- `gs://bucket/prefix` — Google Cloud Storage (requires `gsutil` on PATH)
- `https://` — HTTP PUT endpoint (operator-provided upload server)

When `transcript_storage_url` is configured, the slash command body will upload completed transcripts after each reviewer run. Spot-check (`cli-attestation spot-check <pr>`) will fetch from this URL instead of failing with "transcript GC'd."

**Note (Phase 1 — AISDLC-383.1):** Remote upload is not yet automated. The `transcript_storage_url` config key is reserved for Phase 2 (AISDLC-383.2+). Phase 1 captures transcripts to local disk only.

## Multiple operator keys + remote storage warning

When `.ai-sdlc/trusted-reviewers.yaml` contains more than one operator public key AND `transcript_storage_url` is not configured, the CLI will warn on first push:

```
[cli-attestation] WARNING: Multiple operator keys registered but transcript_storage_url
is not set. Cross-machine spot-checks will fail for GC'd transcripts.
Consider adding transcript_storage_url to .ai-sdlc/config.yaml.
```

This warning is informational (exit 0). It surfaces per RFC-0042 OQ-5 resolution.

## Spot-check on GC'd transcripts

Per RFC-0042 OQ-3 resolution (soft-fail): when `cli-attestation spot-check <pr>` is called and the transcript has been GC'd per the retention policy, the verifier returns:

```
Transcript GC'd per retention policy. Merkle proof valid; spot-check unavailable.
```

Exit 0. The cryptographic claim (Merkle root signed by operator key) remains valid. GC is not an attestation failure.

## Transcript file path reference

| Path | Description |
|------|-------------|
| `.ai-sdlc/transcripts/` | Root transcripts directory (gitignored) |
| `.ai-sdlc/transcripts/<task-id>/` | Per-task directory |
| `.ai-sdlc/transcripts/<task-id>/<reviewer>.jsonl` | Per-reviewer JSONL transcript |
| `.ai-sdlc/transcript-leaves.jsonl` | Merkle leaf index (committed, never GC'd — Phase 2) |

## Related runbooks

- [`docs/operations/emergency-bypass.md`](emergency-bypass.md) — `AI_SDLC_BYPASS_ALL_GATES=1` for gate-rewrite cutover
- [`docs/operations/reviewer-signing-key-runbook.md`](reviewer-signing-key-runbook.md) — per-reviewer key setup (AISDLC-380, being superseded by RFC-0042)
- [`docs/operations/merge-queue-rebase-recovery.md`](merge-queue-rebase-recovery.md) — rebase + re-sign recovery (being simplified by RFC-0042 Phase 2+)

## Phase plan

| Phase | Task | Status |
|-------|------|--------|
| Phase 1 | Transcript capture in reviewer subagents | AISDLC-383.1 (this runbook) |
| Phase 2 | Merkle leaf index + root computation | AISDLC-383.2 |
| Phase 3 | v6 envelope schema + signer | AISDLC-383.3 |
| Phase 4 | v6 verifier in `verify-attestation.yml` | AISDLC-383.4 |
| Cleanup | Delete v3/v4/v5 collectors, sub-attestation code | AISDLC-383.7 |
