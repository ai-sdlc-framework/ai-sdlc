# Changelog

## [0.4.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-python-v0.3.0...sdk-python-v0.4.0) (2026-11-19)


### Features

* **conformance:** classify every reference module as shared or typescript-only (AISDLC-1311) ([#2785](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2785)) ([307a637](https://github.com/ai-sdlc-framework/ai-sdlc/commit/307a6378418d8db16b5ad76e37ad80a4de42a820))
* **conformance:** parity manifest of the reference checked by Python and Go suites (AISDLC-1305) ([#2781](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2781)) ([91d79f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/91d79f5e26683dcfc4d7785708becf8ecc6f056b))
* **sdk-python:** add cost and token metrics and telemetry keys (AISDLC-1304) ([#2784](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2784)) ([b56ceca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/b56cecaeef256644c3066fae2106af5c7eaa684a))


### Bug Fixes

* **sdk:** sync Python and Go schemas with spec/schemas and gate on drift (AISDLC-1302) ([#2779](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2779)) ([17b682e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/17b682eace6c611774eea56d7af3a7c1f7a8ee04))
* **sdk:** sync Python and Go version constants with releases (AISDLC-1303) ([#2783](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2783)) ([350aef1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/350aef15b247a5d22b7ad287b704a371e9066aa6))
* **spec:** make deprecated Pipeline spec.stages optional (AISDLC-1280) ([#2692](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2692)) ([5bcacd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5bcacd62cb70435acc9984158de762bade3c989a))

## [0.3.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-python-v0.2.1...sdk-python-v0.3.0) (2026-11-08)


### Features

* **conformance:** one audit entry schema with JCS hashing and cross-SDK fixture (AISDLC-1213) ([#2471](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2471)) ([11fd3ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/11fd3ca4520dbafe850bd6822e7b2a8dcd42e1ad))

## [0.2.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-python-v0.2.0...sdk-python-v0.2.1) (2026-10-09)


### Bug Fixes

* hash-pin PyPI build deps and drop identity replace (AISDLC-704.4) ([#1266](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1266)) ([92e6e25](https://github.com/ai-sdlc-framework/ai-sdlc/commit/92e6e25b4633d622b1339d960453c7a48163c58e))

## [0.2.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-python-v0.1.1...sdk-python-v0.2.0) (2026-03-24)


### Features

* integrate Product Priority Algorithm (PPA) across all SDKs (AISDLC-7) ([bc4a32d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc4a32df4de65eb9c853b33e85aac56690092ecf))


### Bug Fixes

* skip priority-scoring conformance tests in Python SDK ([8a6b0ac](https://github.com/ai-sdlc-framework/ai-sdlc/commit/8a6b0acfa84b7a4547110afd1287582dfe60b2f6))

## [0.1.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-python/v0.1.0...sdk-python-v0.1.1) (2026-03-06)


### Bug Fixes

* **sdk-python:** resolve mypy errors on Python 3.13 ([226664d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/226664d20429671864b9171ffe5c1a20c2d92825))
* **sdk-python:** resolve ruff lint errors ([472176b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/472176bf3933191f6e04cb65bb48d90988e909fe))
* **sdk-python:** restore type: ignore for jsonschema registry arg ([c195d9f](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c195d9ff6d7454f4a52ae69321e20df014dd641c))
* **sdk-python:** use pprint.pformat for generated schemas to emit valid Python ([7dcd504](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7dcd504fce50ea464c0a89ce5ca53a4b25973c96))
