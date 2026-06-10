# @ai-sdlc/orchestrator

<!-- CHANGELOG is maintained by release-please. Do NOT manually add an
     Unreleased section — release-please accumulates all changes from
     conventional-commit messages and prepends a dated section when the
     rolling release PR lands. See docs/operations/release-flow.md. -->

## [0.13.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.12.0...orchestrator-v0.13.0) (2026-06-10)


### Features

* **orchestrator:** AISDLC-465 RFC-0018 Phase 1 journeys[] schema + limits + inheritance validator ([#824](https://github.com/ai-sdlc-framework/ai-sdlc/issues/824)) ([c8f449a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c8f449a3121771c64260e865ba4dfbf414647926))
* **orchestrator:** AISDLC-489 refactor 3 §13 rules into Tessellation13Registry (467 AC[#3](https://github.com/ai-sdlc-framework/ai-sdlc/issues/3) follow-up) ([#825](https://github.com/ai-sdlc-framework/ai-sdlc/issues/825)) ([0becfd2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0becfd234d3c85cd20ff61de92c95b1f6f0e0f4c))
* **orchestrator:** config-driven source-control adapter (AISDLC-530) ([#889](https://github.com/ai-sdlc-framework/ai-sdlc/issues/889)) ([f4b5e8b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4b5e8bc119adea04f6bb379cdd7d9e1f75e0620))
* **orchestrator:** franc-based language gate + multi-lang opt-in (AISDLC-431) ([#756](https://github.com/ai-sdlc-framework/ai-sdlc/issues/756)) ([745a238](https://github.com/ai-sdlc-framework/ai-sdlc/commit/745a23809913173fa33a147061a4dddc37eeb11d))
* **orchestrator:** rfc-0018 phase 2 journey-scoped admission scorer (AISDLC-466) ([#802](https://github.com/ai-sdlc-framework/ai-sdlc/issues/802)) ([7e1c9a9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7e1c9a93aa3012d328ec3abda26f6017afddf0b2))
* **orchestrator:** runner-registry consultation + --runner/AI_SDLC_RUNNER_PLUGIN seam (AISDLC-529) ([#888](https://github.com/ai-sdlc-framework/ai-sdlc/issues/888)) ([30812ea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30812ead86be1c431535dec9f14b5d5695091c49))
* **orchestrator:** ship §13 rule registry + journey-state-id drift rule (AISDLC-467) ([#803](https://github.com/ai-sdlc-framework/ai-sdlc/issues/803)) ([00550fd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/00550fde29337f16773586ae1b1f58a635fda58b))
* RFC-0028 Phase 3 — structural + statistical drift composition wiring (AISDLC-454) ([#798](https://github.com/ai-sdlc-framework/ai-sdlc/issues/798)) ([744d566](https://github.com/ai-sdlc-framework/ai-sdlc/commit/744d5669e2a799afeab0ec3da8098418ecb2baaf))


### Bug Fixes

* harden 17 ReDoS-prone regexes (CodeQL js/polynomial-redos) ([#820](https://github.com/ai-sdlc-framework/ai-sdlc/issues/820)) ([070864e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/070864e01bddd88d6fa3175cd80c59792b52318e))
* **orchestrator:** actionable error for schema-invalid resource configs (AISDLC-528) ([#887](https://github.com/ai-sdlc-framework/ai-sdlc/issues/887)) ([b78b609](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b78b6092ba7addd30ebec4b4a4a80e8e3ab65947))
* **orchestrator:** guard validate-config against null/non-resource docs ([#885](https://github.com/ai-sdlc-framework/ai-sdlc/issues/885)) ([ad36793](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ad36793490a0db7790a5e44249955f8c3a41ae21))
* **orchestrator:** harden pipeline for local-only repos (AISDLC-527) ([#886](https://github.com/ai-sdlc-framework/ai-sdlc/issues/886)) ([fa025bb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fa025bb544e6a39f3b0a7d1c8f26ab89512289bc))
* **security:** harden command-injection sites (CodeQL js/shell-command-constructed-from-input) ([#812](https://github.com/ai-sdlc-framework/ai-sdlc/issues/812)) ([be944e9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be944e92bd262172408223dbc999a9504e02e8fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.13.0

## [0.12.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.11.0...orchestrator-v0.12.0) (2026-05-29)


### Features

* **orchestrator:** z-score flooding detector + quarantine for signal ingestion (AISDLC-433) ([#752](https://github.com/ai-sdlc-framework/ai-sdlc/issues/752)) ([fd14423](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd14423aa0e97767c2f2162bab2816b61b7f5603))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.12.0

## [0.11.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.10.0...orchestrator-v0.11.0) (2026-05-28)


### Features

* **adapter:** extract codeArea from task references (AISDLC-268) ([#475](https://github.com/ai-sdlc-framework/ai-sdlc/issues/475)) ([7e04f3e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7e04f3e29570985a65a8e99ffcb676211332fec1))
* add signal source adapter substrate ([#506](https://github.com/ai-sdlc-framework/ai-sdlc/issues/506)) ([f4ee355](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4ee355bbfc8a3a9d7d69c807861d739e6abad0a))
* **attestation:** reviewer-side signed sub-attestations — partial closure of 2026-05-20 forgery hole (AISDLC-380) ([#580](https://github.com/ai-sdlc-framework/ai-sdlc/issues/580)) ([1568606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1568606d2f4e8f7c4c5e3b15df8be11140f88f68))
* **ci:** changelog.md owned by release-please; warn on feature-branch edits (AISDLC-401) ([#637](https://github.com/ai-sdlc-framework/ai-sdlc/issues/637)) ([1779ed5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1779ed5dc2f4b31d1ae021ed0ae058527c0a3e6c))
* **ci:** flaky-test convention + nightly workflow + pre-commit short-circuit (AISDLC-371 reopen) ([#561](https://github.com/ai-sdlc-framework/ai-sdlc/issues/561)) ([21e3f2d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/21e3f2d5a9d7aed7a475b49f7a87f831b2f9eb9c))
* **orchestrator:** add compliance-posture wizard step to ai-sdlc init (AISDLC-324) ([#546](https://github.com/ai-sdlc-framework/ai-sdlc/issues/546)) ([dbeaac2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbeaac229555dbc5ba79099f1c158bb00fd42fae))
* **orchestrator:** add JSONL vector storage + cli-embedding-gc (AISDLC-338) ([#660](https://github.com/ai-sdlc-framework/ai-sdlc/issues/660)) ([3f4d9d4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3f4d9d438bccb92f565dd0989cf7a68bfe61fbda))
* **orchestrator:** add rfc-0017 phase 3 deprecation lifecycle and drift extension (AISDLC-436) ([#736](https://github.com/ai-sdlc-framework/ai-sdlc/issues/736)) ([7f758ab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7f758ab65fd2a58a0a0be88ab1ad98ef67cfd24a))
* **orchestrator:** add RFC-0019 phase 1 embedding adapter + registry (AISDLC-337) ([#650](https://github.com/ai-sdlc-framework/ai-sdlc/issues/650)) ([67bc6dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/67bc6dd8f2eb136fff9bd89dfc75bbd682283073))
* **orchestrator:** cli-embedding-bump + stale-vector + deprecation lifecycle (AISDLC-339) ([#688](https://github.com/ai-sdlc-framework/ai-sdlc/issues/688)) ([a953222](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a9532224aa55f9743b5ab3763f96310750baf231))
* **orchestrator:** contentHashV5 — delta-hash with embedded signedMergeBase (AISDLC-362) ([#535](https://github.com/ai-sdlc-framework/ai-sdlc/issues/535)) ([8455935](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8455935e9a476be8e005623b35c417e7a8911e35))
* **orchestrator:** per-org calibration.yaml config for RFC-0031 (AISDLC-310) ([#543](https://github.com/ai-sdlc-framework/ai-sdlc/issues/543)) ([7cf6d80](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7cf6d807f6ed8e4cbd0baf0eb8bd001df5048cd6))
* **orchestrator:** per-soul DSB authoring + Ck calibration aggregation (AISDLC-314) ([#562](https://github.com/ai-sdlc-framework/ai-sdlc/issues/562)) ([cf8615b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf8615b8683c47e3bd193f20e848d53d0ca9e317))
* **orchestrator:** per-stage residency enforcement + multi-posture composition (AISDLC-432) ([#760](https://github.com/ai-sdlc-framework/ai-sdlc/issues/760)) ([27e4006](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27e4006bd64507025f0a4ab3f4f0b07cc75895b9))
* **orchestrator:** rfc-0009 phase 2.1 tessellation admission routing (AISDLC-313) ([#558](https://github.com/ai-sdlc-framework/ai-sdlc/issues/558)) ([1d28adc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1d28adc6df860fbb549a6624f45d2f33cc7a076b))
* **orchestrator:** rfc-0009 phase 4.1 e-rho-5 compliance clearance (AISDLC-316) ([#696](https://github.com/ai-sdlc-framework/ai-sdlc/issues/696)) ([6b5f27f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6b5f27fae95d1572fe5b55c8a4970d78b9be5623))
* **orchestrator:** rfc-0009 phase 4.2 e-tau tessellation-drift detector (AISDLC-317) ([#692](https://github.com/ai-sdlc-framework/ai-sdlc/issues/692)) ([4bd609b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4bd609b5e65b61a716fb17f4e1d6ae7f71fb2a65))
* **orchestrator:** rfc-0009 phase 4.4 oq-11 trigger checklist + oq-10 pin (AISDLC-319) ([#697](https://github.com/ai-sdlc-framework/ai-sdlc/issues/697)) ([068a0fa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/068a0fa0ff11ebd4e52c452b898cee7b49dd4c21))
* **orchestrator:** rfc-0017 phase 2 variant scorer routing (AISDLC-353) ([#682](https://github.com/ai-sdlc-framework/ai-sdlc/issues/682)) ([19401d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/19401d8d8492c3ea3273175893baa14f4d3e500a))
* **orchestrator:** RFC-0017 phase 4 internal-adopter reference impl (AISDLC-437) ([#755](https://github.com/ai-sdlc-framework/ai-sdlc/issues/755)) ([68d3eab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68d3eab871bf50b569307970002a42d7866d5470))
* **orchestrator:** RFC-0022 Phase 1 — CompliancePosture schema + loader (AISDLC-322) ([#505](https://github.com/ai-sdlc-framework/ai-sdlc/issues/505)) ([23f5816](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23f58169ee5b461a289acd33750cde76e31af026))
* **orchestrator:** RFC-0022 Phase 2 — Regime → DerivedGates composer (AISDLC-323) ([#516](https://github.com/ai-sdlc-framework/ai-sdlc/issues/516)) ([a0caca4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a0caca46c20ac3e49a6c1fbe51a99c6de5995235))
* **orchestrator:** RFC-0025 refit phase 1 — quality monitoring substrate salvage (AISDLC-302) ([#550](https://github.com/ai-sdlc-framework/ai-sdlc/issues/550)) ([aeb5de9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aeb5de995a999d9e21474a61fc02d1422940d2c5))
* **orchestrator:** rfc-0030 env-var adapter scope + manual hardening (AISDLC-430) ([#762](https://github.com/ai-sdlc-framework/ai-sdlc/issues/762)) ([d1e26dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d1e26ddff56bc87a6078daf4b006becc6238d205))
* **orchestrator:** rfc-0030 phase 2 — signal classification + language gate (AISDLC-344) ([#654](https://github.com/ai-sdlc-framework/ai-sdlc/issues/654)) ([0a542ab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0a542ab191a81ded52b779b4354a8bbe5ed5b2a3))
* **orchestrator:** rfc-0030 phase 3 — clustering bm25 default + embedding option (AISDLC-345) ([#659](https://github.com/ai-sdlc-framework/ai-sdlc/issues/659)) ([cc9a46e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc9a46e824ec86423531a783f4f8b2d90879f027))
* **orchestrator:** rfc-0030 phase 4 significance + sa + flooding (AISDLC-346) ([#667](https://github.com/ai-sdlc-framework/ai-sdlc/issues/667)) ([9fe25b1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9fe25b15804c01d6444e40795242f690102d2828))
* **orchestrator:** rfc-0030 phase 5 d1 reformulation + ppa integration (AISDLC-347) ([#671](https://github.com/ai-sdlc-framework/ai-sdlc/issues/671)) ([fd17d91](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd17d914532e5b7a920493b48e2e7afd8724bd59))
* **orchestrator:** scaffold .github/workflows on ai-sdlc init (AISDLC-261) ([#480](https://github.com/ai-sdlc-framework/ai-sdlc/issues/480)) ([8dca58f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8dca58f74ac6a3e08a482e7391ab6586c62a1641))
* **orchestrator:** ship canonical identityClass taxonomy + substrate-contract schema (AISDLC-452) ([#750](https://github.com/ai-sdlc-framework/ai-sdlc/issues/750)) ([31313a4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/31313a48bb3f729af8a5f416136aab8eb8472f25))
* **orchestrator:** signal-ingestion schema + governance + runbook for rfc-0030 phase 6 (AISDLC-348) ([#683](https://github.com/ai-sdlc-framework/ai-sdlc/issues/683)) ([b669485](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b66948503977e0655afec5b3b1020b593821cc2c))
* **orchestrator:** wire RFC-0019 phase 4 pipeline schema + embedding load (AISDLC-340) ([#690](https://github.com/ai-sdlc-framework/ai-sdlc/issues/690)) ([cd8425f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cd8425fc0d4163d87ec21d9e67be28febe51ae58))
* rfc-0025 phase 4 suggest-only attribution + config schema (AISDLC-305) ([#676](https://github.com/ai-sdlc-framework/ai-sdlc/issues/676)) ([e8c5d75](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e8c5d75befdaad9735ec17d63e7887b1f51d4da7))
* **spec:** add triad/tessellation/parentTessellation to DID schema + init scaffolding (AISDLC-312) ([#544](https://github.com/ai-sdlc-framework/ai-sdlc/issues/544)) ([bc8feea](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc8feeaab54d9dd0dff16bd345ae203831a5850f))
* **spec:** rfc-0017 phase 1 soul did variant schema additions (AISDLC-435) ([#726](https://github.com/ai-sdlc-framework/ai-sdlc/issues/726)) ([dbe9ffb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbe9ffb3caad42159e9b512a02e0fbfb1994813c))


### Bug Fixes

* **orchestrator:** add generated-schemas.ts to CONTENTHASHV4_IGNORE_FILES (AISDLC-342) ([#502](https://github.com/ai-sdlc-framework/ai-sdlc/issues/502)) ([a2a32d4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2a32d4392cb1002ed5e4363ca13bcca2e68bf27))
* **orchestrator:** init auto-yields to defaults in non-TTY contexts (AISDLC-263) ([#472](https://github.com/ai-sdlc-framework/ai-sdlc/issues/472)) ([cf8996d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf8996d53425ca8f101355d1c01b38efa34dfb9e))
* **orchestrator:** init resolves to git root by default (AISDLC-262) ([#478](https://github.com/ai-sdlc-framework/ai-sdlc/issues/478)) ([a961602](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a96160276545e02b2712d0f02ff19e2e32c01a93))
* **orchestrator:** resolve npm bin symlinks in isMainEntry check (gh-issue-610) ([#703](https://github.com/ai-sdlc-framework/ai-sdlc/issues/703)) ([9219583](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9219583cd2172f19059767a818718dab2b12d6b7))
* **orchestrator:** wire HC_design Source 3 compliance signal from DSB (AISDLC-266) ([#477](https://github.com/ai-sdlc-framework/ai-sdlc/issues/477)) ([8854a00](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8854a0035129a51e471483f81ca74ef9561af4a5))
* **reference:** handle loader-private YAML kinds without false-positive warnings (AISDLC-265) ([#474](https://github.com/ai-sdlc-framework/ai-sdlc/issues/474)) ([e51029c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e51029c0da04ac4ef6025281579361470e2039ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.11.0

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.9.0...orchestrator-v0.10.0) (2026-05-11)


### Features

* add per-file-delta contentHashV3 to attestation predicate (AISDLC-101) ([563d9fc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/563d9fc612193adbed4c0f4bfaa56ad58b5d184a))
* add pipelineVersion to attestation predicate (AISDLC-100.6) ([6ac0ac9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ac0ac9dc1d4416276a7ae0e5f1a8e32b00c4aae))
* **deps:** dor gate enforce mode + RFC-0011 v4 + parent task progress (AISDLC-115.9) ([270a497](https://github.com/ai-sdlc-framework/ai-sdlc/commit/270a4978283ba9f9e5c981ee9fe65d1795d29e8f))
* **orchestrator:** interactive init wizard + scaffold gate workflow (AISDLC-143) ([450cbaa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/450cbaac668091761efb73028c75ee7dbd1877ba))
* **orchestrator:** rfc-0011 phase 4 — definition-of-ready composition (AISDLC-115.5) ([6c0e997](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c0e9977f52405bb5d333b8e4e65d79f2f720715))
* **orchestrator:** tier-based agent-role tool defaults — coding/research/meta (AISDLC-79) ([adeb70d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/adeb70dff0ef45e4c57677df973f02607e343ce7))
* promote AI_SDLC_PARALLELISM to default-on (AISDLC-116) ([4d7c06d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4d7c06d9c67deda9dcdd95e5b25706f526645bea))
* rfc-0011 phase 1 schema + needs-clarification status (AISDLC-115.1) ([300682b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/300682bca895ee9a61da67840c567a36e06a87da))
* **spec:** attestation harness context + Codex finalization via MCP task_complete (AISDLC-202.3) ([#414](https://github.com/ai-sdlc-framework/ai-sdlc/issues/414)) ([c994a1b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c994a1bb476ddb9cee35de6c20b6d3bb01250f91))
* **spec:** make pipeline.yaml canonical; deprecate pipeline-backlog.yaml (AISDLC-245.5) ([#444](https://github.com/ai-sdlc-framework/ai-sdlc/issues/444)) ([281d139](https://github.com/ai-sdlc-framework/ai-sdlc/commit/281d1397400778f7dd90ff78ad24197303b6643f))
* verifier Phase 3 — require contentHashV3, bump schema to v3 (AISDLC-103) ([4602edf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4602edf92cc24d12fa90167b52ff31a95247eaf8))


### Bug Fixes

* add rebase-tolerant contentHash to attestation predicate (AISDLC-94) ([feb5259](https://github.com/ai-sdlc-framework/ai-sdlc/commit/feb52591f66de353193c9d7c9111ce4b3f9e7137))
* address reviewer feedback for AISDLC-94 dual-hash ([957e1f3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/957e1f344d9d2b5691fd3ca98d39bc82bd581376))
* **attestation:** exclude shared churn files from contentHashV4 (AISDLC-258) ([#441](https://github.com/ai-sdlc-framework/ai-sdlc/issues/441)) ([4290056](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42900565251afda282ce1cda36700d89a5796d79))
* **deps:** harden classifier — docs extension safelist + auth regex (AISDLC-145) ([fcc287f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fcc287fa534daeb03cf43d8e691d51922cf8c9cb))
* **orchestrator:** add contentHashV4 base-independent hash + envelope self-exclusion (AISDLC-193.1) ([#335](https://github.com/ai-sdlc-framework/ai-sdlc/issues/335)) ([39c4301](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39c43010d537f15bb5c3421ccbd7b4e0fb13a7b1))
* **orchestrator:** admit confidence honors enrichment-success above 0.5 default (AISDLC-172) ([907662c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/907662ce6dc604d90a8b9290ca4b339bfe175c73))
* **orchestrator:** convention detector — React naming, multi-test-dir, path aliases (AISDLC-80) ([554dbb8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/554dbb8b29847cadde0f92cb9e77775692d5deaa))
* **orchestrator:** harden orchestrator/-side test fixtures against GIT_DIR env bleed (AISDLC-257) ([#438](https://github.com/ai-sdlc-framework/ai-sdlc/issues/438)) ([b6db688](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b6db6884ab39e140c35979955fab4aa22e826b4e))
* **orchestrator:** init UX papercuts (AISDLC-78) ([7085274](https://github.com/ai-sdlc-framework/ai-sdlc/commit/70852740800a0565be90c815af876ad94afaefec))
* **orchestrator:** isolate init-workspace test from host git origin (AISDLC-134) ([0563124](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0563124af37e8f5bb773d6720b1bf8590696a5d8))
* **orchestrator:** re-apply / harden AISDLC-189 init-workspace test fix (AISDLC-159) ([ea89d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea89d5bfd08fa8129a327f95e3d7a85c255cce19))
* **orchestrator:** unset GIT_* env in init-workspace test + direct .git/ writes ([f4f1e28](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4f1e289a147d8dad6455c15bb69c81bf3e283f4))
* **orchestrator:** unshadow CLI --version listener and cover with integration tests (AISDLC-78) ([07b5680](https://github.com/ai-sdlc-framework/ai-sdlc/commit/07b56803eb5baa2db3f9182f019f391c6f3a6996))
* **orchestrator:** verifier accepts codex reviewer variants + enforces cross-harness independence (AISDLC-252) ([#418](https://github.com/ai-sdlc-framework/ai-sdlc/issues/418)) ([2c3b109](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2c3b109729f15e7f2ceebbd796ebbe62ff3f00f9))
* **orchestrator:** wire designAuthority diagnostic into HC_design (AISDLC-171) ([3efab87](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3efab871dccd3250b5c1a3c7f7f3906eb94e1def))
* pin detectGitRemote cwd via git -C to avoid host git origin bleed (AISDLC-104) ([937a5fa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/937a5fa6130766557b130b9016becbd86ed13c42))
* validate changedFileDeltas element shape (review feedback) ([9556af5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9556af5eaf1611f510b2c6780aabc4b155b86e52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.10.0

## [0.9.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.8.0...orchestrator-v0.9.0) (2026-04-30)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add automated dogfood pipeline — admission, routing, and PR review workflows ([4583ab6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4583ab65285163ab16e42f140cdd74e87dbfdb9a))
* add CI boundary to review agent prompts (AISDLC-8.1) ([975c0cd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/975c0cdf000cf8a00e0968348b673aa80ec04be6))
* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* add DiffAnalyzer for deterministic structural pre-review (AISDLC-8.2) ([ae0dde5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae0dde5cb7d227998dd73fcb290da968c05a4fb3))
* add meta-review pass and feedback flywheel (AISDLC-8.5) ([c9ba69d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c9ba69da6fa811fecedfafd33c736b6b6b94af93))
* add pipeline visibility and lint/format to agent context ([8f07b3e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f07b3ef4bc72c1a3bc48a1ba77e6ab9643420ea))
* add pipeline-level cycle detection ([#41](https://github.com/ai-sdlc-framework/ai-sdlc/issues/41)) ([#42](https://github.com/ai-sdlc-framework/ai-sdlc/issues/42)) ([c730803](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7308031e4b6f340c1cc195ae876565d0afe6d7d))
* add Slack integration — pipeline visibility and emoji-to-issue trigger ([ec53b7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec53b7c7cd9adf834e17c28fb7e45271d1bd6e9a))
* add structured reasoning with confidence scores to review agents (AISDLC-8.3) ([1ed0ec0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1ed0ec0a41a476652380191022d9b5500058cec8))
* add trust-based source weighting to PPA admission scoring ([c04ca18](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c04ca1836ce35db8f15f363f1efb5262317eefb0))
* add typecheck command to agent prompt to prevent pre-commit failures ([3497c71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3497c7191bb2c7a5b34e973a68de3fc2986644ae))
* human-readable agent log output instead of raw NDJSON ([685452f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/685452f8559232d187df0a6a0095f017ef4f0fb8))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** add backlog template vars + multi-pipeline support ([fd69674](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd6967475fab54a8af51cfcf95919416cc6a0568))
* **orchestrator:** add BacklogAdapter for admission scoring ([8435d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8435d5b27a46551f88065a8004b2b03201517ebe))
* **orchestrator:** cryptographic review attestations for skip-duplicate-CI (AISDLC-74) ([a120071](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a120071720d91545c51b6c91b05a3ffb223d2cf5))
* **orchestrator:** escalate review agent to large-context model + pre-push coverage gate ([a55e17c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a55e17cb52f592ec8eb008c11e6e2942ce02fc2a))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** loadMaintainers reader for .ai-sdlc/maintainers.yaml ([1887b7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1887b7a0957d8b3f0d77a6cdda9aeabe88dab7f6))
* **orchestrator:** non-fatal config warnings instead of throw-on-first-failure ([c99b6a5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c99b6a5e0812af57cd9efbec75b905de75824e18))
* **orchestrator:** priorityInputOverrides on AdmissionCompositeOptions ([93ab906](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93ab90665a7256ef77cdff51a0b21a48274b51be))
* **orchestrator:** recalibrate ppa scoring for backlog tasks via backlog-context ([02e8105](https://github.com/ai-sdlc-framework/ai-sdlc/commit/02e8105ae76152a81e1d9eaa7a24fc3fc37a6ffa))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2 worktree pool manager ([554034a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/554034a1da4c24c8d4da2b8e8c710262d51fddaf))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **orchestrator:** rfc-0010 phase 3 worker pool + merge gate + requeue ([6fe1b75](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6fe1b750cbbad1b4b254f03dd51f96dd84558430))
* **orchestrator:** rfc-0010 phase 4 artifacts + observability ([93a41f1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93a41f178961047d87aca7f6701ff4e43f301dae))
* **orchestrator:** rfc-0010 phase 6 database isolation ([d44597f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d44597f4aa29330eb7f8c3bd5a1f6a57e89f4d4c))
* **orchestrator:** tier-based agent-role tool defaults — coding/research/meta (AISDLC-79) ([22ffe01](https://github.com/ai-sdlc-framework/ai-sdlc/commit/22ffe011964a65e3c71da49bbb8cad5904b3481c))
* **orchestrator:** wire ClaudeCodeAdapter into security triage ([ddaadf7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ddaadf7743254d1f3afb9cd7d7cb50ac425b271c))
* replace 21 hand-tuned rules with principles + exemplar bank (AISDLC-8.4) ([b02a755](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b02a755e960c98f0b55d2252c0d699e82e9a4e19))
* stream agent progress via Claude Code stream-json output ([4c5c5b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c5c5b4ead16d2238af4809ec1ea1e1ef954767b))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([454548e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/454548ebe86b7588dff523e68d128b3c0b283a79))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([68f36be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68f36be6e66dd354b483ed2d851993823d544b7b))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e33a303](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e33a303e8f9158076c04361d0d09cd5a6f59c2e9))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e6ffd6a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6ffd6aa93cbd9ca27fdb9b2eead4e6f12ed54ac))


### Bug Fixes

* Add missing validation for empty issueBody in SecurityTriageRunner ([#33](https://github.com/ai-sdlc-framework/ai-sdlc/issues/33)) ([#34](https://github.com/ai-sdlc-framework/ai-sdlc/issues/34)) ([9f81e66](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9f81e66dde0950f13272064cb36695cd7c2d8387))
* add real-time observability to Claude Code runner ([bcb2f08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcb2f0825f52914fa7b07acd286bbdd97f50dd87))
* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* Agent should address review findings before human review ([#35](https://github.com/ai-sdlc-framework/ai-sdlc/issues/35)) ([#36](https://github.com/ai-sdlc-framework/ai-sdlc/issues/36)) ([34c7606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34c7606db4dacdc21875f876f332f8d61bfc4c2a))
* allow review dismissals with documented reason ([c38fa35](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c38fa358d89c6d9d297f68bbb7f4f99fbd008569))
* detect agent commits by diffing against merge-base with main ([5a27dc6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a27dc66d51c87587f02da1eaa60e46f5fa962b4))
* detect agent-committed changes instead of reporting 'no files modified' ([7b6309d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b6309d30a0a1a172951ba83cbc542311dc86143))
* only use openshell prefix when provider is explicitly openshell ([e2ea832](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e2ea8324c8de7fb49c16e64bcc21e6d85a4df5e1))
* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **orchestrator:** convention detector — React naming, multi-test-dir, path aliases (AISDLC-80) ([fdeefe4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fdeefe405f758b703c5bb5ec609c4fea4db2c009))
* **orchestrator:** deflake withmergegate timeout test ([57aa161](https://github.com/ai-sdlc-framework/ai-sdlc/commit/57aa161de32b1631f94b08109667afb3cdce6dd9))
* **orchestrator:** disable git core.quotepath so unicode filenames stage cleanly ([ea27178](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea27178afc6e266cc566b76848c20199790ce0cd))
* **orchestrator:** include staged diff in detectChangedFiles ([b255d7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b255d7a7c1836eb311c1967549898743097f15a4))
* **orchestrator:** init UX papercuts (AISDLC-78) ([a4303bf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a4303bf7cbf3150f7bff0aa34d2c917088c18c3d))
* **orchestrator:** only stage agent-touched files (drop git add -a) ([0eef249](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0eef249d2bec18253ac4f73562c2771f37975aaf))
* **orchestrator:** pass dispatcher pipeline through; rebase before push ([26c2061](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26c2061ea3f49a7e776cb237613485adb384b4fc))
* **orchestrator:** pin scheduling tests to peak hour to deflake CI ([8e07d24](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e07d2484d5297ce1667d0381f490d2d0f6c7666))
* **orchestrator:** restore HEAD, surface guardrail detail, detect cross-repo writes ([34cdbb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34cdbb27a14eb89ebbbaa57533a79e726386c495))
* **orchestrator:** schema-validate attestation predicate + sanitize GITHUB_OUTPUT (AISDLC-74) ([09ccaf3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09ccaf3c66709ae93af06a59d3cfbe617a7281e4))
* **orchestrator:** strip GIT_DIR from all execSync('git ...') sites (AISDLC-72) ([09e7780](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09e7780e121ad26e18ace9f6fb0463ed318a7c64))
* **orchestrator:** unshadow CLI --version listener and cover with integration tests (AISDLC-78) ([db8c4b2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db8c4b2afa3384d83663997ae02760a6dd12c2da))
* plugin install fixes, quality gate false positives, gitignore deduplication ([cf84f09](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf84f09cf93aabd8e22acc5e0262a4ed22d4e4e0))
* prevent duplicate .gitignore entries from ensureRuntimeGitignore ([a1ff0fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a1ff0fe49681ea1200059e5eefc40e555915361c))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* resolve issue [#37](https://github.com/ai-sdlc-framework/ai-sdlc/issues/37) ([a8b0707](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8b0707fa96b565a049fd8f123535a6eb885a3ca))
* resolve issue [#46](https://github.com/ai-sdlc-framework/ai-sdlc/issues/46) ([6bd9f39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6bd9f39c84423f688e39f87467c5aea4810e446c))
* stop tracking orchestrator/.gitignore — generated at runtime ([909759b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/909759bd3cd7051f0bb2bdcb6696bc2277ec282b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.9.0

## [0.8.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.7.0...orchestrator-v0.8.0) (2026-04-30)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add automated dogfood pipeline — admission, routing, and PR review workflows ([4583ab6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4583ab65285163ab16e42f140cdd74e87dbfdb9a))
* add CI boundary to review agent prompts (AISDLC-8.1) ([975c0cd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/975c0cdf000cf8a00e0968348b673aa80ec04be6))
* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* add DiffAnalyzer for deterministic structural pre-review (AISDLC-8.2) ([ae0dde5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae0dde5cb7d227998dd73fcb290da968c05a4fb3))
* add meta-review pass and feedback flywheel (AISDLC-8.5) ([c9ba69d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c9ba69da6fa811fecedfafd33c736b6b6b94af93))
* add pipeline visibility and lint/format to agent context ([8f07b3e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f07b3ef4bc72c1a3bc48a1ba77e6ab9643420ea))
* add pipeline-level cycle detection ([#41](https://github.com/ai-sdlc-framework/ai-sdlc/issues/41)) ([#42](https://github.com/ai-sdlc-framework/ai-sdlc/issues/42)) ([c730803](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7308031e4b6f340c1cc195ae876565d0afe6d7d))
* add Slack integration — pipeline visibility and emoji-to-issue trigger ([ec53b7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec53b7c7cd9adf834e17c28fb7e45271d1bd6e9a))
* add structured reasoning with confidence scores to review agents (AISDLC-8.3) ([1ed0ec0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1ed0ec0a41a476652380191022d9b5500058cec8))
* add trust-based source weighting to PPA admission scoring ([c04ca18](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c04ca1836ce35db8f15f363f1efb5262317eefb0))
* add typecheck command to agent prompt to prevent pre-commit failures ([3497c71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3497c7191bb2c7a5b34e973a68de3fc2986644ae))
* human-readable agent log output instead of raw NDJSON ([685452f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/685452f8559232d187df0a6a0095f017ef4f0fb8))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** add backlog template vars + multi-pipeline support ([fd69674](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd6967475fab54a8af51cfcf95919416cc6a0568))
* **orchestrator:** add BacklogAdapter for admission scoring ([8435d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8435d5b27a46551f88065a8004b2b03201517ebe))
* **orchestrator:** cryptographic review attestations for skip-duplicate-CI (AISDLC-74) ([a120071](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a120071720d91545c51b6c91b05a3ffb223d2cf5))
* **orchestrator:** escalate review agent to large-context model + pre-push coverage gate ([a55e17c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a55e17cb52f592ec8eb008c11e6e2942ce02fc2a))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** loadMaintainers reader for .ai-sdlc/maintainers.yaml ([1887b7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1887b7a0957d8b3f0d77a6cdda9aeabe88dab7f6))
* **orchestrator:** non-fatal config warnings instead of throw-on-first-failure ([c99b6a5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c99b6a5e0812af57cd9efbec75b905de75824e18))
* **orchestrator:** priorityInputOverrides on AdmissionCompositeOptions ([93ab906](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93ab90665a7256ef77cdff51a0b21a48274b51be))
* **orchestrator:** recalibrate ppa scoring for backlog tasks via backlog-context ([02e8105](https://github.com/ai-sdlc-framework/ai-sdlc/commit/02e8105ae76152a81e1d9eaa7a24fc3fc37a6ffa))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2 worktree pool manager ([554034a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/554034a1da4c24c8d4da2b8e8c710262d51fddaf))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **orchestrator:** rfc-0010 phase 3 worker pool + merge gate + requeue ([6fe1b75](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6fe1b750cbbad1b4b254f03dd51f96dd84558430))
* **orchestrator:** rfc-0010 phase 4 artifacts + observability ([93a41f1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93a41f178961047d87aca7f6701ff4e43f301dae))
* **orchestrator:** rfc-0010 phase 6 database isolation ([d44597f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d44597f4aa29330eb7f8c3bd5a1f6a57e89f4d4c))
* **orchestrator:** tier-based agent-role tool defaults — coding/research/meta (AISDLC-79) ([22ffe01](https://github.com/ai-sdlc-framework/ai-sdlc/commit/22ffe011964a65e3c71da49bbb8cad5904b3481c))
* **orchestrator:** wire ClaudeCodeAdapter into security triage ([ddaadf7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ddaadf7743254d1f3afb9cd7d7cb50ac425b271c))
* replace 21 hand-tuned rules with principles + exemplar bank (AISDLC-8.4) ([b02a755](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b02a755e960c98f0b55d2252c0d699e82e9a4e19))
* stream agent progress via Claude Code stream-json output ([4c5c5b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c5c5b4ead16d2238af4809ec1ea1e1ef954767b))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([454548e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/454548ebe86b7588dff523e68d128b3c0b283a79))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([68f36be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68f36be6e66dd354b483ed2d851993823d544b7b))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e33a303](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e33a303e8f9158076c04361d0d09cd5a6f59c2e9))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e6ffd6a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6ffd6aa93cbd9ca27fdb9b2eead4e6f12ed54ac))


### Bug Fixes

* Add missing validation for empty issueBody in SecurityTriageRunner ([#33](https://github.com/ai-sdlc-framework/ai-sdlc/issues/33)) ([#34](https://github.com/ai-sdlc-framework/ai-sdlc/issues/34)) ([9f81e66](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9f81e66dde0950f13272064cb36695cd7c2d8387))
* add real-time observability to Claude Code runner ([bcb2f08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcb2f0825f52914fa7b07acd286bbdd97f50dd87))
* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* Agent should address review findings before human review ([#35](https://github.com/ai-sdlc-framework/ai-sdlc/issues/35)) ([#36](https://github.com/ai-sdlc-framework/ai-sdlc/issues/36)) ([34c7606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34c7606db4dacdc21875f876f332f8d61bfc4c2a))
* allow review dismissals with documented reason ([c38fa35](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c38fa358d89c6d9d297f68bbb7f4f99fbd008569))
* detect agent commits by diffing against merge-base with main ([5a27dc6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a27dc66d51c87587f02da1eaa60e46f5fa962b4))
* detect agent-committed changes instead of reporting 'no files modified' ([7b6309d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b6309d30a0a1a172951ba83cbc542311dc86143))
* only use openshell prefix when provider is explicitly openshell ([e2ea832](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e2ea8324c8de7fb49c16e64bcc21e6d85a4df5e1))
* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **orchestrator:** convention detector — React naming, multi-test-dir, path aliases (AISDLC-80) ([fdeefe4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fdeefe405f758b703c5bb5ec609c4fea4db2c009))
* **orchestrator:** deflake withmergegate timeout test ([57aa161](https://github.com/ai-sdlc-framework/ai-sdlc/commit/57aa161de32b1631f94b08109667afb3cdce6dd9))
* **orchestrator:** disable git core.quotepath so unicode filenames stage cleanly ([ea27178](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea27178afc6e266cc566b76848c20199790ce0cd))
* **orchestrator:** include staged diff in detectChangedFiles ([b255d7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b255d7a7c1836eb311c1967549898743097f15a4))
* **orchestrator:** init UX papercuts (AISDLC-78) ([a4303bf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a4303bf7cbf3150f7bff0aa34d2c917088c18c3d))
* **orchestrator:** only stage agent-touched files (drop git add -a) ([0eef249](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0eef249d2bec18253ac4f73562c2771f37975aaf))
* **orchestrator:** pass dispatcher pipeline through; rebase before push ([26c2061](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26c2061ea3f49a7e776cb237613485adb384b4fc))
* **orchestrator:** pin scheduling tests to peak hour to deflake CI ([8e07d24](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e07d2484d5297ce1667d0381f490d2d0f6c7666))
* **orchestrator:** restore HEAD, surface guardrail detail, detect cross-repo writes ([34cdbb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34cdbb27a14eb89ebbbaa57533a79e726386c495))
* **orchestrator:** schema-validate attestation predicate + sanitize GITHUB_OUTPUT (AISDLC-74) ([09ccaf3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09ccaf3c66709ae93af06a59d3cfbe617a7281e4))
* **orchestrator:** strip GIT_DIR from all execSync('git ...') sites (AISDLC-72) ([09e7780](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09e7780e121ad26e18ace9f6fb0463ed318a7c64))
* **orchestrator:** unshadow CLI --version listener and cover with integration tests (AISDLC-78) ([db8c4b2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db8c4b2afa3384d83663997ae02760a6dd12c2da))
* plugin install fixes, quality gate false positives, gitignore deduplication ([cf84f09](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf84f09cf93aabd8e22acc5e0262a4ed22d4e4e0))
* prevent duplicate .gitignore entries from ensureRuntimeGitignore ([a1ff0fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a1ff0fe49681ea1200059e5eefc40e555915361c))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* resolve issue [#37](https://github.com/ai-sdlc-framework/ai-sdlc/issues/37) ([a8b0707](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8b0707fa96b565a049fd8f123535a6eb885a3ca))
* resolve issue [#46](https://github.com/ai-sdlc-framework/ai-sdlc/issues/46) ([6bd9f39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6bd9f39c84423f688e39f87467c5aea4810e446c))
* stop tracking orchestrator/.gitignore — generated at runtime ([909759b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/909759bd3cd7051f0bb2bdcb6696bc2277ec282b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.8.0

## [0.7.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.6.0...orchestrator-v0.7.0) (2026-04-29)


### Features

* add CI boundary to review agent prompts (AISDLC-8.1) ([975c0cd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/975c0cdf000cf8a00e0968348b673aa80ec04be6))
* add Claude Code plugin and SDK runner for native governance integration ([804f068](https://github.com/ai-sdlc-framework/ai-sdlc/commit/804f06801e388fb356cde716291abc4e3386f050))
* add DiffAnalyzer for deterministic structural pre-review (AISDLC-8.2) ([ae0dde5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae0dde5cb7d227998dd73fcb290da968c05a4fb3))
* add meta-review pass and feedback flywheel (AISDLC-8.5) ([c9ba69d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c9ba69da6fa811fecedfafd33c736b6b6b94af93))
* add structured reasoning with confidence scores to review agents (AISDLC-8.3) ([1ed0ec0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1ed0ec0a41a476652380191022d9b5500058cec8))
* implement RFC-0006 Design System Governance Pipeline ([e6dfd4c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6dfd4c3f9efdf4b6ddb219f02131c206dfdcb67))
* **orchestrator:** add backlog template vars + multi-pipeline support ([fd69674](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd6967475fab54a8af51cfcf95919416cc6a0568))
* **orchestrator:** add BacklogAdapter for admission scoring ([8435d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8435d5b27a46551f88065a8004b2b03201517ebe))
* **orchestrator:** cryptographic review attestations for skip-duplicate-CI (AISDLC-74) ([a120071](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a120071720d91545c51b6c91b05a3ffb223d2cf5))
* **orchestrator:** escalate review agent to large-context model + pre-push coverage gate ([a55e17c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a55e17cb52f592ec8eb008c11e6e2942ce02fc2a))
* **orchestrator:** implement rfc-0008 ppa triad integration end-to-end ([522950d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/522950d70b566145feb9718ed88495f09b3e9b9a))
* **orchestrator:** loadMaintainers reader for .ai-sdlc/maintainers.yaml ([1887b7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1887b7a0957d8b3f0d77a6cdda9aeabe88dab7f6))
* **orchestrator:** non-fatal config warnings instead of throw-on-first-failure ([c99b6a5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c99b6a5e0812af57cd9efbec75b905de75824e18))
* **orchestrator:** priorityInputOverrides on AdmissionCompositeOptions ([93ab906](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93ab90665a7256ef77cdff51a0b21a48274b51be))
* **orchestrator:** recalibrate ppa scoring for backlog tasks via backlog-context ([02e8105](https://github.com/ai-sdlc-framework/ai-sdlc/commit/02e8105ae76152a81e1d9eaa7a24fc3fc37a6ffa))
* **orchestrator:** rfc-0010 phase 1 foundations ([9197a0d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9197a0da89916d9a595289cf493a4918b6f1451d))
* **orchestrator:** rfc-0010 phase 2 worktree pool manager ([554034a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/554034a1da4c24c8d4da2b8e8c710262d51fddaf))
* **orchestrator:** rfc-0010 phase 2.5 model routing + classifier ([12b9750](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12b97508db1874b847d4fb40e210cfbef62f3c1a))
* **orchestrator:** rfc-0010 phase 2.7 harness adapter framework ([847a965](https://github.com/ai-sdlc-framework/ai-sdlc/commit/847a96541f45924f89070c8a106ff83e329d8d12))
* **orchestrator:** rfc-0010 phase 2.8 subscription-aware scheduling ([ea26d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea26d40de0f82c06abb70a4c2b920336ee62e6af))
* **orchestrator:** rfc-0010 phase 3 worker pool + merge gate + requeue ([6fe1b75](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6fe1b750cbbad1b4b254f03dd51f96dd84558430))
* **orchestrator:** rfc-0010 phase 4 artifacts + observability ([93a41f1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/93a41f178961047d87aca7f6701ff4e43f301dae))
* **orchestrator:** rfc-0010 phase 6 database isolation ([d44597f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d44597f4aa29330eb7f8c3bd5a1f6a57e89f4d4c))
* **orchestrator:** tier-based agent-role tool defaults — coding/research/meta (AISDLC-79) ([22ffe01](https://github.com/ai-sdlc-framework/ai-sdlc/commit/22ffe011964a65e3c71da49bbb8cad5904b3481c))
* **orchestrator:** wire ClaudeCodeAdapter into security triage ([ddaadf7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ddaadf7743254d1f3afb9cd7d7cb50ac425b271c))
* replace 21 hand-tuned rules with principles + exemplar bank (AISDLC-8.4) ([b02a755](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b02a755e960c98f0b55d2252c0d699e82e9a4e19))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([454548e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/454548ebe86b7588dff523e68d128b3c0b283a79))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e33a303](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e33a303e8f9158076c04361d0d09cd5a6f59c2e9))


### Bug Fixes

* **ci:** review bot no longer 422s on lines outside diff hunks ([b62111f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b62111fc8aa9bda891dfe2538b35b0d669f9dcae))
* **dogfood:** unblock pr 69 ci — return after exit, mock claudecodeadapter ([42c0360](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42c0360759fab3f8bdd86d4867eb300d2135a8c6))
* **orchestrator:** address local review findings for RFC-0008 ([3da537b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3da537b7aa1dd2a8c184414fc65368a3b23c94fe))
* **orchestrator:** convention detector — React naming, multi-test-dir, path aliases (AISDLC-80) ([fdeefe4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fdeefe405f758b703c5bb5ec609c4fea4db2c009))
* **orchestrator:** deflake withmergegate timeout test ([57aa161](https://github.com/ai-sdlc-framework/ai-sdlc/commit/57aa161de32b1631f94b08109667afb3cdce6dd9))
* **orchestrator:** disable git core.quotepath so unicode filenames stage cleanly ([ea27178](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea27178afc6e266cc566b76848c20199790ce0cd))
* **orchestrator:** include staged diff in detectChangedFiles ([b255d7a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b255d7a7c1836eb311c1967549898743097f15a4))
* **orchestrator:** init UX papercuts (AISDLC-78) ([a4303bf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a4303bf7cbf3150f7bff0aa34d2c917088c18c3d))
* **orchestrator:** only stage agent-touched files (drop git add -a) ([0eef249](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0eef249d2bec18253ac4f73562c2771f37975aaf))
* **orchestrator:** pass dispatcher pipeline through; rebase before push ([26c2061](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26c2061ea3f49a7e776cb237613485adb384b4fc))
* **orchestrator:** pin scheduling tests to peak hour to deflake CI ([8e07d24](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e07d2484d5297ce1667d0381f490d2d0f6c7666))
* **orchestrator:** restore HEAD, surface guardrail detail, detect cross-repo writes ([34cdbb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34cdbb27a14eb89ebbbaa57533a79e726386c495))
* **orchestrator:** schema-validate attestation predicate + sanitize GITHUB_OUTPUT (AISDLC-74) ([09ccaf3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09ccaf3c66709ae93af06a59d3cfbe617a7281e4))
* **orchestrator:** strip GIT_DIR from all execSync('git ...') sites (AISDLC-72) ([09e7780](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09e7780e121ad26e18ace9f6fb0463ed318a7c64))
* **orchestrator:** unshadow CLI --version listener and cover with integration tests (AISDLC-78) ([db8c4b2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db8c4b2afa3384d83663997ae02760a6dd12c2da))
* plugin install fixes, quality gate false positives, gitignore deduplication ([cf84f09](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf84f09cf93aabd8e22acc5e0262a4ed22d4e4e0))
* stop tracking orchestrator/.gitignore — generated at runtime ([909759b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/909759bd3cd7051f0bb2bdcb6696bc2277ec282b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.7.0

## [0.6.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.5.0...orchestrator-v0.6.0) (2026-03-31)


### Features

* add action governance — blockedActions in agent-role.yaml ([#45](https://github.com/ai-sdlc-framework/ai-sdlc/issues/45)) ([eb53342](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eb5334229bfd3f66464c4986efb0c432d1756a3e))
* add automated dogfood pipeline — admission, routing, and PR review workflows ([4583ab6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4583ab65285163ab16e42f140cdd74e87dbfdb9a))
* add pipeline visibility and lint/format to agent context ([8f07b3e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f07b3ef4bc72c1a3bc48a1ba77e6ab9643420ea))
* add pipeline-level cycle detection ([#41](https://github.com/ai-sdlc-framework/ai-sdlc/issues/41)) ([#42](https://github.com/ai-sdlc-framework/ai-sdlc/issues/42)) ([c730803](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7308031e4b6f340c1cc195ae876565d0afe6d7d))
* add Slack integration — pipeline visibility and emoji-to-issue trigger ([ec53b7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec53b7c7cd9adf834e17c28fb7e45271d1bd6e9a))
* add trust-based source weighting to PPA admission scoring ([c04ca18](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c04ca1836ce35db8f15f363f1efb5262317eefb0))
* add typecheck command to agent prompt to prevent pre-commit failures ([3497c71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3497c7191bb2c7a5b34e973a68de3fc2986644ae))
* human-readable agent log output instead of raw NDJSON ([685452f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/685452f8559232d187df0a6a0095f017ef4f0fb8))
* stream agent progress via Claude Code stream-json output ([4c5c5b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4c5c5b4ead16d2238af4809ec1ea1e1ef954767b))
* workflow pattern detection Phase 1 — telemetry collection ([#50](https://github.com/ai-sdlc-framework/ai-sdlc/issues/50)) ([68f36be](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68f36be6e66dd354b483ed2d851993823d544b7b))
* workflow pattern detection Phases 2-4 — detection, proposals, artifacts ([e6ffd6a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e6ffd6aa93cbd9ca27fdb9b2eead4e6f12ed54ac))


### Bug Fixes

* Add missing validation for empty issueBody in SecurityTriageRunner ([#33](https://github.com/ai-sdlc-framework/ai-sdlc/issues/33)) ([#34](https://github.com/ai-sdlc-framework/ai-sdlc/issues/34)) ([9f81e66](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9f81e66dde0950f13272064cb36695cd7c2d8387))
* add real-time observability to Claude Code runner ([bcb2f08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcb2f0825f52914fa7b07acd286bbdd97f50dd87))
* address review findings — add schema, audit logging, requireHumanApproval ([e11a79d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e11a79dcacd8ff0f19934e09e18c6e169879a52f))
* Agent should address review findings before human review ([#35](https://github.com/ai-sdlc-framework/ai-sdlc/issues/35)) ([#36](https://github.com/ai-sdlc-framework/ai-sdlc/issues/36)) ([34c7606](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34c7606db4dacdc21875f876f332f8d61bfc4c2a))
* allow review dismissals with documented reason ([c38fa35](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c38fa358d89c6d9d297f68bbb7f4f99fbd008569))
* detect agent commits by diffing against merge-base with main ([5a27dc6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a27dc66d51c87587f02da1eaa60e46f5fa962b4))
* detect agent-committed changes instead of reporting 'no files modified' ([7b6309d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b6309d30a0a1a172951ba83cbc542311dc86143))
* only use openshell prefix when provider is explicitly openshell ([e2ea832](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e2ea8324c8de7fb49c16e64bcc21e6d85a4df5e1))
* prevent duplicate .gitignore entries from ensureRuntimeGitignore ([a1ff0fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a1ff0fe49681ea1200059e5eefc40e555915361c))
* resolve issue [#29](https://github.com/ai-sdlc-framework/ai-sdlc/issues/29) ([8b74a6d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b74a6dbe9eee88c85fea40269e79c34ceded39c))
* resolve issue [#37](https://github.com/ai-sdlc-framework/ai-sdlc/issues/37) ([a8b0707](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8b0707fa96b565a049fd8f123535a6eb885a3ca))
* resolve issue [#46](https://github.com/ai-sdlc-framework/ai-sdlc/issues/46) ([6bd9f39](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6bd9f39c84423f688e39f87467c5aea4810e446c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.6.0

## [0.5.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.4.0...orchestrator-v0.5.0) (2026-03-24)


### Features

* add composite IssueTracker adapter for multi-backend routing ([0cf6a12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0cf6a12cdb21a0592ff448156ea452c8c3ce3e55))
* add NVIDIA OpenShell sandbox integration ([cac7ab2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cac7ab2000f7a04722a16f21b7ac0bdcfd119a95))
* add security triage pipeline and backlog-drift hooks ([8859bf5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8859bf57a3096ffab98786a6f0d5ddbdf4b4ccfd))
* add test coverage reporting with Codecov ([f31137a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f31137a52f3c6ec317c68eef50403e05b2b1c19e))
* address PPA architectural concerns for RFC readiness ([db00094](https://github.com/ai-sdlc-framework/ai-sdlc/commit/db00094b74ed825dc88ddcee885961f01d9a7e17))
* complete OpenShell integration gaps ([905219a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/905219a77e15ab0c7c0398abb6a3adaf2fa75fe6))
* integrate Product Priority Algorithm (PPA) across all SDKs (AISDLC-7) ([bc4a32d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc4a32df4de65eb9c853b33e85aac56690092ecf))
* support multiple AdapterBinding resources per repo ([5a0b39e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a0b39e56dfb4f24be3c1b726b36201cb6cdad42))
* support string issue IDs and config-driven tracker resolution ([56f3c95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/56f3c95326da253a914f54613a3240147911b25c))
* wire OpenShell sandbox into runner and execution pipeline ([84df6fb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/84df6fb9e136147d33ddd3bb842225b4580c337d))


### Bug Fixes

* Add formatIssueRef and issueIdToNumber unit tests (#AISDLC-4) ([#24](https://github.com/ai-sdlc-framework/ai-sdlc/issues/24)) ([5f5f0cb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5f5f0cb3135ac2977780bb099a6ee106e9e316e9))
* backlog adapter, runner lint/format, and gitignore dedup ([#25](https://github.com/ai-sdlc-framework/ai-sdlc/issues/25)) ([ae44805](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ae4480566181b3f715a7365bccff13968fc883ea))
* prevent duplicate .gitignore entries from ai-sdlc init ([957e89f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/957e89feb5a83b99f26cafaa0009b49738849b44))
* resolve TypeScript build errors in test files ([c3cb763](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c3cb763c0c8635ccc243ceb04aadffc9c2ba57a0))
* use config dir path for triage config loading ([eaa3a7f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eaa3a7fdca49ad2959243b0ce52ddf1309a15944))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.5.0

## [0.4.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.3.0...orchestrator-v0.4.0) (2026-03-08)


### Features

* add Backlog.md IssueTracker adapter ([3b1e11c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3b1e11cb4022680fa8cd9e1e24719e57b607bffe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.4.0

## [0.3.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.2.0...orchestrator-v0.3.0) (2026-03-08)


### Features

* auto-detect coding agents, workspace support, and MCP setup during init ([7d224db](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7d224db1c07035763863298173133ff87354d847))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.3.0

## [0.2.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/orchestrator-v0.1.2...orchestrator-v0.2.0) (2026-03-06)


### Features

* implement RFC-0004 cost governance (phases 1-3) ([34e0e03](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34e0e03a8d01b9a964f71b1096654183c8f6d75f))


### Bug Fixes

* address feedback issues [#3](https://github.com/ai-sdlc-framework/ai-sdlc/issues/3), [#4](https://github.com/ai-sdlc-framework/ai-sdlc/issues/4), [#8](https://github.com/ai-sdlc-framework/ai-sdlc/issues/8), [#9](https://github.com/ai-sdlc-framework/ai-sdlc/issues/9), [#10](https://github.com/ai-sdlc-framework/ai-sdlc/issues/10) ([0efc9dd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0efc9dd78eb1ab1ebfe93507b74650ca6b687926))
* **orchestrator:** use createRequire for better-sqlite3 in ESM context ([d67464a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d67464adf454f4c96c460f96979612ca3fa72609))
* resolve all lint and format errors across codebase ([27526fa](https://github.com/ai-sdlc-framework/ai-sdlc/commit/27526faef49fec6fabca3cfdbb11994721866e90))
* resolve workspace:* leak and invalid init templates ([68404b7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68404b7e92687b558e0e842a3642ddc52613698b))
* sync Go SDK schemas with canonical spec and add publishConfig to packages ([78283b3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/78283b35b2c6986f30e35f92a5ddf01c8e3b3462))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.2.0

## 0.1.2

### Patch Changes

- e37c98a: Fix validation error messages, add validate command, wire gate check runs, and load config into MCP advisor
- Updated dependencies [e37c98a]
  - @ai-sdlc/reference@0.1.2
