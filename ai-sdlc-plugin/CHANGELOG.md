# Changelog

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.9.2...ai-sdlc-plugin-v0.10.0) (2026-05-18)


### Features

* **orchestrator:** rfc-0016 phase 5 — per-class bias + 3-state token + pr-comment (AISDLC-283) ([#522](https://github.com/ai-sdlc-framework/ai-sdlc/issues/522)) ([c76c443](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c76c44303e248b671fef2b344f61aa9e9d71b9d8))
* **pipeline-cli:** RFC-0035 Phase 1 — Decision resource schema + cli-decisions {list, show, add} (AISDLC-285) ([#504](https://github.com/ai-sdlc-framework/ai-sdlc/issues/504)) ([019cdfe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/019cdfe265a3301580c003c06a792d6e1ef89c03))


### Bug Fixes

* **ci:** prevent stale-envelope accumulation across queue rebases (AISDLC-274) ([#490](https://github.com/ai-sdlc-framework/ai-sdlc/issues/490)) ([e78b0a0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e78b0a029972c3ade9f5adce1d8624675e7ea7e1))
* make /ai-sdlc execute portable to adopter projects (AISDLC-272) ([#482](https://github.com/ai-sdlc-framework/ai-sdlc/issues/482)) ([98b5a51](https://github.com/ai-sdlc-framework/ai-sdlc/commit/98b5a51b0a386daf7128f251797a354b71df345d))
* **orchestrator:** init auto-yields to defaults in non-TTY contexts (AISDLC-263) ([#472](https://github.com/ai-sdlc-framework/ai-sdlc/issues/472)) ([cf8996d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf8996d53425ca8f101355d1c01b38efa34dfb9e))
* **orchestrator:** resume-from-draft stale verdict + verdict shape + degenerate retry (AISDLC-355) ([#527](https://github.com/ai-sdlc-framework/ai-sdlc/issues/527)) ([117f4b9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/117f4b9f33b23b3df4c4ffdea6aa32c43a6416fb))

## [0.9.2](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.9.1...ai-sdlc-plugin-v0.9.2) (2026-05-12)


### Bug Fixes

* **plugin:** kill Stop-hook infinite loop in deferred-coverage-check ([#456](https://github.com/ai-sdlc-framework/ai-sdlc/issues/456)) ([e9cc422](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e9cc422fe971bbc305c6c8dfe789dbc5c7a7978f))

## [0.9.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.9.0...ai-sdlc-plugin-v0.9.1) (2026-05-11)


### Bug Fixes

* **plugin:** re-add pipeline-cli runtime dep + ship check-orchestrator-state.sh ([#453](https://github.com/ai-sdlc-framework/ai-sdlc/issues/453)) ([be4ef47](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be4ef477002c069c3aa72ce29d1436be10b43183))

## [0.9.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.8.1...ai-sdlc-plugin-v0.9.0) (2026-05-11)


### Features

* add per-file-delta contentHashV3 to attestation predicate (AISDLC-101) ([563d9fc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/563d9fc612193adbed4c0f4bfaa56ad58b5d184a))
* add pipelineVersion to attestation predicate (AISDLC-100.6) ([6ac0ac9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ac0ac9dc1d4416276a7ae0e5f1a8e32b00c4aae))
* add Stage B LLM-evaluator + composite Stage A+B refinement reviewer (AISDLC-115.3) ([27a596f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27a596f1c8cfdb1f1b12495d4cb1454cd4c6142f))
* add Step 0.5 to auto-sync untracked parent task files (AISDLC-217) ([#370](https://github.com/ai-sdlc-framework/ai-sdlc/issues/370)) ([473856c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/473856ce66b2d469b2096d67bf5c56701f1209e5))
* **ci:** add RFC docs-drift gate (AISDLC-69.3) ([57e9c69](https://github.com/ai-sdlc-framework/ai-sdlc/commit/57e9c697067f174791004327ec768237b9516f44))
* **ci:** ci-side attestor signs attestations after reviewer approval (AISDLC-87) ([83b69cf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/83b69cf113440e776ed018300c03c503a69e871f))
* **ci:** cost-savers — skip CI reviewers on valid attestation + budget circuit breaker (AISDLC-147) ([136dae8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/136dae894f927f32303d0fe84e7c636894eb7407))
* **ci:** open PR as draft, sign envelope before ready (1 CI run per PR) (AISDLC-218) ([#376](https://github.com/ai-sdlc-framework/ai-sdlc/issues/376)) ([23d7e54](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23d7e54e1add058855bce398d4fc65b4ad1d2802))
* **ci:** pre-push hook auto-signs attestation when verdicts exist (AISDLC-133) ([2b5dfd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2b5dfd6894a752c378c24e251e41fa89d94f4d3e))
* Codex harness adapter + Step 2 slug fallback (AISDLC-202.2) ([#402](https://github.com/ai-sdlc-framework/ai-sdlc/issues/402)) ([767f5f3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/767f5f329c4df331fd196d7483b91652a1625683))
* **deps:** cli-deps dependency graph + dispatch frontier integration (AISDLC-117) ([dd5230f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dd5230f74f5a6d164eb31a50fc8f42523db50465))
* **deps:** incremental review — skip/delta when contenthash unchanged (AISDLC-142) ([2f85444](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2f85444a129602d5552c35a007331daa515dab02))
* **deps:** rfc-0014 phase 5 — soak corpus aggregator + hybrid promotion runbook (AISDLC-167.5) ([61189d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/61189d896538919f21752a4392409a744d691f90))
* **deps:** rfc-0015 phase 3 — pre-dispatch filter chain (AISDLC-169.3) ([1aecbcf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1aecbcf95048dfcd54631b50c83229c31b9a18b4))
* **deps:** wire conditional review classifier into Step 7 (AISDLC-141) ([69ba3d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/69ba3d7a2d65f9704f3d92e4473c487388cc9763))
* execute-orchestrator subagent for first-class parallel runs (AISDLC-82) ([206b3ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/206b3cae781a002cb72ebe6ae70f1f3889c53270))
* **mcp-advisor:** add Codex reviewer subagents for cross-harness review (AISDLC-247) ([#412](https://github.com/ai-sdlc-framework/ai-sdlc/issues/412)) ([b245a34](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b245a3406b89309e1738d369b3ff3601761c677b))
* **mcp-advisor:** add Pattern-C-aware task_create tool (AISDLC-234) ([#411](https://github.com/ai-sdlc-framework/ai-sdlc/issues/411)) ([d200323](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d20032392346756c80a9617efde39436b3928728))
* migrate dogfood watch CLI to executePipeline() from pipeline-cli (AISDLC-100.5) ([361cbb1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/361cbb1fdc099c26723c507d36991a2124fe2d93))
* nag on stale plugin version at session start (AISDLC-89) ([6278d0c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6278d0c9f7b990ad5db6c853a4082a799a7c1466))
* **orchestrator:** add DispatchabilityFilter for dispatchable:false frontmatter (AISDLC-243) ([#413](https://github.com/ai-sdlc-framework/ai-sdlc/issues/413)) ([8b93759](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b9375993336ec4e1c5d2f83c0e33d64619cb3b8))
* **orchestrator:** dor bypass + 3-round escalation (AISDLC-115.7) ([9af3ed3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9af3ed355082ed57df0ade0d1461f00834255fef))
* **orchestrator:** dor metrics + slack digest (AISDLC-115.6) ([421255b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/421255bb74af8f8a90140a3c558b605e17127ea7))
* **orchestrator:** inline spawner consumer bridge for /ai-sdlc orchestrator-tick (AISDLC-225) ([#390](https://github.com/ai-sdlc-framework/ai-sdlc/issues/390)) ([c5e5e3a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c5e5e3a1958a586379331af674737a64cdbc41c5))
* **orchestrator:** resume from interrupted runs (AISDLC-242) ([#415](https://github.com/ai-sdlc-framework/ai-sdlc/issues/415)) ([b063657](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b063657f62c9082d5af795caba18a1e10ebde301))
* **orchestrator:** rfc-0011 phase 4 — definition-of-ready composition (AISDLC-115.5) ([6c0e997](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c0e9977f52405bb5d333b8e4e65d79f2f720715))
* **orchestrator:** self-heal parent repo state at Step 0 (AISDLC-137) ([eed5f39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eed5f3977ff64f00a996ef251871c4af882c7cd2))
* **orchestrator:** step 3 auto-cleans stale branches in autonomous mode (AISDLC-224) ([#377](https://github.com/ai-sdlc-framework/ai-sdlc/issues/377)) ([35892f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/35892f5275eb97af622f6529d549d762a45c5826))
* **pipeline-cli:** make publishable as @ai-sdlc/pipeline-cli npm package (AISDLC-245.1) ([#442](https://github.com/ai-sdlc-framework/ai-sdlc/issues/442)) ([a2f527a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2f527a9752e315577d4d17142047ca8f422c3dd))
* **plugin:** slash commands resolve paths via CLAUDE_PLUGIN_DIR (AISDLC-245.4) ([#443](https://github.com/ai-sdlc-framework/ai-sdlc/issues/443)) ([990ee52](https://github.com/ai-sdlc-framework/ai-sdlc/commit/990ee5279949dc0f9d93da4274edcb114e75e9ab))
* pre-push hook auto-closes backlog tasks; retire backlog-task-complete.yml (AISDLC-220) ([#372](https://github.com/ai-sdlc-framework/ai-sdlc/issues/372)) ([5d344fb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5d344fba7ce876691a6e380a64c7c6fe5e7f29ee))
* pre-sign rebase + conditional re-review at Step 10.5 (AISDLC-102) ([ff3d904](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ff3d90479f79b2019709d0ccaa70306e2cdbd1af))
* prevent CI-skip magic tokens from disabling workflows (AISDLC-88) ([1550d4b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1550d4b694871d76dc63345e860d5dfebd08be6a))
* rebase-resolver subagent + /ai-sdlc rebase command (AISDLC-105) ([0122951](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0122951bf5cd073a371cea5cb8ea6c40a4d48621))
* respect Pattern C — route MCP backlog writes to active worktree (AISDLC-216) ([#365](https://github.com/ai-sdlc-framework/ai-sdlc/issues/365)) ([c60ffbe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c60ffbe58039dd0357abaf75aa9b47e43d5dae23))
* **spec:** attestation harness context + Codex finalization via MCP task_complete (AISDLC-202.3) ([#414](https://github.com/ai-sdlc-framework/ai-sdlc/issues/414)) ([c994a1b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c994a1bb476ddb9cee35de6c20b6d3bb01250f91))
* **spec:** developer subagent — rebase onto main before push (AISDLC-168) ([164f88c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/164f88c6e66f095c6c1b7e3bbe5126f8de50acac))
* **spec:** make pipeline.yaml canonical; deprecate pipeline-backlog.yaml (AISDLC-245.5) ([#444](https://github.com/ai-sdlc-framework/ai-sdlc/issues/444)) ([281d139](https://github.com/ai-sdlc-framework/ai-sdlc/commit/281d1397400778f7dd90ff78ad24197303b6643f))
* **spec:** strengthen developer subagent prompt — push + PR are required, not optional (AISDLC-164) ([b7f2ef3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b7f2ef325386c29519379b75659a3864fb4ef7f6))
* verifier Phase 3 — require contentHashV3, bump schema to v3 (AISDLC-103) ([4602edf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4602edf92cc24d12fa90167b52ff31a95247eaf8))
* wrap pipeline-cli step functions as MCP tools (AISDLC-100.3) ([cf0b330](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf0b330e6d52147018bbd1bd50dabe2d975d1be3))


### Bug Fixes

* add publishConfig.access=public to mcp-server (lost from main somehow) ([9559375](https://github.com/ai-sdlc-framework/ai-sdlc/commit/95593759dbea1ef3eb356bef27e8ba049b6f641b))
* add rebase-tolerant contentHash to attestation predicate (AISDLC-94) ([feb5259](https://github.com/ai-sdlc-framework/ai-sdlc/commit/feb52591f66de353193c9d7c9111ce4b3f9e7137))
* address reviewer feedback for AISDLC-105 ([1246cca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1246ccab6c13522f108c390a076f87d2ee21c3a1))
* address reviewer feedback for AISDLC-88 ([9090700](https://github.com/ai-sdlc-framework/ai-sdlc/commit/909070056ef6b7fc359eea12f497e5445aa71a68))
* address reviewer feedback for AISDLC-94 dual-hash ([957e1f3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/957e1f344d9d2b5691fd3ca98d39bc82bd581376))
* address reviewer feedback for orchestrator fix (AISDLC-90) ([fb6fd08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fb6fd08fb4b88c05c831a027a18d9236e39c9fec))
* address round-3 reviewer feedback for AISDLC-88 ([b00b106](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b00b106bff8d0443e1fe853635ebb92536361cce))
* also remove agent-Stop hook from .claude-plugin/plugin.json (review feedback) ([ada3f15](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ada3f15ec860bebf0e31bde815060f5f033b63bb))
* build pipeline-cli before bundling MCP server ([d379a68](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d379a68a3e2ebfde90ce5adb4ec72fa0ac1e62fe))
* **ci:** slash command body's slug + preflight bugs that block dispatch on long-titled tasks ([#332](https://github.com/ai-sdlc-framework/ai-sdlc/issues/332)) ([491aef9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/491aef92124ad9a4af80b9bd3e16d8395072c0c1))
* **deps:** incremental-review marker requires trusted author (AISDLC-142 round 2 — CRITICAL) ([eedc0df](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eedc0df5ef42d546b87fe72135e715efdf72c765))
* execute-orchestrator tool declarations (AISDLC-90) ([b580ecb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b580ecb9f84b6ab0e545a507a270ef7b84c29b4c))
* **orchestrator:** enforce dev subagent JSON contract with one retry on parse failure (AISDLC-176) ([28bc0ea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/28bc0eae3dd9ecd3f7fc967d4e57e64cfbd92825))
* **orchestrator:** preserve unknown frontmatter fields in backlog task editor (AISDLC-73) ([a1a840e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a1a840eb7035959386778c7bed598bc301a2a279))
* **orchestrator:** track in-flight dispatches to prevent concurrent re-dispatch (AISDLC-179) ([df274e1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/df274e18a06a6969fa5d3c116fa2a13cc1a286a3))
* **orchestrator:** worktree mutex serializes git ops to prevent .git/config.lock races (AISDLC-241) ([#409](https://github.com/ai-sdlc-framework/ai-sdlc/issues/409)) ([1d0184b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1d0184b8aef246b68feba52e7b7b1178c60ef786))
* per-worktree active-task sentinel for parallel /ai-sdlc execute (AISDLC-81) ([443e8e7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/443e8e7926c02c6ad333ad3f1d804bbd687ff741))
* resolve MCP project root via env-var + cwd-fallback (AISDLC-99) ([fa3244e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fa3244ec2d5cb8b28693d0814b7303b80f408935))
* sweep squash-merged worktrees via --state all query (AISDLC-204) ([#349](https://github.com/ai-sdlc-framework/ai-sdlc/issues/349)) ([714606c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/714606c6334c53a38b0b48356e3da056cd154e4e))


### Reverts

* move /ai-sdlc execute pipeline back inline (AISDLC-98) ([6a15473](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6a1547336e74ea81d98f3fad0f12faff33f19be6))

## [0.8.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.8.0...ai-sdlc-plugin-v0.8.1) (2026-04-30)


### Bug Fixes

* address reviewer feedback for orchestrator fix (AISDLC-90) ([529d22c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/529d22c5e4162d1a95b8e1af9d2c1ee975aa0667))
* execute-orchestrator tool declarations (AISDLC-90) ([c27f769](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c27f7690cdf3c9511859b08c19e81a215df5155b))

## [0.8.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.7.1...ai-sdlc-plugin-v0.8.0) (2026-04-29)


### Features

* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* **ci:** ci-side attestor signs attestations after reviewer approval (AISDLC-87) ([bcc811d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcc811d10981e01275066ec235f5ff146b1b8927))
* execute-orchestrator subagent for first-class parallel runs (AISDLC-82) ([e48a7cd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e48a7cd9ca33905a891377fa48931b7003ba3c46))
* harden plugin hooks for coverage, turbo, and .env ([a688dc5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a688dc55c268244a37b066f577022d8159a0eb71))
* **orchestrator:** /ai-sdlc execute slash command for backlog tasks ([f0ddaa1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f0ddaa1794034b7519b52040e2ff3ad86c927930))
* **orchestrator:** cryptographic review attestations for skip-duplicate-CI (AISDLC-74) ([a120071](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a120071720d91545c51b6c91b05a3ffb223d2cf5))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** subagentStart governance + write/edit blocked-path enforcement ([7fbe49b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7fbe49b09f86fe1397fbf3a3c59c65700c9052f3))
* rewrite fix-pr skill to chain cli-fix-ci + cli-fix-review ([e03241c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e03241c4863de661cf23cc0af4f08fe443867db7))
* rewrite review skill to invoke cli-review ([71a6cf0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/71a6cf00a0d12a920e63baf197e1044dcb87a550))
* rewrite triage skill to use RFC-0008 admission composite ([28d26a8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/28d26a899160b85a3ec6d294c58d85e27e7a5f21))
* triage skill renders provenance + quality flags ([324de6b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/324de6b496a22c608099148c75b9a777b389276e))


### Bug Fixes

* bundle ai-sdlc-plugin mcp-server + commit dist/bin.js (AISDLC-75) ([2251558](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2251558c555edb2d1bf66671bdc683bd6f01cfad))
* coverage hook skips gracefully when @vitest/coverage-v8 not installed ([ee5f86f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ee5f86fa4c4f5d915332a664dbfbcb233caf7c03))
* coverage hook uses test:coverage script instead of passing --coverage flag ([4c35ebd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c35ebdb32806292d862d392c225d0f0da9fb2ed))
* **orchestrator:** active-task sentinel file (env vars don't propagate mid-session) ([1fafb58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1fafb58d1a3900c7d3cb6ecb3b9464f631bb16b5))
* **orchestrator:** preserve unknown frontmatter fields in backlog task editor (AISDLC-73) ([6744997](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6744997a8f56c2651c88d279333c765749bc7c8d))
* **orchestrator:** schema-validate attestation predicate + sanitize GITHUB_OUTPUT (AISDLC-74) ([09ccaf3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09ccaf3c66709ae93af06a59d3cfbe617a7281e4))
* per-worktree active-task sentinel for parallel /ai-sdlc execute (AISDLC-81) ([8c6bb4f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8c6bb4f86515a2353d2a7c52e3e60315190f26fb))
* plugin install fixes, quality gate false positives, gitignore deduplication ([cf84f09](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf84f09cf93aabd8e22acc5e0262a4ed22d4e4e0))

## Changelog

All notable changes to the AI-SDLC Claude Code plugin (`ai-sdlc-plugin/`) are
documented in this file. The plugin version is tracked in `plugin.json`.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
with entries grouped under a release heading or `Unreleased` while in flight.

## Unreleased

### Added

- **Pipeline step functions exposed as MCP tools** (`ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.ts`)
  — RFC-0012 Phase 3. Each Step 0-13 function from `@ai-sdlc/pipeline-cli`
  (AISDLC-100.1) is now wrapped as an MCP tool named
  `pipeline_step_<N>_<name>` (`pipeline_step_0_sweep`,
  `pipeline_step_1_validate`, …, `pipeline_step_13_cleanup`) so the
  `/ai-sdlc execute` slash command body can invoke each phase via
  `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_step_<N>_<name>` instead of
  shelling out to the `ai-sdlc-pipeline` CLI binary inline. Each tool's
  input schema mirrors the corresponding `Options` interface; each tool's
  output is the structured `Result` type JSON-serialised inside an MCP
  `text` content item. Step 9 (the iteration loop — the only step that
  needs an LLM dispatch boundary) lazily resolves the production
  `defaultSpawner()` from `@ai-sdlc/pipeline-cli/runtime` (AISDLC-100.2 —
  `ShellClaudePSpawner` if `claude` is on PATH, `ClaudeCodeSDKSpawner` if
  `ANTHROPIC_API_KEY` is set, throws otherwise per RFC-0012 §8.3). Tests
  inject `stepRunners` + `spawnerFactory` via `PipelineToolDeps` so they
  don't shell out to claude or hit the Anthropic API. The existing 7
  governance tools (`task_edit`, `task_complete`,
  `get_governance_context`, `get_review_policy`,
  `list_detected_patterns`, `check_pr_status`, `check_issue`) continue to
  register unchanged — total registered tool count is now 21. Test
  coverage: 25 new vitest cases in `pipeline-tools.test.ts` covering
  registration shape (14 tools, naming, descriptions, schemas), per-step
  successful invocation with mocked step + spawner, schema validation
  rejection on missing/malformed inputs, and error propagation through
  `isError` text results. New `@ai-sdlc/pipeline-cli` workspace
  dependency added to `ai-sdlc-plugin/mcp-server/package.json`. Bundle
  size grew from ~600KB to 791KB to inline the pipeline-cli step
  functions (the marketplace clone of the plugin still works without
  `pnpm install` — esbuild rolls every runtime dep into `dist/bin.js`,
  the AISDLC-75 contract). (AISDLC-100.3)
- **`@ai-sdlc/pipeline-cli` documentation pass** (AISDLC-100.7 / RFC-0012
  Phase 7): three new contributor + operator references covering the post-100.1
  / 100.2 architecture. (1) `pipeline-cli/README.md` rewritten with the dual-tier
  framing — Tier 1 (slash command body interleaves CLI subcommands with main-
  session `Agent` tool calls) vs Tier 2 (`executePipeline()` composite + injected
  `SubagentSpawner`) — plus an explicit install matrix (plugin-bundled today,
  `pnpm add @ai-sdlc/pipeline-cli` post-Phase-8) and runnable Tier 1 + Tier 2
  quickstarts. (2) New `pipeline-cli/docs/spawner.md` deep-dive: when to pick
  `ShellClaudePSpawner` (subscription) vs `ClaudeCodeSDKSpawner` (API key) vs
  `MockSpawner` (tests) vs a custom implementation; the `defaultSpawner()`
  resolution order (which→shell, env→sdk, else throw); the lazy SDK import
  rationale (~50MB SDK is opt-in, only the API-key path needs it on disk); the
  Q5 (RFC §15) empirical resolution that the actual CLI flag is `--agent <type>`
  not `--subagent <type>` (verified 2026-04-30 against the installed CLI); a
  worked custom-spawner howto with the four implementation rules of thumb (never
  throw, honour cwd + timeout, populate `parsed`, `spawnParallel` may serialise).
  (3) New `pipeline-cli/docs/steps.md` per-step contract reference with one
  short section each for Step 0 through Step 13 — function name, CLI subcommand,
  contract paragraph, input + output type signatures, side effects list, and
  "when it runs" notes — sourced from the per-step JSDoc + `pipeline-cli/src/types.ts`.
  Also updated `CLAUDE.md`'s canonical-execution-paths section with a new
  "Dual-tier pipeline architecture (RFC-0012)" subsection that cross-links the
  three new docs and notes that all three execution paths share the same step
  functions. No code changes — docs only. (AISDLC-100.7)
- **rebase-resolver subagent + `/ai-sdlc rebase` slash command** (AISDLC-105) —
  new `agents/rebase-resolver.md` plugin subagent + `commands/rebase.md` slash
  command body that automate the mechanical 80% of PR rebase + conflict
  resolution and escalate the architectural 20%. Surfaced 2026-05-01 after the
  orchestrator did 6+ manual rebase rounds across PRs #113, #114, #115 in one
  session (PR #115 alone needed three iterations: CHANGELOG → modify-vs-delete
  → prettier-drift CI failure). The subagent handles five mechanical rules
  (CHANGELOG `Unreleased > Added` overlaps → keep both bullets; test additions
  to the same describe → keep both `it()` cases; non-overlapping code
  additions → keep both unless shared identifier; prettier drift → run
  `pnpm exec prettier --write` per resolved file before `git rebase --continue`;
  `--force-with-lease` only, refuses on `main`/`master`) and escalates four
  cases back to the operator (modify-vs-delete with port location guess;
  semantic conflict on overlapping lines; verification failure → no push;
  3-attempt iteration cap exceeded). The `/ai-sdlc rebase <pr>` slash command
  wraps the subagent: locates the worktree at `.worktrees/<task-id-lower>`
  (recreates from origin if missing), spawns the subagent, parses the
  structured JSON return, re-signs the attestation only when `contentHash`
  changed (using `sign-attestation.mjs --print-content-hash` as the
  AISDLC-94/101 oracle from AISDLC-102), and force-pushes with
  `--force-with-lease`. Test coverage: 30+ assertions in
  `agents/rebase-resolver.test.mjs` (frontmatter, hard rules, 5 mechanical
  rules, 4 escalation cases, return contract, fixture conflict scenarios for
  CHANGELOG overlap + test additions + modify-vs-delete + prettier drift +
  verification failure + force-with-lease refusal + attestation re-sign skip
  + iteration-cap escalation) plus 25+ assertions in
  `commands/rebase.test.mjs` (frontmatter, pipeline contract, hard rules,
  re-attestation flow, push step refuse-on-main, escalation handling).
- **Pre-sign rebase + conditional re-review** (`agents/execute-orchestrator.md`
  Step 10.5; `scripts/sign-attestation.mjs --print-content-hash`): inserted a
  new step between Step 9 (review iteration loop) and Step 10 (sign attestation)
  that fetches `origin/main` (with a 30s timeout), skips when `git merge-base
  --is-ancestor` reports no-op, otherwise rebases. The post-rebase
  `contentHash` (AISDLC-94 dual-hash oracle) decides whether reviewers'
  approval still binds (same hash → reuse) or whether 3 reviewers must
  re-spawn for one round (different hash → re-review). Rebase conflicts abort
  with `outcome: aborted (rebase-conflict)`; rebase-loop (main moves 3 times
  during attempts) aborts with `outcome: aborted (rebase-loop)` — the
  orchestrator never auto-resolves. Re-review iterations share Step 9's cap
  (max 2 dev iterations); cap exceeded → ships as `[needs-human-attention]`.
  Step 3 (worktree setup) ALSO fetches latest main first so the developer +
  reviewers run against current state from the start. Together with
  AISDLC-101 (verifier-side per-file delta hashing) this closes the
  AISDLC-93 / PR #102 attestation-invalidation gap as a defense-in-depth
  pair: producer-side Step 10.5 minimises *fresh* invalidation by signing
  the latest state; verifier-side AISDLC-101 accepts envelopes whose
  per-file blob SHA matches when sibling PRs merge between our push and our
  merge. The new `--print-content-hash` flag on `sign-attestation.mjs` is a
  read-only oracle used by Step 10.5 to compare pre/post rebase content
  without requiring a signing key. Tier 2 implementation (`pipeline-cli/src/steps/`)
  is deferred to AISDLC-100.5 (RFC-0012 Phase 5) since `pipeline-cli/`
  doesn't exist yet (RFC-0012 Phase 1 = AISDLC-100.1). Test coverage:
  `commands/execute.test.mjs` adds 9 new assertions on the orchestrator
  body for Step 10.5 prose markers and Step 3 fresh-base behaviour.
  (AISDLC-102)
- **RFC docs-drift CI gate** (`scripts/check-rfc-docs.mjs` +
  `scripts/check-rfc-docs.test.mjs` + `pnpm rfc:check` / `pnpm rfc:test`):
  enforces the `requiresDocs` convention defined in AISDLC-69.2. The script
  walks `spec/rfcs/RFC-*.md` (skipping the template), parses YAML
  frontmatter, and for every sign-off-locked RFC (`status: Approved`,
  `Implemented`, or `Final`) verifies that each surface listed in
  `requiresDocs` has at least one .md file under the corresponding
  `docs/<subdir>/` (per the schema enum: tutorial→tutorials,
  operator-runbook→operations, api-reference→api-reference,
  getting-started→getting-started, example→examples) that references the
  RFC by its `id`. RFCs flagged `deferredDocs: true` short-circuit with a
  warning that announces remaining days until the deadline (or `OVERDUE`).
  Pre-sign-off statuses (`Draft`, `Under Review`, `Rejected`, `Withdrawn`)
  are skipped — the operator process documented in `spec/rfcs/README.md`
  says docs land before requesting `Approved`, so we don't gate authoring.
  Wired into the root `pnpm test` chain so the check runs on every local
  test invocation. Operator follow-up: add `pnpm rfc:check` as an explicit
  step in `.github/workflows/ci.yml` (workflow files are blocked from the
  developer subagent, so this CHANGELOG entry is the handoff). Regression
  coverage: 46 node:test cases covering frontmatter parsing edge cases
  (CRLF, comments, malformed fences, inline empty list, block list,
  booleans), validation outcomes (Approved/Implemented/Final enforced;
  Draft/Under Review/Rejected/Withdrawn skipped; deferred warned;
  malformed rejected), recursive doc lookup, template skip, and CLI exit
  codes. (AISDLC-69.3)
- **CI-skip marker hygiene** (AISDLC-88) — three-layer prevention for the five
  GitHub Actions magic tokens (`(skip ci marker)`, `(ci skip marker)`, `(no ci marker)`,
  `(skip actions marker)`, `(actions skip marker)` — paren-quoted here to avoid
  triggering the parser this CHANGELOG entry documents) leaking into commit
  messages and silently disabling workflows.
  1. New `scripts/check-skip-ci-marker.sh` (`.husky/pre-push` wiring is an
     operator follow-up): scans every commit being pushed for the literal
     bracketed substrings (case-insensitive), prints a clear remediation
     message, and exits 1. Override via `AI_SDLC_SKIP_MARKER_GATE=1 git push`.
     Bot-author exemption: a commit authored by `ai-sdlc-ci-attestor[bot]`
     (production identity per `.github/workflows/ai-sdlc-review.yml`; legacy
     `github-actions[bot]` retained as a fallback in the script) AND subjected
     `chore(ci): sign review attestation*` passes (the documented AISDLC-87
     chore commit).
  2. New Hard Rule in `ai-sdlc-plugin/agents/developer.md` (Hard Rule 7) and
     `ai-sdlc-plugin/commands/execute.md` (post-AISDLC-98 the orchestrator
     subagent file is gone; the slash command body now hosts the rule). The
     agents must use the **paren-quoted form** when discussing these tokens
     in commit bodies. Backtick-wrapping does NOT defeat GitHub's
     literal-substring parser — only the bracket-free form is safe.
  3. The slash command body's Step 10 chore-commit body is now sed-sanitised
     before `git commit -m` as defense-in-depth (so even a leaked token in
     interpolated text gets rewritten before it can land).
- **CI-side attestor** (`scripts/ci-sign-attestation.mjs` +
  `.github/workflows/ai-sdlc-review.yml` Post Review Results step): when CI's
  three reviewer agents (testing/critic/security) all approve a PR AND the
  PR has no valid local attestation, CI signs a DSSE envelope with a
  `ci-attestor` key from GitHub Secrets and pushes it back to the PR branch
  with `[skip ci]`. The verifier (AISDLC-84/85) accepts CI-signed envelopes
  identically to maintainer-signed ones — same DSSE format, same predicate.
  Unblocks remote-agent `/ai-sdlc execute` runs (AISDLC-78/79/80/85 root
  cause was no signing key in the remote sandbox) and gives external
  contributors a zero-key path to a valid attestation. The CI signing step
  delegates the "should I sign?" decision to the existing verifier
  (`--skip-if-valid`), so it never redundantly signs over a valid local
  attestation but DOES sign additively alongside an invalid one (the
  multi-envelope scan picks the valid one). Step is gated to same-repo PRs
  via `head.repo.full_name == github.repository` — fork PRs cannot push to
  their head ref via GITHUB_TOKEN, so they get the existing friendly
  fallback comment instead. Bootstrap (one-time, maintainer-only) is
  documented in `CLAUDE.md` → "Bootstrap CI-side attestor": generate
  keypair, add private key as GH Secret `AI_SDLC_CI_ATTESTOR_PRIVATE_KEY`,
  uncomment + fill the placeholder in `.ai-sdlc/trusted-reviewers.yaml`,
  open onboarding PR. Until that PR merges, `verify-attestation.yml`
  rejects CI-signed envelopes with `signature did not match any trusted
  reviewer pubkey` — the SAFE default (CI signing is additive, never
  weakens the trust model). Regression coverage:
  `scripts/ci-sign-attestation.test.mjs` exercises the three core shapes
  (no-local-attestation → CI signs → verifier valid; valid-local → CI
  no-ops; invalid-local → CI signs additively → verifier picks valid one)
  end-to-end against the real verifier. (AISDLC-87)

### Removed

- **Agent-type Stop hook governance check from `ai-sdlc-plugin/plugin.json`**
  (AISDLC-120, AISDLC-108 follow-up). The first element of `hooks.Stop[]` was
  an `"type": "agent"` entry that invoked Haiku at the end of every
  conversational turn with a prompt to verify build/test/lint/blockedPaths —
  the same governance check the deleted `quality-gate-stop.sh` had been
  running, just LLM-backed instead of shell-backed. Per AISDLC-108's intent
  ("verification belongs on the git lifecycle, not every conversational
  turn"), the per-turn LLM verification was redundant with the husky
  pre-push gate (`scripts/check-coverage.sh` →  `pnpm -r test:coverage` +
  the 80% codecov patch threshold). The second `Stop` block
  (`deferred-coverage-check.sh`, `asyncRewake: true`) is unrelated — it's
  the post-turn coverage check, the script still exists, and it stays.
- **`hooks/quality-gate-stop.{sh,js,test.mjs}` + Stop-hook entries** that
  invoked it (AISDLC-108). The Claude `Stop` hook ran
  `quality-gate-stop.sh` at the end of every conversational turn,
  scanning `~/.claude/usage-data/tool-sequences.jsonl` (multi-MB across
  all sessions) and on miss exit-2'd to wake the model with a
  "Verifying governance compliance..." stderr blast. This was the wrong
  layer: build/test/lint verification belongs on the git lifecycle, not
  every turn. The canonical gate is `.husky/pre-push` →
  `scripts/check-coverage.sh` (runs `pnpm -r test:coverage` workspace-wide
  + enforces the 80% codecov patch threshold), which already runs at the
  right boundary and blocks the push not the conversation. Per-turn false
  positives during long orchestrator runs were the trigger for removal.
  Removed entries from the bundled `ai-sdlc-plugin/plugin.json` and
  `ai-sdlc-plugin/.claude-plugin/plugin.json` Stop arrays; the deferred
  coverage check (`hooks/deferred-coverage-check.sh`, asyncRewake) and
  the Haiku governance verifier remain because they don't duplicate the
  pre-push gate. Project-level `.claude/settings.json` Stop entry must
  also be stripped — handled by the operator (file is outside the
  developer subagent's write scope).

### Documentation

- **RFC-0006 retroactive user docs** (`docs/tutorials/design-system-getting-started.md`,
  `docs/operations/design-system-operator-runbook.md`,
  `docs/api-reference/design-system.md`): authored the three doc surfaces
  declared in RFC-0006's `requiresDocs` frontmatter. The tutorial (~1.3k
  words, three worked examples) walks a frontend team through declaring a
  `DesignSystemBinding`, wiring three quality gates, and operating the
  design-token-cascade / compose-or-justify / token-deletion-blocked flows
  end to end. The operator runbook (~1.2k words) covers the daily / weekly /
  monthly cadence for the design system maintainer + pipeline operator
  (rotating MCP bearer tokens, approving token migrations, refreshing
  baselines, tuning `cascadeThreshold` and review SLA) plus an
  RFC-0006-specific event triage table. The api-reference doc covers the
  three RFC-0006 adapter interfaces (`DesignTokenProvider`,
  `ComponentCatalog`, `VisualRegressionRunner`) and their project-owned
  reference implementations (`tokens-studio`, `figma-variables`,
  `storybook-mcp`, `playwright-visual`). RFC-0006 frontmatter
  `deferredDocs: true` removed (no longer applicable); `updated: 2026-04-30`
  bumped. Closes the canonical "missing docs" example that motivated
  AISDLC-69. (AISDLC-69.4)

- **RFC `requiresDocs` frontmatter convention** (`spec/rfcs/RFC-0001-template.md`,
  `spec/rfcs/README.md`, `spec/schemas/rfc.schema.json`): every RFC now
  carries a YAML frontmatter block with `id` / `title` / `status` / `author` /
  `created` / `updated` / `requiresDocs` (and optional `deferredDocs` +
  `deferredDocsDeadline`). The `requiresDocs` field is a closed enum
  (`tutorial`, `operator-runbook`, `api-reference`, `getting-started`,
  `example`) that declares which user-facing doc surfaces the RFC requires
  — the docs-drift CI gate (AISDLC-69.3) will enforce that each declared
  surface has at least one doc file referencing the RFC by ID. RFCs 0002,
  0003 (both 0003a and 0003b), 0004, 0005, 0006, 0008, and 0010 migrated
  from markdown-bold-style status (`**Status:** Draft`) to YAML; the
  bold-status block is preserved in the body for human readability but
  the frontmatter is the source of truth for tooling. The README RFC index
  table is refreshed to reflect actual statuses (RFC-0006 / RFC-0008 are
  `Final`, not `Draft`) and a new `requiresDocs` column. The stale
  RFC-0007 / RFC-0009 rows are documented as reserved/withdrawn slots.
  RFC-0006 declares `deferredDocs: true` with a `2026-07-31` deadline —
  AISDLC-69.4 tracks the retroactive doc authoring. (AISDLC-69.2)

- **Remote-agent usage policy** (`CLAUDE.md`): documented that Anthropic CCR
  remote agents (scheduled via the bundled `/schedule` skill,
  `Path: bundled:schedule`) are read-only by design. Empirical 4-for-4
  failure rate of `/ai-sdlc execute` over `/schedule` (AISDLC-78, -79, -80,
  -85) confirmed the structural blockers: no signing key in the remote
  sandbox, plugin not auto-installed, subagents not registered, no local
  worktree. The new `Remote agents (/schedule) — read-only by design`
  section in `CLAUDE.md` lists acceptable patterns (PR status surveys,
  backlog state reports, cron-triggered metric digests, Slack workflows,
  CI run surveys) and explicitly-prohibited patterns
  (`/ai-sdlc execute`, signing-key-dependent flows, plugin-subagent
  flows, worktree flows, cross-repo write flows). Notes AISDLC-87
  (CI-side attestor) as the planned fix that will eventually unblock
  remote-agent `/ai-sdlc execute`. Since the `/schedule` skill is
  system-bundled (not in this repo), the callout lives in `CLAUDE.md`
  per AISDLC-86 AC #4. (AISDLC-86)

### Changed

- **`pnpm --filter @ai-sdlc/dogfood watch` migrated to `executePipeline()`
  from `@ai-sdlc/pipeline-cli`** (AISDLC-100.5, RFC-0012 Phase 5) — the
  watch CLI in `dogfood/src/cli-watch.ts` no longer wraps
  `@ai-sdlc/orchestrator`'s reconciler-driven `startWatch`. Each `--issue`
  is now driven directly through the shared Tier 2 composite from the
  pipeline-cli package, which runs Steps 0-13 against a `SubagentSpawner`
  selected per `--spawner auto|shell|sdk|mock` (default `auto` →
  `defaultSpawner()` resolution per RFC §8.3 — `ShellClaudePSpawner`
  preferred when `claude` CLI is on PATH, falling back to
  `ClaudeCodeSDKSpawner` when `ANTHROPIC_API_KEY` is set). Behavior parity
  is intentionally narrow: reconciler retry/backoff, Pipeline-resource
  routing, admission gating, autonomy enforcement, audit logging, OTEL
  instrumentation, and provenance attestation are NOT yet exposed by
  pipeline-cli — those code paths still live in the orchestrator-driven
  `pnpm --filter @ai-sdlc/dogfood execute` CLI (`cli.ts`, unchanged) and
  Phase 6 follow-up tracks restoring them on top of `executePipeline()`.
- **`/ai-sdlc execute`, `/ai-sdlc status`, `/ai-sdlc triage`**: rewired all
  call sites that previously used `mcp__backlog__task_edit` and
  `mcp__backlog__task_complete` to the plugin's drop-in replacements
  `mcp__ai-sdlc-plugin__task_edit` / `mcp__ai-sdlc-plugin__task_complete`
  (shipped in AISDLC-73). The new tools preserve unknown frontmatter keys
  verbatim — most importantly `permittedExternalPaths`, which the upstream
  tools silently strip on every status flip, breaking cross-repo writes for
  any task that needs them. `mcp__backlog__task_view` (read-only) continues
  to use upstream. (AISDLC-83)
- `ai-sdlc-plugin/commands/execute.md` `allowed-tools` frontmatter updated
  accordingly: removed upstream `mcp__backlog__task_edit` /
  `mcp__backlog__task_complete`, added the plugin equivalents.

### Notes

- No MCP server schema changes were required — the AISDLC-73 tool schemas
  (`status`, `acceptanceCriteriaCheck`, `finalSummary`, `updatedDate` for
  `task_edit`; `id`, `finalSummary`, `updatedDate` for `task_complete`)
  already cover every field `/ai-sdlc execute` needs. No bundle rebuild
  was needed for AISDLC-83.
- AC #4 of AISDLC-83 (end-to-end dogfood verification with a task carrying
  `permittedExternalPaths`) is intentionally deferred to a manual run by
  the human operator after this PR merges.
