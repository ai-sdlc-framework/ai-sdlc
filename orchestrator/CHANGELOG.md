# @ai-sdlc/orchestrator

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
