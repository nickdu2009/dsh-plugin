# @nick.du/dsh-plugin-model-instructions

按「当前这一步将要调用的模型」向系统提示词追加指令：推理模型可以拿到过程要求，写作模型可以拿到语气说明，同一份会话在不同模型下得到不同引导。规则在设置页里用提供商/模型通配符维护，保存后从下一个模型步骤开始生效，无需重启；没有命中的模型提示词保持不变。

- **设置页：** 设置 → 按模型注入（页面标题「按模型注入提示词」）
- **配置：** `order` / `name` / `interpolate` / `rules`（`rules` 由设置页维护）

## 使用

1. 打开侧边栏底部的 **设置**，在左侧选择 **按模型注入**。
2. 规则默认为空，此时所有模型的系统提示词保持原样，不占任何 token。
3. 点 **添加规则**，填写以下字段：

| 字段   | 含义                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| 规则名 | 可选，只用于在列表中区分规则；留空时标题显示为「提供商 · 模型」。                                         |
| 提供商 | 从当前可路由的提供商中选择；「全部提供商」表示不限。需要通配符时选「自定义通配符…」手填。                 |
| 模型   | 从所选提供商可路由的模型中选择；「全部模型」表示不限。需要通配符或列表外的模型时选「自定义通配符…」手填。 |
| 指令   | 命中时追加到系统提示词的文本。留空的规则不生效，可用于暂时停用一条规则。                                  |

4. 点 **保存**。改动写入当前 profile 的配置，下一个模型步骤就按新规则拼装提示词；会话中途切换模型时同样在下一步生效，不需要重启。

提供商和模型支持通配符：`*` 匹配任意长度，`?` 匹配单个字符；匹配不区分大小写，且必须整体命中 id——`deepseek-reasoner*` 命中 `deepseek-reasoner-max`，不命中 `deepseek-flash`。提供商和模型留空表示不限（命中所有模型）。

多条规则同时命中时，按列表顺序用空行拼接，因此可以先写一条通用规则、再写一条针对具体模型的补充规则。卡片上的 **未生效** 表示指令为空，**全部模型** 表示没有限定提供商和模型（页面底部会提示）；↑ ↓ 调整顺序（顺序影响拼接结果），**删除** 只改动当前草稿。点标题左侧的箭头可以收起单条规则或整个规则列表，收起后仍会显示一行指令摘要。

有未保存修改时 **重新加载** 不可用，避免误丢草稿；**放弃修改** 把编辑框恢复成已保存的内容。保存时如果配置已被其它改动更新，界面会提示冲突：草稿保留、最新配置重新载入，再次保存即可应用。配置只读时页面会标出且无法保存；如果暂时读不到模型目录，页面会给出提示，此时仍可用「自定义通配符」手填。

## 配置

设置页只编辑 `rules` 这一个字段；其余字段写在配置行里（`cordis.patch.yml` 或 profile 的 patch 层）：

```yaml
- id: model-instructions
  name: '@nick.du/dsh-plugin-model-instructions'
  config:
    order: 9500 # 段落位置
    name: deployment:model-instructions # 段落名
    interpolate: false # 是否解析 {{变量}} 插值
    rules: [] # 由设置页维护
```

| 键            | 类型    | 默认值                          | 说明                                               |
| ------------- | ------- | ------------------------------- | -------------------------------------------------- |
| `order`       | number  | `9500`                          | 段落位置：交付物引用之后、结构化输出之前。         |
| `name`        | string  | `deployment:model-instructions` | 段落名；同名的 Agent 级段落会遮蔽它。              |
| `interpolate` | boolean | `false`                         | 是否对指令文本做 `{{变量}}` 插值；默认按原样注入。 |
| `rules`       | array   | `[]`                            | 有序规则列表，只在设置页编辑。                     |

`rules` 里存的仍是「字符串列表」：界面上选择单个提供商/模型时写入单元素列表，「全部」写入空列表，「自定义」写入按逗号拆分的通配符；手写 YAML 配置时同样要写成列表。

覆盖配置时请整套提供 `config`：Loader 的覆盖会替换整份配置，而不是逐字段合并。修改 `order` / `name` / `interpolate` 会让插件按常规重新应用；`rules` 是 volatile 字段，设置页的写入直接生效、不重挂插件。

## 安装

1. 构建：`pnpm --filter @nick.du/dsh-plugin-model-instructions build`
2. DeepSeek Harness → **插件 / Plugins** → **添加插件 / Add plugin**，选择 `plugins/model-instructions` 目录（不要选仓库根目录）。
3. 在**新会话**中打开 **设置 → 按模型注入**，添加一条规则验证。

> 如果之前装过原插件 `@local/model-instructions`，请先在插件页面把它移除：迁移后的 bundle 仍使用 Loader 行 id `model-instructions`（设置页和 volatile 的 `rules` 字段都以该 id 为键），两个 bundle 不能同时插入同一行 id。迁移后的包名不同（`@nick.du/dsh-plugin-model-instructions`），旧页面上的规则不会自动迁移，需要在新的设置页重新添加，或把 `rules` 列表抄进 profile 的 patch 层。

## 开发

```bash
pnpm install          # 仓库根目录
pnpm --filter @nick.du/dsh-plugin-model-instructions typecheck
pnpm --filter @nick.du/dsh-plugin-model-instructions build
pnpm test             # 仓库根目录运行全部插件测试
```

源码在 `src/`：Host 半边在 `src/index.ts`（段落注册）与 `src/instructions.ts`（规则匹配），浏览器半边在 `src/client.ts`（由 DSH 以经典脚本加载，不能包含 import/export）；构建产物在 `lib/`（不提交），Host 源码的相对导入使用 `.js` 扩展名。

## 限制

- 段落是 profile 级全局贡献：所有会话和子代理都会看到命中的指令。
- 只影响提示词文本，不改变工具、模型路由或任何会话状态。
- `minimal` 预设的人设声明了完整提示词（`complete: true`），该预设只发送人设前缀，本插件的段落会被忽略；`standard`、`ptc`、`cordis` 正常生效。
- 指令默认按原样注入，不做 `{{变量}}` 插值，因此正文里出现花括号也不会让拼装失败；需要插值时把配置行的 `interpolate` 设为 `true`。
- 提供商/模型匹配针对 id，不针对显示名；下拉来自当前部署可路由的模型目录（与对话框里的模型选择器同源），目录暂时读不到时只能用「自定义通配符」手填。

## 迁移说明

本插件由 `@local/model-instructions` v1.1.0 迁移而来，代码已改为 TypeScript（Host 与浏览器两半分别在 `src/index.ts`、`src/client.ts`），行为与配置字段保持一致。
