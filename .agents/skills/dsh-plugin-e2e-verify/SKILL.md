---
name: dsh-plugin-e2e-verify
description: Verify a DSH plugin end to end inside a real, agent-driven DSH Web GUI — model picker, reasoning levels, per-turn routing, attachment conversion, failure visibility — without a human clicking anything. Use when accepting plugin work, reproducing a user-reported GUI failure, or collecting reproducible evidence (screenshots, wire payloads) for a review.
---

# 用 agent 自己验证 DSH 插件（真实 GUI）

目标：不依赖人工点击，在**真实运行**的 DSH Web GUI 里驱动插件、观察结果、留下可复现证据。
所有结论必须来自实际观测；mock 只能证明被 mock 的部分。

本文件只规定**要证明什么、怎么判定**，不绑定具体工具。下面的「能力」用你环境里现有的实现即可（见能力映射表）。

## 边界：什么必须真实，什么可以 mock

| 项                               | 要求                                      |
| -------------------------------- | ----------------------------------------- |
| 模型目录、推理档位、选择器渲染   | 真实宿主 + 真实 CLI 返回，不许硬编码      |
| 路由（哪条消息被派发、派发几次） | 真实 agent loop；用可见的轮次/回答证明    |
| 附件转换（PDF/图片）             | 真实上传/拖入，真实请求                   |
| 第三方模型限制                   | **只做 mock**；真实调用仅限官方允许的模型 |
| 凭据                             | 永远不搜索、不复制、不落盘                |

## 需要的能力（任选实现）

| 能力                                                     | 你环境里的可能形式                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 起后台进程并拿到它的 stdout                              | 后台任务 / `tmux` / `nohup` + 日志文件                                                                         |
| 用浏览器打开 URL、点击、输入、上传文件、截图、读页面文本 | 浏览器自动化工具；Playwright/Puppeteer 脚本；CDP；DevTools MCP。若只有 HTTP 客户端，见文末「没有浏览器工具时」 |
| 跑一次性 Node/TS 脚本                                    | `tsx`、`node --experimental-strip-types`、先 `tsc` 再跑                                                        |
| 抓网络/协议帧                                            | 在代码里 wrap 被测客户端；或浏览器网络面板/perf 日志                                                           |

选择器的 DOM 特征、命令写法、断言方式都与工具无关；只有「怎么点、怎么截图」随工具变。

## 步骤 1：建一次性 profile（不要动用户的 desktop profile）

```bash
dsh --profile <test-name> --from-default-profile web --dump-config
dsh plugin --profile <test-name> add /absolute/path/to/plugins/<name>
```

- profile 目录在 `$DSH_HOME/profiles/<name>`；`dsh plugin add` 会把目录 link 进去。
- 不要手改已装好 profile 的 `cordis.patch.yml`；要走 `dsh plugin` 或插件管理器。
- 用完可保留（便于复现）或删除，但**不要**改用户的默认 profile。

## 步骤 2：启动 GUI 宿主（唯一正确写法）

```bash
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" "$DSH_INSTALL_DIR/lib/bin.js" \
  --profile <test-name> --port 0 --no-open
```

坑：`dsh --profile X web --port 0` 会报 `error: too many arguments. Expected 0 arguments but got 1: web.`
后台跑，从**它自己的 stdout** 里拿 `dsh web: http://127.0.0.1:<port>/?token=...`。
这个 token 是你启动的进程打印的，不是窃取凭据；仍然不要写进提交物或报告正文。

## 步骤 3：驱动真实页面

1. 打开该 URL；若出现「预览版说明」弹窗，点「继续」。
2. DSH Web 的 DOM 特征（与工具无关）：
   - 输入框是 `[contenteditable="true"]`，**不是** `textarea`
   - 发送按钮 `button[aria-label*="发送消息"]`（空内容时 disabled）
   - 模型按钮 `[aria-label*="选择模型"]`，文本形如「当前 <model>，推理等级 <effort>」
   - 附件入口是隐藏的 `input[type=file]`：直接把本地路径注入这个 input
   - 模型弹层是 `menuitemradio` 列表 + `搜索模型…` 搜索框；档位子菜单用 `aria-checked` 读当前值
3. 等待与断言：**不要依赖工具的固定等待上限**（有的 15 s 就超时）。用「睡一段 + 读页面可见文本」循环，单次断言同时检查**出现**与**未出现**：

```js
// 在页面上下文读取可见文本；换成你的工具读取页面文本的方式
;(() => {
  const t = document.body.innerText
  return { ok: t.includes('EXPECTED'), failed: t.includes('本轮运行失败'), tail: t.slice(-300) }
})()
```

4. 每个验收点留一张截图到 `/tmp/<case>.png`，报告里引用路径。

## 步骤 4：报文级证据（证明「发出去的是什么」）

要证明「只发了转换后的内容、没发原始字节」，不要靠推理，抓帧：

```ts
const client = new AcpClient('agy')
const frames: Array<{ method: string; params: unknown }> = []
const original = client.request.bind(client)
client.request = async (method, params, signal) => {
  frames.push({ method, params })
  return original(method, params, signal)
}
await client.run({/* 与插件相同的入参构造方式 */})
// 断言：session/prompt 的 parts 类型、图片 mimeType，且不含 %PDF / JVBERi0 / file:// / 本地路径
```

- 必须用**被测代码自己的**构造函数生成内容，否则证明的不是插件行为。
- 断言要包含**否定项**：`!/%PDF/.test(serialized)`、`!/file:\/\//`、`!new RegExp(localPath)`。
- 模型不回话也要能出证据：先抓帧，再让超时把探针结束，别让探针把证据一起吞掉。

## 步骤 5：失败路径必须逐条观察

| 输入                                   | 期望                                               |
| -------------------------------------- | -------------------------------------------------- |
| 加密 / 损坏 / 超限（页数、字节、像素） | 用户可见的明确说明：哪些没发、为什么；不许静默截断 |
| CLI 静默不回                           | 有界的看门狗 → 本轮明确失败，不无限等待、不重发    |
| 取消                                   | 立即停止，不重发、不换模型                         |
| 错误信息                               | 不能包含 token、密钥等敏感串（写断言验证脱敏）     |

## 常见坑（都是踩过的）

- 长驻子进程的输出**不要经 `| tail` / `| head`**：会被缓冲到 EOF，看起来像挂起。写文件再读。
- kill 后台任务后**子进程可能残留**（如 `agy acp --stdio`），会污染后续实验；先查进程再重跑。
- 目录软链安装的插件会加载到**自己那份**同版本依赖，模块内状态（WeakSet、缓存）与宿主不共享；
  需要宿主语义时从 `DSH_INSTALL_DIR` 解析宿主副本，而不是 import 本地依赖。
- 带附件时宿主会把请求**投影复制**（`projectFilesToText`）再交给 adapter：对象身份、WeakMap 键都会失效；
  跨边界关联要用稳定的 `Message.id`，不要用对象引用。
- 本地渲染类服务（officeKit 等）可能在打包环境里**永不返回**（引擎路径在 asar 内不可执行）。
  渲染必须加 deadline，并优先从源文件里直接提取可用内容。
- 插件自身的自我测试**不能**当作验收结论；它只能证明「我理解的路径」。验收要来自真实宿主。

## 没有浏览器工具时

用 HTTP 直接驱动：`GET /?token=...` 拿会话 cookie，再调 Web 端的会话 API 发消息、订阅流式事件。
代价大且有风险：接口未公开、事件格式会变，因此只能作为最后手段；需要时先确认接口，别凭猜测写死路径。

## 交付格式

报告用表格：验收点 / 结论 / 证据（命令、耗时、轮次、截图路径、报文断言）。
显式列出**未验证项**和**为什么**（例如「第三方模型仅 mock，合规要求」）。
最后清理：停掉测试宿主进程，说明 profile 是否保留。
