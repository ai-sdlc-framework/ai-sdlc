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
- Operator-supplied `notes` (free-form annotation field)

Pattern catalogue (registry order — specific BEFORE generic so the
more-meaningful marker wins):

| Marker | Shape | Notes |
|---|---|---|
| `ANTHROPIC` | `sk-ant-(?:api03\|admin01)-[A-Za-z0-9_-]{20,}` | Anthropic API + admin keys (AISDLC-126) |
| `OPENAI_PROJECT` | `sk-proj-[A-Za-z0-9_-]{20,}` | Project-scoped OpenAI keys |
| `OPENAI` | `sk-[A-Za-z0-9]{20,}` | Classic OpenAI keys |
| `SLACK` | `xox[abprs]-[A-Za-z0-9-]{10,}` | Bot/user/refresh/app/legacy tokens (AISDLC-126) |
| `STRIPE_LIVE_SECRET` | `sk_live_[A-Za-z0-9]{20,}` | Stripe secret keys (AISDLC-126) |
| `STRIPE_LIVE_PUBLISHABLE` | `pk_live_[A-Za-z0-9]{20,}` | Stripe publishable keys (AISDLC-126) |
| `STRIPE_WEBHOOK` | `whsec_[A-Za-z0-9]{20,}` | Stripe webhook signing secrets (AISDLC-126) |
| `GCP_API_KEY` | `AIza[0-9A-Za-z_-]{35,}` | GCP API keys, ≥ 39 chars (AISDLC-126; greedy `{35,}` AISDLC-128) |
| `SENDGRID` | `SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}` | SendGrid 3-segment dotted keys (AISDLC-126) |
| `TWILIO_SID` | `AC[a-f0-9]{32,}` | Twilio account SIDs (AISDLC-126; greedy `{32,}` AISDLC-128) |
| `MAILGUN` | `key-[a-f0-9]{32,}` | Mailgun v1 API keys (AISDLC-126; greedy `{32,}` AISDLC-128) |
| `GITHUB_PAT_FINE` | `github_pat_[A-Za-z0-9_]{82,}` | Fine-grained GitHub PATs (greedy `{82,}` AISDLC-128) |
| `GITHUB_PAT` | `ghp_[A-Za-z0-9]{36,}` | Classic GitHub PATs (greedy `{36,}` AISDLC-128) |
| `AWS_ACCESS_KEY` | `AKIA[0-9A-Z]{16,}` | AWS access key IDs (greedy `{16,}` AISDLC-128) |
| `PRIVATE_KEY_BLOCK` | `-----BEGIN (?:RSA \| EC \| OPENSSH \| DSA \| PGP )?PRIVATE KEY( BLOCK)?-----...` | PEM-encoded private-key blocks (AISDLC-128) |
| `JWT` | `eyJ<base64url>.eyJ<base64url>.<base64url>` | Three-segment JWTs (second-segment `eyJ` anchor is intentional — AISDLC-128) |
| `HIGH-ENTROPY` | `(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{48,}` | Catch-all, last (raised 40 → 48 + require ≥1 digit AISDLC-128) |

Matches are replaced with `[REDACTED:<marker>]`. The catch-all uses
`[REDACTED:HIGH-ENTROPY]` instead of pretending to know what it caught.
Pattern order matters: the more-specific entries (e.g. OpenAI's
`sk-proj-` variant) come BEFORE less-specific ones, and the
high-entropy catch-all is last so it only fires when no named pattern
matched.

The redactor is **idempotent** by construction: every marker contains
characters (`[`, `:`, `]`) that are NOT in any pattern's character
class, so `redactSecrets(redactSecrets(s)) === redactSecrets(s)` for
every registered shape (asserted in `secret-redact.test.ts`). This
matters when the same string flows through multiple redaction surfaces
(e.g. the calibration log writer + a downstream Slack-digest re-redact)
— the marker is stable across passes.

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

## Composition with the dependency graph (RFC-0014 Phase 3)

The DoR clarification comment + calibration log gain optional
blast-radius surfacing when `AI_SDLC_DEPS_COMPOSITION` is ON. Behind
that flag the comment template appends "this issue gates N downstream
tasks" callouts (or a separate maintainer-tone FYI for `dor-bypass`-
admitted high-radius tasks per RFC-0014 §12 Q5), and the calibration
log gains a `blastRadius` field so the soak loop can distinguish
false-positives on graph leaves (low cost) from false-positives on
chain roots (high cost).

When the flag is OFF, the comment + log shapes match the RFC-0011
baseline byte-for-byte.

See [`pipeline-cli/docs/deps.md`](./deps.md#phase-3--dor-composition-aisdlc-1673-rfc-0014-6) for:

- The two comment templates (standard + bypass FYI).
- The `--blast-radius` flag on `cli-dor-corpus`.
- The `dor-config.yaml` `blastRadiusThreshold` knob.
- The library API for stitching snapshot → verdict → comment → log.
