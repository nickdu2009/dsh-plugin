# dsh-plugin

[![CI](https://github.com/nickdu2009/dsh-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/nickdu2009/dsh-plugin/actions/workflows/ci.yml)

[DeepSeek Harness](https://deepseek.com)（DSH）插件集合。**一个目录一个插件**：`plugins/<name>/` 就是一个独立的 DSH bundle，可以单独安装、启用和卸载。

- 新插件一律使用 **TypeScript** 开发。
- 从其它仓库迁移进来的既有插件可以保留 JavaScript，但目录结构、`package.json`、`cordis.patch.yml` 与展示元数据的要求相同。
- 插件以 npm 包 `@nick.du/dsh-plugin-<name>` 分发（scope 由根 `package.json` 的 `dshPluginScope` 决定），仓库是公共 GitHub 仓库。
- 也支持从本地目录安装，供开发和调试使用。

当前已对齐的 DSH 版本：**0.2.2-rc.5**。

## 环境

| 组件             | 版本                                                  |
| ---------------- | ----------------------------------------------------- |
| DeepSeek Harness | 0.2.2-rc.5（Desktop）                                 |
| Node.js          | >= 24.9（推荐 24 LTS；DSH 自带的运行时为 24.21）      |
| pnpm             | 10.26.1（以 `package.json` 的 `packageManager` 为准） |
| TypeScript       | 5.9（严格模式，NodeNext ESM）                         |

> 宿主机 Node 低于 24.9 时 `pnpm install` 只会给出 engine 警告；CI 使用 Node 24。

## 目录结构

```text
.
├── plugins/                  # 一个目录一个插件
│   ├── hello/                # 参考插件：@nick.du/dsh-plugin-hello
│   └── model-instructions/   # 迁移插件：@nick.du/dsh-plugin-model-instructions
│       ├── package.json      # 独立 bundle：name / exports / dsh.bundle.patch
│       ├── tsconfig.json     # 类型检查（noEmit）
│       ├── tsconfig.build.json
│       ├── cordis.patch.yml  # 插入同名插件行
│       ├── src/              # TypeScript 源码
│       │   ├── index.ts
│       │   └── *.test.ts
│       ├── locale/           # en.json / zh.json，提供 meta.title/description
│       ├── docs/DETAIL.md    # 插件详情页
│       ├── icon.svg          # 插件图标
│       └── README.md
├── templates/plugin/         # pnpm run new 使用的模板
├── scripts/create-plugin.mjs # 插件生成器
├── .github/workflows/
│   ├── ci.yml                # pnpm check
│   └── publish.yml           # tag 触发的 npm 发布
├── AGENTS.md                 # 给后续 agent 的工作约定
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

每个插件都是独立的 npm 包（`@nick.du/dsh-plugin-<name>`），源码在 `src/`，构建产物在 `lib/`（不提交）。

## 快速开始

```bash
pnpm install
pnpm run new my-plugin --title "My plugin" --description "Adds one Agent tool."
pnpm check
```

`pnpm run new` 会：

1. 从 `templates/plugin` 复制目录到 `plugins/<name>/`；
2. 把包名生成为 `@nick.du/dsh-plugin-<name>`（可用 `--scope` 覆盖）；
3. 替换插件标题、描述、工具名等占位符；
4. 打印后续需要补全的内容（工具实现、中文文案、图标、详情页）。

生成后按 `plugins/hello` 的样式实现，再运行 `pnpm check`（Prettier + 类型检查 + 单测 + 构建）。

## 插件约定

1. **一个目录一个插件。** 目录名使用 kebab-case；包名 `@nick.du/dsh-plugin-<name>`；`cordis.patch.yml` 中行的 `id` 与目录名一致，`name` 与包名一致（scoped 名称在 YAML 中必须加引号）。
2. **源码只用 TypeScript。** `src/` 下不允许 `.js`；相对导入带 `.js` 扩展名（NodeNext）。迁移插件例外，但要在其 README 中注明语言与来源。
3. **导出形态。** `src/index.ts` 导出 `name`、可选的 `inject`、可选的 `Config`（schemastery schema）、`apply(ctx, config)`；所有资源用 `ctx.effect` / `ctx.on` 注册并返回清理函数。
4. **依赖。** `@deepseek-ai/cordis` 只做类型导入（`import type`），放 `devDependencies`；运行时用到的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 放 `dependencies`。不要打包第二份 React；不要直接导入 `@deepseek-ai/dsh-client-ui-primitives`。
5. **版本对齐。** 所有 `@deepseek-ai/*` 依赖固定为当前 DSH 版本对应的版本（见下表），并声明 `engines.dsh`（例如 `">=0.2.2-rc.5 <0.3.0"`），让 DSH 在版本不匹配时明确拒绝安装。升级 DSH 时统一升级并单独提交。
6. **展示元数据。** `locale/en.json` 与 `locale/zh.json` 必须提供切题的 `meta.title`、`meta.description` 和 `meta.detail`；`icon.svg` 必须是可渲染的原创或已授权图片（≤ 256 KiB）；详情页写在 `docs/DETAIL.md`。
7. **配置。** 用户可调参数放进 `Config`，通过 `cordis.patch.yml` 或 profile 的 patch 层修改；不要把用户配置写死在代码里。
8. **不改用户 profile。** 不手写 `~/.dsh`、不直接编辑 profile 的 `package.json` / `cordis.patch.yml`；安装、启用、卸载一律走 DSH「插件」页面（或 `plugin_manager`）。
9. **构建产物不提交。** `lib/`、`node_modules/`、`*.tsbuildinfo` 均在 `.gitignore` 中；npm 包在发布前由 workflow 构建。

## 安装（使用者）

### 从 npm

插件发布后，用户在 DeepSeek Harness → **插件 / Plugins** → **添加插件 / Add plugin** 中输入包名，例如：

```text
@nick.du/dsh-plugin-hello
```

命令行 profile 等价写法：

```bash
dsh plugin --profile <name> add @nick.du/dsh-plugin-hello
```

DSH 会校验 `engines.dsh` 与当前版本是否兼容，然后安装预构建的 `lib/`，不需要用户执行构建。

### 从本地目录（开发者）

1. 克隆仓库并安装、构建：
   ```bash
   git clone git@github.com:nickdu2009/dsh-plugin.git
   cd dsh-plugin
   pnpm install
   pnpm --filter @nick.du/dsh-plugin-hello build
   ```
2. 打开 DSH → **插件** → **添加插件**，选择 `plugins/hello` 的**绝对路径**（不要选仓库根目录）。
3. DSH 会链接该目录；在**新会话**中验证插件能力。修改代码后重新构建，并按需重启 DSH 或重新加载插件。
4. 卸载走插件页面的移除操作，不要手工删 profile 文件。

## 发布到 npm

发布使用 scope `@nick.du`（npm 账号 `nick.du`）。相关 workflow 是 `.github/workflows/publish.yml`。

### 一次性准备

每个新包第一次发布必须先手动创建，之后才能在 npm 上绑定 Trusted Publishing：

```bash
pnpm --filter @nick.du/dsh-plugin-hello build
cd plugins/hello
npm publish --access public
```

然后在 npmjs.com → 该包 → **Settings → Trusted publishing** 添加 GitHub Actions：

- Repository: `nickdu2009/dsh-plugin`
- Workflow filename: `publish.yml`
- Environment: 留空

有 npm 11.15+ 时也可以用命令完成同样的事：

```bash
npx -y npm@latest trust github @nick.du/dsh-plugin-hello \
  --repo nickdu2009/dsh-plugin --file publish.yml --allow-publish --yes
```

绑定后 CI 使用 OIDC 发布，不再需要长期 `NPM_TOKEN`。

### 发布一个版本

```bash
cd plugins/hello
npm version patch --no-git-tag-version
cd ../..
git add plugins/hello/package.json
git commit -m "release(hello): 0.1.1"
git tag hello-v0.1.1
git push && git push --tags
```

tag 格式为 `<插件目录名>-v<semver>`，例如 `hello-v0.1.1`。workflow 会：

1. 要求 tag 与 `plugins/hello/package.json` 的版本一致；
2. 构建该插件；
3. 在插件目录执行 `npm publish --access public --provenance`（Trusted Publishing，无需 token）。

## 校验与 CI

```bash
pnpm format:check   # Prettier
pnpm typecheck      # 每个插件 tsc --noEmit
pnpm test           # vitest（plugins/*/src/**/*.test.ts）
pnpm build          # 每个插件 tsc → lib/
pnpm check          # 以上全部
```

`.github/workflows/ci.yml` 在 Node 24 + pnpm 10 上执行 `pnpm check`；`.github/workflows/publish.yml` 由 tag 触发。

## 版本对应

| DSH        | `@deepseek-ai/cordis` | `@deepseek-ai/schemastery` | `@deepseek-ai/dsh-tools` |
| ---------- | --------------------- | -------------------------- | ------------------------ |
| 0.2.2-rc.5 | 4.1.0                 | 3.19.0                     | 0.2.2-rc.5               |

升级 DSH 后：读取新版本的 `docs/upgrade-guide/`，同步更新本表、所有插件的 `package.json`（含 `engines.dsh`）与根依赖，运行 `pnpm install && pnpm check`，然后单独提交。

## 迁移插件

从其它地方迁移、且不是用 TypeScript 写的插件，可以原样放进 `plugins/<name>/`，但必须补齐：

- `package.json`（含 `dsh.bundle.patch`、`exports`、`files`、`engines.dsh`）
- `cordis.patch.yml`（行 id 与目录名一致）
- `locale/en.json`、`locale/zh.json`、`docs/DETAIL.md`、`icon.svg`
- README 中注明「迁移插件 / 非 TypeScript」及来源

迁移插件不参与 TypeScript 构建，也不要为了统一构建而重写它。

## 许可证

[MIT](LICENSE)。插件使用的第三方素材需保留其许可与署名。
