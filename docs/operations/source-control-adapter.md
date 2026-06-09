# Source-Control Adapter Selection

**Audience:** AI-SDLC adopters running on GitLab, self-hosted GitLab, or local-only (no remote) environments.
**Added in:** AISDLC-530 (config-driven SC resolution).

---

## Overview

By default, the AI-SDLC orchestrator uses the GitHub adapter for all source-control operations (creating branches, pushing, opening pull requests). As of AISDLC-530, adopters on GitLab or local-only environments can configure a different adapter via `adapter-binding.yaml` — without patching or forking the orchestrator.

Resolution order (first match wins):

1. `options.sourceControl` programmatic injection (testing / SDK usage).
2. The first `AdapterBinding` with `spec.interface: SourceControl` in `.ai-sdlc/`.
3. Default: GitHub (no binding → no regression for existing adopters).

---

## Configuration

Add an `AdapterBinding` resource to your `.ai-sdlc/` directory. The file can sit alongside your existing `pipeline.yaml`, `agent-role.yaml`, etc.

### GitHub (explicit, matches the built-in default)

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: github-source-control
spec:
  interface: SourceControl
  type: github
  version: 0.1.0
  config:
    org: my-org
    repo: my-repo
    token:
      secretRef: github-token   # resolved from process.env.GITHUB_TOKEN
```

### GitLab self-hosted

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: gitlab-source-control
spec:
  interface: SourceControl
  type: gitlab
  version: 0.1.0
  config:
    url: https://gitlab.internal.company.com    # omit for gitlab.com SaaS
    projectId: "group/subgroup/project"          # URL-encoded path or numeric ID
    token:
      secretRef: gitlab-token   # resolved from process.env.GITLAB_TOKEN
```

### GitLab SaaS (gitlab.com)

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: gitlab-source-control
spec:
  interface: SourceControl
  type: gitlab
  version: 0.1.0
  config:
    projectId: "my-namespace/my-project"
    token:
      secretRef: gitlab-token
```

### Local-only (no remote, development / CI-less environments)

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: local-source-control
spec:
  interface: SourceControl
  type: local
  version: 0.1.0
```

In local-only mode:

- `createBranch` is a passthrough (the git CLI creates the branch as normal).
- `git push` is skipped — the orchestrator detects the missing remote and logs a skip message rather than timing out against a remote API.
- `createPR` returns a sentinel `{ url: 'local', id: 'local', ... }` — no real PR is opened.
- The tracker "PR created" comment and Slack notification are suppressed (they would be misleading with no remote URL).
- `prUrl` in the pipeline result is set to `'local'` so callers can detect the skip.

---

## How auto-detection works

Even without an explicit `type: local` binding, the orchestrator degrades gracefully when there is no `origin` remote:

- **git fetch** (step 7) — skipped with a log message when `origin` is not configured. This was added in AISDLC-527.
- **git push** (step 12) — skipped with a log message when `origin` is not configured. Extended in AISDLC-530.

The two-phase detection means a pure local-only environment works without any `adapter-binding.yaml` — the pipeline runs the agent, commits locally, and skips the remote steps automatically.

---

## Token resolution

The `secretRef` field maps to a process environment variable via `resolveSecret()`:

| `secretRef` value | Environment variable |
|---|---|
| `github-token` | `GITHUB_TOKEN` |
| `gitlab-token` | `GITLAB_TOKEN` |
| `my-custom-ref` | `MY_CUSTOM_REF` (upper-cased, hyphens → underscores) |

---

## GitLab adapter — known gaps (AC #4)

The `reference/src/adapters/gitlab` adapter implements the full `SourceControl` interface as used by the pipeline:

| Method | Status |
|---|---|
| `createBranch` | Implemented (GitLab REST `POST /repository/branches`) |
| `createPR` | Implemented as `createMR` (GitLab `POST /merge_requests`) |
| `mergePR` | Implemented (GitLab `PUT /merge_requests/:iid/merge`) |
| `getFileContents` | Implemented |
| `listChangedFiles` | Implemented |
| `setCommitStatus` | Implemented |
| `watchPREvents` | Stub — returns an empty async iterable (no webhook listener) |

The `watchPREvents` stub means any pipeline stage that waits on MR events (e.g. an approval gate) will stall indefinitely in GitLab mode. File a follow-up task to add GitLab webhook support if you need real-time MR event streaming.

---

## Multiple SourceControl bindings

When multiple `AdapterBinding` resources with `spec.interface: SourceControl` are present, the **first** one in the config scan order wins. This is intentional — the pipeline has a single active remote, and supporting multiple SC adapters simultaneously (e.g. mirroring to both GitHub and GitLab) is out of scope for this release.

---

## Troubleshooting

**Pipeline times out against api.github.com on a local-only repo.**
Add a `type: local` binding or remove the `origin` remote. The auto-detection at the push step (`git push origin <branch>`) will then skip gracefully.

**GitLab `createPR` returns 404.**
Check that `projectId` is URL-encoded correctly. Numeric project IDs work without encoding; path-style IDs (`group/project`) must be URL-encoded (`group%2Fproject`) when passed as a path segment, but the adapter handles this automatically via `encodeURIComponent`.

**Token not resolved.**
Run `echo $GITLAB_TOKEN` to confirm the env var is set. The `secretRef: gitlab-token` maps to `GITLAB_TOKEN` (upper-cased, hyphens → underscores).
