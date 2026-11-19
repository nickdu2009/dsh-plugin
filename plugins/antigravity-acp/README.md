# Antigravity (ACP)

将 DeepSeek Harness 的原生模型选择器接入官方 `agy acp --stdio`（ACP v1），并在发送前把本轮显式附加的 PDF 在本地逐页转换为内嵌文字和/或 PNG。

## 行为

- 在原生模型目录中注册 **Antigravity (ACP)**，模型与思考档位来自 `agy` 实际返回的 `model` / `thought_level` 配置项。切换后使用 ACP 返回的完整配置列表刷新；没有档位的模型不显示档位。
- 认证保留在 Antigravity CLI。插件不读取或保存凭据，也不伪装成其他 IDE 绕过第三方模型限制。首次响应说明模型来源及[官方第三方模型限制](https://antigravity.google/docs/ide/extensions/acp/#models-and-thinking-level)。
- 仅路由本轮首步、来源明确且与原始 DSH agent-loop 请求相匹配的用户输入。不会发送系统提示、历史、标题或内部续步；重复、未知、取消和结果未知的请求不会重发。
- PDF 在本地读取并逐页提取文字，保留文件名和页码。扫描页、图表、版式敏感页及提取不完整的页按需渲染 PNG；只发送内嵌文字/图像，不发送原始 PDF 或本地路径。
- ACP 工具调用、计划和权限事件不会变成 DSH 工具执行；不注册 Agent 工具、不开放 MCP、不创建第二面板。

## 配置

| 键                   | 默认值     | 说明                                                      |
| -------------------- | ---------- | --------------------------------------------------------- |
| `executable`         | `agy`      | 官方 Antigravity CLI 可执行文件；参数固定为 `acp --stdio` |
| `workingDirectory`   | 空         | ACP `session/new` 的工作目录；空值使用 DSH 主机当前目录   |
| `maxPdfPages`        | `10`       | 每个 PDF 最多处理的页数                                   |
| `maxPdfBytes`        | `33554432` | 单个 PDF 最大字节数                                       |
| `maxPageTextChars`   | `16000`    | 每页最大提取字符数                                        |
| `maxImages`          | `10`       | 每个 PDF 最大 PNG 页数                                    |
| `maxTotalImageBytes` | `12582912` | 单次提交的图像总字节预算                                  |
| `maxImageDimension`  | `2048`     | PNG 最大边长                                              |
| `maxImagePixels`     | `16000000` | PNG 最大像素数                                            |
| `maxPromptTextChars` | `120000`   | 单次提交的文字预算                                        |
| `idleTimeoutSeconds` | `90`       | `session/prompt` 无任何 ACP 报文的最长等待；超时本轮报错  |

加密、损坏、不可读、超限或转换失败的页会明确报告未发送范围与原因；可用的其他页文字仍可发送。

`agy` 接受了 `session/prompt` 却长时间没有任何回应时，本轮会以 `ACP_NO_RESPONSE` 失败并取消该 ACP 请求，不会无限等待、也不会重发。`agy` 的 stderr 只保留最后若干行**脱敏**摘要（`token=`、`Bearer`、长随机串都会被替换为 `[redacted]`）用于诊断，不采集凭据。

## 开发

```bash
pnpm --filter @nick.du/dsh-plugin-antigravity-acp typecheck
pnpm --filter @nick.du/dsh-plugin-antigravity-acp build
pnpm test
pnpm check
```

源码位于 `src/`，构建输出 `lib/` 不提交。单元测试使用严格 mock 验证第三方模型选择、思考档位、拒绝、取消和不重发行为；这些 mock 不代表绕过官方限制。实际 ACP v1 枚举可用已认证的官方 `agy` 验证。

## 安装

仅在用户明确要求时，通过 DeepSeek Harness「插件」页面安装构建后的目录或发布后的包 `@nick.du/dsh-plugin-antigravity-acp`。安装后在新会话的原生模型选择器中选择 **Antigravity (ACP)**；本仓库任务不自动安装或启用插件。
