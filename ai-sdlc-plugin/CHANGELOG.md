# Changelog

<!-- CHANGELOG is maintained by release-please. Do NOT manually add an
     Unreleased section — release-please accumulates all changes from
     conventional-commit messages and prepends a dated section when the
     rolling release PR lands. See docs/operations/release-flow.md. -->

## [0.11.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.10.0...ai-sdlc-plugin-v0.11.0) (2026-06-10)


### Features

* AISDLC-464 remaining gaps — execute.md lib sourcing, schema tightening, drift guard ([#805](https://github.com/ai-sdlc-framework/ai-sdlc/issues/805)) ([7bb2191](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7bb2191b7a62f89fd7f123a9cd25cb30c6161f63))
* AISDLC-480 surface dispatched-session decisions to Decision Catalog (async escape hatch) ([#830](https://github.com/ai-sdlc-framework/ai-sdlc/issues/830)) ([80cd5a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/80cd5a7efb5a336be15aa310a5b2ae8075dc6c55))
* AISDLC-481 dispatch-session heartbeat reaper + cancel back-channel (v1 cancel-only) ([#827](https://github.com/ai-sdlc-framework/ai-sdlc/issues/827)) ([9adc050](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9adc0502d748770591e0af956027c8ff9c188e1f))
* AISDLC-483 default code/test review to Codex harness (cost control) ([#826](https://github.com/ai-sdlc-framework/ai-sdlc/issues/826)) ([6ff5c39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ff5c392d9e0c639e60d67b790be56b167841d2e))
* **orchestrator:** AISDLC-449 reverify cached blockers before extending passive heartbeat ([#804](https://github.com/ai-sdlc-framework/ai-sdlc/issues/804)) ([93c3671](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93c3671fcd6701106538875d02d973f5e55af981))
* rfc-0043 phase 4 — hardened reviewer matrix + prompt-injection hardening (AISDLC-500) ([#846](https://github.com/ai-sdlc-framework/ai-sdlc/issues/846)) ([886d640](https://github.com/ai-sdlc-framework/ai-sdlc/commit/886d640c9a27b4a1e1d04217f742787c36164b65))


### Bug Fixes

* AISDLC-482 guard rm -rf on possibly-empty path vars (autonomous-run safety) ([#823](https://github.com/ai-sdlc-framework/ai-sdlc/issues/823)) ([afb54d9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afb54d94fc6c86a66c7b1f7e1ef7e48abfafba4e))
* AISDLC-485 execute-parallel spawned sessions don't hang on permission prompts (DEC-0009 opt-in) ([#822](https://github.com/ai-sdlc-framework/ai-sdlc/issues/822)) ([ddaa78d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ddaa78df1467023b82abaadd8d147c358db5035e))
* AISDLC-486 dev subagent updates inbound refs on rename (avoid Backlog Drift stall) ([#829](https://github.com/ai-sdlc-framework/ai-sdlc/issues/829)) ([ae8c7a1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae8c7a13dd57aec838ebcf844a52a765c7f689a5))
* **plugin:** rename /ai-sdlc:review command to review-pr (AISDLC-474) ([#789](https://github.com/ai-sdlc-framework/ai-sdlc/issues/789)) ([a09b87d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a09b87d6c5a7abe7e65f1ef9826cdb9b30058472))
* robustness follow-ups to execute-parallel wrapper (AISDLC-464) ([#773](https://github.com/ai-sdlc-framework/ai-sdlc/issues/773)) ([3938e5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3938e5cd33265dfbec329735bf27ed415d99cccf))

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/ai-sdlc-plugin-v0.9.2...ai-sdlc-plugin-v0.10.0) (2026-05-28)


### Features

* add /ai-sdlc execute-parallel tmux wrapper (AISDLC-462) ([#764](https://github.com/ai-sdlc-framework/ai-sdlc/issues/764)) ([dda8c5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dda8c5c5edee0d29775c870f6226534ddc7582b7))
* ai-sdlc rfc init scaffold + framework-rfc template (AISDLC-327) ([#751](https://github.com/ai-sdlc-framework/ai-sdlc/issues/751)) ([0221d88](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0221d883b98b764cfa4d981fe64f8182c6e49a8b))
* **attestation:** reviewer-side signed sub-attestations — partial closure of 2026-05-20 forgery hole (AISDLC-380) ([#580](https://github.com/ai-sdlc-framework/ai-sdlc/issues/580)) ([1568606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1568606d2f4e8f7c4c5e3b15df8be11140f88f68))
* **ci:** changelog.md owned by release-please; warn on feature-branch edits (AISDLC-401) ([#637](https://github.com/ai-sdlc-framework/ai-sdlc/issues/637)) ([1779ed5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1779ed5dc2f4b31d1ae021ed0ae058527c0a3e6c))
* **ci:** content-address envelope filenames via git patch-id (AISDLC-398) ([#632](https://github.com/ai-sdlc-framework/ai-sdlc/issues/632)) ([b15e312](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b15e31238e25aad0c411dd863421458ae99ad5fe))
* **ci:** flaky-test convention + nightly workflow + pre-commit short-circuit (AISDLC-371 reopen) ([#561](https://github.com/ai-sdlc-framework/ai-sdlc/issues/561)) ([21e3f2d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/21e3f2d5a9d7aed7a475b49f7a87f831b2f9eb9c))
* **ci:** sign MCP server npm tarball SHA in DSSE attestation (AISDLC-439) ([#738](https://github.com/ai-sdlc-framework/ai-sdlc/issues/738)) ([e327127](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e3271274f7d4c727d9b37ca9d92c67c1a29fdc85))
* **deps:** frontier dispatch-readiness rubric (AISDLC-451) ([#746](https://github.com/ai-sdlc-framework/ai-sdlc/issues/746)) ([af36f9f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af36f9fdfec8ebcd4a22f4ef44dd3a5276975d28))
* **dispatch:** RFC-0041 Phase 1.5 — iteration mechanism (Conductor-triggered, Worker-driven session resumption) [needs-human-attention] (AISDLC-377.2) ([#586](https://github.com/ai-sdlc-framework/ai-sdlc/issues/586)) ([8dfcfa0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8dfcfa03a6de7e6d6158c4780f233aba2296c2f7))
* **docs:** agentic scope-creep prevention guardrails (AISDLC-308) ([#630](https://github.com/ai-sdlc-framework/ai-sdlc/issues/630)) ([705fef8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/705fef8da784a890c5885547be81e262e7ea4c5b))
* **docs:** prohibit subagent inline OQ resolution + add reviewer check (AISDLC-298) ([#540](https://github.com/ai-sdlc-framework/ai-sdlc/issues/540)) ([fb55bad](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fb55badb5c7fbf6cb2f38918baf30addb45df685))
* emit transcript leaves after reviewer runs (AISDLC-383.8) ([#602](https://github.com/ai-sdlc-framework/ai-sdlc/issues/602)) ([87fc52b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87fc52b2b8f31270eba9a96aaff5e56640a27aca))
* **execute:** accept GH issue numbers (Option A: inline TaskSpec + sourceKind) (AISDLC-393, closes [#612](https://github.com/ai-sdlc-framework/ai-sdlc/issues/612)) ([#620](https://github.com/ai-sdlc-framework/ai-sdlc/issues/620)) ([ca72663](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ca726635122417a890c29a5be2a72852164f7e8d))
* **orchestrator:** add compliance-posture wizard step to ai-sdlc init (AISDLC-324) ([#546](https://github.com/ai-sdlc-framework/ai-sdlc/issues/546)) ([dbeaac2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbeaac229555dbc5ba79099f1c158bb00fd42fae))
* **orchestrator:** ci-triggered PR conflict-resolver agent (AISDLC-460) ([#761](https://github.com/ai-sdlc-framework/ai-sdlc/issues/761)) ([f84c3e1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f84c3e186c8b9feb824fa64b1e4edd6925d8b711))
* **orchestrator:** contentHashV5 — delta-hash with embedded signedMergeBase (AISDLC-362) ([#535](https://github.com/ai-sdlc-framework/ai-sdlc/issues/535)) ([8455935](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8455935e9a476be8e005623b35c417e7a8911e35))
* **orchestrator:** default spawner = claude + ANTHROPIC_API_KEY warning (AISDLC-352) ([#532](https://github.com/ai-sdlc-framework/ai-sdlc/issues/532)) ([7863ca2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7863ca2e41a3aaeb2ec8ebabf9bf6e7eeee40daf))
* **orchestrator:** flip v6 attestation default-ON (AISDLC-409) ([#641](https://github.com/ai-sdlc-framework/ai-sdlc/issues/641)) ([1640698](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1640698a36634ba31f0521ac449dbcae3943e3d0))
* **orchestrator:** Pattern X — dev pushes, Conductor reconciles (AISDLC-396) ([#621](https://github.com/ai-sdlc-framework/ai-sdlc/issues/621)) ([dae8a58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dae8a588739c81c6a645f26a2c903da692c70609))
* **orchestrator:** prune stale parent debris when task ID in completed (AISDLC-446) ([#735](https://github.com/ai-sdlc-framework/ai-sdlc/issues/735)) ([9a7f4b5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9a7f4b5c7476088abab3e6e4c8b18a3bfe66bbd6))
* **orchestrator:** reconcile sub-tick + reviewer-pass cache (AISDLC-418) ([#662](https://github.com/ai-sdlc-framework/ai-sdlc/issues/662)) ([8bbb777](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8bbb77796b30fd40b9f2686c8964df384cf0c958))
* **orchestrator:** rfc-0016 phase 5 — per-class bias + 3-state token + pr-comment (AISDLC-283) ([#522](https://github.com/ai-sdlc-framework/ai-sdlc/issues/522)) ([c76c443](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c76c44303e248b671fef2b344f61aa9e9d71b9d8))
* **orchestrator:** rfc-0036 phase 4 — cli-import-spec spec-kit bridge (AISDLC-329) ([#668](https://github.com/ai-sdlc-framework/ai-sdlc/issues/668)) ([f935954](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f935954c817d1bd41125ede01e58267436affc1b))
* Phase 1 transcript capture in reviewer subagents (AISDLC-383.1) ([#593](https://github.com/ai-sdlc-framework/ai-sdlc/issues/593)) ([bc55b5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc55b5c5c2c5dd72f7840005f1171748a51390c4))
* **pipeline-cli:** RFC-0035 Phase 1 — Decision resource schema + cli-decisions {list, show, add} (AISDLC-285) ([#504](https://github.com/ai-sdlc-framework/ai-sdlc/issues/504)) ([019cdfe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/019cdfe265a3301580c003c06a792d6e1ef89c03))
* **spec:** add dispatch board protocol + in-session-agent worker (AISDLC-377.1) ([#576](https://github.com/ai-sdlc-framework/ai-sdlc/issues/576)) ([0685b95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0685b9512661fb6c9fe29b41dc6f70216b7a345c))
* v6 envelope schema + signer (RFC-0042 phase 2) (AISDLC-383.3) ([#598](https://github.com/ai-sdlc-framework/ai-sdlc/issues/598)) ([666858d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/666858d89a7f7149dde5d1ab63296fe3568d7be2))


### Bug Fixes

* **attestation:** exclude transcript-leaves/ from patch-id (AISDLC-422) ([#680](https://github.com/ai-sdlc-framework/ai-sdlc/issues/680)) ([a42309e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a42309e8503996518785f38b3d76affd36d7f15a))
* **ci:** prevent stale-envelope accumulation across queue rebases (AISDLC-274) ([#490](https://github.com/ai-sdlc-framework/ai-sdlc/issues/490)) ([e78b0a0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e78b0a029972c3ade9f5adce1d8624675e7ea7e1))
* emit hookEventName in session-start + subagent-start hooks (AISDLC-382) ([#585](https://github.com/ai-sdlc-framework/ai-sdlc/issues/585)) ([bb94edd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bb94edde0fe11c0943c3c8c82ec8d7ec67076d7e))
* heal plugin install via session-start hook + parse runtimeDependencies (AISDLC-441) ([#719](https://github.com/ai-sdlc-framework/ai-sdlc/issues/719)) ([790e38b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/790e38bf9d7fb288f3ed5f968cb1e3780d6646d2))
* make /ai-sdlc execute portable to adopter projects (AISDLC-272) ([#482](https://github.com/ai-sdlc-framework/ai-sdlc/issues/482)) ([98b5a51](https://github.com/ai-sdlc-framework/ai-sdlc/commit/98b5a51b0a386daf7128f251797a354b71df345d))
* **orchestrator:** add OpenPullRequestExists filter to close deadlock (AISDLC-361) ([#534](https://github.com/ai-sdlc-framework/ai-sdlc/issues/534)) ([09d78be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09d78be549eb5cab6d2ba7289183d0bdf100a4ee))
* **orchestrator:** address PR [#576](https://github.com/ai-sdlc-framework/ai-sdlc/issues/576) unaddressed majors + file AISDLC-380 governance task (AISDLC-377.1) ([#577](https://github.com/ai-sdlc-framework/ai-sdlc/issues/577)) ([87aab49](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87aab494b340e43c38d0dfc64e3d5d0943cd1ba0))
* **orchestrator:** auto-rearm after force-push + branch-slug helper (AISDLC-356) ([#533](https://github.com/ai-sdlc-framework/ai-sdlc/issues/533)) ([6a36c62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6a36c62deb4c233bda989bea952b8fbf42188670))
* **orchestrator:** init auto-yields to defaults in non-TTY contexts (AISDLC-263) ([#472](https://github.com/ai-sdlc-framework/ai-sdlc/issues/472)) ([cf8996d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf8996d53425ca8f101355d1c01b38efa34dfb9e))
* **orchestrator:** pipeline error propagation + PR auto-promote + gh PATH detection (AISDLC-354) ([#531](https://github.com/ai-sdlc-framework/ai-sdlc/issues/531)) ([b365b2b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b365b2bcbd701e14e39f5b0b6fb1777d6b9cdd56))
* **orchestrator:** resume-from-draft stale verdict + verdict shape + degenerate retry (AISDLC-355) ([#527](https://github.com/ai-sdlc-framework/ai-sdlc/issues/527)) ([117f4b9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/117f4b9f33b23b3df4c4ffdea6aa32c43a6416fb))
* **plugin:** skill-body env gates match AISDLC-411 default-ON polarity ([#645](https://github.com/ai-sdlc-framework/ai-sdlc/issues/645)) ([f125a5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f125a5c861148b9152584efb810697b1982fb6da))
* remove AISDLC-215 docs-only auto-approve synthesis (AISDLC-387) ([#603](https://github.com/ai-sdlc-framework/ai-sdlc/issues/603)) ([af70882](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af708826e4f4139485450f2acb566b55f876814b))

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
