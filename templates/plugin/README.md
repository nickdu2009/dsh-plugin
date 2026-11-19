# dsh-plugin-**NAME**

**DESCRIPTION**

- **Tool:** `__TOOL__`
- **Config:** `greeting`（默认 `Hello`）

## 开发

```bash
pnpm install          # 仓库根目录
pnpm --filter dsh-plugin-__NAME__ typecheck
pnpm --filter dsh-plugin-__NAME__ build
pnpm test             # 仓库根目录运行全部插件测试
```

源码在 `src/`，构建产物在 `lib/`（不提交）。相对导入使用 `.js` 扩展名。

## 安装

1. `pnpm --filter dsh-plugin-__NAME__ build`
2. DeepSeek Harness → 插件 → 添加插件 → 选择本目录
3. 在新会话中调用 `__TOOL__` 验证

## 限制

- 只返回文本，不访问其它服务。
