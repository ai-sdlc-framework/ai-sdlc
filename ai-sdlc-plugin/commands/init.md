---
name: init
description: Scaffold the .ai-sdlc configuration this release requires (keyring, review policy, reviewer set, agent role, pipeline) from one manifest. Re-run after a plugin update to add only what is new.
argument-hint: '[--non-interactive] [--force]'
allowed-tools: Bash
model: haiku
---

Scaffold the required consumer configuration. The list of required files lives
in one manifest (`pipeline-cli/src/config-manifest/manifest.ts`); the same list
drives the `/ai-sdlc execute` Step 1 preflight, `ai-sdlc doctor` and the
SessionStart config-version notice, so what init creates is exactly what those
check (AISDLC-910).

## Behavior

1. Creates every manifest entry that does not exist yet. Entries that need your
   input (the signing keyring, the pipeline provider) are prompted for;
   `--non-interactive` takes defaults (git remote, git email,
   `~/.ai-sdlc/signing-key.pub.pem`) or fails naming the entries it could not fill.
2. Generating your signing key is a step of init: run `/ai-sdlc init-signing-key`
   first, then init reads the public key it wrote.
3. Records `configVersion` in `.ai-sdlc/config-version.yaml`.
4. Re-running is a no-op for entries that exist (without `--force`). After a plugin
   update adds a required entry, re-running prompts only for that entry.

## Run

```bash
PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts}"
PLUGIN_SCRIPTS_DIR="${PLUGIN_SCRIPTS_DIR:-$(pwd)/ai-sdlc-plugin/scripts}"
PIPELINE_CLI_BIN="$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh")" || exit 1
node "$PIPELINE_CLI_BIN/cli-init.mjs" $ARGUMENTS
```

Commit the created files on a branch and merge them through a reviewed PR: the
verifier reads the keyring and review policy from the base branch.
