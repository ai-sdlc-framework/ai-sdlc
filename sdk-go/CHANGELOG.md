# Changelog

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
