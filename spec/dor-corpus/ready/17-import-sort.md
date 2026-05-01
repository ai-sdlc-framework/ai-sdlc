## Description
Adopt `eslint-plugin-import`'s `order` rule across the workspace via `eslint.config.mjs`.

## Acceptance Criteria
- [ ] #1 `eslint-plugin-import` is added as a workspace devDependency
- [ ] #2 `eslint.config.mjs` enables `import/order` at warn level
- [ ] #3 `pnpm lint` is clean after fix-up
