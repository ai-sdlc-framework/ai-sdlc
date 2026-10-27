# Changelog

## [0.37.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.36.0...pipeline-cli-v0.37.0) (2026-10-27)


### Features

* knowledge ingest adapters for decisions, RFCs, reviews, events, tasks (AISDLC-774) ([#2007](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2007)) ([699af7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/699af7c8742936aa78f84c1bfccb19fe205aa3a6))
* **orchestrator:** cli-hierarchy demo regenerates the terminal demo clip (AISDLC-1079) ([#2016](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2016)) ([be6822c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be6822c195232e7b49e645ba4cb6b825fece9523))
* **orchestrator:** cli-hierarchy spawn creates a per-task executor session (AISDLC-1073) ([#2017](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2017)) ([caf223f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/caf223f578112307191571d353dc92b6e91abcdd))
* **orchestrator:** fixed-prefix tiering, path-bound rules and control linter (AISDLC-782) ([#1988](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1988)) ([45aba26](https://github.com/ai-sdlc-framework/ai-sdlc/commit/45aba2643c32e4e9adec40cd3174c0ec78eba00a))
* **orchestrator:** status CONTEXT column flags sessions over their clear threshold (AISDLC-1066) ([#2005](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2005)) ([7343754](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7343754b45d056d673b069de30c8d6fb0a99728e))
* **orchestrator:** step 6 runs verify commands and gates on exit status (AISDLC-1078) ([#2013](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2013)) ([a2210e4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2210e43cd3654ba14031c367302bb4ebdfb2979))
* show hooks-module health in status and fail up when dispatch has none (AISDLC-1061) ([#1980](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1980)) ([5965c97](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5965c972fa780201fb419ba8c1a4bf0efd12f62e))


### Bug Fixes

* **orchestrator:** refuse fork and protected fixesPr heads, add takeover pipeline test (AISDLC-1070) ([#2012](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2012)) ([494112c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/494112ce8b49aaea94dd7a7e4de6a5bea7062c85))
* refuse executor-start --wait without a module and guard idle repeats (AISDLC-1065) ([#1991](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1991)) ([89d5c53](https://github.com/ai-sdlc-framework/ai-sdlc/commit/89d5c53933e3f9556cc9df6329989f201efec50b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.37.0

## [0.36.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.35.0...pipeline-cli-v0.36.0) (2026-10-23)


### Features

* a --until rule gates the claim and an unchecked executor start is refused (AISDLC-1025) ([#1883](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1883)) ([b0d06fd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0d06fdb979489814335219471117236c4a44972))
* A dispatch wake reads one PR snapshot and re-evaluates only PRs whose head or checks moved since the last wake (AISDLC-959) ([#1761](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1761)) ([19956af](https://github.com/ai-sdlc-framework/ai-sdlc/commit/19956af6a39efb576a3cb5e0c5f0bafd2eec0cb2))
* a manifest with fixesPr runs on and pushes to that PR's head branch (AISDLC-1054) ([#1954](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1954)) ([2f5c040](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2f5c0400a436edaad64351d54ea0693c3f73801e))
* Add the CLI-level test for the cli-workflow graph subcommand so PR [#1907](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1907) passes the patch coverage gate (AISDLC-1052) ([#1950](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1950)) ([bd0343b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bd0343b3353dc7217702997eb2fac3a84a898aa0))
* add Workflow schema, manifest entry, init scaffold and doctor check (AISDLC-992) ([#1955](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1955)) ([d35dc12](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d35dc12d787759b9ba0e430ab326cfef40c5ddb2))
* allowForcePush mode lease for any non-protected branch (AISDLC-1005) ([#1828](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1828)) ([3820bda](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3820bda7b65c19203fc41fee5e7a68331527e717))
* attestation and leaf growth is a measured row in the tooling-limitations register (AISDLC-968) ([#1884](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1884)) ([3824ed0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3824ed0d7a72c10e75486deaabbf34a429e52614))
* **ci:** post-merge pipeline canary on macOS holds the drain and files a hotfix (AISDLC-1023) ([#1895](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1895)) ([c0ee0f2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c0ee0f2ae7b56c004d459fb4654cb0744a201400))
* clear writes a start token that executor-start consumes (AISDLC-1028) ([#1893](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1893)) ([dc1ec86](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dc1ec865d539618e21e290dd6ade704856da431c))
* cli-dispatch reprioritize and peek --order show and change claim order (AISDLC-904) ([#1709](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1709)) ([853967e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/853967e167dc090d55637986ed85017638f3df16))
* cli-file task --update edits an existing task on main (AISDLC-921) ([#1742](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1742)) ([98ef1ed](https://github.com/ai-sdlc-framework/ai-sdlc/commit/98ef1ed33dd4f567617c3627c45a7af2f675d4ce))
* **cost:** per-PR, per-rung model spend report ledger and readers (AISDLC-885) ([#1770](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1770)) ([ca9fb47](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ca9fb47d585dfd39d080d58d9387c70bf9e3deeb))
* delete the command-text matcher from the blocked-actions hook (AISDLC-1014) ([#1845](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1845)) ([6ff154d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ff154d77ceb9101da027cd9d36cf69364dc7e67))
* delete the hierarchy keystroke layer, clear becomes a rotate request (AISDLC-1037) ([#1964](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1964)) ([3f1c1cf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3f1c1cfd907372ed8b430b2abd3a707d396985b6))
* delivered vs landed definition of done, claim pause on undelivered PR (AISDLC-816) ([#1707](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1707)) ([2bd9cb6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2bd9cb637e3762272febd3e7031dba42327b7d95))
* dispatch tick owns parent-checkout upkeep (AISDLC-981) ([#1816](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1816)) ([6a3283b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6a3283bb42365b3784a88d5e8ed1638a1551c6b1))
* docs lane accepts docs/* head branches (AISDLC-1006) ([#1838](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1838)) ([d04a71d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d04a71de80c33ee6b623ae0db60c43aa80345b6a))
* drop earlier attestation chore commits before re-signing (AISDLC-999) ([#1817](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1817)) ([bcf6fb3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bcf6fb3ec09eedce8bc7833d1af4ad83c5d44f79))
* enforce fresh reviewer context and one worktree per task (AISDLC-995) ([#1914](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1914)) ([de0ddf1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/de0ddf10063317d3cf4f89dd1f879d536d055bf6))
* executor clear handshake polls for the identity line (AISDLC-1000) ([#1823](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1823)) ([2b19092](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2b19092ddfc2d499dd51cf6679a2c9960b026b89))
* finalize runs waived-tests governance check locally (AISDLC-1056) ([#1962](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1962)) ([21f4533](https://github.com/ai-sdlc-framework/ai-sdlc/commit/21f45330e2ffb1244d6f14cd560b3d8afa58b618))
* hierarchy hooks module executor role, executor-start loses --wait and token (AISDLC-1034) ([#1947](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1947)) ([074da29](https://github.com/ai-sdlc-framework/ai-sdlc/commit/074da29810dc0955f294fde040d345683c8318c4))
* hierarchy mod planner role and roster send wrapper (AISDLC-1036) ([#1959](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1959)) ([5a6c1b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5a6c1b4edcd82012895a0fd14853fb58d6e5e0b9))
* model-less dispatch host, delete idle-backoff and dispatch clear (AISDLC-1035) ([#1957](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1957)) ([0946dca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0946dcac09086bc253073aa74dca6858797b0d83))
* model-routing.yaml is the single source for role to model; fill the cells; pins gate asserts frontmatter equals the table (AISDLC-982) ([#1804](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1804)) ([5c28f1c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5c28f1c4001d1c9b55ad427b2968529e6e20dd01))
* **orchestrator:** auto-clear at threshold, log every exit (AISDLC-1007) ([#1843](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1843)) ([50777a2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/50777a2b7113cd7965d5744530b65be4c311f8ff))
* **orchestrator:** cli-dispatch block parks a queued task (AISDLC-1043) ([#1935](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1935)) ([0023d7d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0023d7d0fb1be33d19e0e9bd30d0507e4396d7e1))
* **orchestrator:** close CLI-opened PRs superseded by identical landed content (AISDLC-1011) ([#1849](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1849)) ([0b7eab2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0b7eab2929cf192cfd9fa788875247933fee10a0))
* **orchestrator:** correct a filed-but-unmerged task via cli-file rebase --source (AISDLC-1045) ([#1933](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1933)) ([d125843](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d12584365b14f45bdd311c3cdac4f5d5d89f88bf))
* **orchestrator:** handoff note ledger of outward actions and exact-text gate (AISDLC-1049) ([#1943](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1943)) ([b4590e6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b4590e6e06b7548fb61f5257ec0cbb221b24fe03))
* **orchestrator:** hold is a board state set by cli-hierarchy, never stops reporting (AISDLC-899) ([#1660](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1660)) ([b8284f7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b8284f7651b8b3efecbfb03422135940a0ee591f))
* **orchestrator:** land-prep runner with guarded ready flip (AISDLC-881) ([#1600](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1600)) ([ed12110](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ed12110447c5dd642d56c61ee9fed1564dcd3d74))
* **orchestrator:** log every gh call with session and quota, report in status (AISDLC-963) ([#1775](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1775)) ([4ade6d9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4ade6d98a9680258b980eeaa86b6bd891e6f9326))
* pace cli-file --pr against the installation rate-limit bucket (AISDLC-986) ([#1803](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1803)) ([5442d65](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5442d65dafe8e3eef37056d79be9049bb213e1af))
* pipeline hotfix lane pins the executor to the last canary-green build (AISDLC-1024) ([#1902](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1902)) ([6ddfacf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6ddfacf3d84ddae9a3660e35d9f2a75d3baaf74d))
* reenter --developer-round forces a developer round (AISDLC-1053) ([#1953](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1953)) ([2e404cc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2e404ccc1db506197e452097714afa2626e4de89))
* refuse a stale pipeline-cli build at hierarchy launch (AISDLC-988) ([#1781](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1781)) ([cedd846](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cedd8466eac01e79a2ec4cbb94e6ab92dea7948b))
* report rejected briefs every tick and retry on parent head change (AISDLC-952) ([#1702](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1702)) ([a60b32b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a60b32b7f3a8cb6ad419e920aeb2135461ffb3c7))
* reviewer harness default from model-routing.yaml (AISDLC-1003) ([#1821](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1821)) ([10ba9a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/10ba9a7fbc92f00ed6b74c24d50597e476d957aa))
* run CI sweep every 15 minutes and keep busy tick board-only (AISDLC-960) ([#1809](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1809)) ([cf7502a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cf7502a3b6b01c5a573c27b4b227c9b1739a1cf2))
* **spec:** render standing decision rules into prompts (AISDLC-873) ([#1765](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1765)) ([196cd9f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/196cd9f667a463c965f88b3b427a2a03a375125f))
* verifier requires a verified envelope chain for delta review ranges (AISDLC-970) ([#1853](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1853)) ([3e629c9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3e629c937350a58c2cbadbd26387abe4ff86f344))
* wire pr-lifecycle operational keys, drop trust constants (AISDLC-980) ([#1815](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1815)) ([4dd3322](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4dd33227182c3da7b2a44e9a1db9e9a961685928))
* workflow engine behind AI_SDLC_WORKFLOW_ENGINE=1 with workflowDigest (AISDLC-993) ([#1958](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1958)) ([6e1e469](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6e1e469f128bdf4a7da0d4a6d97fa46e214f89ae))
* workflow overlays, frozen set with cited enforcers, base-branch pr-lifecycle (AISDLC-994) ([#1960](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1960)) ([9cfcde3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9cfcde3d3aa0e78faeb077e0fe171fd04da876e3))


### Bug Fixes

* a failed emit-leaf at step 7d fails the run there, not at signing (AISDLC-978) ([#1890](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1890)) ([c77fb08](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c77fb0856ec8e4dbcf1b368a5cce143b418850ec))
* a verified executor start stays verified until the next clear (AISDLC-1032) ([#1904](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1904)) ([7b5e143](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b5e143ec1d9aeeec57343e7e6b26185bd0831ad))
* arm uses the right source kind and executor keeps stdout refusal reason (AISDLC-919) ([#1919](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1919)) ([c2570c9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c2570c911c35585d727e8856f7d02f7f74b2fef1))
* brief keeps its slug and full dependency list (AISDLC-923) ([#1908](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1908)) ([cfd1713](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cfd1713293af85998a3f747ffed46bd6fa001d56))
* build pipeline-cli where staleness is detected instead of falling back (AISDLC-1001) ([#1811](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1811)) ([ef286b8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ef286b83ff11f0a190ef5a727951433b063cd62e))
* close-superseded names the PR that landed the content (AISDLC-1055) ([#1956](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1956)) ([f8a7feb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f8a7feb2c682f227ee31d86ed66e0f3e84f55cee))
* **deps:** migrate to zod 4, ZodError.errors to .issues (AISDLC-1038) ([#1916](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1916)) ([5487fa5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5487fa5509659688225a26ad69db85615bc01b72))
* derive after from dependencies and hold a claim until each has landed (AISDLC-1027) ([#1885](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1885)) ([a882b7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a882b7ced79291bf9ae3782e9557ed5582c17365))
* derive executor test default model from the routing resolver (AISDLC-1002) ([#1812](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1812)) ([0d0e34a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0d0e34a183dc203076b916df792c4f818fa0886b))
* gitignore claude memory dream output so step 0.5 stops aborting (AISDLC-869) ([#1906](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1906)) ([972cb68](https://github.com/ai-sdlc-framework/ai-sdlc/commit/972cb689ce12015f975f61665d4f63e558ca7a41))
* guard against pushing a task branch from the parent checkout (AISDLC-1019) ([#1870](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1870)) ([96f085a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/96f085a8ebcabdfaa8284293a24711aee0c58a35))
* hand reviewers a bootstrapPrompt naming the prompt file (AISDLC-1031) ([#1901](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1901)) ([e50702e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e50702e6f140a6a95017799e2a80d04eb57bd1f3))
* merged PR completes its iterate-needed task (AISDLC-1030) ([#1903](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1903)) ([7cf9100](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7cf9100cadbcc70a0d578af0e98e1930daa4ba63))
* one review-ledger path helper and a lint gate on hand-built paths (AISDLC-1020) ([#1879](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1879)) ([3bb16d6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3bb16d6752e8940c53545af80963b08184b7476d))
* **orchestrator:** a resume of a delivered task never rewrites its task file (AISDLC-1026) ([#1882](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1882)) ([0e4956c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0e4956c884da8b410defdbf6dd6eee90b2dc6c88))
* **orchestrator:** clear confirms the resume command was submitted or fails loudly (AISDLC-1029) ([#1900](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1900)) ([3b795de](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3b795de43b72b2d314e6f16eac1b4df18dedd9bb))
* **orchestrator:** fail Step 10.5 when the review ledger cannot be staged (AISDLC-967) ([#1848](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1848)) ([fce26ed](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fce26ed503f940a6c2aa0d9f41ec9bf5ba99a554))
* **orchestrator:** lease-push Step 11 own pre-sign rebase (AISDLC-1016) ([#1858](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1858)) ([7b5e72d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7b5e72d2228d301c7a2df51b8186bb71b1df5aba))
* **orchestrator:** reprioritize must not create a resume block (AISDLC-1015) ([#1857](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1857)) ([4726e20](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4726e207146f86a34c407d88166491b2edab5cd0))
* **orchestrator:** step 0 sweep makes one batched gh call and caches landed branches (AISDLC-958) ([#1739](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1739)) ([ce2a182](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ce2a182981bc66ab8d85cc49ffe75561a604b103))
* **orchestrator:** up owns the reconcile scheduler; receiver touches .reconcile-wake (AISDLC-932) ([#1729](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1729)) ([191a3cc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/191a3cca193432f832c095e229b26dfe025437a2))
* playbook runs rebase-push on push-non-fast-forward (AISDLC-918) ([#1783](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1783)) ([0946321](https://github.com/ai-sdlc-framework/ai-sdlc/commit/09463218a9b7bd94b7e822559ad7297d222fa731))
* reconcile cli-hierarchy docs with code, share gate-run lookup (AISDLC-983) ([#1772](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1772)) ([434f593](https://github.com/ai-sdlc-framework/ai-sdlc/commit/434f593a44a013b63a68326cc151320213aefa54))
* reconciler arms the decisions-sync PR with its own source kind (AISDLC-935) ([#1771](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1771)) ([9baa4ff](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9baa4ffa8025e9c1b7f4a959423635faf3e8253f))
* reenter machine route reruns the resolved gate run id (AISDLC-962) ([#1744](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1744)) ([a385360](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a385360b46b815ba070d57afbb7ed97d108e7e72))
* render Follow-up from structured followups, check at finalize (AISDLC-997) ([#1801](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1801)) ([b935436](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b935436d49895f1d8a2428694798e853c7ae784f))
* report what GitHub shows for --arm, land directly without auto-merge (AISDLC-1009) ([#1844](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1844)) ([b0aefed](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0aefedea1e33237ca30aa3fd9bf88725a8632fe))
* reprioritize --note never overwrites resume.note (AISDLC-1047) ([#1940](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1940)) ([e542085](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e54208506b108eab93ec9630058684f85e87af9e))
* route remaining auto-arm calls through merge-if-eligible (AISDLC-975) ([#1864](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1864)) ([694e94e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/694e94e72323eeedb989ec9b8bfa8831905a8ed1))
* ship and resume fail closed when head has no v6 envelope (AISDLC-984) ([#1777](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1777)) ([4eac182](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4eac18203e4dc0a8d19fe753224f694c221bccff))
* sign with the post-rebase patch-id (AISDLC-998) ([#1802](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1802)) ([d5b7d5e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d5b7d5eb2c74d35f7e7b8915a8753a9bd6106d0f))
* stage the review ledger by its lowercase path in Step 10.5 (AISDLC-1017) ([#1872](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1872)) ([88f3018](https://github.com/ai-sdlc-framework/ai-sdlc/commit/88f3018e079542c01be51a93764f8178a1a4ecd4))
* staged verdict is advisory in review-finalize aggregation (AISDLC-974) ([#1778](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1778)) ([b58909e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b58909eb98c7cc21c5eb9f534f9d8104c5f0f915))
* write landing-gate audit under the main checkout (AISDLC-1010) ([#1856](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1856)) ([3331ea8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3331ea89eb919075e8b706dbeb255a28c2b36939))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.36.0

## [0.35.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.34.0...pipeline-cli-v0.35.0) (2026-10-17)


### Features

* add memory dream command to consolidate agent memory (AISDLC-729) ([#1522](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1522)) ([f7c7cb3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f7c7cb317e1fdf4914501eb2f2383d693b2f27cc))
* alert-only stall notice (AISDLC-871) ([#1728](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1728)) ([e8d736d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e8d736d31a770462a60dd814719eccb48e9b58a3))
* **ci:** docs lane skips lint, DoR treats sibling filing PR refs as pending (AISDLC-879) ([#1621](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1621)) ([1e2bb5a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1e2bb5ab98a3f1116147e7ebf8f389bed925c9c6))
* decisions-sync PR opens ready; trusted decisions-sync source kind (AISDLC-895) ([#1601](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1601)) ([65713e6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/65713e6cce015bba62e622e65c8ffd0ee5cc0d34))
* **docs:** an executor never parks on a question (AISDLC-948) ([#1694](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1694)) ([ec7319c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec7319cf7a3a348b8f0764eed17b79b7a46e774b))
* Failed executor work is re-claimable by the normal loop: resume finds a completed task file and a push-only refusal falls through to a full resume (AISDLC-946) ([#1699](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1699)) ([91ffb7f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/91ffb7f9bb77d1937a8db9f3518f80ea516cc1ac))
* incremental review works in every case [needs-human-attention] (AISDLC-725) ([#1346](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1346)) ([0080319](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0080319f4c5b94cadf908710fe433f40643378da))
* **orchestrator:** add pr throughput kpi command and page (AISDLC-877) ([#1599](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1599)) ([791f547](https://github.com/ai-sdlc-framework/ai-sdlc/commit/791f5470e788f94f157026e479688726bacb3c56))
* **orchestrator:** clear on context threshold only, not per tick or idle wait (AISDLC-815) ([#1696](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1696)) ([efb32d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/efb32d707fa56eb53ae40100b00388d81c29eab8))
* **orchestrator:** dispatch tick lands eligible own-author PRs (AISDLC-894) ([#1612](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1612)) ([ec657c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec657c0bd5cf6ef33a6f52333c6b4e146ac7b829))
* **orchestrator:** docs lane for cli-file filing PRs (AISDLC-878) ([#1622](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1622)) ([ebd5f8e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ebd5f8e662aff32f3a6df3a795946aa3deb4ea15))
* **orchestrator:** init scaffolds required consumer config from one manifest (AISDLC-910) ([#1606](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1606)) ([6f3bffc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6f3bffc94705144e779dda6a2ddacacf313cd626))
* **orchestrator:** reenter &lt;pr|task&gt; replaces resume and requeue --note (AISDLC-882) ([#1603](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1603)) ([30b7326](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30b7326991e68a876075d6b33b138b0fb173930f))
* **orchestrator:** resume skips review when the patch id is unchanged (AISDLC-947) ([#1700](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1700)) ([301b9cc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/301b9ccc48f10d04d0ebb64a4889c136d384fb85))
* **orchestrator:** same-head loop guard; drop stale-claim row and ci-failure-watcher (AISDLC-883) ([#1608](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1608)) ([30cf5ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30cf5ca5bd7eae959bdffb8e336ed2ceeb876ccb))
* **orchestrator:** surface PRs needing a human in tick report and digest (AISDLC-888) ([#1607](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1607)) ([eec20c6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/eec20c6946c7996f7fd02970f5b5a3c97b295122))
* **orchestrator:** webhook receiver and event records (AISDLC-880) ([#1602](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1602)) ([39b1493](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39b14937cf9894fd29197a32652d290f3443d509))


### Bug Fixes

* **ci:** format the mcp tarball envelope writer like the others (AISDLC-875) ([#1568](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1568)) ([c1eca71](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c1eca71364a687039478796438068883faa7f77f))
* classify installation rate-limit red as rate-limited (AISDLC-949) ([#1695](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1695)) ([be1e14b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be1e14b5e2fb4815eb9d20e082508dbec507bd63))
* cli-file task accepts a task file written outside the parent tree (AISDLC-931) ([#1668](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1668)) ([d8da92e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d8da92e0c1579f5e31dda998b8b4713caea2e471))
* commit review ledger with leaves before step 10.5 rebase (AISDLC-951) ([#1701](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1701)) ([7df782c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7df782c1f44acaf5c23c93c083886e0933a7e01a))
* **docs:** handoff write keeps one notes block and archives older prose (AISDLC-933) ([#1725](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1725)) ([1d72025](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1d72025c3e6461e4b4740a8f728d8222ef5f6c80))
* isolate CODEX_HOME for every bin-invocation test (AISDLC-908) ([#1595](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1595)) ([7305525](https://github.com/ai-sdlc-framework/ai-sdlc/commit/73055259bad3cf338920363409c657c6b3bdd3c9))
* make cli-usage ingest tests hermetic against real codex home (AISDLC-915) ([#1590](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1590)) ([a8f9c7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a8f9c7c2fddc810aaac9324de5ade41ea2178a0b))
* **orchestrator:** auto-brief a filed task so it reaches the dispatch board (AISDLC-930) ([#1666](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1666)) ([a80de7b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a80de7b2872e3d11199907993b86a0528fdec5f8))
* **orchestrator:** classify Detect Changes failed + downstream skipped as rate-limited (AISDLC-953) ([#1708](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1708)) ([0f8b4d5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0f8b4d5e3042fc607698637cce9e9219c019204a))
* **orchestrator:** cli-file decision reads and writes the per-event decisions store (AISDLC-852) ([#1597](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1597)) ([02f5e3c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/02f5e3c224b8027800a3480b040bafce34bd2c75))
* **orchestrator:** cli-file removes its source copy after push (AISDLC-950) ([#1697](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1697)) ([9b39cb4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9b39cb47d60f6690c7cdc6c0ecfde3023585ca80))
* **orchestrator:** close three dispatch board gaps from the 2026-10-14 hand-off (AISDLC-868) ([#1598](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1598)) ([dc67ee9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dc67ee94a8580d63b01f01a273566074047eaaf2))
* **orchestrator:** decision events skip the parent; ff cleans identical copies (AISDLC-874) ([#1710](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1710)) ([857308c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/857308c6bd0bc77ccedee3f1075e72fa8ac3fac1))
* **orchestrator:** decisions-sync commit uses the session git identity (AISDLC-928) ([#1631](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1631)) ([888f554](https://github.com/ai-sdlc-framework/ai-sdlc/commit/888f554031d472d08e6a6ddcca753209cd72843b))
* **orchestrator:** dequeue retires a stale queued manifest with a reason (AISDLC-907) ([#1638](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1638)) ([fd39caf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd39caf11458e19e5532298063d3feaaecdb6251))
* **orchestrator:** dispatch facts gatherer fills state mapping and failing line (AISDLC-913) ([#1645](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1645)) ([f1937a6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f1937a6785bd5f7ca8473504947ad03d040671dd))
* **orchestrator:** dispatch keeps planner rulings and drains its inbox first (AISDLC-903) ([#1609](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1609)) ([8e134ab](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e134abd64ca39a1fdc8e7d3aedda54f33f2a136))
* **orchestrator:** enqueue and Step 2 share one branch name (AISDLC-851) ([#1571](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1571)) ([642e281](https://github.com/ai-sdlc-framework/ai-sdlc/commit/642e281f4e863f459c4147d48c61c90df9bf990c))
* **orchestrator:** envelope formatter counts key prefix in line width (AISDLC-916) ([#1637](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1637)) ([f87e3ae](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f87e3aedee911233d28c48c84322020dedafa183))
* **orchestrator:** findTaskFile accepts both task filename shapes (AISDLC-965) ([#1734](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1734)) ([2f48fe0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2f48fe03013cb46c7431a9a6c4325a8a6444bf4a))
* **orchestrator:** gate 3 ignores task ids in body prose (AISDLC-898) ([#1604](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1604)) ([7dfbfda](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7dfbfda25e081f03b9674cac1f9042a6234ff70e))
* **orchestrator:** handoff read shows state block plus newest prose (AISDLC-889) ([#1679](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1679)) ([af0c9ed](https://github.com/ai-sdlc-framework/ai-sdlc/commit/af0c9ed28aa64453cfd79818d6439643a4c014e0))
* **orchestrator:** label attestation leaf with real reviewer harness (AISDLC-911) ([#1614](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1614)) ([388de20](https://github.com/ai-sdlc-framework/ai-sdlc/commit/388de204509c571114eddf4181f8af1c4b49734c))
* **orchestrator:** mark-ready flips task PRs ready when the repo has no CodeQL (AISDLC-896) ([#1636](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1636)) ([9cb8ff0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9cb8ff009b4307a3809b85f433c33baf33e49e4e))
* **orchestrator:** name the cwd cause on a lease-push refusal (AISDLC-905) ([#1650](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1650)) ([ff2015a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ff2015a19ad728ab2556392150ac5117b115b361))
* **orchestrator:** planner auto clear resumes after 3s, not 60s (AISDLC-912) ([#1724](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1724)) ([30b4162](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30b4162d6f131d252002aa901eed3b3ea3eeb01c))
* **orchestrator:** reconciler reruns resolve the gate run id (AISDLC-945) ([#1706](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1706)) ([9b7f048](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9b7f048b93835b703234aaf0bf32fcd8d3e114d7))
* **orchestrator:** requeue counts prNumber-only OPEN PR as follow-up (AISDLC-857) ([#1573](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1573)) ([30033a9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/30033a9320b34f495550160197ef73a0290ff086))
* **orchestrator:** resolve target repo via GitHub (AISDLC-897) ([#1580](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1580)) ([c6392f6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c6392f62df9e4813c5e868554a0244ff1ab1ef0c))
* **orchestrator:** rewrite queued manifest branch from PR head (AISDLC-901) ([#1615](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1615)) ([541495a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/541495a5ae94e3d97383e32c09a18d22914ddaf2))
* **orchestrator:** treat installation rate-limit reds as wait-and-rerun (AISDLC-926) ([#1642](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1642)) ([a386cd8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a386cd85e085fa73285097b75ec9ac11cd1a01f4))
* red main is surfaced by the dispatch tick, not a GitHub issue (AISDLC-929) ([#1662](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1662)) ([e983ef2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e983ef2a2a0e1f304cd17cc65339164530afb819))
* reenter loop guard keys on the origin head (AISDLC-937) ([#1693](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1693)) ([81075ff](https://github.com/ai-sdlc-framework/ai-sdlc/commit/81075fff380c1764374c9983baec7e0cd01255a3))
* send route-to-planner once per PR, head sha and reason (AISDLC-924) ([#1664](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1664)) ([cd65a33](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cd65a3389736790c9ff7aa84551e528d9557b66d))
* **test:** cli-usage ingest tests no longer walk real codex sessions (AISDLC-887) ([#1585](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1585)) ([36d3ab6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/36d3ab626516bc6661ec0b60f12b4de4f42a04b7))
* warn on pre-existing duplicate pairs on main in cli-file (AISDLC-922) ([#1661](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1661)) ([2a57859](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2a578596a5d14606723a72f5095a9721045e977c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.35.0

## [0.34.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.33.0...pipeline-cli-v0.34.0) (2026-10-15)


### Features

* dispatch tick PR and board state machine (AISDLC-823) ([#1520](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1520)) ([bfa4b3f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bfa4b3f9bfd25e512e687354b8f8aa6b500b2c64))
* **orchestrator:** accept DEC-0202 test waiver in developer return (AISDLC-864) ([#1582](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1582)) ([5357ab3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5357ab3f85d2b972c62df76b8f18a87b3c098c1f))
* **orchestrator:** coded PR reconciler, scheduler and landing records (AISDLC-829) ([#1546](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1546)) ([47f899e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/47f899ee322394fe862e08f686850db3057e530e))


### Bug Fixes

* **ci:** keep approval across a rebase-only force-push (AISDLC-872) ([#1545](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1545)) ([2f98e94](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2f98e94c6b3ad203c8842ac45a9a62ee61740833))
* planner auto-clear waits for an idle pane and logs failures (AISDLC-886) ([#1572](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1572)) ([cc5096b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc5096b483180e5259c963b0f60ce9732881e614))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.34.0

## [0.33.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.32.0...pipeline-cli-v0.33.0) (2026-10-14)


### Features

* GitHub Actions load discipline, cli-ci sweep and queue (AISDLC-799) ([#1389](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1389)) ([b6e2241](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b6e224165ce025e5558a9b248431d06598a89798))
* governance rules enforced in prose move to hooks and CI checks (AISDLC-764) ([#1368](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1368)) ([217cdb2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/217cdb25d1ca475d6135646ff2f878041e5944b9))
* reviewerSet staged, staged Step 7 pipeline, stage leaves, staged ledger role [needs-human-attention] (AISDLC-676) ([#1360](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1360)) ([c42ea82](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c42ea82748dc006ddd1a4ca2106bfe8fd12553d5))


### Bug Fixes

* **ci:** step 0.5 files tasks via cli-file and refuses duplicate ids (AISDLC-860) ([#1505](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1505)) ([165c5a0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/165c5a0092b8a3f24ac0e8b50faf1c592013687f))
* reuse existing sync branch and PR in step 0.5 on resume (AISDLC-858) ([#1499](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1499)) ([8eb024e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8eb024e405752a2abb197383c0c1078305ff03f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.33.0

## [0.32.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.31.0...pipeline-cli-v0.32.0) (2026-10-13)


### Features

* anchor artifacts dir at the project root for routing (AISDLC-654.2) ([#1375](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1375)) ([456b0ae](https://github.com/ai-sdlc-framework/ai-sdlc/commit/456b0aef828359af61b85484baf200877a8d3fb4))
* audit, not refuse, governance paths for trusted merge-if-eligible PRs (AISDLC-789) ([#1336](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1336)) ([62bc063](https://github.com/ai-sdlc-framework/ai-sdlc/commit/62bc0633bb3d4cca76b0bb229fd07d7ea09e5d89))
* automatic revert and strength-only overrides for model routing (AISDLC-656.3) ([#1351](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1351)) ([77940db](https://github.com/ai-sdlc-framework/ai-sdlc/commit/77940db935ed3395c76f8239dded82e2cfd380fd))
* **ci:** correctness-only review for test-only and docs-adjacent diffs (AISDLC-723) ([#1344](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1344)) ([4371be5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4371be554924552890c1269846e64cd4fda9be73))
* **ci:** knowledge store schema, ontology and protected-scope checks (AISDLC-773) ([#1306](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1306)) ([ab41ed5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ab41ed561e3373ca9f674141bdea2a1bb0df1e11))
* cli-file validates and files planner records (AISDLC-801) ([#1435](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1435)) ([9c3f280](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9c3f280994a2dce696dddfdd65fab8dc18688aba))
* continuous handoff files and automatic context clearing (AISDLC-766) ([#1292](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1292)) ([2843e58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/2843e585858c9cb021fdec57cbec6e24efa0be55))
* decisions filed from a task worktree land in the parent catalog (AISDLC-825) ([#1454](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1454)) ([bb7031f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bb7031f950b8041f7e92f272b65f8b3117287533))
* developer run turn budget with warning, stop notice and parked return (AISDLC-651.3) ([#1365](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1365)) ([853ed1a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/853ed1aa4f2967a9ec34d155abc519983176bdc0))
* dispatch tick reaps stalled executors and relaunches them (AISDLC-826) ([#1450](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1450)) ([9ec8d8a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9ec8d8ad5dde4354575ee553bfcc92adbcc341e9))
* enforce dispatch board invariants in code (AISDLC-800) ([#1391](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1391)) ([fd6e13f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fd6e13fbbab93670f6b861150db6bbf5e329f63d))
* execute command body becomes a next-step state machine (AISDLC-762) ([#1303](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1303)) ([0f75632](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0f7563231acaff05c6c5e0016f2ff4b277eb03f4))
* fold Codex ingester into cli-usage ingest and harden it (AISDLC-650.1) ([#1378](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1378)) ([8f6760b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8f6760b0ddbef93606829796b4e9c7799cc78d45))
* guarantee and verify the hierarchy launch env for executors (AISDLC-791) ([#1330](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1330)) ([4e6e7c6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4e6e7c663b364b329e3ee4de41c73e8628e33fdb))
* hierarchy sessions default to bypassPermissions, planner included (AISDLC-752) ([#1259](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1259)) ([31117a4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/31117a4f189c43e6557b1dcb6eeab6a8c7255181))
* large tool output notice, explore-first rule, tool names in ledger (AISDLC-651.5) ([#1366](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1366)) ([935d0b0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/935d0b0f4fdcf08deca301406e03ff78cff4ace8))
* launch hierarchy sessions under the pinned Node and flag mismatches in status (AISDLC-812) ([#1413](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1413)) ([7fc3084](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7fc3084067147b82264df371f706372042581b2f))
* lease-push preflight names the failing hook condition before Step 10.5 (AISDLC-798) ([#1436](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1436)) ([4e0aa4f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4e0aa4fd0dc9e51dcaa6707b248077ff3a39bc21))
* **orchestrator:** escalation chain routing, parking, tier-scoped answers, timeboxes (AISDLC-669) ([#1317](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1317)) ([e02db2f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e02db2f930a6f9cd9588ae60962b16d13a905f71))
* per-role context budgets, Stop-hook notice, turns since clear (AISDLC-651.4) ([#1348](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1348)) ([99f8495](https://github.com/ai-sdlc-framework/ai-sdlc/commit/99f8495d8f84a44c9726c51c47ec1c1eb2e04a44))
* persist the dispatch agent recovery key in the session record (AISDLC-564) ([#1372](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1372)) ([63adf95](https://github.com/ai-sdlc-framework/ai-sdlc/commit/63adf95c7a8d09bcec6e6d1244169766f5c5ea6e))
* push-only resume mode for tasks with an approved verdict (AISDLC-821) ([#1429](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1429)) ([da05b62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/da05b6294359272d633c8452c8039ca09decbfcb))
* replay-run usage records carry repoId (AISDLC-653.2) ([#1349](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1349)) ([7a24d68](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7a24d683b94c6df81f85ca19dd68a0217da00976))
* report capability outcomes from every registered seam and the judgment runtime (AISDLC-643) ([#1315](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1315)) ([843883b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/843883b16ca972e83d42b625b329338a721255d6))
* requeue past the retry cap when the failed task has an open PR (AISDLC-847) ([#1478](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1478)) ([c596d6a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c596d6a1587f32a4f4da3fe0c3bd97b6161d5929))
* require a five-step review paragraph on fix and rule tasks in DoR (AISDLC-804) ([#1394](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1394)) ([090ade3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/090ade364ef506daf1fe8cbd52c20f019e16f43d))
* restart or re-register a single hierarchy session (AISDLC-713) ([#1379](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1379)) ([b47581d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b47581dce808551b816e267b57544b0ada0e5c70))
* **spec:** review planner and synthesizer agents with grounded findings (AISDLC-674) ([#1181](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1181)) ([34e6d40](https://github.com/ai-sdlc-framework/ai-sdlc/commit/34e6d40f3c424e831da314250705a7268bb9bbf9))
* tree-sitter StructuralProvider for stage 1 and trace probe (AISDLC-692) ([#1355](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1355)) ([dbdb62c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/dbdb62c2c7fcabe082f1db1258b69017a66d0d79))
* two reviewers by default for PRs touching no trust-chain path (AISDLC-722) ([#1347](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1347)) ([8a09acd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8a09acd63a9d22f22dbb927ecd8a6850023e34d2))
* usage audit CLI and idle-sessions doctor check (AISDLC-765) ([#1363](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1363)) ([270ce03](https://github.com/ai-sdlc-framework/ai-sdlc/commit/270ce03829e2c304b5f234a0f0abbf29d292569b))
* vscode extension opens one terminal per hierarchy agent (AISDLC-755) ([#1398](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1398)) ([72fd350](https://github.com/ai-sdlc-framework/ai-sdlc/commit/72fd35028ea16810e6fae7bae5ec6e68e00370a7))
* warn when verdicts are written but no attestation signer is reachable (AISDLC-556) ([#1371](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1371)) ([a5a548c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a5a548c5c296a6c41ead9999e88e1be43929f7fd))


### Bug Fixes

* accept a task file in backlog/completed on resume at validation (AISDLC-822) ([#1432](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1432)) ([d6272b4](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d6272b4f7f9ac63e6ce4d5e9e54e4e9de1116bfb))
* check-sender derives the pid from the harness uds socket ref (AISDLC-827) ([#1449](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1449)) ([6038f6c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6038f6c2c09365f74bec8891e06fa7e1db1c73da))
* cli-dispatch resume accepts iterate-needed and failed verdicts, requeue takes a note (AISDLC-807) ([#1386](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1386)) ([3aeaf24](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3aeaf243d8847e176020e4a756ee4f778f40d992))
* correct seed prices, price cache-write tokens, release-date effectiveFrom (AISDLC-648.1) ([#1374](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1374)) ([b57ee54](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b57ee54a4a8c4fbc868285901afe84ec3e06a9fb))
* embed review nonce in prompts and keep committed envelopes in sign hook (AISDLC-739) ([#1316](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1316)) ([8aa6db3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8aa6db30055badbdd4a9962f2751d6666eed918d))
* eval reads no cache by default; cache hits make a promotion not met (AISDLC-631.6) ([#1403](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1403)) ([c25b303](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c25b303a843947b19e739167572fc0ae23f7e3f1))
* gitignore parent runtime state so Step 0.5 stops refusing fresh executes (AISDLC-811) ([#1439](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1439)) ([37c5fbd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/37c5fbd353810883f10567ba76bbd68eb9ee7bfd))
* harden kind lookups and add routing-table follow-up tests (AISDLC-699) ([#1387](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1387)) ([4e3a0ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4e3a0caceec8f01a6e0033ee60763248fc48af56))
* inference proxy error responses return code-based detail (AISDLC-744) ([#1272](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1272)) ([679a690](https://github.com/ai-sdlc-framework/ai-sdlc/commit/679a69039b9de0a97df9a33d04ec322a3b016d96))
* keep the verifier-required reviewer set on trust-chain diffs (AISDLC-850) ([#1482](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1482)) ([154b851](https://github.com/ai-sdlc-framework/ai-sdlc/commit/154b851a425ed56dca9a6101160cb1ebd82ec321))
* next-step init resumes an existing worktree or branch (AISDLC-762.1) ([#1412](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1412)) ([382832c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/382832c17eadda852a2b27c7d0f5439e8e422462))
* next-step resume reads the branch from manifest, PR or worktree (AISDLC-762.2) ([#1430](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1430)) ([4bad2d5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4bad2d58d15919231de0e919aecd33ffdf3bf20a))
* **orchestrator:** one file per decision event so concurrent PRs merge cleanly (AISDLC-719) ([#1243](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1243)) ([7042011](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7042011e63f2ed69c6092a571fe372b5e85393d5))
* re-sign orphaned envelope subject in pre-push hook (AISDLC-810) ([#1396](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1396)) ([264aa79](https://github.com/ai-sdlc-framework/ai-sdlc/commit/264aa796898e8783103901bba8ed54d08e604c2c))
* resolve review diff base from trusted workDir with qualified refs (AISDLC-638.1) ([#1361](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1361)) ([f6ecdd1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f6ecdd11cff92e9d1f729a50a9fab6cc42f89b25))
* resume finds a task file already in backlog/completed (AISDLC-849) ([#1481](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1481)) ([32fe9a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/32fe9a7a97be55c887055cc09aec099ad56fad59))
* review plan validator counts baseline run probes in the cap (AISDLC-695) ([#1380](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1380)) ([8e13ebd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8e13ebdbf47059d26f973969688583b502b38569))
* route review ledger writes to the task worktree (AISDLC-793) ([#1331](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1331)) ([cc22e6b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc22e6b8028cc771303feb9b354c393fe50934ca))
* **spec:** commit leaves before pre-sign rebase (AISDLC-848) ([#1479](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1479)) ([d17a759](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d17a759fb84a9c3c3cc9fbd9c0b123fe78fc5153))
* step 10.5 rebases once and names conflicting files (AISDLC-818) ([#1428](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1428)) ([896a305](https://github.com/ai-sdlc-framework/ai-sdlc/commit/896a305f51c5a38a6770156d766ea68d67a734a3))
* stop TUI App tests shelling out to real gh pr list (AISDLC-819) ([#1423](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1423)) ([5ee9d58](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5ee9d58a252f7173428c1fbcb0177afb8c89e180))
* unwrap quoted pane_start_command in hasLaunchEnv (AISDLC-791.1) ([#1385](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1385)) ([8720818](https://github.com/ai-sdlc-framework/ai-sdlc/commit/87208183c7f98e647cd909512690bf8b723b5af8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.32.0

## [0.31.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.30.0...pipeline-cli-v0.31.0) (2026-10-10)


### Features

* **orchestrator:** up regenerates VS Code tasks with a CLI path (AISDLC-754) ([#1309](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1309)) ([51d6978](https://github.com/ai-sdlc-framework/ai-sdlc/commit/51d697809515c5b96f192faf297c7806753c590f))


### Bug Fixes

* **orchestrator:** bind main-rooted hierarchy executor lease push to its claimed task (AISDLC-756) ([#1305](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1305)) ([912e41a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/912e41a519415641727c061eaec684359e292445))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.31.0

## [0.30.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.29.0...pipeline-cli-v0.30.0) (2026-10-09)


### Features

* add mark-ready-after-codeql to dispatch operational authority (AISDLC-736) ([#1264](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1264)) ([afed0d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afed0d87c6556e16d18e0b83bfcaa5a650c63113))
* clock discipline lint rule, test convention and reviewer check (AISDLC-769) ([#1288](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1288)) ([6c9ccd8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/6c9ccd832bee37c179f6e638e3b29b53a9da0034))
* context discipline in the hierarchy command bodies: dispatch self-clears after every tick, planner clears at 150k (AISDLC-741) ([#1246](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1246)) ([347d48a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/347d48a50d988d8575099e7d94a1416312e02a13))
* executor idle path blocks on claim and self-clears (AISDLC-759) ([#1287](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1287)) ([92e1d1b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/92e1d1bf2c1bf449f7d90dd100ec3434883e349b))
* merge policy follows governance.allowMerge everywhere (AISDLC-753) ([#1258](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1258)) ([39e37d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39e37d762986f8b1a15ad0526dbce09cc9f3876e))
* **orchestrator:** dispatch idle hibernation and self-clear on every wake path (AISDLC-760) ([#1290](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1290)) ([3cafb1d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3cafb1db115593d131a18a84e486e8a9f6c66848))
* **orchestrator:** resume a done task with feedback, wake idle executors (AISDLC-738) ([#1295](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1295)) ([23643ec](https://github.com/ai-sdlc-framework/ai-sdlc/commit/23643ec973e35d4d36bd666994229b9ba097018b))


### Bug Fixes

* clear known dependency vulnerabilities reported by Scorecard (AISDLC-745) ([#1273](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1273)) ([5b7a40e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5b7a40e501c802a400b47b508ce65b204f6454c1))
* harden git fetch against option injection in three sites (AISDLC-704.3) ([#1263](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1263)) ([4400224](https://github.com/ai-sdlc-framework/ai-sdlc/commit/44002247ffebd833a389b58121d6672d1c7b3d1f))
* hash-pin PyPI build deps and drop identity replace (AISDLC-704.4) ([#1266](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1266)) ([92e6e25](https://github.com/ai-sdlc-framework/ai-sdlc/commit/92e6e25b4633d622b1339d960453c7a48163c58e))
* linear-time spec-kit parser matching, no polynomial ReDoS (AISDLC-704.1) ([#1262](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1262)) ([04c7ccc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/04c7ccca96e202c9ab1af05e8692d9d04be4afda))
* **orchestrator:** dor-evaluate feeds frontmatter dependencies to Gate 7 (AISDLC-758) ([#1300](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1300)) ([481581b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/481581be80aa899d68c8db3031c7456df3a52904))
* **orchestrator:** persist Decision Catalog to the remote on add/answer/escalate (AISDLC-546) ([#1236](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1236)) ([11c9de3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/11c9de3d2d52d1bab7256771b7930b0372ea45f2))
* **orchestrator:** untrusted-run marker survives child agents, all outside paths (AISDLC-730) ([#1235](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1235)) ([cc00c7e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cc00c7ea5a314428b15bed6916c20b7d8e4fe0f0))
* **pipeline-cli:** usage pane bad-ledger-line test pins the clock (AISDLC-767) ([#1282](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1282)) ([22aa377](https://github.com/ai-sdlc-framework/ai-sdlc/commit/22aa377e17b1b7a62deb712e34e04ba3a87b36ba))
* task-from-file tick works for a task file not on main (AISDLC-770) ([#1289](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1289)) ([4628da1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4628da13d36820da97fff92d57f4d3af141362af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.30.0

## [0.29.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.28.0...pipeline-cli-v0.29.0) (2026-10-06)


### Features

* **ci:** mark untrusted workflow jobs and lint INTERNAL_RUN placement (AISDLC-720.1) ([#1229](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1229)) ([fe6c699](https://github.com/ai-sdlc-framework/ai-sdlc/commit/fe6c699dbd65860b7d00d2c4bcba445dfce68e01))


### Bug Fixes

* **orchestrator:** eliminate attestation re-sign races (AISDLC-543) ([#1234](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1234)) ([04416a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/04416a70cb83a81ab53b0c60afc60799a6500f41))
* **orchestrator:** idempotent leaf re-emit, signer task env fallback, bounded verify (AISDLC-734) ([#1226](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1226)) ([7839425](https://github.com/ai-sdlc-framework/ai-sdlc/commit/783942530119bb73f02f9dcf6c25f814877af849))
* **orchestrator:** write prettier-formatted envelope JSON (AISDLC-732) ([#1219](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1219)) ([912a91c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/912a91c2165860913d6b5037365bce325531482e))
* **security:** fix critical DangerousWorkflow alerts and triage code-scanning backlog (AISDLC-704) [supersedes [#1223](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1223)] ([#1232](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1232)) ([1ea76c1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1ea76c17e77f692b0320dd5f989c5c8958913a20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.29.0

## [0.28.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.27.0...pipeline-cli-v0.28.0) (2026-10-05)


### Features

* **docs:** operator delegation policy, derived governance tag, 10-hour timebox (AISDLC-703) ([#1215](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1215)) ([4bcce07](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4bcce079e464355bdac1e545e5a059169b35abaa))
* fail worktree setup closed without git hooks, pin Node, add doctor check (AISDLC-693) ([#1185](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1185)) ([f2816f2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f2816f2235081eb63090074e7650276066359631))
* **governance:** internal agents may edit .ai-sdlc config; untrusted runs stay blocked (AISDLC-720) ([#1211](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1211)) ([e07e1c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/e07e1c0e205a33aceec727af1bd82a841aa05040))
* **orchestrator:** enforce the executor authority matrix with a PreToolUse rule (AISDLC-684) ([#1203](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1203)) ([c80be62](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c80be62b961ea911d2d8fd5f0e39dcb4064bcebb))
* **orchestrator:** lease push on the agent's own branch is allowed by default (AISDLC-710) ([#1213](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1213)) ([7715d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7715d5b5a72285e486df1e0da8f7f8f130bee1c4))
* **orchestrator:** operator-dispatch loop, executor context clear, requeue (AISDLC-667) ([#1191](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1191)) ([12348c8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/12348c89ce625b43e1ff678f41bdf1b5e078d744))
* **orchestrator:** project-scoped session names and peer-binding guards (AISDLC-709) ([#1217](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1217)) ([64680f7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/64680f7482b79c7dffc7becab8f347a8ba2a81a9))
* **orchestrator:** release source kind for cli-merge-if-eligible (AISDLC-702) ([#1196](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1196)) ([79afae6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/79afae6b40bf4d2a930f56e3be3b8bae674e0bc9))


### Bug Fixes

* **orchestrator:** use family aliases for model defaults, one central id module (AISDLC-690) ([#1212](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1212)) ([f01fd32](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f01fd3247dcd837642227eb614816a900dd0fd19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.28.0

## [0.27.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.26.1...pipeline-cli-v0.27.0) (2026-10-04)


### Features

* **orchestrator:** advisory ac-coverage and finding-grounding judgments (AISDLC-637) ([#1131](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1131)) ([aeb2266](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aeb226619e7b6d509bc53935e3e9c262c64eae6b))
* **orchestrator:** board ordering, requeue reaper, enqueue (AISDLC-665) ([#1115](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1115)) ([c17c875](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c17c875e0e64773d8265b19d54ef06350a23081d))
* **orchestrator:** claude code transcript ingester and cli-usage ingest (AISDLC-649) ([#1109](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1109)) ([0048523](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0048523839b30b32f2d2527244ea42f8b5f971fc))
* **orchestrator:** complexity factors, failure class and injection screen judgments (AISDLC-639) ([#1136](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1136)) ([501aa7b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/501aa7b646f9463a441f8657f14856a4282e1960))
* **orchestrator:** judgment-first DoR Stage B with tighten and relax definitions (AISDLC-636) ([#1144](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1144)) ([d272b47](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d272b474ee004c6112520824ce0cc7d669f66386))
* **orchestrator:** model routing table, resolveModel and deterministic exploration (AISDLC-654) ([#1114](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1114)) ([b0f50e0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b0f50e0767b7edfdd586f65cb01ef838b395b2fd))
* **orchestrator:** one tmux session per hierarchy agent, plus attach and terminals (AISDLC-688) ([#1179](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1179)) ([3e67cfb](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3e67cfbd3df511c9c99fb11d11a17221dcb92771))
* **orchestrator:** operator tui usage pane with window view and top consumers (AISDLC-652) ([#1123](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1123)) ([4e9808a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/4e9808a5d08a4cbbbcb846104333af7651df2899))
* **orchestrator:** review executor probes with contained, redacted evidence (AISDLC-675) ([#1178](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1178)) ([699f3fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/699f3fef42c42a5e80dd054a6a2f12b134019f22))
* **orchestrator:** review plan schema, baseline checklist and allowlist (AISDLC-673) ([#1164](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1164)) ([618cd8f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/618cd8fc64399ba7d9c7a15f0ebaf2740dd62eb3))
* **orchestrator:** review routing and per-PR reviewer-set judgments (AISDLC-638) ([#1140](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1140)) ([7109589](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7109589f358168e2c28a2fca1ee157456a050fe5))
* **orchestrator:** RFC-0051 executor loop skill, claim-bound complete, next-subid (AISDLC-666) ([#1170](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1170)) ([8a4fbce](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8a4fbce3b16c41ac3c52a00fd718c9b7edda3fe1))
* **orchestrator:** routing bar evaluation and weekly proposal (AISDLC-656.1) ([#1161](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1161)) ([0da3e64](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0da3e645942b5b46ec1de0969102fccc3a93652e))
* **orchestrator:** stable repoId in the usage ledger (AISDLC-653.1) ([#1150](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1150)) ([bbc2b6b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bbc2b6b521c278f44a2a8904e3be6a8353191d9b))
* **orchestrator:** usage reports, allotment tracking and usage config (AISDLC-651) ([#1119](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1119)) ([85c1294](https://github.com/ai-sdlc-framework/ai-sdlc/commit/85c1294493952c4de8d531e09ff0183ebef9efca))
* **reference:** bridge the classifier substrate to the judgment layer (AISDLC-634) ([#1139](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1139)) ([873a8a6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/873a8a66407e717a43c6e435d133edf2dbbfebec))
* **reference:** cli-judgment doctor/list/ask/eval/replay and live contract test (AISDLC-632) ([#1133](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1133)) ([8c2c6c6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8c2c6c67bff04f4dfebbe8a425b0ddbbd00a1aad))
* **reference:** evaluateJudgment runtime, catalog, JudgmentConfig and loader (AISDLC-630) ([#1118](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1118)) ([530c712](https://github.com/ai-sdlc-framework/ai-sdlc/commit/530c712f7c9be11afb4ec50f6a5f4cf4f3ac678e))
* **reference:** judgment log, cache, cost, events and doctor check (AISDLC-631) ([#1129](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1129)) ([468b54d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/468b54d7d73bb81c352d34aed8becaf30e601a27))
* **reference:** model price feed with dated history and held rows (AISDLC-659) ([#1108](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1108)) ([f70ba22](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f70ba2252252895f8a55c6e7f46659ce1d2ff9d8))
* **reference:** registration-time safety rules for judgment definitions (AISDLC-630.1) ([#1130](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1130)) ([10725b0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/10725b09ccf0513a1d580a625cc2d474983bb7fc))
* **reference:** RFC-0049 Group A decision and estimation judgments, conservative form (AISDLC-635) ([#1141](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1141)) ([9c19374](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9c19374edf4b5ba658a16d03363d544abce09684))
* RFC-0049 section 9.5: follow-ups in a completed task must cite a filed task, say none, or be explicitly declined (AISDLC-645) ([#1103](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1103)) ([1b02908](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1b029089a3ca1827486a236461fff4a6142005d9))
* RFC-0050 Part A: Codex session ingester and direct usage reporters for API runners and embeddings (AISDLC-650) ([#1107](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1107)) ([26a9c28](https://github.com/ai-sdlc-framework/ai-sdlc/commit/26a9c285b9eebb110883dc49500f0866de9598ca))
* RFC-0050 Part B: offline reviewer replay (corpus builder, cli-usage replay, budget and off-peak scheduling) (AISDLC-655) ([#1126](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1126)) ([afc8857](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afc88576f02c72762befceea79cff2f32584b80a))
* RFC-0051: cli-hierarchy brief generates a dispatch brief with waves and sequence groups from task metadata (AISDLC-668) ([#1120](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1120)) ([a3e2748](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a3e27485789b57c038aaf7abc42042aa8522556b))
* RFC-0051: hierarchy roster schema and cli-hierarchy up/status/down bootstrapping named tmux sessions per role (AISDLC-664) ([#1116](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1116)) ([5963b0b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5963b0b96f1a8b236add11be4cac36903fb9e64d))
* **spec:** add cli-usage scorecard joining usage to review outcomes (AISDLC-653) ([#1122](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1122)) ([95dc642](https://github.com/ai-sdlc-framework/ai-sdlc/commit/95dc6429b9d48c239a84538490b8a6edfed49c16))
* **spec:** review risk map stages 0 to 2 behind an injected structural provider (AISDLC-672) ([#1175](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1175)) ([a2e70ff](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a2e70ff56374ffb45a1dac0d29a3aa225450c54a))


### Bug Fixes

* bind attestation leaves to their own reviewer run (AISDLC-697) ([#1182](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1182)) ([86745fe](https://github.com/ai-sdlc-framework/ai-sdlc/commit/86745fe7ed9fc052b66552e28cd6c85aed7947df))
* **hooks:** coverage gate reaps workers and caps memory; vitest workers die with parent (AISDLC-681) ([#1158](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1158)) ([ce802d2](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ce802d25ffe657ecbc33c75f8e497f28aa3f1280))
* **orchestrator:** add scorecardMinTasks to the usage pane test fixture (AISDLC-652.1) ([#1125](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1125)) ([f1bf3c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f1bf3c00e8a0754ded3ce55d913edd77acc2d64f))
* **orchestrator:** align default artifacts dir of resolver, scorecard and replay (AISDLC-657.2) ([#1153](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1153)) ([593e857](https://github.com/ai-sdlc-framework/ai-sdlc/commit/593e857eb38ae6a6b010458635eb10fab7f8a470))
* **pipeline-cli:** bound and linearise failure classifier heuristics (AISDLC-682) ([#1165](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1165)) ([f619a82](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f619a8274e69344020caab0bd41033cfb0171ae2))
* **reference:** skip judgment cache reads in enforce mode (AISDLC-631.3) ([#1147](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1147)) ([232230f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/232230f4f276a45fc92bc33e283f34922faf7060))
* **spec:** harden cli-merge-if-eligible before the allowMerge grant (AISDLC-663.5) ([#1134](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1134)) ([ea6b7da](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea6b7da08bf7c58acb459a43c076be048a20b288))
* **spec:** parse diff headers without backtracking regex (AISDLC-672) ([#1184](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1184)) ([3de7c5f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3de7c5f76f9eca16bef06b5aa0522282c007ab9a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.27.0

## [0.26.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.26.0...pipeline-cli-v0.26.1) (2026-09-18)


### Miscellaneous

* **pipeline-cli:** Synchronize node-packages versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.26.1

## [0.26.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.25.0...pipeline-cli-v0.26.0) (2026-09-17)


### Bug Fixes

* hermetic DoR gate 3 skips url/github refs instead of failing them (AISDLC-621) ([#1075](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1075)) ([8b80e51](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8b80e517a6a16d053184e527c1953c4fcc522f26))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.26.0

## [0.25.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.24.2...pipeline-cli-v0.25.0) (2026-09-15)


### Features

* add opt-in merged correctness reviewer, keep security separate (AISDLC-617) ([#1069](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1069)) ([7d3522a](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7d3522adb203baf0b4fff8d68d75d7b2f68470ce))
* persist reviewer findings to an append-only ledger (AISDLC-616) ([#1066](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1066)) ([ad809b7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ad809b7042bcb3072d6960f1d341ed1fee7513e9))


### Bug Fixes

* bring check-attestation-sign.sh patch-id exclusions into lockstep (AISDLC-618) ([#1073](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1073)) ([0735fbd](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0735fbd9f70e7a28554fb62bbf85f445faafdd19))
* harden reviews-ledger append IO + prototype pollution, add test coverage (AISDLC-619) ([#1072](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1072)) ([80c5e7c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/80c5e7c5995d51073c55cc41163fd5115f3d562f))
* route no-required-checks exit-1 to check-run fallback (AISDLC-620) ([#1071](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1071)) ([d51eec1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d51eec1bbb2218eefcfa9ccc7af7236957e8747f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.25.0

## [0.24.2](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.24.1...pipeline-cli-v0.24.2) (2026-09-14)


### Bug Fixes

* lockstep attestation patch-id exclusions across emit-leaf/sign-v6/verifier (AISDLC-610) ([#1063](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1063)) ([5bd2a60](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5bd2a60ca02c562a01cde7b2b9978390817e769a))
* make Step 0.5 parent-sync/prune task-id-prefix-agnostic (AISDLC-609) ([#1061](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1061)) ([7bef389](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7bef389c7dd54d3f2555d03465c4a533f002553d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.24.2

## [0.24.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.24.0...pipeline-cli-v0.24.1) (2026-09-08)


### Bug Fixes

* cli-merge-if-eligible unusable in consumer / no-branch-protection repos (AISDLC-607) ([#1054](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1054)) ([528f9f9](https://github.com/ai-sdlc-framework/ai-sdlc/commit/528f9f9893aa32594b7bb47cd079c374b122b111))
* honor spec.branching.targetBranch, not hardcoded main (AISDLC-606) ([#1053](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1053)) ([50547c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/50547c08ea9aa2e88ccc1c671f5b7695a106edd7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.24.1

## [0.24.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.23.0...pipeline-cli-v0.24.0) (2026-09-07)


### Features

* deterministic merge-if-eligible CLI helper (AISDLC-603) ([#1046](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1046)) ([1edf1ec](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1edf1ecf07993db5aaf4c98d0d21cf07f4f1cb6b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.24.0

## [0.23.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.22.0...pipeline-cli-v0.23.0) (2026-09-07)


### Features

* add anchorEvidence audit-only leaf field (AISDLC-594) ([#1025](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1025)) ([d722f0e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/d722f0e15f734d55498837b0359906ca839d43d7))
* rfc-0046 phase 4 — requiredTier policy + gate-agnostic enforcement (AISDLC-591) ([#1030](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1030)) ([5517164](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5517164bdacc406d0758801702a79b9e41a21e29))
* rfc-0047 phase 1 — ci-only trust marker + verifier key partitioning (AISDLC-593) ([#1026](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1026)) ([cac3387](https://github.com/ai-sdlc-framework/ai-sdlc/commit/cac33878f6fede0d55d20a2547ba7f61b5a64d51))
* rfc-0047 phase 3 — verifier isolated re-derivation (AISDLC-595) ([#1028](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1028)) ([1c9ef0c](https://github.com/ai-sdlc-framework/ai-sdlc/commit/1c9ef0c78ee3c623032625ffe95221821fec757f))
* rfc-0047 phase 4 — isolated producer + ci-only clean-room signer (AISDLC-596) ([#1029](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1029)) ([677a2cc](https://github.com/ai-sdlc-framework/ai-sdlc/commit/677a2cca9fd8f0ee59fba26b337710d3d865a8a7))
* rfc-0047 phase 5 — flip isolated capability gate into requiredTier policy (AISDLC-597) ([#1031](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1031)) ([3a409a7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3a409a7205b7e8d1be7ae788d7746e797a5b07f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.23.0

## [0.22.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.21.0...pipeline-cli-v0.22.0) (2026-09-06)


### Features

* rfc-0046 phase 1 — independenceTier leaf schema + verifier dual-read (AISDLC-588) ([#1018](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1018)) ([aa8409f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/aa8409f60e9e2ce1ad33f1b90f0a43ab41e43e4c))
* rfc-0046 phase 2 — attested tier fixes worktree project-dir + agentType namespace (AISDLC-589) ([#1020](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1020)) ([68f3d14](https://github.com/ai-sdlc-framework/ai-sdlc/commit/68f3d143b5466d56689aece5b124de0488f203a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.22.0

## [0.21.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.20.1...pipeline-cli-v0.21.0) (2026-09-06)


### Bug Fixes

* resolve reviewer agent-defs from installed plugin, not repo-only path (AISDLC-583) ([#1013](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1013)) ([715e956](https://github.com/ai-sdlc-framework/ai-sdlc/commit/715e9562a658bdcf685a27541bbebd488f560271))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.21.0

## [0.20.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.20.0...pipeline-cli-v0.20.1) (2026-09-05)


### Bug Fixes

* single-source v6 Merkle primitives to fix multi-leaf verify (AISDLC-579) ([#1005](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1005)) ([9042b6e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9042b6efb5ff0402809f067b5015562410d18c3c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.20.1

## [0.20.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.19.0...pipeline-cli-v0.20.0) (2026-09-05)


### Features

* plugin-less `cli-attestation verify` subcommand (AISDLC-575) ([#1001](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1001)) ([a5fe3ee](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a5fe3ee110e307e8c73c83f9488097a4229db659))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.20.0

## [0.19.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.18.0...pipeline-cli-v0.19.0) (2026-09-05)


### Features

* wire nonce injection into reviewer dispatch (AISDLC-573) ([#996](https://github.com/ai-sdlc-framework/ai-sdlc/issues/996)) ([575cb69](https://github.com/ai-sdlc-framework/ai-sdlc/commit/575cb69b28435358a63211c43e8b4f8ccce4520e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.19.0

## [0.18.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.17.2...pipeline-cli-v0.18.0) (2026-09-05)


### Features

* bind attestation leaf to reviewer's harness transcript, sign-time-only (AISDLC-570) ([#993](https://github.com/ai-sdlc-framework/ai-sdlc/issues/993)) ([be02c44](https://github.com/ai-sdlc-framework/ai-sdlc/commit/be02c44280605532b95468256d5b84899c86798f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.18.0

## [0.17.2](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.17.1...pipeline-cli-v0.17.2) (2026-09-05)


### Bug Fixes

* bind verdictClass independent to reviewer role, not just timing (AISDLC-572) ([#990](https://github.com/ai-sdlc-framework/ai-sdlc/issues/990)) ([708abc6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/708abc6cdc8ac6c18e9906a5232990805cef1cb8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.17.2

## [0.17.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.17.0...pipeline-cli-v0.17.1) (2026-09-04)


### Bug Fixes

* register SubagentStart hook in canonical marketplace manifest (AISDLC-571) ([#988](https://github.com/ai-sdlc-framework/ai-sdlc/issues/988)) ([bf37c2b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bf37c2b437d789094733e19527ddbcd52f96fc73))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.17.1

## [0.17.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.16.0...pipeline-cli-v0.17.0) (2026-09-04)


### Features

* add verdictClass trust class to v6 attestation leaves (AISDLC-568) ([#986](https://github.com/ai-sdlc-framework/ai-sdlc/issues/986)) ([338df4e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/338df4e362cf61c985d8afb16aff7d6e14fce3ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.17.0

## [0.16.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.15.0...pipeline-cli-v0.16.0) (2026-09-04)


### Features

* configurable .github/workflows blocking + worktree isolation (AISDLC-567) ([#982](https://github.com/ai-sdlc-framework/ai-sdlc/issues/982)) ([880538f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/880538f615e923c5e7ad005a42bf3a6e2bab1e05))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.16.0

## [0.15.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.14.0...pipeline-cli-v0.15.0) (2026-09-04)


### Bug Fixes

* populate DoR Gate 7 declared-dependency refs from frontmatter (AISDLC-563) ([#969](https://github.com/ai-sdlc-framework/ai-sdlc/issues/969)) ([73ed370](https://github.com/ai-sdlc-framework/ai-sdlc/commit/73ed370b4f2fb5615f5a02a96c782409d13107d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ai-sdlc/reference bumped to 0.15.0

## [0.14.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/pipeline-cli-v0.13.0...pipeline-cli-v0.14.0) (2026-07-29)


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
