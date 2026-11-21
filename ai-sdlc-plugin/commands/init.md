---
name: init
description: Scaffold the .ai-sdlc configuration this release requires (review policy, reviewer set, agent role, pipeline) from one manifest. Re-run after a plugin update to add only what is new.
argument-hint: '[--non-interactive] [--force]'
allowed-tools: Bash
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; fixed output; no free prose; no retries beyond the caller cap"
---

Scaffold the required consumer configuration. The list of required files lives
in one manifest (`pipeline-cli/src/config-manifest/manifest.ts`); the same list
drives the `/ai-sdlc execute` Step 1 preflight, `ai-sdlc doctor` and the
SessionStart config-version notice, so what init creates is exactly what those
check (AISDLC-910).

## Behavior

1. Creates every manifest entry that does not exist yet. Entries that need your
   input (the pipeline provider) are prompted for; `--non-interactive` takes
   defaults (git remote) or fails naming the entries it could not fill.
2. Records `configVersion` in `.ai-sdlc/config-version.yaml`.
3. Re-running is a no-op for entries that exist (without `--force`). After a plugin
   update adds a required entry, re-running prompts only for that entry.

## Run

```bash
# >>> plugin-root preamble
unset PLUGIN_SCRIPTS_DIR
for _c in "${CLAUDE_PLUGIN_DIR:-}" "${CLAUDE_PLUGIN_ROOT}" "$(pwd)/ai-sdlc-plugin" "$(node -e 'const f=require("fs"),p=require("path"),r=(d)=>{try{return f.realpathSync(d)}catch(e){return d}};try{const g=JSON.parse(f.readFileSync(p.join(require("os").homedir(),".claude/plugins/installed_plugins.json"))).plugins,s=[];for(const k in g)if(k.startsWith("ai-sdlc@"))s.push(...g[k]);const o=[];for(let d=process.cwd(),u;u!==d;d=p.dirname(d)){u=d;for(const e of s)if(e.scope!="user"&&e.scope!="managed"&&e.projectPath&&r(e.projectPath)==d)o.push(e)}for(const e of s)if(e.scope=="user")o.push(e);console.log(o.find((e)=>f.existsSync(e.installPath)).installPath)}catch(e){}' 2>/dev/null)"; do
  [ -n "$_c" ] && [ -d "$_c" ] && PLUGIN_SCRIPTS_DIR="$_c/scripts" && break
done
[ -n "${PLUGIN_SCRIPTS_DIR:-}" ] || { echo "ERROR: plugin not found: set CLAUDE_PLUGIN_DIR or CLAUDE_PLUGIN_ROOT, or install it (see ~/.claude/plugins/installed_plugins.json)" >&2; exit 1; }
# <<< plugin-root preamble
PIPELINE_CLI_BIN="$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh")" || exit 1
node "$PIPELINE_CLI_BIN/cli-init.mjs" $ARGUMENTS
```

Commit the created files on a branch and merge them through a reviewed PR: the
review policy is read from the base branch.
