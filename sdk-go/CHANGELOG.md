# Changelog

## [0.10.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.9.0...sdk-go-v0.10.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* **sdk-go:** all Go-only metric names, categories, span names, metric names and attribute keys (and the Go struct field names) are removed; see the migration section of sdk-go/README.md.
* **sdk-go:** compliance.FrameworkMappings, ComplianceResult and the Features field are removed. CheckCompliance now takes a set of enabled AI-SDLC control ids and the framework, and the report uses CoveredControls, Gaps and CoveragePercent (0 to 100). See the migration section in sdk-go/README.md.

### Features

* **conformance:** classify every reference module as shared or typescript-only (AISDLC-1311) ([#2785](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2785)) ([307a637](https://github.com/ai-sdlc-framework/ai-sdlc/commit/307a6378418d8db16b5ad76e37ad80a4de42a820))
* **conformance:** parity manifest of the reference checked by Python and Go suites (AISDLC-1305) ([#2781](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2781)) ([91d79f5](https://github.com/ai-sdlc-framework/ai-sdlc/commit/91d79f5e26683dcfc4d7785708becf8ecc6f056b))
* **sdk-go:** align metric and telemetry names with the reference (AISDLC-1307) ([#2782](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2782)) ([f4dedb0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f4dedb0322627b1b9551c1ceb5c78d45fd1ebe79))
* **sdk-go:** use the reference control model in compliance (AISDLC-1306) ([#2780](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2780)) ([0a79b42](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0a79b42a047d0a923a4865ec1e66b39f69c1dcf2))


### Bug Fixes

* **sdk-go:** move to Go 1.26 and patched OpenTelemetry 1.47.0 (AISDLC-1274) ([#2663](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2663)) ([42593d6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/42593d68e2037ca23fd968246276271cee14c576))
* **sdk:** sync Python and Go schemas with spec/schemas and gate on drift (AISDLC-1302) ([#2779](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2779)) ([17b682e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/17b682eace6c611774eea56d7af3a7c1f7a8ee04))
* **sdk:** sync Python and Go version constants with releases (AISDLC-1303) ([#2783](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2783)) ([350aef1](https://github.com/ai-sdlc-framework/ai-sdlc/commit/350aef15b247a5d22b7ad287b704a371e9066aa6))
* **spec:** make deprecated Pipeline spec.stages optional (AISDLC-1280) ([#2692](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2692)) ([5bcacd6](https://github.com/ai-sdlc-framework/ai-sdlc/commit/5bcacd62cb70435acc9984158de762bade3c989a))

## [0.9.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.8.0...sdk-go-v0.9.0) (2026-11-08)


### Features

* **conformance:** one audit entry schema with JCS hashing and cross-SDK fixture (AISDLC-1213) ([#2471](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2471)) ([11fd3ca](https://github.com/ai-sdlc-framework/ai-sdlc/commit/11fd3ca4520dbafe850bd6822e7b2a8dcd42e1ad))


### Bug Fixes

* open task PRs ready when CodeQL does not run on pull requests (AISDLC-1149) ([#2273](https://github.com/ai-sdlc-framework/ai-sdlc/issues/2273)) ([9dadf31](https://github.com/ai-sdlc-framework/ai-sdlc/commit/9dadf314286653df5c9e43a10d0d7847906c8353))

## [0.8.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.7.0...sdk-go-v0.8.0) (2026-10-23)


### Features

* allowForcePush mode lease for any non-protected branch (AISDLC-1005) ([#1828](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1828)) ([3820bda](https://github.com/ai-sdlc-framework/ai-sdlc/commit/3820bda7b65c19203fc41fee5e7a68331527e717))


### Bug Fixes

* **deps:** raise Go to 1.25, bump x/net 0.55, CodeQL Go autobuild (AISDLC-1041) ([#1929](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1929)) ([c7d3d69](https://github.com/ai-sdlc-framework/ai-sdlc/commit/c7d3d692f279a009bbd6244aa834dd5eba1a53d5))

## [0.7.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.6.1...sdk-go-v0.7.0) (2026-10-17)


### Features

* **orchestrator:** dispatch tick lands eligible own-author PRs (AISDLC-894) ([#1612](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1612)) ([ec657c0](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ec657c0bd5cf6ef33a6f52333c6b4e146ac7b829))

## [0.6.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.6.0...sdk-go-v0.6.1) (2026-10-13)


### Bug Fixes

* **sdk-go:** sync agent-role schema mirror and add drift gate (AISDLC-604) ([#1402](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1402)) ([a51c402](https://github.com/ai-sdlc-framework/ai-sdlc/commit/a51c402a16e67d675fb7266706247775f1bf19d9))

## [0.6.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.5.0...sdk-go-v0.6.0) (2026-10-09)


### Features

* add mark-ready-after-codeql to dispatch operational authority (AISDLC-736) ([#1264](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1264)) ([afed0d8](https://github.com/ai-sdlc-framework/ai-sdlc/commit/afed0d87c6556e16d18e0b83bfcaa5a650c63113))
* merge policy follows governance.allowMerge everywhere (AISDLC-753) ([#1258](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1258)) ([39e37d7](https://github.com/ai-sdlc-framework/ai-sdlc/commit/39e37d762986f8b1a15ad0526dbce09cc9f3876e))

## [0.5.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.4.0...sdk-go-v0.5.0) (2026-10-05)


### Features

* **orchestrator:** lease push on the agent's own branch is allowed by default (AISDLC-710) ([#1213](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1213)) ([7715d5b](https://github.com/ai-sdlc-framework/ai-sdlc/commit/7715d5b5a72285e486df1e0da8f7f8f130bee1c4))

## [0.4.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.3.0...sdk-go-v0.4.0) (2026-10-04)


### Features

* **spec:** scope force-push to own branch via leaseOnOwnBranch (AISDLC-663) ([#1113](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1113)) ([bf63baf](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bf63baf71a41c1bb8561c3a6f462e921f3080ccc))


### Bug Fixes

* **spec:** harden cli-merge-if-eligible before the allowMerge grant (AISDLC-663.5) ([#1134](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1134)) ([ea6b7da](https://github.com/ai-sdlc-framework/ai-sdlc/commit/ea6b7da08bf7c58acb459a43c076be048a20b288))

## [0.3.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.2.1...sdk-go-v0.3.0) (2026-09-07)


### Features

* per-repo configurable governance — source of truth + hook render (AISDLC-601) ([#1043](https://github.com/ai-sdlc-framework/ai-sdlc/issues/1043)) ([f9e407e](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f9e407eee452837863b52fd5aa05822ea82e0e2d))

## [0.2.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.2.0...sdk-go-v0.2.1) (2026-06-10)


### Bug Fixes

* **security:** pin Docker base images to digests (Scorecard PinnedDependencies) ([#813](https://github.com/ai-sdlc-framework/ai-sdlc/issues/813)) ([f44c426](https://github.com/ai-sdlc-framework/ai-sdlc/commit/f44c42623576ad2404a1b843e96a55b70c8eb546))

## [0.2.0](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.1.1...sdk-go-v0.2.0) (2026-03-24)


### Features

* integrate Product Priority Algorithm (PPA) across all SDKs (AISDLC-7) ([bc4a32d](https://github.com/ai-sdlc-framework/ai-sdlc/commit/bc4a32df4de65eb9c853b33e85aac56690092ecf))

## [0.1.1](https://github.com/ai-sdlc-framework/ai-sdlc/compare/sdk-go-v0.1.0...sdk-go-v0.1.1) (2026-03-08)


### Bug Fixes

* sync Go SDK schemas with canonical spec and add publishConfig to packages ([78283b3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/78283b35b2c6986f30e35f92a5ddf01c8e3b3462))
* update Go SDK version test to match 0.1.1 ([0fe9704](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0fe97047b091688c3c3345a28c2edbf30e45f480))

## 0.1.0 (2026-03-06)


### Bug Fixes

* sync Go SDK schemas with canonical spec and add publishConfig to packages ([78283b3](https://github.com/ai-sdlc-framework/ai-sdlc/commit/78283b35b2c6986f30e35f92a5ddf01c8e3b3462))
* update Go SDK version test to match 0.1.1 ([0fe9704](https://github.com/ai-sdlc-framework/ai-sdlc/commit/0fe97047b091688c3c3345a28c2edbf30e45f480))
