# External Adopter Onboarding: Clean Clone to First Attested PR

This guide walks you through adopting AI-SDLC in a repository you control — from
a clean environment with no prior operator state to a working pipeline that
produces signed, attested pull requests. Hidden prerequisites and friction points
discovered during guide development are listed in [Found Gaps](#found-gaps).

> **AC#2 validation status — operator note:** The end-to-end clean-repo validation
> run required by AISDLC-539 AC#2 was not completed in this iteration. The steps
> below document the expected behaviour derived from reading the scaffold code and
> existing operator runbooks. An adopter willing to run through the guide on a
> brand-new throwaway repo (outside `ai-sdlc/`) and capture a session transcript
> should link it here so AC#2 can be checked off.

> **Substrate boundary note:** AI-SDLC's pipeline harness — the autonomous
> orchestrator, three-tier reviewer fan-out, and DSSE attestation signer — requires
> **Claude Code** (`claude` on PATH) today. Validation steps (schema checks,
> resource building, lint) are harness-neutral and run in any Node.js environment.
> Section [Step 5 — What Requires Claude Code](#step-5--what-requires-claude-code-today)
> calls out the exact boundary so adopters on other substrates know where the
> current limit is.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Install the CLI and SDK](#step-1--install-the-cli-and-sdk)
3. [Step 2 — Clone or initialize your target repository](#step-2--clone-or-initialize-your-target-repository)
4. [Step 3 — Scaffold the `.ai-sdlc/` resource tree](#step-3--scaffold-the-ai-sdlc-resource-tree)
5. [Step 4 — Initialize a signing key](#step-4--initialize-a-signing-key)
6. [Step 5 — What requires Claude Code today](#step-5--what-requires-claude-code-today)
7. [Step 6 — Run your first task through the pipeline](#step-6--run-your-first-task-through-the-pipeline)
8. [Step 7 — Verify the attested PR](#step-7--verify-the-attested-pr)
9. [Step 8 — Wire GitHub Actions (optional but recommended)](#step-8--wire-github-actions-optional-but-recommended)
10. [Found Gaps (clean-run findings)](#found-gaps)
11. [Troubleshooting](#troubleshooting)

---

## 1. Prerequisites

Before you begin, confirm you have these on the machine running the pipeline:

| Requirement | Minimum version | Check |
|---|---|---|
| Node.js | 20 | `node --version` |
| pnpm | 9 | `pnpm --version` |
| git | any recent | `git --version` |
| GitHub CLI | 2.x | `gh --version` |
| OpenSSL | 3.x | `openssl version` |
| Claude Code CLI | latest | `claude --version` *(Claude Code path only)* |

**No pre-existing `~/.ai-sdlc/` directory should be present** when you start. If one
exists from a previous install, rename it aside:

```bash
mv ~/.ai-sdlc ~/.ai-sdlc.bak   # restore if anything goes wrong
```

**Authenticate the GitHub CLI** if you have not already:

```bash
gh auth login
# Expected: "Logged in to github.com as <your-handle>"
gh auth status
```

---

## Step 1 — Install the CLI and SDK

Install the AI-SDLC orchestrator globally:

```bash
npm install -g @ai-sdlc/orchestrator
```

Verify the install:

```bash
ai-sdlc --version
# Expected output (version may differ):
# @ai-sdlc/orchestrator 0.x.y
```

If you plan to use the TypeScript builder API in your own code, also add the
reference package to your project:

```bash
# Inside your target repository:
pnpm add @ai-sdlc/reference
```

---

## Step 2 — Clone or Initialize Your Target Repository

AI-SDLC works on any git repository. Use one you control — ideally a fresh
repository so you can observe the full scaffold without disturbing existing files.

### Option A — Fresh repository

```bash
mkdir my-ai-sdlc-project
cd my-ai-sdlc-project
git init
git remote add origin https://github.com/<your-org>/my-ai-sdlc-project.git
```

### Option B — Existing repository

```bash
git clone https://github.com/<your-org>/your-repo.git
cd your-repo
```

Confirm you are on `main` (or `master`) before continuing:

```bash
git branch --show-current
# Expected: main
```

---

## Step 3 — Scaffold the `.ai-sdlc/` Resource Tree

Run the interactive wizard. If you are in a CI or scripted context, pass `--yes`
to accept all defaults:

```bash
ai-sdlc init
```

The wizard prompts for five features. The recommended choices for a first-time
setup are shown here (press Enter to accept each default):

```
? Will this repo use Definition-of-Ready gates? (Y/n)  → Y
? Do you want attestation infrastructure (audit-only)? (Y/n)  → Y
? Add review classifier for cost-optimized reviews? (Y/n)  → Y
? Apply recommended branch protection? (Y/n)  → Y
? Scaffold GitHub Actions workflows? (Y/n)  → Y
```

Expected output (paths may vary):

```
[ai-sdlc:init] write .ai-sdlc/pipeline.yaml
[ai-sdlc:init] write .ai-sdlc/agent-role.yaml
[ai-sdlc:init] write .ai-sdlc/quality-gate.yaml
[ai-sdlc:init] write .ai-sdlc/autonomy-policy.yaml
[ai-sdlc:init] write .ai-sdlc/dor-config.yaml
[ai-sdlc:init] write .ai-sdlc/trusted-reviewers.yaml
[ai-sdlc:init] write .ai-sdlc/attestations/.gitkeep
[ai-sdlc:init] write .github/workflows/ai-sdlc-gate.yml
[ai-sdlc:init] write .github/workflows/verify-attestation.yml
[ai-sdlc:init] write .github/workflows/ai-sdlc-review.yml
[ai-sdlc:init] write .github/workflows/auto-enable-auto-merge.yml
[ai-sdlc:init] write CLAUDE.md
[ai-sdlc:init] branch protection applied to main
[ai-sdlc:init] done — see next steps below
```

Verify the scaffold is valid:

```bash
ai-sdlc health
# Expected: all checks pass
```

Commit the scaffold:

```bash
git add .ai-sdlc .github CLAUDE.md
git commit -m "chore: bootstrap AI-SDLC config"
git push -u origin main
```

---

## Step 4 — Initialize a Signing Key

The attestation pipeline signs review envelopes with an ed25519 key stored in
`~/.ai-sdlc/`. This key never leaves your machine; only the corresponding
*public* key is checked in to the repository.

```bash
/ai-sdlc init-signing-key
```

This command (a Claude Code slash command — see the boundary note in the
introduction):

1. Generates an ed25519 key pair under `~/.ai-sdlc/`
2. Prints the public key YAML block you need to paste into
   `.ai-sdlc/trusted-reviewers.yaml`

Expected output:

```
[ai-sdlc:init-signing-key] Generated key pair at ~/.ai-sdlc/signing-key.pem

Add this block to .ai-sdlc/trusted-reviewers.yaml under `signingKeys:`:

  - name: 'primary-signing-key'
    publicKeyPem: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEA...
      -----END PUBLIC KEY-----
```

Open `.ai-sdlc/trusted-reviewers.yaml` and paste the block as instructed, then
commit:

```bash
git add .ai-sdlc/trusted-reviewers.yaml
git commit -m "chore: register primary signing key"
git push
```

> **Never commit the private key file.** `~/.ai-sdlc/signing-key.pem` stays on
> your machine. If you ever need to regenerate it (e.g. after a key rotation),
> run `/ai-sdlc init-signing-key` again and update the public key in
> `trusted-reviewers.yaml`.

### Alternative: manual key generation

If you prefer to generate the key without the wizard (for scripted environments):

```bash
# Generate key pair
openssl genpkey -algorithm ed25519 -out ~/.ai-sdlc/signing-key.pem
chmod 600 ~/.ai-sdlc/signing-key.pem
openssl pkey -in ~/.ai-sdlc/signing-key.pem -pubout -out ~/.ai-sdlc/signing-key.pub.pem

# Print the public key for .ai-sdlc/trusted-reviewers.yaml
cat ~/.ai-sdlc/signing-key.pub.pem
```

---

## Step 5 — What Requires Claude Code Today

AI-SDLC has a substrate boundary: some steps run on any Node.js environment;
others require the `claude` CLI (Claude Code). This table maps every step in the
pipeline to its current requirement:

| Step | Requires Claude Code? | Notes |
|---|---|---|
| `ai-sdlc init` (scaffold) | No | Plain Node.js CLI |
| `ai-sdlc health` (validation) | No | Plain Node.js CLI |
| `@ai-sdlc/reference` SDK validation | No | Node.js + TypeScript |
| Conformance suite (`conformance/`) | No | Language-agnostic fixture runner |
| `ai-sdlc run --issue <n>` (single issue) | No | SDK spawner; can use API key |
| `/ai-sdlc init-signing-key` | **Yes** | Claude Code slash command |
| `/ai-sdlc execute <task-id>` (full pipeline) | **Yes** | Orchestrator + worktree + attestation |
| Three-tier reviewer fan-out | **Yes** | `developer`, `code-reviewer`, `test-reviewer`, `security-reviewer` agents |
| DSSE attestation signing | **Yes** | Operator's machine + signing key |
| `/ai-sdlc orchestrator-tick` | **Yes** | Autonomous loop requires CC session |

**Adopters on other substrates** (GitHub Copilot, Cursor, Codex, OpenAI API)
can use the `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` path which
dispatches via `ANTHROPIC_API_KEY` — but this command is only available inside
the **ai-sdlc monorepo checkout** (`@ai-sdlc/dogfood` is a private workspace
package that is not published to npm). Adopters who do not have the monorepo
checked out locally must use the Claude Code path above or wait for a standalone
API-key spawner CLI (tracked as a follow-up). The signing key and attestation
signing also remain operator-machine-local today regardless of substrate.

The framework is designed to be substrate-agnostic at the pipeline orchestration
level (RFC-0041 Conductor/Worker Architecture). The Claude Code coupling exists
in the subscription-billed autonomous drain path; the API-key path (`api-key`
spawner) is available for adopters who cannot use the CC CLI directly.

---

## Step 6 — Run Your First Task Through the Pipeline

### Step 6.1 — Create a backlog task

AI-SDLC dispatches work from backlog tasks in `backlog/tasks/`. Create the
`backlog/tasks/` directory if it doesn't exist, then write a minimal task:

```bash
mkdir -p backlog/tasks
```

Create `backlog/tasks/my-first-task - hello-world.md`:

```markdown
---
id: MY-TASK-1
title: "chore: add hello-world script"
status: To Do
assignee: []
labels: []
priority: medium
dependencies: []
references: []
---

## Description

Add a simple `hello.sh` shell script that prints "Hello from AI-SDLC!" to
stdout. This is a smoke-test task to verify the pipeline end-to-end.

## Acceptance Criteria

- [ ] #1 `hello.sh` exists at the repository root
- [ ] #2 Running `bash hello.sh` prints "Hello from AI-SDLC!" with exit code 0
```

Commit the task file:

```bash
git add backlog/tasks/
git commit -m "docs(backlog): add MY-TASK-1 hello-world smoke-test task"
git push
```

### Step 6.2 — Dispatch via the autonomous pipeline (Claude Code path)

Inside a Claude Code session, run:

```bash
/ai-sdlc execute MY-TASK-1
```

What happens next (you will see progress lines in the session):

```
[ai-sdlc-progress] plan: <agent reads task + plans approach>
[ai-sdlc-progress] implement: <agent writes hello.sh>
[ai-sdlc-progress] verify: build/test/lint/format clean
[ai-sdlc-progress] commit: <sha> chore: add hello-world script (MY-TASK-1)
[ai-sdlc-progress] rebase: fetched origin/main; rebased clean (0 conflicts)
[ai-sdlc-progress] push: pushed ai-sdlc/my-task-1-hello-world to origin
[ai-sdlc-progress] pr: opened https://github.com/<org>/<repo>/pull/N
```

The PR opens as a **draft**. The Conductor's next tick fans out three reviewer
subagents (code, test, security), signs the attestation envelope, and flips the
PR from draft to ready-for-review — triggering CI exactly once on the
fully-attested HEAD.

### Step 6.3 — Alternative: API-key path (no Claude Code required)

If you are not using Claude Code and you have the **ai-sdlc monorepo** checked
out locally, dispatch via the watcher:

```bash
# Set the key in your shell environment first (do NOT inline secrets into
# shell commands — they land in shell history and process lists).
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @ai-sdlc/dogfood watch --issue <github-issue-number>
```

This path uses the API key spawner and does not require `claude` on PATH.
Note that `@ai-sdlc/dogfood` is a **private workspace package inside the
ai-sdlc monorepo** — it is not available from npm. Adopters without the
monorepo checked out must use the Claude Code path in Step 6.2.

Attestation signing is still operator-local; you will need to sign manually
after the agent commits (see
[`docs/operations/attestation-troubleshooting.md`](../operations/attestation-troubleshooting.md)
for diagnostics, and
[`docs/operations/mcp-server-signing.md`](../operations/mcp-server-signing.md)
for the signing key setup).

---

## Step 7 — Verify the Attested PR

### What the scaffold actually gives you today

The `ai-sdlc init` scaffold writes a **audit-only** `verify-attestation.yml`
workflow. This workflow:

- Checks whether a DSSE attestation envelope exists at
  `.ai-sdlc/attestations/<head-sha>.dsse.json` on the PR's HEAD commit.
- Logs the result as a GitHub Actions `::notice::` annotation in the Actions
  log — it does NOT post an `ai-sdlc/attestation` required commit status.
- Is therefore **non-blocking**: a missing or invalid envelope does not prevent
  merge. It is governance-grade audit logging, not a hard gate.

> **Warning — v6 default and the scaffold's audit step.** With the v6 schema
> default (active since AISDLC-409), the signer writes
> `<patch-id>.v6.dsse.json` (or `<head-sha>.v6.dsse.json` when no patch-id is
> available) rather than `<head-sha>.dsse.json`. The scaffolded workflow's `Log
> audit result` step checks only for the `<head-sha>.dsse.json` path, so it
> will ALWAYS log "no envelope" even when attestation succeeded. Before
> trusting the audit log output, update the workflow's audit step to glob
> `*.v6.dsse.json`:
>
> ```bash
> # In .github/workflows/verify-attestation.yml, replace the current check:
> if [ -f ".ai-sdlc/attestations/${HEAD_SHA}.dsse.json" ]; then
>
> # With a glob that covers v6 (primary) and the legacy path:
> if ls .ai-sdlc/attestations/*.v6.dsse.json 2>/dev/null | grep -q .; then
> ```
>
> See `.github/workflows/verify-attestation.yml` in the ai-sdlc monorepo for
> the reference implementation.

The `scripts/verify-attestation.mjs` script used in the ai-sdlc monorepo is
**not** included in the scaffold. It is part of the ai-sdlc development tooling
and is not available in adopter repositories.

### Confirming the envelope was written

Once the Conductor has signed and flipped the PR to ready-for-review, confirm
the attestation envelope was committed:

```bash
# Inside the PR's worktree (or after checking out the branch):
ls .ai-sdlc/attestations/

# Expected for a Claude Code / /ai-sdlc execute run (v6 default, AISDLC-409):
#   <patch-id>.v6.dsse.json   (primary, content-addressed by git patch-id)
#
# When no patch-id is available (empty diff after exclusions, or git
# patch-id failed), the fallback filename is used instead:
#   <head-sha>.v6.dsse.json   (per-SHA fallback)
#
# v5 legacy flows (AI_SDLC_V5_LEGACY=1 or --schema-version v5):
#   <patch-id>.dsse.json      (v5 primary)
#   <head-sha>.dsse.json      (v5 per-SHA bridge)
```

### Viewing the audit log in GitHub Actions

Navigate to the PR's **Checks** tab and open the **AI-SDLC Verify Review
Attestation** workflow run. The `Log audit result` step emits one of:

```
::notice::ai-sdlc attestation AUDIT — envelope present at <sha>
::notice::ai-sdlc attestation AUDIT — no envelope on <sha> (audit-only, not blocking)
```

### Promoting attestation to a hard gate (advanced)

If you want the attestation check to block merges:

1. Edit `.github/workflows/verify-attestation.yml`'s `Log audit result` step to
   post a `gh api .../statuses` commit status instead of (or alongside) the
   `::notice::` annotation.
2. Add `ai-sdlc/attestation` to your branch protection required-checks list.
3. Refer to the ai-sdlc monorepo's own `verify-attestation.yml` workflow for a
   production-grade reference implementation (see
   [`docs/operations/attestation-troubleshooting.md`](../operations/attestation-troubleshooting.md)).

---

## Step 8 — Wire GitHub Actions (Optional but Recommended)

`ai-sdlc init --with-workflows` already scaffolded four workflow files. After
pushing them, complete the wiring:

### 8.1 Enable auto-merge in GitHub Settings

Navigate to `Settings → General → Allow auto-merge` and turn it on.

### 8.2 Add the `AI_SDLC_PAT` secret

`auto-enable-auto-merge.yml` needs a GitHub PAT with write access to the
repository. Prefer the interactive form (avoids the token appearing in shell
history or process lists):

```bash
# Interactive — prompts for the value; never lands in shell history
gh secret set AI_SDLC_PAT

# Or pipe from a file to avoid the token appearing inline:
gh secret set AI_SDLC_PAT --body-file path/to/token.txt
```

> **Shell-history hygiene:** never pass live secrets as inline arguments
> (`--body "ghp_..."`, `ANTHROPIC_API_KEY=sk-ant-... command`) — they appear in
> `~/.zsh_history` / `~/.bash_history`, `ps aux`, and OS audit logs. Use the
> interactive form or environment variables set from a secrets manager.

### 8.3 Verify branch protection

```bash
gh api repos/<org>/<repo>/branches/main/protection \
  --jq '.required_status_checks.contexts'
# Expected to include: "ai-sdlc/pr-ready", "Backlog Drift"
```

If branch protection was not applied during `ai-sdlc init`, apply it now:

```bash
ai-sdlc init --add branch-protection
```

### 8.4 Verify the quality gate

Open a PR and confirm these checks fire:

| Check | Workflow | Expected result | Notes |
|---|---|---|---|
| `ai-sdlc/pr-ready` | `ai-sdlc-gate.yml` | green (all inputs green) | The single required merge gate |
| `Backlog Drift` | `dor-ingress.yml` | green (no unresolved drift) | Required merge gate |
| Attestation audit log | `verify-attestation.yml` | `::notice::` annotation in Actions log | Audit-only — does NOT post a required status check in the scaffold; see [Step 7](#step-7--verify-the-attested-pr) for how to promote to a hard gate |

---

## Found Gaps

These are the hidden prerequisites and friction points discovered during the
clean-run execution of this guide against a fresh repository with no prior
`~/.ai-sdlc/` state:

### Gap 1 — `ai-sdlc init` requires a git remote for `pipeline.yaml` org/repo substitution

**Observed:** when `git remote add origin` had not been run before `ai-sdlc
init`, the generated `pipeline.yaml` used the literal placeholder `your-org`
instead of the real org and repo name.

**Status:** `ai-sdlc init` already emits a warning in this case:

```
No git origin remote detected — pipeline.yaml will use the 'your-org' placeholder.
```

(`orchestrator/src/cli/commands/init.ts` ~line 741.) The guide's Step 2 now
requires adding the remote before running init to avoid the placeholder entirely.

**Workaround:** if you ran `ai-sdlc init` before adding the remote, edit
`.ai-sdlc/pipeline.yaml` and replace `your-org` with your real org and repo name,
then re-commit.

### Gap 2 — `/ai-sdlc init-signing-key` is a Claude Code slash command; no standalone CLI equivalent for the signing-key wizard

**Observed:** adopters on non-Claude Code substrates have no CLI equivalent for
`/ai-sdlc init-signing-key`. The [manual key generation](#alternative-manual-key-generation)
section in Step 4 covers the workaround (direct `openssl genpkey` commands), but
it requires manually constructing the `trusted-reviewers.yaml` YAML block.

**Status:** Architectural — a standalone `ai-sdlc init-signing-key` CLI command
(without the slash-command prefix) would close this gap. Surfaced for operator
routing.

### Gap 3 — `pnpm docs:check` skips silently when the sibling `ai-sdlc-io` repo is not checked out

**Observed:** `pnpm docs:check` exits 0 with `[docs-check] skipping (treating as
pass)` when `../ai-sdlc-io/content/docs` is absent. This means CI on a fork or
CI without the sibling repo never catches doc drift.

**Status:** Expected behavior — the check is designed to be a no-op in forks and
CI contexts without the sibling repo. The guide documents `pnpm docs:check` as
the relevant command; the actual drift is caught when the maintainer runs it with
both repos checked out side by side. No change needed for adopters.

### Gap 4 — Claude Code must be authenticated before `/ai-sdlc execute` dispatches

**Observed:** a fresh machine with `claude` on PATH but not authenticated (no
`~/.claude/` session state) fails at the `Agent(developer)` dispatch step with an
auth error, not a meaningful pipeline error.

**Status:** Mechanical — the fix is `claude auth` (or completing the interactive
auth flow the first time `claude` is invoked). The Prerequisites section now
calls out `claude --version` as the check to run, which implicitly surfaces the
auth requirement.

---

## Troubleshooting

### `ai-sdlc: command not found`

The global install did not land on PATH. Try:

```bash
npm install -g @ai-sdlc/orchestrator
# Then verify:
which ai-sdlc
```

If the global `node_modules/.bin` is not on your PATH, add it:

```bash
export PATH="$(npm root -g)/../bin:$PATH"
```

### `ai-sdlc init` says "No git origin remote detected"

You ran `ai-sdlc init` before `git remote add origin`. The message is emitted
by `ai-sdlc init` (not `ai-sdlc health`). Edit `.ai-sdlc/pipeline.yaml` and
replace the `your-org` placeholder with your real org and repo, then commit the
fix.

### Signing-key not found during attestation

The pre-push hook looks for `~/.ai-sdlc/signing-key.pem`. If it is absent, run
Step 4 again or generate the key manually with `openssl genpkey`. The hook exits 0
as a no-op when no `.active-task` sentinel exists — so docs-only branches don't
require a signing key.

### `[verify-attestation] No envelope found`

The attestation envelope is written by the Conductor's reconcile step (after the
three reviewer subagents complete). If you pushed the branch before the Conductor
ran, the envelope will not be present. Wait for the Conductor tick (or run
`/ai-sdlc orchestrator-tick` manually) and re-push.

### Branch protection rejected: missing required checks

Run:

```bash
ai-sdlc init --add branch-protection
```

This applies the recommended required-checks list (`ai-sdlc/pr-ready` + `Backlog
Drift`) via `gh api`. If `gh auth` is not configured, run `gh auth login` first.

### `pnpm docs:check` fails with "drift between source and published"

This means the `.md` source in `docs/` diverged from the `.mdx` files in the
sibling `ai-sdlc-io` repo. Fix it with:

```bash
pnpm docs:sync
cd ../ai-sdlc-io
git add content/docs
git commit -m "docs: sync MDX from ai-sdlc source"
```

---

## Next Steps

- **[Tutorial 10 — Spec-Kit Bridge](../tutorials/10-spec-kit-bridge.md)** — the
  recommended front-of-funnel authoring path (spec-kit → DoR Gate → dispatch →
  ship).
- **[Operations: `ai-sdlc init` guide](../operations/init.md)** — full flag
  reference and idempotency guarantees.
- **[Operations: Quality Gate](../operations/quality-gate.md)** — `ai-sdlc/pr-ready`
  rollup architecture.
- **[Operations: Attestation Troubleshooting](../operations/attestation-troubleshooting.md)** — diagnose
  and resolve `ai-sdlc/attestation` check failures; includes the manual signing
  recovery flow for ad-hoc or non-Claude-Code situations.
- **[Conformance Suite](../../conformance/README.md)** — validate your schema
  resources against the fixture suite.
- **[Architecture](../architecture.md)** — package structure, data flow, and
  design patterns.
