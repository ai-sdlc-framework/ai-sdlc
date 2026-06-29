# Changelog

## [0.14.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.13.0...pipeline-cli-v0.14.0) (2026-06-29)


### Features

* **orchestrator:** dispatch→merge lifecycle profiling instrumentation (AISDLC-493) ([#909](https://github.com/ai-sdlc-framework/ai-sdlc/issues/909)) ([906f53a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/906f53a9ae2a05389b623873f58e0642de4d1578))


### Bug Fixes

* de-flake capture.test.ts against-current-pr graceful fallback (AISDLC-533) ([#902](https://github.com/ai-sdlc-framework/ai-sdlc/issues/902)) ([40d652f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/40d652f1a15e36600357d5f8efc4e6519a6f826d))
* **security:** resolve CodeQL source-code findings — ReDoS, cmd-injection, sanitization (AISDLC-535) ([#913](https://github.com/ai-sdlc-framework/ai-sdlc/issues/913)) ([64f0165](https://github.com/ai-sdlc-framework/ai-sdlc/commit/64f016554ee1cea21cef4ca86c89af1332dd9df9))
* stop pipeline-cli test runs leaving _artifacts/ and mutating classifier-corpus (AISDLC-518) ([#907](https://github.com/ai-sdlc-framework/ai-sdlc/issues/907)) ([bd5605e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bd5605e904d2cddc1419f0513ee47b137379973f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.14.0

## [0.13.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.12.0...pipeline-cli-v0.13.0) (2026-06-10)


### Features

* AISDLC-480 surface dispatched-session decisions to Decision Catalog (async escape hatch) ([#830](https://github.com/ai-sdlc-framework/ai-sdlc/issues/830)) ([80cd5a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/80cd5a7efb5a336be15aa310a5b2ae8075dc6c55))
* AISDLC-481 dispatch-session heartbeat reaper + cancel back-channel (v1 cancel-only) ([#827](https://github.com/ai-sdlc-framework/ai-sdlc/issues/827)) ([9adc050](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9adc0502d748770591e0af956027c8ff9c188e1f))
* AISDLC-483 default code/test review to Codex harness (cost control) ([#826](https://github.com/ai-sdlc-framework/ai-sdlc/issues/826)) ([6ff5c39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ff5c392d9e0c639e60d67b790be56b167841d2e))
* **ci:** wire RFC-0043 AQ2 InferenceProxy in sandbox-run (AISDLC-520) ([#868](https://github.com/ai-sdlc-framework/ai-sdlc/issues/868)) ([b23d87d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b23d87d4a3acaa296cf881c36e9f3335f3f011ee))
* cli-decisions priority/timebox/resolve/auto-expire — AISDLC-463 core slice ([#797](https://github.com/ai-sdlc-framework/ai-sdlc/issues/797)) ([631d6de](https://github.com/ai-sdlc-framework/ai-sdlc/commit/631d6de22b208f382284887d107e634385d6b123))
* inference.local credential-withholding proxy (AISDLC-510) ([#858](https://github.com/ai-sdlc-framework/ai-sdlc/issues/858)) ([19f3583](https://github.com/ai-sdlc-framework/ai-sdlc/commit/19f358306987b35dac281233935af2e416a6a827))
* **orchestrator:** AISDLC-449 reverify cached blockers before extending passive heartbeat ([#804](https://github.com/ai-sdlc-framework/ai-sdlc/issues/804)) ([93c3671](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93c3671fcd6701106538875d02d973f5e55af981))
* **orchestrator:** instrument parallel-dispatch profiling (AISDLC-479) ([#774](https://github.com/ai-sdlc-framework/ai-sdlc/issues/774)) ([424372e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/424372e06213ab295c0c592a6a371d79fd60293e))
* real DockerSandboxDriver — isolation, enforcement, teardown (AISDLC-508) ([#857](https://github.com/ai-sdlc-framework/ai-sdlc/issues/857)) ([5d01aad](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5d01aad169beb5079c55f637a2cee5421512985a))
* rfc-0043 phase 1 — trust classifier + AST gate + drift workflow (AISDLC-497) ([#843](https://github.com/ai-sdlc-framework/ai-sdlc/issues/843)) ([a94dad8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a94dad812787474760c77f1293c32279a4686faa))
* rfc-0043 phase 2 — report schema + Zod validator + clean-room signer (AISDLC-498) ([#844](https://github.com/ai-sdlc-framework/ai-sdlc/issues/844)) ([e615cb0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e615cb056ecc629372b861c51da6314fdb5c8ce3))
* rfc-0043 phase 3 — sandbox runner + driver abstraction + resource limits (AISDLC-499) ([#845](https://github.com/ai-sdlc-framework/ai-sdlc/issues/845)) ([7eeced5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7eeced5d9847cd6bb0d0588d9cd4d8f592a33b68))
* rfc-0043 phase 4 — hardened reviewer matrix + prompt-injection hardening (AISDLC-500) ([#846](https://github.com/ai-sdlc-framework/ai-sdlc/issues/846)) ([886d640](https://github.com/ai-sdlc-framework/ai-sdlc/commit/886d640c9a27b4a1e1d04217f742787c36164b65))
* rfc-0043 phase 5 — untrusted-pr-gate workflow + flag + degradation (AISDLC-501) ([#847](https://github.com/ai-sdlc-framework/ai-sdlc/issues/847)) ([5927c3d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5927c3d2cf7b839cdc35f97c2949862b558d777e))
* rfc-0043 phase 7 — differential test execution in sandbox (AISDLC-509) ([#859](https://github.com/ai-sdlc-framework/ai-sdlc/issues/859)) ([68b84a2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68b84a24ba8a33a0a6b2ad5a87db66be4ad0a553))
* rfc-0043 phase 7 — in-sandbox reviewer execution + real verdicts (AISDLC-511) ([#860](https://github.com/ai-sdlc-framework/ai-sdlc/issues/860)) ([fd2ecde](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd2ecde8ba5b899e3513f7de140a8352e417562a))
* rfc-0043 phase 7 integration glue and resolveModelClient hard error (AISDLC-512) ([#861](https://github.com/ai-sdlc-framework/ai-sdlc/issues/861)) ([44afbb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/44afbb28791b84dc179bd106a35ddd6d09e111fc))


### Bug Fixes

* AISDLC-482 guard rm -rf on possibly-empty path vars (autonomous-run safety) ([#823](https://github.com/ai-sdlc-framework/ai-sdlc/issues/823)) ([afb54d9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afb54d94fc6c86a66c7b1f7e1ef7e48abfafba4e))
* **ci:** AISDLC-475 remove per-SHA v6 attestation bridge — kill the re-sign loop ([#808](https://github.com/ai-sdlc-framework/ai-sdlc/issues/808)) ([e2f17ad](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e2f17ad5a3d2c6ea7faae4efefa2b0e921f72265))
* harden 17 ReDoS-prone regexes (CodeQL js/polynomial-redos) ([#820](https://github.com/ai-sdlc-framework/ai-sdlc/issues/820)) ([070864e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/070864e01bddd88d6fa3175cd80c59792b52318e))
* **orchestrator:** anchor **/ glob prefix to separator boundary (AISDLC-505) ([#855](https://github.com/ai-sdlc-framework/ai-sdlc/issues/855)) ([2ca1bc4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2ca1bc46deae1148542e5595b91759115483ac75))
* **orchestrator:** narrow DoR Gate 7 regex to dep-phrase + tracked-work-id pairs (AISDLC-457) ([#748](https://github.com/ai-sdlc-framework/ai-sdlc/issues/748)) ([4308763](https://github.com/ai-sdlc-framework/ai-sdlc/commit/430876332fa2d93d92cb88623eb9623c97ebd2fd))
* **RFC-0043:** port fork-proven UCVG AQ2 fixes to ai-sdlc main (AISDLC-522) ([#871](https://github.com/ai-sdlc-framework/ai-sdlc/issues/871)) ([d6010dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d6010dd22acd25a8483e2272db9b42d1975817a2))
* **security:** harden command-injection sites (CodeQL js/shell-command-constructed-from-input) ([#812](https://github.com/ai-sdlc-framework/ai-sdlc/issues/812)) ([be944e9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be944e92bd262172408223dbc999a9504e02e8fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.13.0

## [0.12.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.11.0...pipeline-cli-v0.12.0) (2026-05-29)


### Miscellaneous

* **pipeline-cli:** Synchronize node-packages versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.12.0

## [0.11.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.10.0...pipeline-cli-v0.11.0) (2026-05-28)


### Features

* add --timebox flag to cli-decisions for urgency escalation (AISDLC-447) ([#747](https://github.com/ai-sdlc-framework/ai-sdlc/issues/747)) ([efa0c82](https://github.com/ai-sdlc-framework/ai-sdlc/commit/efa0c8297b0ebf0a39e5913273949c0a15e84345))
* add /ai-sdlc execute-parallel tmux wrapper (AISDLC-462) ([#764](https://github.com/ai-sdlc-framework/ai-sdlc/issues/764)) ([dda8c5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dda8c5c5edee0d29775c870f6226534ddc7582b7))
* add cli-compliance-audit export CLI + deterministic .tar.gz bundle (AISDLC-325) ([#651](https://github.com/ai-sdlc-framework/ai-sdlc/issues/651)) ([25feb30](https://github.com/ai-sdlc-framework/ai-sdlc/commit/25feb302de5f9c6cccecfbe6c66377ceb5d64067))
* ai-sdlc rfc init scaffold + framework-rfc template (AISDLC-327) ([#751](https://github.com/ai-sdlc-framework/ai-sdlc/issues/751)) ([0221d88](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0221d883b98b764cfa4d981fe64f8182c6e49a8b))
* allow orchestrator Codex spawner selection (AISDLC-326) ([#497](https://github.com/ai-sdlc-framework/ai-sdlc/issues/497)) ([b38f429](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b38f4292c971f0fd013a1f994e8676341aeca2f2))
* **ci:** content-address envelope filenames via git patch-id (AISDLC-398) ([#632](https://github.com/ai-sdlc-framework/ai-sdlc/issues/632)) ([b15e312](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b15e31238e25aad0c411dd863421458ae99ad5fe))
* **ci:** flaky-test convention + nightly workflow + pre-commit short-circuit (AISDLC-371 reopen) ([#561](https://github.com/ai-sdlc-framework/ai-sdlc/issues/561)) ([21e3f2d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/21e3f2d5a9d7aed7a475b49f7a87f831b2f9eb9c))
* **cli-deps:** RFC-0041 Phase 3.2 — recommendedWorkerKind annotation (AISDLC-377.5) ([#591](https://github.com/ai-sdlc-framework/ai-sdlc/issues/591)) ([724df65](https://github.com/ai-sdlc-framework/ai-sdlc/commit/724df65721318851763d276d1ecfd07ca3033400))
* **deps:** frontier dispatch-readiness rubric (AISDLC-451) ([#746](https://github.com/ai-sdlc-framework/ai-sdlc/issues/746)) ([af36f9f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af36f9fdfec8ebcd4a22f4ef44dd3a5276975d28))
* **deps:** promote AI_SDLC_DEPS_COMPOSITION default-ON (AISDLC-410) ([#642](https://github.com/ai-sdlc-framework/ai-sdlc/issues/642)) ([154639b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/154639ba182066beb193ee83b10d6b0528ad9976))
* **dispatch:** RFC-0041 Phase 1.5 — iteration mechanism (Conductor-triggered, Worker-driven session resumption) [needs-human-attention] (AISDLC-377.2) ([#586](https://github.com/ai-sdlc-framework/ai-sdlc/issues/586)) ([8dfcfa0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8dfcfa03a6de7e6d6158c4780f233aba2296c2f7))
* **docs:** agentic scope-creep prevention guardrails (AISDLC-308) ([#630](https://github.com/ai-sdlc-framework/ai-sdlc/issues/630)) ([705fef8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/705fef8da784a890c5885547be81e262e7ea4c5b))
* **docs:** prohibit subagent inline OQ resolution + add reviewer check (AISDLC-298) ([#540](https://github.com/ai-sdlc-framework/ai-sdlc/issues/540)) ([fb55bad](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fb55badb5c7fbf6cb2f38918baf30addb45df685))
* emit transcript leaves after reviewer runs (AISDLC-383.8) ([#602](https://github.com/ai-sdlc-framework/ai-sdlc/issues/602)) ([87fc52b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87fc52b2b8f31270eba9a96aaff5e56640a27aca))
* **execute:** accept GH issue numbers (Option A: inline TaskSpec + sourceKind) (AISDLC-393, closes [#612](https://github.com/ai-sdlc-framework/ai-sdlc/issues/612)) ([#620](https://github.com/ai-sdlc-framework/ai-sdlc/issues/620)) ([ca72663](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ca726635122417a890c29a5be2a72852164f7e8d))
* **hooks:** pre-push DoR gate (AISDLC-370) ([#565](https://github.com/ai-sdlc-framework/ai-sdlc/issues/565)) ([6814cdf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6814cdf21e3a077e14dacb2bd604cd1201fd5552))
* **orchestrator:** add --spawner claude (real shell-out to claude -p) (AISDLC-349) ([#510](https://github.com/ai-sdlc-framework/ai-sdlc/issues/510)) ([36eeac2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/36eeac2cb9d1a4e9ba698761f46bc8a45aaf2194))
* **orchestrator:** add compliance-posture wizard step to ai-sdlc init (AISDLC-324) ([#546](https://github.com/ai-sdlc-framework/ai-sdlc/issues/546)) ([dbeaac2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbeaac229555dbc5ba79099f1c158bb00fd42fae))
* **orchestrator:** add CopilotHarnessAdapter and --spawner copilot resolver (AISDLC-429.2) ([#740](https://github.com/ai-sdlc-framework/ai-sdlc/issues/740)) ([932db71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/932db7132869ed78466ac84d11f8af0b251d9164))
* **orchestrator:** add HC_cost admission channel per RFC-0009 §7.4 (AISDLC-318) ([#649](https://github.com/ai-sdlc-framework/ai-sdlc/issues/649)) ([c7e1a4e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7e1a4ef5e2097bb4ea66289a508086e2e28bb94))
* **orchestrator:** add JSONL vector storage + cli-embedding-gc (AISDLC-338) ([#660](https://github.com/ai-sdlc-framework/ai-sdlc/issues/660)) ([3f4d9d4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3f4d9d438bccb92f565dd0989cf7a68bfe61fbda))
* **orchestrator:** add resume-from-draft + rework-pr recovery paths (AISDLC-273) ([#489](https://github.com/ai-sdlc-framework/ai-sdlc/issues/489)) ([39acbcb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39acbcb4fd44650cbbbeace5bbaf2e6772998bac))
* **orchestrator:** ci-triggered PR conflict-resolver agent (AISDLC-460) ([#761](https://github.com/ai-sdlc-framework/ai-sdlc/issues/761)) ([f84c3e1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f84c3e186c8b9feb824fa64b1e4edd6925d8b711))
* **orchestrator:** cli-embedding-bump + stale-vector + deprecation lifecycle (AISDLC-339) ([#688](https://github.com/ai-sdlc-framework/ai-sdlc/issues/688)) ([a953222](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a9532224aa55f9743b5ab3763f96310750baf231))
* **orchestrator:** decisions-pending TUI pane + multi-surface notify (AISDLC-292) ([#541](https://github.com/ai-sdlc-framework/ai-sdlc/issues/541)) ([86facd2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/86facd2eca7006ee302e7704e645e946995d87b1))
* **orchestrator:** default spawner = claude + ANTHROPIC_API_KEY warning (AISDLC-352) ([#532](https://github.com/ai-sdlc-framework/ai-sdlc/issues/532)) ([7863ca2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7863ca2e41a3aaeb2ec8ebabf9bf6e7eeee40daf))
* **orchestrator:** flip v6 attestation default-ON (AISDLC-409) ([#641](https://github.com/ai-sdlc-framework/ai-sdlc/issues/641)) ([1640698](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1640698a36634ba31f0521ac449dbcae3943e3d0))
* **orchestrator:** harden estimation log + cache for Phase-5 concurrency (AISDLC-328) ([#661](https://github.com/ai-sdlc-framework/ai-sdlc/issues/661)) ([8f55cb7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f55cb7cf86fe0c38637cb710ef7d1ccea1b4044))
* **orchestrator:** Pattern X — dev pushes, Conductor reconciles (AISDLC-396) ([#621](https://github.com/ai-sdlc-framework/ai-sdlc/issues/621)) ([dae8a58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dae8a588739c81c6a645f26a2c903da692c70609))
* **orchestrator:** promote AI_SDLC_AUTONOMOUS_ORCHESTRATOR default-ON (AISDLC-411) ([#644](https://github.com/ai-sdlc-framework/ai-sdlc/issues/644)) ([4fa6041](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4fa604171768228d54497aa7a250cae5ccf0a1c5))
* **orchestrator:** prune stale parent debris when task ID in completed (AISDLC-446) ([#735](https://github.com/ai-sdlc-framework/ai-sdlc/issues/735)) ([9a7f4b5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9a7f4b5c7476088abab3e6e4c8b18a3bfe66bbd6))
* **orchestrator:** reconcile sub-tick + reviewer-pass cache (AISDLC-418) ([#662](https://github.com/ai-sdlc-framework/ai-sdlc/issues/662)) ([8bbb777](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8bbb77796b30fd40b9f2686c8964df384cf0c958))
* **orchestrator:** RFC-0016 Phase 4 — Stage B LLM tie-breaker + Q5 ensemble (AISDLC-282) ([#514](https://github.com/ai-sdlc-framework/ai-sdlc/issues/514)) ([53efd12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/53efd12c2707f9d47083f7d22a4623f376e39abf))
* **orchestrator:** rfc-0016 phase 5 — per-class bias + 3-state token + pr-comment (AISDLC-283) ([#522](https://github.com/ai-sdlc-framework/ai-sdlc/issues/522)) ([c76c443](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c76c44303e248b671fef2b344f61aa9e9d71b9d8))
* **orchestrator:** rfc-0025 phase 5 coverage-gap + determinism + op-time-cost (AISDLC-306) ([#665](https://github.com/ai-sdlc-framework/ai-sdlc/issues/665)) ([d0e5307](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d0e5307ee6a560ecb5a29cf50f85e6b7da855c79))
* **orchestrator:** RFC-0025 refit phase 1 — quality monitoring substrate salvage (AISDLC-302) ([#550](https://github.com/ai-sdlc-framework/ai-sdlc/issues/550)) ([aeb5de9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aeb5de995a999d9e21474a61fc02d1422940d2c5))
* **orchestrator:** rfc-0036 phase 4 — cli-import-spec spec-kit bridge (AISDLC-329) ([#668](https://github.com/ai-sdlc-framework/ai-sdlc/issues/668)) ([f935954](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f935954c817d1bd41125ede01e58267436affc1b))
* **orchestrator:** rfc-0036 phase 5 dor gate at import (AISDLC-330) ([#670](https://github.com/ai-sdlc-framework/ai-sdlc/issues/670)) ([2520a13](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2520a132d0c7c0c6a28747885ac002e94f3f4d9e))
* **orchestrator:** RFC-0041 Phase 2 — supervisor daemon + claude-p-shell Worker (AISDLC-377.3) ([#588](https://github.com/ai-sdlc-framework/ai-sdlc/issues/588)) ([e14bbc9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e14bbc9e8d5b54695da0d6adf5069a9315e33b30))
* **orchestrator:** warn on legacy --spawner claude-cli (AISDLC-377.4) ([#590](https://github.com/ai-sdlc-framework/ai-sdlc/issues/590)) ([c44fc87](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c44fc87425383869eea131f3a897f92572ce2af1))
* **orchestrator:** wire --spawner copilot through umbrella + operator docs (AISDLC-429.3) ([#759](https://github.com/ai-sdlc-framework/ai-sdlc/issues/759)) ([7430cd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7430cd635c9922850dde583e6615896d24f9311d))
* **orchestrator:** wire emitDorDecisions into DorReadiness filter (AISDLC-395) ([#616](https://github.com/ai-sdlc-framework/ai-sdlc/issues/616)) ([6c82370](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c823706b2b3fb97784e28938447b10e8d480a44))
* **orchestrator:** wire RFC-0019 phase 4 pipeline schema + embedding load (AISDLC-340) ([#690](https://github.com/ai-sdlc-framework/ai-sdlc/issues/690)) ([cd8425f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cd8425fc0d4163d87ec21d9e67be28febe51ae58))
* Phase 1 Merkle leaf index + root computation (AISDLC-383.2) ([#594](https://github.com/ai-sdlc-framework/ai-sdlc/issues/594)) ([ef183d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ef183d7a13d51d5840372efc616406c6ea460655))
* Phase 1 transcript capture in reviewer subagents (AISDLC-383.1) ([#593](https://github.com/ai-sdlc-framework/ai-sdlc/issues/593)) ([bc55b5c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc55b5c5c2c5dd72f7840005f1171748a51390c4))
* **pipeline-cli:** RFC-0035 Phase 1 — Decision resource schema + cli-decisions {list, show, add} (AISDLC-285) ([#504](https://github.com/ai-sdlc-framework/ai-sdlc/issues/504)) ([019cdfe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/019cdfe265a3301580c003c06a792d6e1ef89c03))
* **quality:** RFC-0025 refit phase 3 — multi-window recurrence + first-capture MTTR (AISDLC-304) ([#566](https://github.com/ai-sdlc-framework/ai-sdlc/issues/566)) ([a084c68](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a084c68122fe259fc86180e34a69b06259dc4141))
* RFC-0011 DoR upstream-OQ gate (AISDLC-296) ([#507](https://github.com/ai-sdlc-framework/ai-sdlc/issues/507)) ([8332994](https://github.com/ai-sdlc-framework/ai-sdlc/commit/83329947a4fa0987968a06d7ca99b72945c5a725))
* RFC-0016 Phase 1 — Stage A signals + class-default fallback (AISDLC-279) ([#495](https://github.com/ai-sdlc-framework/ai-sdlc/issues/495)) ([5c8dd02](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5c8dd02163f81e00ba439eb00ef4acaf6d997661))
* RFC-0016 Phase 2 — estimate log writer + class cache (AISDLC-280) ([#498](https://github.com/ai-sdlc-framework/ai-sdlc/issues/498)) ([023e845](https://github.com/ai-sdlc-framework/ai-sdlc/commit/023e8454479ad452e19ba4273f8fab958e8f7f1f))
* RFC-0016 Phase 3 — measurement + monthly-rotated calibration writer (AISDLC-281) ([#508](https://github.com/ai-sdlc-framework/ai-sdlc/issues/508)) ([bedec2e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bedec2e3c0b40cf097ad9f05fc27b8d444016619))
* rfc-0016 phase 6 — soak + drift detection + class proposals (AISDLC-284) ([#524](https://github.com/ai-sdlc-framework/ai-sdlc/issues/524)) ([986895a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/986895a57f3d297ed6d5edd7a1838086d121edd1))
* RFC-0024 refit phase 1 — draft capture state machine + tiered deletion (AISDLC-320) ([#549](https://github.com/ai-sdlc-framework/ai-sdlc/issues/549)) ([0cf19ed](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0cf19edac71d64e8bf7f48269c6620e8ba0b6387))
* RFC-0024 Refit Phase 2 — Shared classifier substrate (AISDLC-321) ([#669](https://github.com/ai-sdlc-framework/ai-sdlc/issues/669)) ([086449f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/086449fbf0c93a27e35ca008dac0e204da434d43))
* rfc-0024 refit phase 3 threshold-gated triage + severity (AISDLC-275) ([#675](https://github.com/ai-sdlc-framework/ai-sdlc/issues/675)) ([84a2750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/84a27506dde1e92093261a45b1242d7ff8d96351))
* rfc-0024 refit phase 4 — pr-comment auto-classifier + bidirectional sync (AISDLC-276) ([#687](https://github.com/ai-sdlc-framework/ai-sdlc/issues/687)) ([61ca469](https://github.com/ai-sdlc-framework/ai-sdlc/commit/61ca4690553b9028d0461d61dc83cf895742389e))
* rfc-0024 refit phase 5 — dor-classifier integration (AISDLC-277) ([#694](https://github.com/ai-sdlc-framework/ai-sdlc/issues/694)) ([b22fc38](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b22fc384be964acc340090abbd94c676f546f104))
* rfc-0025 phase 2 confidence-bucketed classifier (AISDLC-303) ([#672](https://github.com/ai-sdlc-framework/ai-sdlc/issues/672)) ([4552c9f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4552c9fc5cb605bfc68f8f91d23a2c1c6c6143bd))
* rfc-0025 phase 4 suggest-only attribution + config schema (AISDLC-305) ([#676](https://github.com/ai-sdlc-framework/ai-sdlc/issues/676)) ([e8c5d75](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e8c5d75befdaad9735ec17d63e7887b1f51d4da7))
* RFC-0035 phase 2 — stage-a scorer and dep-graph blast-radius (AISDLC-286) ([#512](https://github.com/ai-sdlc-framework/ai-sdlc/issues/512)) ([d926466](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d926466cb4f6f2b41055f45cf21e295b080d76b0))
* rfc-0035 phase 3 — stage B rubric scorer + actor routing (AISDLC-287) ([#521](https://github.com/ai-sdlc-framework/ai-sdlc/issues/521)) ([d2a9eb4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d2a9eb4f7dda662b85bc708839a28b3560204777))
* ship cli-rfc index for adopter RFC ↔ Decision Catalog cross-ref (AISDLC-334) ([#693](https://github.com/ai-sdlc-framework/ai-sdlc/issues/693)) ([4c39eaf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c39eafd7472a8c25589525a5ea5fbb9dcde1801))
* ship rfc-0025 phase 6 upstream reporting and namespace enforce (AISDLC-307) ([#569](https://github.com/ai-sdlc-framework/ai-sdlc/issues/569)) ([2ffb846](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2ffb846260294737ad641c269ab9763df76f764c))
* **spec:** add backlog-task.v1.schema.json with optional specRef field (AISDLC-444) ([#729](https://github.com/ai-sdlc-framework/ai-sdlc/issues/729)) ([d6d0ce4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d6d0ce4f816dae179a347212e7ca2ac9651b178d))
* **spec:** add dispatch board protocol + in-session-agent worker (AISDLC-377.1) ([#576](https://github.com/ai-sdlc-framework/ai-sdlc/issues/576)) ([0685b95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0685b9512661fb6c9fe29b41dc6f70216b7a345c))
* **spec:** phase 7 decision-catalog capacity + fatigue (AISDLC-291) ([#689](https://github.com/ai-sdlc-framework/ai-sdlc/issues/689)) ([42d9a6e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42d9a6e73428711abfd07bc9392aca98018d76cb))
* **spec:** render RFC-0035 Phase 6 decision support surface (AISDLC-290) ([#681](https://github.com/ai-sdlc-framework/ai-sdlc/issues/681)) ([81c7871](https://github.com/ai-sdlc-framework/ai-sdlc/commit/81c7871f895cf3b3cdef03e1814d2ec946daf798))
* **spec:** rfc-0024 refit phase 6 — §15.1 lifecycle defaults + oq-6 + oq-9 (AISDLC-278) ([#739](https://github.com/ai-sdlc-framework/ai-sdlc/issues/739)) ([d39b285](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d39b285e1960a4e38865009437fa089b9a8d1661))
* **spec:** rfc-0035 phase 10 — research subagent + visual graphs (AISDLC-294) ([#757](https://github.com/ai-sdlc-framework/ai-sdlc/issues/757)) ([e012766](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e0127663f45521c519207d7eebfef39de3b9b8fb))
* **spec:** rfc-0035 phase 5 — stage c llm classifier + corpus (AISDLC-289) ([#673](https://github.com/ai-sdlc-framework/ai-sdlc/issues/673)) ([4745f93](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4745f93acd0cbcc884f2354f8fae215656aa866b))
* **spec:** rfc-0035 phase 9 override-driven calibration loop (AISDLC-293) ([#677](https://github.com/ai-sdlc-framework/ai-sdlc/issues/677)) ([14f44f9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/14f44f9ac517bed49e9a005730b311a92f38d93c))
* **spec:** rfc-0036 phase 6 import-spec reconcile drift handling (AISDLC-331) ([#674](https://github.com/ai-sdlc-framework/ai-sdlc/issues/674)) ([30435ac](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30435ac835f616a54b810b391664229b7fe3d165))
* **spec:** split RFC requires/assumes dependency semantics (AISDLC-311) ([#684](https://github.com/ai-sdlc-framework/ai-sdlc/issues/684)) ([c2b9200](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c2b9200b9a14d4845ecb8703dc7ff6b571471e08))
* v6 envelope schema + signer (RFC-0042 phase 2) (AISDLC-383.3) ([#598](https://github.com/ai-sdlc-framework/ai-sdlc/issues/598)) ([666858d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/666858d89a7f7149dde5d1ab63296fe3568d7be2))
* wire rfc-0011 dor clarification rounds into decision catalog (AISDLC-288) ([#511](https://github.com/ai-sdlc-framework/ai-sdlc/issues/511)) ([bec9699](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bec96993f13e450013ffe48518a21fbcf6a1242e))


### Bug Fixes

* **attestation:** exclude transcript-leaves/ from patch-id (AISDLC-422) ([#680](https://github.com/ai-sdlc-framework/ai-sdlc/issues/680)) ([a42309e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a42309e8503996518785f38b3d76affd36d7f15a))
* **ci:** DoR ingress workflow fails the status check on violations (AISDLC-379) ([#625](https://github.com/ai-sdlc-framework/ai-sdlc/issues/625)) ([1aee660](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1aee660d1a3014b71b7558c54e6239e4b562b78e))
* **ci:** v5 attestation rebase-fragility + queue/orchestration robustness (AISDLC-369) ([#559](https://github.com/ai-sdlc-framework/ai-sdlc/issues/559)) ([9c7d01c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9c7d01c15a29bd7094c38dd010eec73d83df82db))
* drop compliance-audit manifest self-sha + validate regime + honest AC-8 test (AISDLC-416) ([#664](https://github.com/ai-sdlc-framework/ai-sdlc/issues/664)) ([8b0312a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b0312aa3fc22c7769b5b1cebe342d943323d6b9))
* harden Codex spawn bridge output handling ([#500](https://github.com/ai-sdlc-framework/ai-sdlc/issues/500)) ([42ed716](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42ed7160152b99884225873f65186d9559a8d4ea))
* **orchestrator:** add OpenPullRequestExists filter to close deadlock (AISDLC-361) ([#534](https://github.com/ai-sdlc-framework/ai-sdlc/issues/534)) ([09d78be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09d78be549eb5cab6d2ba7289183d0bdf100a4ee))
* **orchestrator:** address PR [#576](https://github.com/ai-sdlc-framework/ai-sdlc/issues/576) unaddressed majors + file AISDLC-380 governance task (AISDLC-377.1) ([#577](https://github.com/ai-sdlc-framework/ai-sdlc/issues/577)) ([87aab49](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87aab494b340e43c38d0dfc64e3d5d0943cd1ba0))
* **orchestrator:** auto-rearm after force-push + branch-slug helper (AISDLC-356) ([#533](https://github.com/ai-sdlc-framework/ai-sdlc/issues/533)) ([6a36c62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6a36c62deb4c233bda989bea952b8fbf42188670))
* **orchestrator:** parent-must-be-on-main guard in state check + loop tick (AISDLC-358) ([#528](https://github.com/ai-sdlc-framework/ai-sdlc/issues/528)) ([f4a48b7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4a48b7625dc3eb03bb3b26395442ba087f857bf))
* **orchestrator:** parseClaudeOutput strips markdown fences + extracts embedded JSON (AISDLC-351) ([#515](https://github.com/ai-sdlc-framework/ai-sdlc/issues/515)) ([a03dd41](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a03dd416112c12dbcbc6cd2ccea548133fe0a0b2))
* **orchestrator:** pipeline error propagation + PR auto-promote + gh PATH detection (AISDLC-354) ([#531](https://github.com/ai-sdlc-framework/ai-sdlc/issues/531)) ([b365b2b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b365b2bcbd701e14e39f5b0b6fb1777d6b9cdd56))
* **orchestrator:** resume-from-draft stale verdict + verdict shape + degenerate retry (AISDLC-355) ([#527](https://github.com/ai-sdlc-framework/ai-sdlc/issues/527)) ([117f4b9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/117f4b9f33b23b3df4c4ffdea6aa32c43a6416fb))
* **orchestrator:** scrub GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in checkpoint.ts production git calls (AISDLC-260) ([#461](https://github.com/ai-sdlc-framework/ai-sdlc/issues/461)) ([af8c8ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af8c8ca59814cf23d5cb6b53d49038955359293e))
* **orchestrator:** skip parent-branch-guard in GH merge-queue probe (AISDLC-363) ([#537](https://github.com/ai-sdlc-framework/ai-sdlc/issues/537)) ([bfe412d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bfe412d47c3d3fbf78a3387efea62561d7818659))
* **reference:** handle loader-private YAML kinds without false-positive warnings (AISDLC-265) ([#474](https://github.com/ai-sdlc-framework/ai-sdlc/issues/474)) ([e51029c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e51029c0da04ac4ef6025281579361470e2039ff))
* **spec:** per-patch-id transcript-leaves files (AISDLC-421) ([#679](https://github.com/ai-sdlc-framework/ai-sdlc/issues/679)) ([c626459](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c626459b39a29dd3984ceaa09d73632df8784fa5))
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
