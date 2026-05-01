# DoR (Definition-of-Ready) — operator notes

The DoR module (`pipeline-cli/src/dor/`) implements RFC-0011's
Definition-of-Ready rubric — a Stage A (deterministic) + Stage B
(LLM-backed) pipeline that decides whether an issue has enough context
to be admitted into the development pipeline. The bulk of the design is
in [`spec/rfcs/RFC-0011-definition-of-ready-rubric.md`](../../spec/rfcs/RFC-0011-definition-of-ready-rubric.md);
this doc captures operational concerns that don't belong in the RFC
(file paths, environment variables, hardening notes).

## Calibration log secret hygiene

Every refinement verdict is appended to a calibration log at
`$ARTIFACTS_DIR/_dor/calibration.jsonl` (default `./artifacts/_dor/...`).
The log captures the issue snapshot (id / source / title / body preview
or SHA), the full verdict (per-gate findings + clarifying questions),
and any ground-truth outcome so we can replay against new rubric
versions during weekly calibration spot-checks.

That makes the log a **secrets-adjacent surface**: if an author pastes
an API token into the issue body or title, it would otherwise land in
the JSONL on disk and — combined with the dogfood pipeline's
`git add -A` practice (per `feedback_stash_completely_before_pipelines.md`)
— could be committed into git history. AISDLC-122 layered three
defenses:

### 1. `.gitignore` for `artifacts/`

The repo-root `.gitignore` excludes `artifacts/` entirely. That covers
the default path AND every path resolved via the `$ARTIFACTS_DIR`
override that points anywhere inside the repo. Operators who set
`$ARTIFACTS_DIR=/tmp/...` are out of scope (writing to `/tmp` won't be
committed by `git add`).

### 2. Lower `BODY_INLINE_LIMIT` (500 → 80)

`pipeline-cli/src/dor/calibration-log.ts` previously inlined any issue
body up to 500 chars verbatim as `bodyPreview`. AISDLC-122 lowered the
threshold to 80 chars: long enough to disambiguate "the typo PR" from
"the auth bug" at a glance, but short enough that anything resembling
structured data (a token, a URL with auth params, a config blob) trips
the SHA-only branch. Bodies above 80 chars are persisted as a short
non-cryptographic checksum (`bodySha = cs_<8-hex>`) — keyed for
"same body, different rubric versions" grouping, not retrievable.

### 3. Regex redaction (`secret-redact.ts`)

`pipeline-cli/src/dor/secret-redact.ts` defines a `SECRET_PATTERNS`
registry and a `redactSecrets()` function that's called on every
secrets-adjacent string before the entry is serialised:

- Issue `title`
- Issue `bodyPreview` (when inlined)
- Per-gate `finding` and `clarificationQuestion` (LLM-derived; may
  quote the body verbatim)
- Top-level `summary` and `questions[]`

Pattern catalogue:

| Marker | Shape |
|---|---|
| `OPENAI` | `sk-[A-Za-z0-9]{20,}` |
| `OPENAI_PROJECT` | `sk-proj-[A-Za-z0-9_-]{20,}` |
| `GITHUB_PAT` | `ghp_[A-Za-z0-9]{36}` |
| `GITHUB_PAT_FINE` | `github_pat_[A-Za-z0-9_]{82}` |
| `AWS_ACCESS_KEY` | `AKIA[0-9A-Z]{16}` |
| `JWT` | `eyJ<base64url>.eyJ<base64url>.<base64url>` |
| `HIGH-ENTROPY` | `[A-Za-z0-9_-]{40,}` (catch-all, last) |

Matches are replaced with `[REDACTED:<marker>]`. The catch-all uses
`[REDACTED:HIGH-ENTROPY]` instead of pretending to know what it caught.
Pattern order matters: the more-specific entries (e.g. OpenAI's
`sk-proj-` variant) come BEFORE less-specific ones, and the
high-entropy catch-all is last so it only fires when no named pattern
matched.

The registry is exported from `@ai-sdlc/pipeline-cli/dor` so other
consumers (Slack digest, dashboard, shadow-mode tooling) can apply the
same redaction to any other surface that ingests issue text. Bump the
registry whenever a new credential format ships — false positives just
lose a literal value in the log, which is a much smaller cost than
leaking a real token.

### What this hardening does NOT defend against

- **Direct filesystem reads outside git.** A user who `cat`s
  `artifacts/_dor/calibration.jsonl` and pastes the contents into a
  Slack thread would still leak whatever the regex doesn't catch (e.g.
  a 30-char API token below the high-entropy threshold). The
  defense-in-depth answer is to scrub upstream — don't paste secrets
  into issues — and to rotate any token that may have entered the log.
- **Custom issue templates with structured secret fields.** If a
  template pre-populates an `Authorization:` header field with a token,
  the redactor only catches it when the token matches one of the known
  shapes. Add a registry entry for any new format.
- **Re-export to a non-AI-SDLC consumer.** A shadow-mode corpus exported
  for an external evaluator should be re-scrubbed with `redactSecrets()`
  before sharing — the calibration-log writer redacts at write time, but
  a downstream consumer might re-introduce raw text from a different
  source. Apply the same registry there.
