# **TITLE**

**DESCRIPTION**

## 功能

注册一个 `__TOOL__` Agent 工具：传入姓名，返回按配置拼好的问候语。

## 配置

| 键         | 类型   | 默认值  | 说明         |
| ---------- | ------ | ------- | ------------ |
| `greeting` | string | `Hello` | 问候语前缀。 |

在 `cordis.patch.yml` 的插件行或 profile 的 patch 层中修改；保存后插件自动重新应用，无需重启。

## 安装

1. 构建：`pnpm --filter dsh-plugin-__NAME__ build`
2. 在 DeepSeek Harness 中打开「插件」页面，选择「添加插件」，选中本插件目录。
3. 在**新会话**中让模型调用 `__TOOL__` 验证。

## 限制

- 只返回文本，不访问文件、网络或其它服务。
- 工具对当前 profile 内所有 Agent 可见；如需按 Agent 限制，请在上层使用工具策略。
