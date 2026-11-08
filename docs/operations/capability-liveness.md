# Capability liveness

**Audience:** operators and adopters who want to know when an optional, usually model-backed,
capability has quietly fallen back to its fallback path.
**Specified by:** `RFC-0049` section 9 (capability liveness), open question 7.

A capability is an optional function of the framework with a defined fallback, for example
the Definition-of-Ready stage B judgment or the capture triage classifier. Each one is
declared once in code with an id, the RFC that specified it, what its fallback does, and how
to enable it. When a capability runs it reports one outcome:

| Outcome | Meaning |
| --- | --- |
| `live` | It produced its real result and the caller used it. |
| `shadow` | It produced its real result and the caller did not use it. |
| `degraded` | It took the fallback path; the reason is recorded. |

Reports are counted in `$ARTIFACTS_DIR/_capabilities/state.json` (default
`.ai-sdlc/artifacts/_capabilities/state.json`). A capability with no record is
`never-observed`, which is treated as `degraded`. Reporting never changes the result of the
call it describes.

## Declaring required capabilities

List the capabilities you expect to be live in `.ai-sdlc/capabilities.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: CapabilitiesConfig
metadata:
  name: capabilities
spec:
  required:
    - dor.stage-b
```

The file is read from the base branch (`origin/main`) only, never from the working tree, so a
pull request cannot relax the declaration it is governed by. With no file, or an empty list,
nothing changes. `ai-sdlc init` scaffolds a starter at `.ai-sdlc/templates/capabilities.yaml`.

## What happens when a required capability is not live

- **Doctor.** `ai-sdlc doctor` runs the `capability-liveness` check. It prints a table of
  every registered capability with its status and counts. The check is `fail` when a required
  capability is `degraded` or `never-observed`, `warn` when one is in `shadow`, and `pass`
  otherwise (including when no file is declared).
- **Decision.** The orchestrator tick files one Decision per degraded required capability
  (scope `capability:<id>`), at most once per UTC day, and none while an earlier Decision for
  that capability is still open. It also emits a `CapabilityDegraded` event when it files.
- **Nothing is blocked.** No tick refuses to dispatch and no pull request check fails because
  a capability is degraded. If filing the Decision throws, the tick carries on.

## Clearing it

Answer the Decision with one of two options:

1. **Wire the capability.** Configure a model backend for the judgment layer (see
   [`judgment-layer.md`](judgment-layer.md)) and leave the capability enabled. Its next run
   reports `live` and the Decision stops recurring.
2. **Drop the requirement.** Remove the id from `spec.required` and merge the change to the
   default branch. The fallback keeps running and the check stops covering it.

A capability reports `shadow` while its judgment runs in shadow mode; promote it as described
in [`judgment-promotion.md`](judgment-promotion.md).

## Reading the state

`ai-sdlc doctor` is the supported view. To inspect the raw file, read
`.ai-sdlc/artifacts/_capabilities/state.json`; it holds only ids, counts, timestamps and short
reason strings.

See also [`doctor.md`](doctor.md) and [`fail-soft-at-the-adopter-boundary.md`](fail-soft-at-the-adopter-boundary.md).
