# `backlog-drift check` reports false-positive `ref-deleted` for refs with URL fragments

**Affected version:** `backlog-drift@0.1.2` (latest as of 2026-05-01)
**Severity:** Medium — gate produces high noise-to-signal ratio that erodes operator trust in the tool

## Summary

`backlog-drift check` resolves task `references:` entries that contain URL fragments (`<path>#section`) by passing the entire string — fragment included — to `fs.statSync`. Since no file at `<path>#section` exists on disk, the tool reports `Referenced file no longer exists: <path>#section` even when `<path>` is present and unchanged.

In our repo (`ai-sdlc-framework/ai-sdlc`), this single bug accounts for ~70% of the 297 reported drift issues — every backlog task that legitimately references a section anchor in an RFC document trips the gate.

## Reproduction

1. Create a task with a fragment-bearing `references:` entry:

   ```yaml
   ---
   id: TEST-1
   title: Reproduction
   status: To Do
   references:
     - spec/rfcs/RFC-0011.md#52-ingress-shims
   ---
   ```

2. Ensure `spec/rfcs/RFC-0011.md` exists and is unchanged.
3. Run `npx backlog-drift check`.

**Expected:** no drift reported (the file exists; the fragment is a section anchor for human navigation).

**Actual:**
```
TEST-1 "Reproduction"
  ✗ Referenced file no longer exists: spec/rfcs/RFC-0011.md#52-ingress-shims
```

## Root Cause

`backlog-drift@0.1.2` `dist/index.js`:

```js
// dist/index.js:13115-13129
function checkDeadRefs(task, ctx) {
  const results = [];
  for (const ref of task.refs) {
    if (isRefIgnored(ref, ctx.config))
      continue;
    if (!ctx.git.fileExists(ref)) {                      // <-- ref is the full string, including #fragment
      results.push({
        taskId: task.id,
        taskTitle: task.title,
        type: "ref-deleted",
        severity: "error",
        message: `Referenced file no longer exists: ${ref}`,
        ref
      });
    }
  }
  return results;
}
```

```js
// dist/index.js:21598-21606
fileExists(filePath) {
  try {
    const fullPath = resolve3(projectRoot, filePath);    // resolves "spec/rfcs/RFC-0011.md#anchor" as a literal path
    statSync(fullPath);                                   // ENOENT — no file at that path on disk
    return true;
  } catch {
    return false;
  }
},
```

`extractRefs` (`dist/index.js:16898`) takes frontmatter `references:` verbatim with no normalization, so any URL-fragment-bearing entry flows through unchanged.

There is no fragment-stripping anywhere in the codebase (verified via `grep -nE '#|fragment|anchor|split.*#'` — only YAML-anchor handling matches, which is unrelated).

## Suggested Fix

Strip URL fragments before the file-existence check. The fragment is a navigation hint for humans (markdown anchor, code line range, query string), not part of the filesystem path.

Minimal patch in `checkDeadRefs` (or, more broadly, in `extractRefs` so the normalization is consistent across all checks that consume `task.refs`):

```js
function stripFragment(ref) {
  // Don't strip from URLs (http/https) — those should be checked differently anyway,
  // see secondary issue below. For local paths, the first '#' starts a fragment.
  if (/^https?:\/\//.test(ref)) return ref;
  const hashIdx = ref.indexOf('#');
  return hashIdx === -1 ? ref : ref.slice(0, hashIdx);
}

// in checkDeadRefs:
if (!ctx.git.fileExists(stripFragment(ref))) { ... }
```

Tests to add:
- `references: ['spec/rfc.md#section']` → no drift when `spec/rfc.md` exists
- `references: ['spec/rfc.md#L42-L88']` → same (line-range fragment)
- `references: ['spec/missing.md#section']` → drift reported (the file is genuinely missing — fragment shouldn't mask that)
- `references: ['#anchor-only']` → must still be flagged (no path component → invalid ref)

## Secondary issue (worth flagging, possibly out of scope)

`fileExists` also returns `false` for entries that are URLs (`https://...`), absolute paths outside the project root, or git-tree paths. If the intent is to support task references to external resources (e.g., a Linear ticket URL, an upstream issue link), those should be either skipped or checked with a different mechanism (HEAD request for URLs).

In our case this manifests as the remaining ~30% of drift reports — but those are mostly genuine filesystem stale references, so the URL-handling gap is less prominent. Worth handling alongside the fragment fix for consistency.

## Impact

After fixing this in `ai-sdlc-framework/ai-sdlc`'s local copy, drift count drops from 297 → ~90, and the `backlog-drift` CI gate becomes signal-bearing (real misses) instead of noise-bearing (mostly fragment false-positives).

## Environment

- `backlog-drift@0.1.2`
- Node 22 (Ubuntu 24.04 GitHub-hosted runner; reproduces on macOS 14 Node 22 locally)
- Tasks live under `backlog/tasks/*.md` and `backlog/completed/*.md`
- Task frontmatter parsed by `gray-matter` (per `dist/index.js:16927`)

Happy to land the fix as a PR if you confirm the suggested approach. Test fixtures already exist in the project's task corpus — the existing 297-issue baseline IS the regression test.
