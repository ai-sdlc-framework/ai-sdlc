# Changelog

## [0.11.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.10.0...pipeline-cli-v0.11.0) (2026-05-18)


### Features

* allow orchestrator Codex spawner selection (AISDLC-326) ([#497](https://github.com/ai-sdlc-framework/ai-sdlc/issues/497)) ([b38f429](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b38f4292c971f0fd013a1f994e8676341aeca2f2))
* **orchestrator:** add --spawner claude (real shell-out to claude -p) (AISDLC-349) ([#510](https://github.com/ai-sdlc-framework/ai-sdlc/issues/510)) ([36eeac2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/36eeac2cb9d1a4e9ba698761f46bc8a45aaf2194))
* **orchestrator:** add resume-from-draft + rework-pr recovery paths (AISDLC-273) ([#489](https://github.com/ai-sdlc-framework/ai-sdlc/issues/489)) ([39acbcb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39acbcb4fd44650cbbbeace5bbaf2e6772998bac))
* **orchestrator:** RFC-0016 Phase 4 — Stage B LLM tie-breaker + Q5 ensemble (AISDLC-282) ([#514](https://github.com/ai-sdlc-framework/ai-sdlc/issues/514)) ([53efd12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/53efd12c2707f9d47083f7d22a4623f376e39abf))
* **orchestrator:** rfc-0016 phase 5 — per-class bias + 3-state token + pr-comment (AISDLC-283) ([#522](https://github.com/ai-sdlc-framework/ai-sdlc/issues/522)) ([c76c443](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c76c44303e248b671fef2b344f61aa9e9d71b9d8))
* **pipeline-cli:** RFC-0035 Phase 1 — Decision resource schema + cli-decisions {list, show, add} (AISDLC-285) ([#504](https://github.com/ai-sdlc-framework/ai-sdlc/issues/504)) ([019cdfe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/019cdfe265a3301580c003c06a792d6e1ef89c03))
* RFC-0011 DoR upstream-OQ gate (AISDLC-296) ([#507](https://github.com/ai-sdlc-framework/ai-sdlc/issues/507)) ([8332994](https://github.com/ai-sdlc-framework/ai-sdlc/commit/83329947a4fa0987968a06d7ca99b72945c5a725))
* RFC-0016 Phase 1 — Stage A signals + class-default fallback (AISDLC-279) ([#495](https://github.com/ai-sdlc-framework/ai-sdlc/issues/495)) ([5c8dd02](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5c8dd02163f81e00ba439eb00ef4acaf6d997661))
* RFC-0016 Phase 2 — estimate log writer + class cache (AISDLC-280) ([#498](https://github.com/ai-sdlc-framework/ai-sdlc/issues/498)) ([023e845](https://github.com/ai-sdlc-framework/ai-sdlc/commit/023e8454479ad452e19ba4273f8fab958e8f7f1f))
* RFC-0016 Phase 3 — measurement + monthly-rotated calibration writer (AISDLC-281) ([#508](https://github.com/ai-sdlc-framework/ai-sdlc/issues/508)) ([bedec2e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bedec2e3c0b40cf097ad9f05fc27b8d444016619))
* RFC-0035 phase 2 — stage-a scorer and dep-graph blast-radius (AISDLC-286) ([#512](https://github.com/ai-sdlc-framework/ai-sdlc/issues/512)) ([d926466](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d926466cb4f6f2b41055f45cf21e295b080d76b0))
* rfc-0035 phase 3 — stage B rubric scorer + actor routing (AISDLC-287) ([#521](https://github.com/ai-sdlc-framework/ai-sdlc/issues/521)) ([d2a9eb4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d2a9eb4f7dda662b85bc708839a28b3560204777))
* wire rfc-0011 dor clarification rounds into decision catalog (AISDLC-288) ([#511](https://github.com/ai-sdlc-framework/ai-sdlc/issues/511)) ([bec9699](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bec96993f13e450013ffe48518a21fbcf6a1242e))


### Bug Fixes

* harden Codex spawn bridge output handling ([#500](https://github.com/ai-sdlc-framework/ai-sdlc/issues/500)) ([42ed716](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42ed7160152b99884225873f65186d9559a8d4ea))
* **orchestrator:** parseClaudeOutput strips markdown fences + extracts embedded JSON (AISDLC-351) ([#515](https://github.com/ai-sdlc-framework/ai-sdlc/issues/515)) ([a03dd41](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a03dd416112c12dbcbc6cd2ccea548133fe0a0b2))
* **orchestrator:** resume-from-draft stale verdict + verdict shape + degenerate retry (AISDLC-355) ([#527](https://github.com/ai-sdlc-framework/ai-sdlc/issues/527)) ([117f4b9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/117f4b9f33b23b3df4c4ffdea6aa32c43a6416fb))
* **orchestrator:** scrub GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in checkpoint.ts production git calls (AISDLC-260) ([#461](https://github.com/ai-sdlc-framework/ai-sdlc/issues/461)) ([af8c8ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af8c8ca59814cf23d5cb6b53d49038955359293e))
* **reference:** handle loader-private YAML kinds without false-positive warnings (AISDLC-265) ([#474](https://github.com/ai-sdlc-framework/ai-sdlc/issues/474)) ([e51029c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e51029c0da04ac4ef6025281579361470e2039ff))
* **tui:** align CRITICAL PATH + OPERATOR THROUGHPUT panel borders (AISDLC-259) ([#459](https://github.com/ai-sdlc-framework/ai-sdlc/issues/459)) ([4326a80](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4326a800967158f3807ea778d8259e7f607246b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.11.0

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.1.0...pipeline-cli-v0.10.0) (2026-05-11)


### Features

* add ai-sdlc-pipeline execute umbrella subcommand for end-to-end dispatch (AISDLC-182) ([b980987](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b980987aef8acc139aeb953b2d7d83de206123b1))
* add DoR ingress shims + idempotent comment loop + staleness (AISDLC-115.4) ([f6178b2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f6178b27ed5198ffd5461a4e6a47f5f99b95318b))
* add Stage B LLM-evaluator + composite Stage A+B refinement reviewer (AISDLC-115.3) ([27a596f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27a596f1c8cfdb1f1b12495d4cb1454cd4c6142f))
* add Step 0.5 to auto-sync untracked parent task files (AISDLC-217) ([#370](https://github.com/ai-sdlc-framework/ai-sdlc/issues/370)) ([473856c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/473856ce66b2d469b2096d67bf5c56701f1209e5))
* atomic Codex task completion + duplicate-detection gate (AISDLC-203) ([#346](https://github.com/ai-sdlc-framework/ai-sdlc/issues/346)) ([05f65a1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/05f65a11adb45b6e8a0495da0d38de447ab0914c))
* **ci:** add canonical codex-spawn-agent-bridge.mjs for --spawner codex (AISDLC-251) ([#422](https://github.com/ai-sdlc-framework/ai-sdlc/issues/422)) ([c754f89](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c754f89f627c6df43e4ac07675315065040b9c2f))
* **ci:** cost-savers — skip CI reviewers on valid attestation + budget circuit breaker (AISDLC-147) ([136dae8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/136dae894f927f32303d0fe84e7c636894eb7407))
* **ci:** open PR as draft, sign envelope before ready (1 CI run per PR) (AISDLC-218) ([#376](https://github.com/ai-sdlc-framework/ai-sdlc/issues/376)) ([23d7e54](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23d7e54e1add058855bce398d4fc65b4ad1d2802))
* **ci:** persist DoR calibration to artifacts + aggregator CLI (AISDLC-161) ([b8659ee](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b8659eebf79926b4a1a0ed25bb3823bdd3f9af2b))
* Codex harness adapter + Step 2 slug fallback (AISDLC-202.2) ([#402](https://github.com/ai-sdlc-framework/ai-sdlc/issues/402)) ([767f5f3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/767f5f329c4df331fd196d7483b91652a1625683))
* create @ai-sdlc/pipeline-cli package — RFC-0012 Phase 1 (AISDLC-100.1) ([14850ae](https://github.com/ai-sdlc-framework/ai-sdlc/commit/14850aefe33c668129c5d6aa4382ad5ef1ee3050))
* **dashboard:** add dor calibration page (AISDLC-162) ([a8f9ff9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8f9ff91c26c49eb25c95a644c57e2a921a6f62c))
* **deps:** cli-deps dependency graph + dispatch frontier integration (AISDLC-117) ([dd5230f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dd5230f74f5a6d164eb31a50fc8f42523db50465))
* **deps:** cli-pr-unstick deterministic PR-blocker auto-resolver (AISDLC-139) ([edc44a3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/edc44a3dcce8481356ec4dac55a5039c25854558))
* **deps:** hmac integrity for incremental-review marker (AISDLC-146) ([35a7976](https://github.com/ai-sdlc-framework/ai-sdlc/commit/35a7976a25b8dbbd79c97232dca3721f24ef0519))
* **deps:** incremental review — skip/delta when contenthash unchanged (AISDLC-142) ([2f85444](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2f85444a129602d5552c35a007331daa515dab02))
* **deps:** rfc-0014 phase 1 deps snapshot artifact + GC + externalDependencies (AISDLC-166) ([e5d8fd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e5d8fd610fb215ccc447d648801bd0b4919bcb76))
* **deps:** rfc-0014 phase 2 — depth-aware priority dispatcher (AISDLC-167.2) ([40b3b97](https://github.com/ai-sdlc-framework/ai-sdlc/commit/40b3b97ba19dc459a415b2c5811728e397eb9f33))
* **deps:** rfc-0014 phase 3 — DoR blast-radius surfacing (AISDLC-167.3) ([a0abb46](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a0abb46cc9e2e01e4f5c46857d995b6bb9f568ef))
* **deps:** rfc-0014 phase 4 — Slack digest + dashboard critical-path surfacing (AISDLC-167.4) ([45902c9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/45902c93c4de81094e9f07496b42b76e7e585868))
* **deps:** rfc-0014 phase 5 — soak corpus aggregator + hybrid promotion runbook (AISDLC-167.5) ([61189d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/61189d896538919f21752a4392409a744d691f90))
* **deps:** rfc-0015 phase 1 — bare orchestrator loop (AISDLC-169.1) ([976b211](https://github.com/ai-sdlc-framework/ai-sdlc/commit/976b211e09af7eb1e7be950e74b4154c58704a4d))
* **deps:** rfc-0015 phase 2 — failure playbook (9 modes) (AISDLC-169.2) ([b8e7602](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b8e76023c1aa701765ff8547124d2266fe8342c6))
* **deps:** rfc-0015 phase 3 — pre-dispatch filter chain (AISDLC-169.3) ([1aecbcf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1aecbcf95048dfcd54631b50c83229c31b9a18b4))
* **deps:** rfc-0015 phase 4 — events.jsonl writer + cli-status --orchestrator (AISDLC-169.4) ([26daa6f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26daa6f71ee8c784ebafb93e9ff57e8cd5291d2c))
* **deps:** tessellated-platform shard naming for Gate 5 + regression test (AISDLC-115.8 partial) ([3fe06f8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3fe06f82c4480b7f7573aa42aeb09c72739cbb38))
* **deps:** wire conditional review classifier into Step 7 (AISDLC-141) ([69ba3d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/69ba3d7a2d65f9704f3d92e4473c487388cc9763))
* expand umbrella rollback to aborted + unknown-failure outcomes (AISDLC-191) ([f7d76ff](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f7d76ffbc0816a75816bab8cddba82cad34d9194))
* harden DoR SECRET_PATTERNS trailing-leak + key block (AISDLC-128) ([16af739](https://github.com/ai-sdlc-framework/ai-sdlc/commit/16af73942cb6535486ac6c454e3ba4210e67ccc1))
* implement ShellClaudeP + ClaudeCodeSDK SubagentSpawners (AISDLC-100.2) ([c1c9ed0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c1c9ed0e8bbf4455b0cf8011e9a5c383f84d771e))
* make @ai-sdlc/pipeline-cli publishable + register in release-please (AISDLC-100.8 prep) ([bf07e0e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bf07e0e614ecb364b7859023e49111bdd3903d23))
* **orchestrator:** add BlastRadiusOverlapFilter to dispatch admission chain (AISDLC-231) ([#425](https://github.com/ai-sdlc-framework/ai-sdlc/issues/425)) ([d05f8f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d05f8f50755105ddb40bae6d81726373d7368d0d))
* **orchestrator:** add BlockedFilter admission gate + blocked frontmatter (AISDLC-223) ([#378](https://github.com/ai-sdlc-framework/ai-sdlc/issues/378)) ([b058407](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0584072fd94ae0e8428352436fe680e8c1333c2))
* **orchestrator:** add claude-cli inline spawner (Option 3, AISDLC-198) ([#353](https://github.com/ai-sdlc-framework/ai-sdlc/issues/353)) ([4eaa21b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4eaa21baa2e93f8344c3277547aa82d4acbffa84))
* **orchestrator:** add DispatchabilityFilter for dispatchable:false frontmatter (AISDLC-243) ([#413](https://github.com/ai-sdlc-framework/ai-sdlc/issues/413)) ([8b93759](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b9375993336ec4e1c5d2f83c0e33d64619cb3b8))
* **orchestrator:** add phase + iteration discriminator to retry event (AISDLC-196) ([5dc3a7d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5dc3a7dc5a3d3be239d5d0258e5f2ea76c1a6bec))
* **orchestrator:** autonomous loop sweeps merged worktrees per tick (AISDLC-256) ([#433](https://github.com/ai-sdlc-framework/ai-sdlc/issues/433)) ([8d3b20d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8d3b20d489e7ccaeda8793b282f1464647d4687d))
* **orchestrator:** dor bypass + 3-round escalation (AISDLC-115.7) ([9af3ed3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9af3ed355082ed57df0ade0d1461f00834255fef))
* **orchestrator:** dor metrics + slack digest (AISDLC-115.6) ([421255b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/421255bb74af8f8a90140a3c558b605e17127ea7))
* **orchestrator:** harden Stage B prompt against fence-breakout prompt injection (AISDLC-121) ([8b660e3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b660e31400abc0c3d6b1caecb647136deeaad9b))
* **orchestrator:** in-flight detection filter (AISDLC-227) ([#404](https://github.com/ai-sdlc-framework/ai-sdlc/issues/404)) ([c6669cb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c6669cb6330d308ab408a77a01cfd7e94978f970))
* **orchestrator:** inline spawner consumer bridge for /ai-sdlc orchestrator-tick (AISDLC-225) ([#390](https://github.com/ai-sdlc-framework/ai-sdlc/issues/390)) ([c5e5e3a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c5e5e3a1958a586379331af674737a64cdbc41c5))
* **orchestrator:** instrument spawner with stderr/exit-code/signal capture (AISDLC-239) ([#406](https://github.com/ai-sdlc-framework/ai-sdlc/issues/406)) ([dd85548](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dd85548d902f3373dc79a66c426009c58f476f95))
* **orchestrator:** late-rebase in Step 11 before push (AISDLC-232) ([#407](https://github.com/ai-sdlc-framework/ai-sdlc/issues/407)) ([296085c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/296085c9f18de9a022371df592b11aefb6b5e60d))
* **orchestrator:** mode switching + configuration browser TUI (AISDLC-178.5) ([#389](https://github.com/ai-sdlc-framework/ai-sdlc/issues/389)) ([d1da8f6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d1da8f6606a132ebede452e5ac690bd7b0f36dd3))
* **orchestrator:** pr critical-path ordering for the PRs pane (AISDLC-178.4.1) ([#386](https://github.com/ai-sdlc-framework/ai-sdlc/issues/386)) ([8558eb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8558eb2d6eaddf601acb5a0dbc10b939308582a6))
* **orchestrator:** redact secrets in DoR calibration log + gitignore artifacts/ (AISDLC-122) ([8e9c328](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e9c3289ab760b4caa09855f54ef6423b40aa82a))
* **orchestrator:** resume from interrupted runs (AISDLC-242) ([#415](https://github.com/ai-sdlc-framework/ai-sdlc/issues/415)) ([b063657](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b063657f62c9082d5af795caba18a1e10ebde301))
* **orchestrator:** rfc-0011 phase 4 — definition-of-ready composition (AISDLC-115.5) ([6c0e997](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c0e9977f52405bb5d333b8e4e65d79f2f720715))
* **orchestrator:** rfc-0015 phase 5 chaos test + corpus aggregator (AISDLC-169.5) ([0dc03c6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0dc03c66e1d078530257df08e11b19587724d2e4))
* **orchestrator:** rfc-0023 phase 1 skeleton — cli-tui binary + Ink Overview Mode (AISDLC-178.1) ([2d723d2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2d723d2f16153313ed89421e10236e26cd23a3af))
* **orchestrator:** rfc-0023 phase 2 — TUI data sources + React hooks (AISDLC-178.2) ([7804a91](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7804a914afa0b4d25ced627600af3f1953479ea2))
* **orchestrator:** rfc-0023 phase 4 — PRs pane + Critical Path pane (AISDLC-178.4) ([#384](https://github.com/ai-sdlc-framework/ai-sdlc/issues/384)) ([e9488fc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e9488fc31c9ef56a1589f8c5ba819c56121784aa))
* **orchestrator:** rfc-0023 phase 6 — analytics pane + operator throughput (AISDLC-178.6) ([#392](https://github.com/ai-sdlc-framework/ai-sdlc/issues/392)) ([6c33fa6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c33fa655b135850edcefff2ee3f5f8925f6bf65))
* **orchestrator:** step 3 auto-cleans stale branches in autonomous mode (AISDLC-224) ([#377](https://github.com/ai-sdlc-framework/ai-sdlc/issues/377)) ([35892f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/35892f5275eb97af622f6529d549d762a45c5826))
* **orchestrator:** tick invokes ai-sdlc-pipeline execute umbrella (AISDLC-229) ([#391](https://github.com/ai-sdlc-framework/ai-sdlc/issues/391)) ([14fd58f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/14fd58f7618f80a2fa49cffcb1ce093f2f709b85))
* **orchestrator:** tui corpus aggregator + hybrid promotion runbook (AISDLC-178.7) ([#434](https://github.com/ai-sdlc-framework/ai-sdlc/issues/434)) ([8cf9027](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8cf90273a82ca25aba5b5ae8be56a895b0cbdae1))
* phase 3 Blockers pane — decision-pending detection, sort, drill-down (AISDLC-178.3) ([#383](https://github.com/ai-sdlc-framework/ai-sdlc/issues/383)) ([342e9c4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/342e9c4be6a47fd82e93f3775afa7be2ccf99004))
* **pipeline-cli:** expand SECRET_PATTERNS with 9 new credential formats (AISDLC-126) ([2bbc6d5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2bbc6d5e7c37c870cd3af59810c25e3f8df91f7c))
* **pipeline-cli:** make publishable as @ai-sdlc/pipeline-cli npm package (AISDLC-245.1) ([#442](https://github.com/ai-sdlc-framework/ai-sdlc/issues/442)) ([a2f527a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2f527a9752e315577d4d17142047ca8f422c3dd))
* **pipeline:** Step 0.5 reconciles path-mismatched task files (AISDLC-222) ([#432](https://github.com/ai-sdlc-framework/ai-sdlc/issues/432)) ([ed4e394](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ed4e39407e0d38dd15d19f801354a5f5d361c337))
* rfc-0011 phase 2a — deterministic stage A + test corpus (AISDLC-115.2) ([781ff3d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/781ff3db172e8b442b124cd4e7baec802f430e32))
* **spec:** attestation harness context + Codex finalization via MCP task_complete (AISDLC-202.3) ([#414](https://github.com/ai-sdlc-framework/ai-sdlc/issues/414)) ([c994a1b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c994a1bb476ddb9cee35de6c20b6d3bb01250f91))
* **spec:** make pipeline.yaml canonical; deprecate pipeline-backlog.yaml (AISDLC-245.5) ([#444](https://github.com/ai-sdlc-framework/ai-sdlc/issues/444)) ([281d139](https://github.com/ai-sdlc-framework/ai-sdlc/commit/281d1397400778f7dd90ff78ad24197303b6643f))
* width-pinned TUI snapshot test infrastructure (AISDLC-255) ([#436](https://github.com/ai-sdlc-framework/ai-sdlc/issues/436)) ([45acc50](https://github.com/ai-sdlc-framework/ai-sdlc/commit/45acc50fc96c7b114bb50febfccb9fa962feadb0))
* wire rollbackDispatch + drop inert flag in execute umbrella (AISDLC-182 iteration 2) ([9eccffd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9eccffdf5e62051ed46296df1c1dd95080cc892c))


### Bug Fixes

* address reviewer feedback for AISDLC-100.1 ([14767a1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/14767a158d44773b1224884708343c94362a24c9))
* atomicity hardening + input validation in completeTaskAtomically (AISDLC-209) ([#363](https://github.com/ai-sdlc-framework/ai-sdlc/issues/363)) ([b482d62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b482d62fd1a750ec50fdb25a967c883c28b4ec88))
* **ci:** invoke pipeline-cli CLIs via node directly, not pnpm exec (AISDLC-156) ([a27ef13](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a27ef133830ec16cb3e878956b10a47b69d58a9c))
* **ci:** regular workflows short-circuit on docs-only merge_group, retire fallbacks (AISDLC-214) ([#358](https://github.com/ai-sdlc-framework/ai-sdlc/issues/358)) ([1398d0b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1398d0bb4ec14540c0c0867c68da7e75b183f2f9))
* **ci:** replace pnpm exec ai-sdlc-pipeline in dor-ingress (AISDLC-181) ([76ae77a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/76ae77ae48fd63b57d8f87139a3e00ad929a5d26))
* **ci:** shell-validate PRIOR_SHA after jq extraction (AISDLC-151) ([06ddd28](https://github.com/ai-sdlc-framework/ai-sdlc/commit/06ddd28e3c9a8d5525ba38daf8731a6d5cdfad3a))
* **deps:** budget classifier — detect budget exhaustion in valid-verdict findings (AISDLC-149) ([d89abb6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d89abb60b33b2fe1619454c175c5778111709595))
* **deps:** budget classifier — substring fallback uses whole stdout, not last line (AISDLC-154) ([87dd463](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87dd463d2518b107faf189f190605d3c83447b24))
* **deps:** budget classifier — suppress when only NON-OK reviewers are budget-exhausted (AISDLC-157) ([98e9d9d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/98e9d9dcfa58d7cbb6e8cbc1d78d1a9dc62e9875))
* **deps:** cli-incremental-decide emits single-line JSON (AISDLC-142 round 3 — CRITICAL SKIP-path) ([887dbf8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/887dbf83f196a1b109ef6bfc841c377a1ae3d326))
* **deps:** cli-pr-unstick — gate forwards by parent + handle paginated runs (AISDLC-139) ([d4db863](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d4db8631d10a25007aeb9f256078d240099b0d98))
* **deps:** frontier CLI consults status field, not just file location (AISDLC-153) ([f0dfef4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f0dfef44c7c43a3711097e7284cd1fd99f79b358))
* **deps:** harden classifier — docs extension safelist + auth regex (AISDLC-145) ([fcc287f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fcc287fa534daeb03cf43d8e691d51922cf8c9cb))
* **deps:** incremental-review marker requires trusted author (AISDLC-142 round 2 — CRITICAL) ([eedc0df](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eedc0df5ef42d546b87fe72135e715efdf72c765))
* **deps:** parse YAML frontmatter via js-yaml in slug computation (AISDLC-180) ([2754e7e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2754e7ef4df73a80422607b6743ef59edbe30a1a))
* make TUI hook tests await microtask flush (AISDLC-188) ([d06262b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d06262b7eafe716482fd3cf097b07b32a1ace521))
* **orchestrator:** add alt-screen buffer mode to cure TUI down-arrow content drift (AISDLC-236) ([#424](https://github.com/ai-sdlc-framework/ai-sdlc/issues/424)) ([8656a90](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8656a90b939c296fc9f78c8c8a5bca6e2383021f))
* **orchestrator:** auto-rebuild stale pipeline-cli/dist before tick (AISDLC-226) ([#410](https://github.com/ai-sdlc-framework/ai-sdlc/issues/410)) ([acc4d2d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/acc4d2d696bee91b4a8c4275b8e7a10bb66fa6f8))
* **orchestrator:** enforce dev subagent JSON contract with one retry on parse failure (AISDLC-176) ([28bc0ea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/28bc0eae3dd9ecd3f7fc967d4e57e64cfbd92825))
* **orchestrator:** expand cleanup/rollback boundary to cover Step 3+ throws (AISDLC-200) ([#337](https://github.com/ai-sdlc-framework/ai-sdlc/issues/337)) ([886db3b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/886db3b714c32d3ca8aec9bcf08d7465f99e9a0a))
* **orchestrator:** filter orphan-parent tasks from frontier dispatch (AISDLC-175) ([cc024a8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc024a863f82cb2463dfc175a16ecb71490272a8))
* **orchestrator:** fix TUI layout corruption on terminal resize (AISDLC-235) ([#417](https://github.com/ai-sdlc-framework/ai-sdlc/issues/417)) ([dbc1e3a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbc1e3ab8beb9ba64e9c421de74100063d23f0ba))
* **orchestrator:** frontier resolver filters In Progress tasks (AISDLC-183) ([cfe4cfa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cfe4cfa9271c4a3a9546ba041ec0f846df7ec2a0))
* **orchestrator:** guard quarantine with isReallyStale() 4-signal check (AISDLC-228) ([#408](https://github.com/ai-sdlc-framework/ai-sdlc/issues/408)) ([6c7e916](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c7e916d5fa9a2640e98aef7047a2e1e06a61d69))
* **orchestrator:** harden checkpoint test fixtures against GIT_DIR env bleed (AISDLC-253) ([#429](https://github.com/ai-sdlc-framework/ai-sdlc/issues/429)) ([8ea17dc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8ea17dcad9782ee98fc13424dd8fb0f81bf4a356))
* **orchestrator:** rollback event payload + ms-precision quarantine refs (AISDLC-186) ([f8f7fe3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f8f7fe38ba0f86680e6e7a3bd265f21634895774))
* **orchestrator:** rollback task status + sweep worktree on developer-failed (AISDLC-177) ([04ed1b1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/04ed1b15cf49d1bb89430b034004a267beed7446))
* **orchestrator:** step 4 beginTask targets worktree, not parent checkout (AISDLC-199) ([#336](https://github.com/ai-sdlc-framework/ai-sdlc/issues/336)) ([db8d492](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db8d4929e16e48ee1c66099264a8c35d221d7ee3))
* **orchestrator:** tick reverts to legacy direct-spawner default until AISDLC-225 ships (AISDLC-240) ([#398](https://github.com/ai-sdlc-framework/ai-sdlc/issues/398)) ([32cf576](https://github.com/ai-sdlc-framework/ai-sdlc/commit/32cf5763c1aacb832600314a38fa4f5a70e76df3))
* **orchestrator:** track in-flight dispatches to prevent concurrent re-dispatch (AISDLC-179) ([df274e1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/df274e18a06a6969fa5d3c116fa2a13cc1a286a3))
* **orchestrator:** wire onDeveloperContractRetry through Step 9 iteration loop (AISDLC-184) ([3ad8475](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3ad84752077b2cf47d96cd969f36603c6d995f94))
* **orchestrator:** worktree mutex serializes git ops to prevent .git/config.lock races (AISDLC-241) ([#409](https://github.com/ai-sdlc-framework/ai-sdlc/issues/409)) ([1d0184b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1d0184b8aef246b68feba52e7b7b1178c60ef786))
* **pipeline-cli:** gh-pr-cache fast-recovery on transient failures (AISDLC-187) ([01d6a50](https://github.com/ai-sdlc-framework/ai-sdlc/commit/01d6a50c516dc0c40b1cc11659ce78deee725424))
* **pipeline-cli:** require explicit run for execute dispatch ([#328](https://github.com/ai-sdlc-framework/ai-sdlc/issues/328)) ([7f7ad3f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7f7ad3f4b7b7b13a40f76db42136160f6908b652))
* sweep squash-merged worktrees via --state all query (AISDLC-204) ([#349](https://github.com/ai-sdlc-framework/ai-sdlc/issues/349)) ([714606c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/714606c6334c53a38b0b48356e3da056cd154e4e))
* **tui:** remove hardcoded fixed-width dividers that overflow pane borders (AISDLC-254) ([#430](https://github.com/ai-sdlc-framework/ai-sdlc/issues/430)) ([658ed9b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/658ed9b7741f3b79ac332570b5aa11c6267b7b1c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.10.0
