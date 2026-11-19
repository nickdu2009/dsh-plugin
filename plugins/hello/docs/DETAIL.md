# Hello

Adds a `hello_greet` tool that greets someone by name.

## 功能

- 注册 Agent 工具 `hello_greet`，参数 `name`（必填）。
- 返回拼好的问候语，例如 `Hello, DSH!`。
- 问候语前缀由插件配置提供，默认 `Hello`。

## 配置

| 键         | 类型   | 默认值  | 说明         |
| ---------- | ------ | ------- | ------------ |
| `greeting` | string | `Hello` | 问候语前缀。 |

在 profile 的 patch 层中修改，例如：

```yaml
- id: hello
  name: '@nick.du/dsh-plugin-hello'
  config:
    greeting: 你好
```

保存后插件自动重新应用，无需重启。

## 安装

1. 构建：`pnpm --filter @nick.du/dsh-plugin-hello build`
2. 在 DeepSeek Harness 中打开「插件」页面，选择「添加插件」：
   - 已发布到 npm 时，直接输入 `@nick.du/dsh-plugin-hello`；
   - 本地开发时，选中本插件目录。
3. 在**新会话**中让模型调用 `hello_greet` 验证。

## 限制

- 只返回文本，不访问文件、网络或其它服务。
- 工具对当前 profile 内的 Agent 可见；如需按 Agent 限制，请在上层使用工具策略。
