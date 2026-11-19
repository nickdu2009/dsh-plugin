# Antigravity (ACP)

官方 Antigravity CLI 的原生 ACP v1 模型适配器，附带受控的本地 PDF 逐页转换。

## 原生模型选择

插件通过 `ctx.llm.registerAdapter` 注册 **Antigravity (ACP)**，沿用原聊天框与模型选择器。`agy acp --stdio` 的 `session/new` / `session/set_config_option` 返回实际配置项：

- `category: model` 提供模型目录，包括 CLI 实际枚举的第三方模型；不逐项添加警告。
- `category: thought_level` 提供原生思考档位；每次切换采用完整返回列表刷新，没有该配置项时不显示档位。
- 第一次 ACP 响应解释来源与限制。第三方模型仅按官方支持范围使用，详见[官方说明](https://antigravity.google/docs/ide/extensions/acp/#models-and-thinking-level)。

认证由 CLI 自己管理。配置被拒绝、模型拒绝或结果未知时会报错或说明，不换模型、不自动重试。

`session/prompt` 发出后若在 `idleTimeoutSeconds`（默认 90 秒）内没有任何 ACP 报文，本轮以 `ACP_NO_RESPONSE` 失败并发送 `session/cancel`，不会无限挂起，也不会重发。CLI 的 stderr 只保留最后几行脱敏摘要用于诊断（`token=`、`Bearer`、长随机串替换为 `[redacted]`），不采集凭据。

## 受控消息路由

`agent/pre-step`、原始 `llm/stream` 的 `isAgentLoopRequest` 和适配器共同核验 DSH 会话、模型和本次消息对象。只接受首步明确用户输入；两次独立输入各发送一次。系统提示、历史、标题、内部续步、来源不明及重复请求均不进入 ACP。其他提供商的请求保持原样。

插件向 CLI 声明无文件系统、终端与 MCP 能力，并取消权限请求。ACP 工具事件不会转成 DSH 工具调用。

## 本地 PDF 转换

仅处理本轮消息中显式 `.pdf` 文件引用。插件通过 DSH attachments 服务读取校验后的字节，本地逐页提取文字；扫描/空白、图表、版式敏感或提取不完整的页通过 OfficeKit 渲染 PNG。混合页可同时发送带文件名/页码的文字与 PNG。

不会上传原始 PDF，也不会发送 `file://`、本地路径或句柄作为替代品。页数、文件字节、单页文字、图片数量/尺寸/像素/总字节及提交文字均有限制。加密、损坏、不可读或部分超限时，提示未发送的页码与原因。

## 配置与安装

配置键、默认值及开发命令见 [README](../README.md)。插件不注册第二面板或 Agent 工具，不修改 DSH 核心。仅在用户明确要求时通过「插件」页面安装；本任务不自动启用。
