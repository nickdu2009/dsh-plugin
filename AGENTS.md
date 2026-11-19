# AGENTS.md

Working agreements for agents that develop plugins in this repository.

## Project

- This is a collection of DeepSeek Harness (DSH) plugin bundles: **one plugin per directory under `plugins/`**.
- Every new plugin is written in TypeScript. Migrated plugins may stay JavaScript; do not rewrite them only to satisfy the TypeScript rule.
- The repository is public on GitHub. Never commit secrets, DSH profile files, `node_modules/`, or build output (`lib/`).
- The running DSH installation is the authority for APIs and versions. Load the `dsh-doc` skill before designing, building, or debugging a plugin.

## Read before changing a plugin

1. Load `dsh-doc`.
2. Read `references/plugin-development.md` and `references/host-plugin.md`; add `references/practices.md`, `references/ui-plugin.md`, `references/plugin-details.md`, or `references/configuration.md` when the task touches those areas.
3. Check the running version before choosing dependency versions:
   - `$DSH_INSTALL_DIR/package.json` names `@deepseek-ai/dsh` and carries the version.
   - Installed `@deepseek-ai/*` packages sit under `$DSH_INSTALL_DIR/../..`; read them through the Electron runtime when they live inside `app.asar`.
4. Use `cordis_inspect_*` tools when available for live services, events, slots, and config schemas.

## Create a plugin

1. `pnpm run new <name> --title "<Title>" --description "<Sentence-case description.>"`
2. Implement the capability under `plugins/<name>/src/`. Keep the exported shape: `name`, optional `inject`, optional `Config`, `apply(ctx, config)`.
3. Register resources with `ctx.effect` / `ctx.on` and return their disposers. Use `import type` for `@deepseek-ai/cordis`.
4. Keep these in sync: `package.json` (`exports`, `files`, `dsh.bundle.patch`), `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `docs/DETAIL.md`, `icon.svg`, `README.md`.
5. Add unit tests for pure logic under `src/*.test.ts`. Integration behavior is verified in DSH, not mocked.
6. `pnpm check` must pass before committing.

## Install and verify

- Install only when the user asks; installing changes the shared profile. Use the DSH **Plugins** page / `plugin_manager` and select the plugin directory. Do not edit `$DSH_PROFILE_DIR` files by hand.
- Build before installing; DSH links the directory, so a rebuild is required after source changes.
- After installation, verify the requested capability in a **new session** (or the live page for UI). Confirm the plugin row, locale text, detail page, and icon. Report what remains unverified; installation alone is not visual or behavioral verification.
- Restore any user state changed during testing.

## Dependency policy

- Pin `@deepseek-ai/*` packages to the versions matching the running DSH release. The current table is in `README.md`; update it when DSH is upgraded.
- `@deepseek-ai/cordis`: type-only import, `devDependencies`.
- Runtime helpers such as `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`: `dependencies`.
- Do not bundle a second React. Do not require or import `@deepseek-ai/dsh-client-ui-primitives` or other Harness Client packages as modules; `dsh.client.inject` only orders activation.
- Node ESM with `module: NodeNext`; relative imports use `.js` extensions.

## Commits

- Conventional-style subjects scoped by plugin: `feat(hello): ...`, `fix(hello): ...`, `chore: ...`, `docs: ...`.
- Keep one plugin's changes in one commit where practical; dependency/version bumps get their own commit.
- Do not commit generated `lib/` output or the pnpm store.
