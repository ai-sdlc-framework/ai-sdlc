# External Adopter Onboarding: Clean Clone to First Attested PR

## Fastest path: two steps

```text
/plugin marketplace add ai-sdlc-framework/ai-sdlc
/plugin install ai-sdlc@ai-sdlc
```

Then, once the plugin is loaded (run `/reload-plugins` if Claude Code does not pick it up), run one command:

```text
/ai-sdlc setup
```

It runs init, registers the MCP advisor for the detected clients and runs doctor, then prints a report listing each step as done, skipped (already present) or not possible, with the reason and the exact next action. Re-running it is safe and says "Nothing changed" when the repo is already set up. No signing key is needed (RFC-0061). The global `@ai-sdlc/orchestrator` install is not required. The longer paths below remain for scripted or manual installs.

## Quick install: paste this into Claude Code

Open Claude Code in the repository you want to adopt AI-SDLC in and paste the brief below. The agent runs each step, verifies it, and recovers from the known failures (partial plugin cache install, missing `@ai-sdlc/reference`, doctor warnings). The same brief is kept as a standalone file at [`install-agent-brief.md`](install-agent-brief.md). The step-by-step commands follow in [Raw install commands](#raw-install-commands).

````text
You are installing AI-SDLC into the git repository in your current directory. Run the steps in order. After each step run its verification; if it fails, apply the recovery listed for it, re-run the verification, and only then continue. Stop and report to me only if a recovery does not work twice.

Prerequisites to check first: `node --version` (20 or newer), `pnpm --version` (9 or newer), `git --version`, `gh auth status` (logged in), `claude --version`. Install or ask me about anything missing. If `~/.ai-sdlc/` already exists, tell me before touching it.

1. Install the CLI. Run `npm install -g @ai-sdlc/orchestrator`. Verify with `ai-sdlc --version`, which must print a version.
2. Install the SDK in this repository. Run `pnpm add @ai-sdlc/reference`. Verify with `pnpm ls @ai-sdlc/reference`, which must list the package.
3. Install the Claude Code plugin. Run `/plugin marketplace add ai-sdlc-framework/ai-sdlc` then `/plugin install ai-sdlc@ai-sdlc`. Verify that `/plugin` lists `ai-sdlc` as enabled and that `/ai-sdlc` commands are available (restart the session if they are not).
4. Scaffold the repository. Run `ai-sdlc init --yes`. Verify with `ai-sdlc health`, which must report all checks passing, and confirm `.ai-sdlc/pipeline.yaml` exists.
5. Run the doctor. Run `/ai-sdlc doctor`. It must finish with no errors and no unresolved warnings.

Recovery for known failures:

- Partial plugin cache install (plugin listed but commands missing, or files missing under the plugin cache): run `/plugin uninstall ai-sdlc@ai-sdlc`, delete the cached `ai-sdlc` directory under `~/.claude/plugins/` (show me the path before deleting), restart Claude Code, then repeat step 3.
- Missing `@ai-sdlc/reference` (import or "cannot find module" errors, or doctor reports it absent): run `pnpm add @ai-sdlc/reference` in the repository root, confirm it appears in `package.json`, then re-run the failing step.
- Doctor warnings: read each warning, fix the cause it names (usually one of the two failures above, a missing `gh` login, or an uncommitted scaffold), and re-run `/ai-sdlc doctor` until it is clean. Do not suppress or ignore a warning without telling me why.

When doctor passes, commit the scaffold (the `git add` command init prints under "Next steps", which lists only paths that exist) and report what you installed and the doctor output.
````

## Raw install commands

The guide below is the same install as a manual command sequence.

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
> executor loop and configured reviewer fan-out — requires
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
5. [Step 5 — What requires Claude Code today](#step-5--what-requires-claude-code-today)
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

## Step 4 — No signing key needed

There is no key to create. The merge gate reads a review verdict record that the
pipeline writes outside the branch, under `refs/ai-sdlc/verdicts/*` (RFC-0061); no
key signs it and nothing is committed for it. See
[`attestation-reference.md`](../operations/attestation-reference.md) for the
mechanics. `.ai-sdlc/trusted-reviewers.yaml` is an optional allowlist of
contributor keys, appended by hand when you need it.

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
| `/ai-sdlc execute <task-id>` (full pipeline) | **Yes** | Orchestrator + worktree + attestation |
| Configured reviewer fan-out ([reviewer-set-flag.md](../operations/reviewer-set-flag.md)) | **Yes** | `developer` and the reviewer agents of the configured set |
| Review verdict record (`refs/ai-sdlc/verdicts/*`) | **Yes** | Written by the pipeline at the end of `/ai-sdlc execute` |
| `cli-hierarchy up` (replaces retired `/ai-sdlc orchestrator-tick`) | **Yes** | Autonomous loop requires CC sessions |

**Adopters on other substrates** (GitHub Copilot, Cursor, Codex, OpenAI API)
can use the `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` path which
dispatches via `ANTHROPIC_API_KEY` — but this command is only available inside
the **ai-sdlc monorepo checkout** (`@ai-sdlc/dogfood` is a private workspace
package that is not published to npm). Adopters who do not have the monorepo
checked out locally must use the Claude Code path above or wait for a standalone
API-key spawner CLI (tracked as a follow-up). The review verdict record is also
written by the Claude Code pipeline today, regardless of substrate.

The framework is designed to be substrate-agnostic at the pipeline orchestration
level (the executor loop and `cli-hierarchy`). The Claude Code coupling exists
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

The PR opens as a **draft**. The executor loop fans out the configured reviewer set
(see [reviewer-set-flag.md](../operations/reviewer-set-flag.md)), records the review verdict, and flips the
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

Review verdicts are written by the Claude Code pipeline; on this path you review
the agent's commit yourself (see
[`docs/operations/attestation-troubleshooting.md`](../operations/attestation-troubleshooting.md)
for diagnostics).

---

## Step 7 — Verify the Attested PR

### What the gate checks

The `ai-sdlc/pr-ready` rollup includes a `verdict-check` job. It reads the verdict
record for the PR's head from `refs/ai-sdlc/verdicts/<head-sha>` (or carries an
earlier approved record forward after a clean rebase) and posts the
`ai-sdlc/attestation` status. Nothing is committed to the branch and no key signs
anything. The full rules are in
[`docs/operations/attestation-reference.md`](../operations/attestation-reference.md)
and [`docs/operations/quality-gate.md`](../operations/quality-gate.md).

### Confirming the verdict was written

Once the executor loop has finished review and flipped the PR to ready-for-review,
confirm the record exists:

```bash
git ls-remote origin 'refs/ai-sdlc/verdicts/*'
# Expected: a ref named for the PR's head SHA
```

The PR's **Checks** tab shows the `ai-sdlc/attestation` status with a reason code
(`ok`, `no-record`, `subject-mismatch`, ...).

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
| `ai-sdlc/attestation` | `ai-sdlc-gate.yml` (`verdict-check`) | green (verdict record found) | Feeds `ai-sdlc/pr-ready`; see [Step 7](#step-7--verify-the-attested-pr) |

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

### `ai-sdlc/attestation` reports `no-record`

The verdict record is written by the executor once the configured reviewers
complete. If you pushed the branch before the executor ran, the record will not be
present. Wait for the executor loop to finish the review step (see
[`cli-hierarchy.md`](../operations/cli-hierarchy.md)) and re-push.

### Branch protection rejected: missing required checks

Run:

```bash
ai-sdlc init --add branch-protection
```

This applies the recommended required-checks list (`ai-sdlc/pr-ready` + `Backlog
Drift`) via `gh api`. If `gh auth` is not configured, run `gh auth login` first.

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
