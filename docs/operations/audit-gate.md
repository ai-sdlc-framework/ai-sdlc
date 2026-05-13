# Audit Gate — per-CVE advisory-ignore mechanism

**Status:** Active (AISDLC-264)
**Audience:** AI-SDLC operators and adopters managing the pre-push audit gate.
**Script:** `scripts/audit-with-ignores.mjs`
**Schema:** `spec/schemas/audit-ignores.schema.json`

---

## TL;DR

When `pnpm audit` finds a high-severity advisory with no upstream fix, you no longer need to
disable the gate or roll your own wrapper. Instead, add a time-bound entry to
`.audit-ignores.json`:

```json
[
  {
    "cveId": "CVE-2024-12345",
    "justification": "No upstream fix available as of 2026-05-13. Attack vector blocked by sandbox policy. Approved by @security-lead.",
    "expiresAt": "2026-08-13T00:00:00Z"
  }
]
```

Then call the script instead of bare `pnpm audit`:

```bash
node scripts/audit-with-ignores.mjs
```

- Exit 0: all high+ advisories are either absent or covered by non-expired ignore entries.
- Exit 1: one or more blocking advisories, OR at least one expired ignore entry.

---

## Why this exists

`pnpm audit --audit-level=high` is the canonical pre-push gate, but it has no built-in
exemption mechanism. When a transitive dependency publishes a high-severity advisory with no
fix available, adopters face a forced choice: disable the gate entirely, or pin to an
older (possibly less-secure) version. Both options leave no audit trail.

`audit-with-ignores.mjs` gives adopters a third path: a structured, time-bound exemption with
mandatory justification and an expiry that forces regular re-evaluation.

---

## How it works

1. Runs `pnpm audit --json` from the repo root.
2. Loads `.audit-ignores.json` (optional; treated as empty if absent).
3. Partitions ignore entries into *active* (expiresAt in the future) and *expired*
   (expiresAt in the past or present).
4. For each high+ advisory in the audit output:
   - If any of the advisory's CVE/GHSA identifiers matches an *active* ignore entry, the
     advisory is **suppressed** (it does not block the gate).
   - Otherwise the advisory is a **blocker** and the gate fails.
5. If any ignore entries have *expired*, the gate **also fails** — forcing the operator to
   either renew the entry or fix the underlying dependency.
6. Every run appends a structured JSON line to `$ARTIFACTS_DIR/_audit/audit.jsonl`.

---

## .audit-ignores.json

Place this file at the repo root. The JSON Schema is at
`spec/schemas/audit-ignores.schema.json`.

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `cveId` | string | yes | CVE identifier (`CVE-YYYY-NNNNN`) or GHSA identifier (`GHSA-xxxx-yyyy-zzzz`) as reported by `pnpm audit`. Must be an exact match. |
| `justification` | string | yes | Human-readable reason for the exemption. Should explain: (1) why no fix is available or applicable, (2) any compensating controls, and (3) who approved the exemption. Minimum 20 characters. |
| `expiresAt` | string | yes | ISO 8601 datetime after which this entry is no longer honoured. The gate fails if this date has passed, even if there are no new advisories. Recommended cadence: 30–90 days. |

### Example

```json
[
  {
    "cveId": "CVE-2024-12345",
    "justification": "Prototype-pollution in dep-x@1.2.3. Upstream fix not released as of 2026-05-13. Exploitation requires attacker-controlled input to JSON.parse, which our API gateway filters. Reviewed and approved by @security-lead.",
    "expiresAt": "2026-08-13T00:00:00Z"
  },
  {
    "cveId": "GHSA-xxxx-yyyy-zzzz",
    "justification": "ReDoS in regex-library@2.0.0. We control all inputs. No fix available; upstream issue #123 open. Approved by @security-lead.",
    "expiresAt": "2026-07-01T00:00:00Z"
  }
]
```

---

## CLI usage

```bash
# Default: reads .audit-ignores.json, threshold = high
node scripts/audit-with-ignores.mjs

# Custom ignores file
node scripts/audit-with-ignores.mjs --ignores path/to/my-ignores.json

# Lower threshold (include moderate+)
node scripts/audit-with-ignores.mjs --audit-level moderate

# Dry run: prints what would happen but exits 0 always
node scripts/audit-with-ignores.mjs --dry-run

# Override artifacts dir (default: .artifacts)
node scripts/audit-with-ignores.mjs --artifacts-dir /tmp/my-artifacts
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ARTIFACTS_DIR` | `.artifacts` (repo root) | Base directory for audit artifacts. Audit log is written to `$ARTIFACTS_DIR/_audit/audit.jsonl`. |

---

## Wiring into the pre-push hook

Replace the bare `pnpm audit --audit-level=high` call in `.husky/pre-push` (or your
project's equivalent) with the reference implementation:

```bash
# .husky/pre-push (excerpt)
node scripts/audit-with-ignores.mjs
```

---

## Expiry renewal runbook

When the gate fails because an ignore entry has expired:

1. **Re-evaluate the advisory.** Check whether an upstream fix is now available:

   ```bash
   pnpm audit --audit-level=high
   ```

2. **If a fix is available**, update the dependency and remove the ignore entry:

   ```bash
   pnpm update <package>[@<version>]
   # Remove the expired entry from .audit-ignores.json
   ```

3. **If no fix is available**, renew the entry with a new expiry date and updated
   justification:

   ```json
   {
     "cveId": "CVE-2024-12345",
     "justification": "Still no upstream fix as of 2026-08-13. Attack vector blocked by WAF rule #42 (confirmed by @security-lead). Next review 2026-11-13.",
     "expiresAt": "2026-11-13T00:00:00Z"
   }
   ```

4. **Commit the change** through normal PR flow so the renewal is reviewed and audited.

---

## Audit log

Every invocation appends a JSON line to `$ARTIFACTS_DIR/_audit/audit.jsonl`:

```json
{
  "timestamp": "2026-05-13T12:00:00.000Z",
  "minSeverity": "high",
  "advisoriesFound": 2,
  "blockers": 0,
  "suppressed": 2,
  "expiredIgnores": 0,
  "details": {
    "blockers": [],
    "suppressed": [
      {
        "ids": ["CVE-2024-12345"],
        "severity": "high",
        "title": "Prototype pollution in dep-x",
        "affectedPackage": "dep-x",
        "ignoredBy": "CVE-2024-12345",
        "ignoreExpiresAt": "2026-08-13T00:00:00Z",
        "justification": "No upstream fix. Attack vector blocked by API gateway."
      }
    ],
    "expiredIgnores": []
  }
}
```

The log is append-only. It provides a paper trail of which exemptions were active at each
push, suitable for security audits and compliance reviews.

---

## Integration with `ai-sdlc init`

When `ai-sdlc init --with-workflows` ships (AISDLC-261), the scaffold will include:

- A copy of `scripts/audit-with-ignores.mjs`
- A `spec/schemas/audit-ignores.schema.json` reference
- An empty `.audit-ignores.json` with a comment template
- The pre-push hook wired to call `audit-with-ignores.mjs`

Until then, copy the script directly from this repository.

---

## References

- AISDLC-264: implementation task
- `scripts/audit-with-ignores.mjs`: reference implementation
- `scripts/audit-with-ignores.test.mjs`: hermetic test suite
- `spec/schemas/audit-ignores.schema.json`: JSON Schema for `.audit-ignores.json`
- [`pnpm audit` documentation](https://pnpm.io/cli/audit)
