# @ai-sdlc/orchestrator

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
