[English](README.en.md) | **中文**

# @zhourenke/dsh-reasoning-summary

`@zhourenke/dsh-reasoning-summary` 是一个面向 DeepSeek Harness 的第一阶段 Cordis 插件。它要求被配置为触发路由的模型在调用工具前给出一条简洁的行动摘要，并把规范化摘要写入 durable session history，让后续每一个模型都能看到完整的行动轨迹。

插件默认关闭。`models` 为空时，不注入提示、不规范化当前流，也不创建新的 relay 或 continuation。

## 核心契约

`models` 是精确的 `provider + model` 路由列表。它只决定**新步骤是否启用本插件的生成行为**，不决定 DSH 的通用模型选择，也不隔离 session history。

每一个步骤在准入时采样一次当前路由和设置：

| 步骤准入状态 | 当前步骤的新行为 | 已有摘要历史 |
|---|---|---|
| 精确路由已启用 | 注入提示；处理当前流；可创建 relay 或 reasoning-only continuation | 完整可见 |
| 精确路由未启用 | 普通流原样通过；不注入提示；不创建新的 relay/continuation | 完整可见 |

已准入的启用步骤拥有自己的流状态。模型切换或设置开关发生在流进行期间时，不会取消、清空或改写该步骤；它仍会完成当前摘要并持久化。变化只影响下一个步骤。relay 与 continuation 只声明插件身份和语义形式，不携带来源路由字段，也不会用于隐藏历史。

因此以下行为是有意设计的：

- A 启用 → B 禁用 → A 启用：B 能看到 A 的旧摘要但不产生新摘要，A 恢复后继续产生新摘要。
- A 禁用设置 → 重新启用 A：禁用区间不产生摘要，旧摘要不消失，重新启用后从下一步骤恢复。
- A → B → C → D，其中 A/C 启用、B/D 禁用：四个模型都能读取已存在的完整摘要历史，只有 A/C 的新工具步骤产生 relay。
- 以禁用的 B 开始且历史为空：B 不产生摘要；之后切换到启用的 A 时，从空历史开始生成第一条摘要。

插件不安装 `Session.deriveMessages()` 路由过滤器，也不追加空的 assistant replacement。普通 user/assistant、reasoning、tool、其他插件 context、relay 和 continuation 消息都按 DSH 的正常 durable projection 对所有路由开放。

## 实现范围

本版本包含：

- 为精确选中的路由注入英文系统提示；
- 严格匹配完整的 `provider + model`；
- 固定在工具调用前生成一条具体、可执行的摘要；
- complete、partial 和 missing 摘要规范化；
- 按 Agent、按步骤维护流状态，并在 DSH 的正常 `llm/stream` waterfall 中处理 prepared call；
- 从 assistant UI 流中移除工具步骤的全部 text block，同时将可用执行细节保存到摘要 relay；无工具的最终答复仍按原样保留；
- 在所有根工具调用的 durable `tool/result` 提交后，将摘要 relay 注入下一步骤；
- 工具调用结束 turn 时，将 relay 作为普通 durable `user/message` 追加到 session，继续对所有后续路由可见；
- reasoning-only 响应通过公开 `agent.steer()` 在同一 turn 内排队最多 3 次 continuation notice；该 notice 也是 durable model context，不会被路由过滤或 surface mask；
- 从实时模型目录读取模型并在设置卡片中保留过期选择；
- 保持 DSH GUI 的普通消息可见；客户端不安装全局 DOM 聊天行过滤器。

本版本明确不实现：

- 屏蔽 `reasoning_content` 或选择屏蔽模型；
- 工具门控或工具权限策略；
- 删除历史 `thinking` 内容。

这些能力属于后续阶段。

## 安装

通过目标 DSH profile 安装：

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

包内的 `cordis.patch.yml` 会把插件插入 bundle。安装、更新 profile 或重新构建 Host 侧代码后，需要按原命令重启正在使用的 DSH Web 服务，再刷新原有 GUI 地址。本插件不会启动替代服务器。

## 配置

设置命名空间为 `reasoning-summary`：

```yaml
models:
  - provider: cotton-codex
    model: gpt-5.6-luna
```

provider 和 model 必须同时匹配；同一个 model 配在另一个 provider 下不会启用该路由。空列表是唯一的关闭状态。schema 只保留 `models`，旧版本留下的无关字段会在读取时被归一化丢弃。设置卡片只修改本插件的 namespace，不会改动 DSH 通用的模型设置；模型目录中不可用且已启用的条目仍会保留显示，方便等待其恢复或手动清理。

## 流协议

模型准备调用工具时，必须把摘要作为**可见 assistant 文本**输出——也就是 text 通道，而不是只写在推理/思考内容里；只出现在 reasoning/thinking 中的摘要在插件看来是缺失的。标签必须是字面文本，且位于第一个工具调用之前：

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

摘要是下一步骤的执行记录，而不是泛泛的状态播报。它应写明相关的用户请求、文件/函数/命令、已经确认的观察或结果，以及紧接着要执行的动作或决策；不要只写“继续分析”“检查实现”“取得进展”之类无法据此行动的内容。

工具调用步骤不应在标签外输出普通 assistant 文案。插件也会在 finish 边界从 UI 流移除该步骤的全部 text block，以免模型遗漏协议时泄露无上下文的内部进度；工具块的原有顺序不会重排。若 provider 以 `error`/`aborted` 结束或流抛出异常，已出现工具调用的失败尝试同样隐藏已缓冲 text block，但不会创建 relay，避免把失败进度误当作完成的执行记录。标签按同一文本块中的最近邻完整配对提取，前面的孤立开标签不会抢走后续完整配对。首个有效配对具有权威性；输入标签只用于采集本步骤记录，后续模型收到的是紧凑 relay：

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

若工具步骤没有完整标签但存在普通执行文本，插件会隐藏该文本，但**不会**把它推测成摘要：没有可用 `<summary>` 标签的步骤一律使用 `[Action summary: missing]`，relay 附上提醒，要求模型在可见文本中重新输出字面标签——这样既防止 GUI 显示零散进度，也不会把模型自带的思考摘要误当成行动总结。reasoning/thinking 内容一律不计为可用文本；非失败流在闭合标签前结束时，已收到的内容使用 `[Action summary: partial]`，并保留下列说明：

```text
Missing action summary: the previous tool step's summary was not received as visible text — summaries written only into the reasoning/thinking channel are never read. Before your next tool call, write the summary again as visible assistant text inside a literal <summary>...</summary> tag.

Summary incomplete: the response ended before the closing tag.
```

最终自然语言答复不要求摘要，也不会创建 relay。无工具答复完全跳过摘要解析、标签删除和规范化；即使答复中包含字面 `<summary>...</summary>`，所有 text block 也会原样保留。

在已安装的 DSH `0.1.5-rc.1` 中，`PreparedLlmCall.stream()` 通过同一个 `llm/stream` waterfall，因此普通摘要规范化也覆盖 prepared-call 路径。插件只处理没有 `purpose` 的主 Agent Loop 请求，并用当前步骤的取消信号确认请求归属；标题、压缩等复用同一 `sessionId` 的辅助调用不会进入摘要状态。`dsh-llm` 自带的 `isAgentLoopRequest()` 标记集是模块局部的，profile 插件可能解析到另一份物理副本，因此这里不依赖它。durable `assistant/message` 检查只是对未经过本插件 stream hook 的调用方提供 reasoning-only 防御性回退。

## 摘要历史与接力

每条工具步骤摘要都会作为普通 `user/message` 写入或排队，并带有来源标记：

```json
{ "kind": "plugin", "plugin": "reasoning-summary", "form": "relay" }
```

模型可见正文采用紧凑格式。完整摘要只保留一个语义标题和正文：

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

只有不完整或缺失状态才在标题中标明 `partial` 或 `missing`。插件身份、来源 form、provider/model、turn/step 与 XML 包络不再重复写入正文：DSH 的 `source` 仍在 durable message 上保留 provenance，而正文专门保留下一步需要的行动事实。已有 session 中的旧 relay 会继续作为普通历史传递，本插件不会自动改写它们。

工具循环继续时，插件等待所有根工具调用的 durable `tool/result` 事件提交，再通过 Agent inbox 排队 relay；下一步骤会消费它一次并把它写入 durable session。工具调用导致 turn 结束时，插件也把 relay 直接以 `surfaceOp: 'append'` 追加到 durable session。两种 relay 都保留在正常 session history 中，任何后续 provider/model 都可从 `Session.deriveMessages()` 读取；没有按来源路由的隐藏、replacement 或二次遮蔽。

reasoning-only 响应没有工具调用或用户可见答复时，插件会使用公开 `agent.steer()` 请求同一 turn 继续。notice 的模型可见标题为 `[Continue after reasoning-only response]`，不再嵌套一份规范化摘要。启用状态只属于产生该 notice 的步骤；后续禁用路由仍可读取已存在的 notice，但不会因为它再次创建新的 continuation。

旧版本曾用 replacement 遮蔽结束 turn 的 relay。对于已经写入旧 replacement 的 session，移除新代码不能逆转 DSH append-only surface projection：原始 relay 可能仍在 raw log，但当前 surface/derived history 已经被旧 replacement 隐藏。这类旧 session 如需恢复，需要单独的 raw-log 重建/迁移；本插件不会自动改写用户历史。新代码产生的 relay 不使用 replacement。

## 开发与验证

本包面向 DSH `0.1.5-rc.1` 和 Node.js 20+。宿主包通过 `peerDependencies` 声明、`devDependencies` 仅用于本地类型检查与测试，且版本与目标宿主保持一致：

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

当前 `pnpm test` 通过 64 项测试，覆盖配置归一化、严格路由匹配、完整历史跨路由可见、A/B/C/D 路由序列、设置禁用/重新启用、已准入步骤在中途切换后的完成、relay 与 continuation 时序、同 session 标题与异信号辅助流隔离、工具结果去重、紧凑 complete/partial/missing relay 标题、正常和失败工具步骤的文本隐藏、最近邻标签配对、无工具最终答复的字面标签原样保留、provider 块顺序、prepared-call 防御性回退、客户端不安装全局聊天行过滤器、客户端只经 `remote.session` 命名空间读取宿主模型目录，以及一条**跨插件契约**：注入的消息不会重置 `dsh-repeat-tool-reminder` 的重复计数。其中 `test/client.test.mjs` 会真正执行 `lib/client.js`：注入 `window.__ModuleLoader__` 后捕获注册定义、以桩 `require` 调用工厂、再以模拟 ctx 调用 `apply`，从而验证插槽占用、样式注入，以及三条模型目录解析路径（`ctx.get('remote.session')`、`ctx.get('remote')`、`ctx.remote.session`）。该文件同时把实测到的宿主契约写进桩与注释（`settings.plugin.item` 是宿主不向卡片传 props 的 keyed 插槽、`settingsScope.bind({ namespace })` 的返回面与快照状态、`status !== 'ready'` 时卡片不渲染），并实际挂载一次卡片元素，确认注入面被转交给组件、未就绪时不产出任何元素。

那条跨插件契约用**真实的** `dsh-repeat-tool-reminder` 代码验证（该守卫只注册两个 handler、不依赖其它服务，所以测试能用两行 `ctx.on` 把它装进同一进程），并配了一条反向对照：同样大小的 pre-step 批次里换成一条 `source.kind === 'user'` 的消息时，链确实会被清除——否则主测试可能因为"清除分支从未执行"而通过。这也是 `@deepseek-ai/dsh-repeat-tool-reminder` 出现在 `devDependencies` 里的唯一原因：**本包从不 import 它，只有测试加载它**，请勿把它当作未使用的残留删除。

### 产物提交纪律

本包走 git 分发：`dsh plugin add` 只安装 git 跟踪的文件，且安装过程不执行任何构建步骤。因此 `lib/` 的四个产物必须一并提交——`lib/index.js`、`lib/client.js`、`lib/types/index.d.ts`、`lib/types/client.d.ts`；只提交 `.js` 而漏掉 `lib/types/` 会造成「装得上但没有类型声明」的半发布状态。同时**不要**添加 `prepare` 脚本：pnpm 默认拦截依赖的构建脚本，加它会把手动安装变成「先手改 profile 的 `allowBuilds` 再重跑」。

改动 `src/` 后的固定流程：

```powershell
pnpm run build
git status --porcelain   # 必须为空；有输出说明产物没跟上源码
```

Host 半边与 Browser 半边分别使用一份配置：`tsconfig.json` 面向 Node（`lib: ["ES2022"]`、`types: ["node"]`，不含 DOM），`tsconfig.client.json` 面向浏览器（`lib: ["ES2022", "DOM"]`、`types: []`，`require` 由 ModuleLoader 的工厂参数注入）。分开配置的作用是让 `window`、`document` 这类浏览器全局量不会误入 Host 代码。

## 许可证

MIT
