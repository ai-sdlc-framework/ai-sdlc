---
id: AISDLC-416
title: 'fix(compliance-audit): manifest self-sha two-pass + AC-8 integration test fixups + path validation (AISDLC-325 follow-up)'
status: To Do
labels: [fix, compliance, follow-up-aisdlc-325]
dependencies:
  - AISDLC-325
references: []
priority: high
permittedExternalPaths: []
blocked:
  reason: "Referenced files (compliance-audit.ts + .test.ts) ship via AISDLC-325 PR #651 — references will resolve after that merges. This is the follow-up to fix manifest self-sha + AC-8 integration test flagged by review."
---

## Description

AISDLC-325 shipped the RFC-0022 Phase 4 cli-compliance-audit export CLI. Three review findings need follow-up:

1. **Code-reviewer MAJOR**: manifest self-sha256 is stale. Computed from intermediate manifest form (before self-entry inserted), so `files[manifest.json].sha256` doesn't match the actual bytes inside the tarball. BundleHash tamper-detection still works (it excludes manifest.json), but downstream consumers verifying the manifest file against this sha256 get a false mismatch.

2. **Test-reviewer MAJOR**: AC-8 integration test claims "all 5 evidence kinds" but only 2 are actually produced — dsse-envelope excluded by 2026-Q1 mtime filter (today is outside), trusted-reviewers + access-control-changes excluded because tmpDir has no git history.

3. **Security-reviewer MINOR**: `--regime` CLI flag flows unvalidated into bundle filename (path-traversal vector if untrusted source).

## Acceptance criteria

- [ ] AC-1: manifest self-sha fix — two-pass approach: build final manifest without self-sha (set to empty string with comment), serialize, hash, inject. OR omit self-entry from `files[]` entirely (manifest references itself implicitly by being in the archive). Pick the approach that round-trips cleanly through `validateManifest`.
- [ ] AC-2: AC-8 integration test fixup — either extend period to include today (e.g. `2026-01-01..2099-12-31`), initialize a git repo in tmpDir for trusted-reviewers/access-control-changes collectors, OR downgrade the test description + assertions to accurately reflect which 2 of 5 kinds are tested.
- [ ] AC-3: `--regime` validation — assert `/^[A-Za-z0-9._-]+$/` at the yargs handler. Same regex for `manifestFilename`.
- [ ] AC-4: full test suite passes; coverage holds ≥80% on changed lines.

## Out of scope

- Adding symlink-realpath checks to `collectDsseEnvelopes` (security-reviewer minor — defense-in-depth; narrow attack vector since attestations/ is operator-write-only). File as separate follow-up if needed.
- Restructuring the tar writer or replacing the POSIX ustar implementation.

## Estimated effort

30-60 min. Mostly the manifest two-pass refactor + 1-2 test additions/corrections.
