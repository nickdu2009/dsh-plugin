# @nick.du/dsh-plugin-hello

Adds a `hello_greet` tool that greets someone by name.

- **Tool:** `hello_greet`
- **Config:** `greeting`（默认 `Hello`）
- **npm:** [@nick.du/dsh-plugin-hello](https://www.npmjs.com/package/@nick.du/dsh-plugin-hello)

## 开发

```bash
pnpm install          # 仓库根目录
pnpm --filter @nick.du/dsh-plugin-hello typecheck
pnpm --filter @nick.du/dsh-plugin-hello build
pnpm test             # 仓库根目录运行全部插件测试
```

源码在 `src/`，构建产物在 `lib/`（不提交）。相对导入使用 `.js` 扩展名。

## 安装

- **npm（发布后）**：DeepSeek Harness → 插件 → 添加插件 → 输入 `@nick.du/dsh-plugin-hello`
- **本地开发**：
  1. `pnpm --filter @nick.du/dsh-plugin-hello build`
  2. 插件 → 添加插件 → 选择本目录
  3. 在新会话中调用 `hello_greet` 验证

## 限制

- 只返回文本，不访问其它服务。
