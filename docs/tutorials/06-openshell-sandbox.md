# Tutorial: Enabling OpenShell Sandbox Isolation

This tutorial walks through enabling [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox isolation for AI agent execution in your AI-SDLC pipeline.

## What You'll Get

When enabled, every agent execution runs inside a kernel-level sandbox with:

- **Filesystem isolation** — Landlock LSM restricts agent to declared paths only
- **Network isolation** — deny-by-default, only explicitly allowed endpoints reachable
- **Credential isolation** — secrets injected via OpenShell providers, never on filesystem
- **Process isolation** — agent runs as unprivileged `sandbox` user, cannot escalate
- **Autonomy-aware policies** — lower trust levels get stricter constraints

## Prerequisites

- Docker Desktop or Docker Engine v28.04+
- Linux kernel 5.13+ (for Landlock support; Ubuntu 22.04+ works)
- An existing AI-SDLC project (`ai-sdlc init` completed)

## Step 1: Install OpenShell

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

Verify the installation:

```bash
openshell --version
```

## Step 2: Set Up Credential Providers

Create providers for the API keys your agents need:

```bash
# For Claude Code
openshell provider create --name claude --type claude --from-existing

# For GitHub access
openshell provider create --name github --type github --from-existing
```

These providers securely inject credentials into sandboxes without exposing them on the filesystem.

## Step 3: Enable OpenShell in Your Pipeline

Set the `AI_SDLC_SANDBOX_PROVIDER` environment variable:

```bash
export AI_SDLC_SANDBOX_PROVIDER=openshell
```

That's it. The orchestrator will automatically:

1. Generate an OpenShell policy from your `AgentRole` constraints and `AutonomyPolicy` level
2. Create a sandbox with the policy before each agent execution
3. Spawn the agent inside the sandbox via `openshell sandbox connect`
4. Download results and destroy the sandbox after execution

## Step 4: Configure Network Access (Optional)

By default, the sandbox blocks all outbound network access at autonomy level 0. To allow specific endpoints, configure them in your pipeline code or environment:

```typescript
import { createOpenShellSandbox } from '@ai-sdlc/reference';

const sandbox = createOpenShellSandbox(exec, {
  workDir: '/path/to/repo',
  networkEndpoints: {
    anthropic: [{ host: 'api.anthropic.com', port: 443, access: 'full' }],
    github: [{ host: 'api.github.com', port: 443, access: 'read-write' }],
    npm: [{ host: 'registry.npmjs.org', port: 443, access: 'read-only' }],
  },
  autoProviders: [
    { name: 'claude', type: 'claude' },
    { name: 'github', type: 'github' },
  ],
});
```

## Step 5: GitHub Actions Setup

Add OpenShell to your CI workflow:

```yaml
- name: Install NVIDIA OpenShell
  run: |
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
    echo "$HOME/.local/bin" >> $GITHUB_PATH
  continue-on-error: true

- name: Run AI-SDLC pipeline
  env:
    AI_SDLC_SANDBOX_PROVIDER: openshell
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.AI_SDLC_PAT }}
  run: pnpm --filter @ai-sdlc/dogfood execute --issue ${{ github.event.issue.number }}
```

The `continue-on-error: true` on the install step ensures the pipeline gracefully falls back to the stub sandbox if OpenShell installation fails.

## How Autonomy Levels Map to Policies

The policy generator automatically adjusts strictness based on the agent's autonomy level:

| Level | Landlock | Network | Use Case |
|---|---|---|---|
| 0 (Observer) | `hard_requirement` | All blocked | New/untrusted agents |
| 1 (Junior) | `best_effort` | Configured endpoints only | Agents earning trust |
| 2+ (Senior) | `best_effort` | Full configured network | Proven agents |

Level 0 agents cannot make any network calls — they can only read and write to allowed filesystem paths. As agents earn trust and get promoted, the policy automatically widens.

## Monitoring

View sandbox activity in real-time:

```bash
# Stream all sandbox logs
openshell logs <sandbox-name> --tail

# Filter for denied requests (useful for debugging blocked operations)
openshell logs <sandbox-name> --tail --source sandbox | grep deny

# Launch the OpenShell terminal dashboard
openshell term
```

## Fallback Behavior

If OpenShell is not installed or fails to start, the orchestrator automatically falls back to the stub sandbox (no isolation). This means:

- Development machines without OpenShell work normally
- CI runners where installation fails still complete the pipeline
- The `isOpenShellAvailable()` check happens once at pipeline start

## Next Steps

- [Security API Reference](../api-reference/security.md) — Full OpenShell API documentation
- [Agent Runners](../api-reference/runners.md) — How sandbox prefixing works for each runner
- [Progressive Autonomy Tutorial](03-progressive-autonomy.md) — How autonomy levels work
