# 开发注意事项（Development Notes）

面向维护者。使用者请看 [README.md](README.md)——那里只回答"能不能用、怎么调、哪里会踩坑"，实现内部细节一律放在本文档。

本插件是**双半边**插件：`src/index.ts` 跑在宿主 Node 进程里，`src/client.ts` 是浏览器侧由 ModuleLoader 加载的普通脚本。两半不能互相 `import`，所有跨半边的身份字符串都靠**逐字一致**维持（见实现要点 8）。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 宿主半边全部实现：设置、提示注入、流拦截、摘要规范化、relay 与 continuation |
| `src/client.ts` | 浏览器半边：设置页里的一张模型选择卡片（纯脚本，无 `import`） |
| `lib/index.js` | 宿主编译产物，**必须提交**（路线 A） |
| `lib/client.js` | 浏览器编译产物，**必须提交** |
| `lib/types/index.d.ts` | 宿主类型声明，**必须提交** |
| `lib/types/client.d.ts` | 浏览器类型声明，**必须提交** |
| `test/core.test.mjs` | 纯函数与解析器（11 项）：`inspectSummary`、`normalizeTextBlocks`、`routeKey`、摘要素 |
| `test/runtime.test.mjs` | 宿主事件链（42 项）：模拟 ctx 走完整 step 生命周期 |
| `test/client.test.mjs` | 浏览器半边（11 项）：**真正执行** `lib/client.js` |
| `cordis.patch.yml` | profile 层插入声明 |
| `tsconfig.json` | 宿主半边配置（Node，无 DOM） |
| `tsconfig.client.json` | 浏览器半边配置（DOM，无 Node 类型） |
| `pnpm-workspace.yaml` | pnpm 自管的 `minimumReleaseAgeExclude` 允许清单，**一并提交**，不要手改（§6.6） |

## 本地开发与构建

```powershell
pnpm install
pnpm run typecheck   # 两份 tsconfig 都要过
pnpm run build       # 两个 tsc：src/index.ts → lib/index.js，src/client.ts → lib/client.js
pnpm test            # 先 build，再 node --test
```

**两份 tsconfig 不能合并。** `tsconfig.json` 给宿主半边 `lib: ["ES2022"]` + `types: ["node"]` 且不含 DOM；`tsconfig.client.json` 给浏览器半边 `lib: ["ES2022", "DOM"]` + `types: []`。这样 `window`、`document` 不会误入宿主代码，`node:` 内置模块也不会误入浏览器半边。浏览器半边的 `require` 由 ModuleLoader 的工厂参数注入，因此那里没有 Node 类型可用。

`pnpm test` 不是可选项。`tsc` 只做类型检查与转译，漂移检查只看 git 状态——**没有任何一步执行过产物**。于是「模块在 import 时抛错」可以一路绿灯，直到用户重启 DSH 才在启动日志里爆出来。测试直接 `import` 编译产物，用模拟 ctx 走一遍加载、事件注册与整条 relay 时序。

`test` 脚本写作 `"pnpm run build && node --test"`，两点都不能省：`node --test` 不带参数才会递归发现全部测试文件；串上构建则保证执行的永远是源码当前编译出的产物，而不是上一次的残留。

**每次修改 `src/` 后必须运行 `pnpm run build`，并把 `lib/` 一并提交**：

```powershell
pnpm run build
git status --porcelain   # 必须为空；有输出说明产物没跟上源码
```

## 开发挂载：让 DSH 加载你改的代码

用目录连接点把插件挂进 profile 的 `node_modules`，改完 `pnpm run build` 再重启即可，不必每次重新安装：

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\web"
[System.IO.Directory]::CreateDirectory("$prof\node_modules\@zhourenke") | Out-Null
New-Item -ItemType Junction -Path "$prof\node_modules\@zhourenke\dsh-reasoning-summary" -Target $PWD
```

**连接点会绕过 profile 里已提升的依赖**：Node 按 realpath 解析后沿工作区路径向上找 `node_modules`，所以插件目录里必须自己 `pnpm install` 一份，否则启动时报 `Cannot find package '@deepseek-ai/schemastery'`。

**代码改动的生效方式分两半**：宿主半边改完必须**重启 DSH**；浏览器半边改完在重启后还需要**刷新页面**（`lib/client.js` 由 ModuleLoader 在页面加载时取用）。只测宿主半边时不必管卡片，但反过来只刷新页面不会让宿主改动生效。

**配置改动则与重启无关**：`settings.yaml` 与 profile 补丁层都是热重载的，改完立刻生效，两边都不用重启。把这条与上面的代码改动分开记，就不会写出"改配置要重启"这种文档错误。

## 配置落点：`settings.yaml` 与 profile 补丁

同一个 `config` 有两个写入点，README 面向使用者只讲第一个：

| 落点 | 谁写它 | 形态 | 生效 |
|---|---|---|---|
| `<harness home>/settings.yaml` | 设置卡片（经由设置服务）或用户手改 | **顶层键 = namespace**：`reasoning-summary:` 下直接放 `models:` | 保存即生效（热重载） |
| `<profile>/cordis.patch.yml` | 用户或 profile 维护者 | `- id: reasoning-summary` 覆盖条目，其下 `config:` | 保存即生效（补丁层热重载） |

`settings.yaml` 由 `dsh-settings-file` 提供：文件监听默认开启（`config.watch ?? true`，`debounceMs` 默认 100），并且用一条独占操作链把"监听重载"与"文档写入"串行化，因此不会读到写了一半的文件——这也是它能热重载而无需重启的原因。

`cordis.patch.yml` 里**必须用 `- id:` 的覆盖写法，不要写 `- insert:`**：bundle 自带的 patch 已经把这个条目插进去了，再 `insert` 一次不报错，而是多出一个同 id 的实例——插件跑两遍、摘要逻辑算两遍。覆盖只看 `id`，所以 `name` 可省，但一旦写了就必须逐字一致，写错只会静默不生效。

**不要把这个 `id` 当成配置的一部分写进 README 的用户指引**：使用者改的是 `settings.yaml`（或直接点设置卡片），那里没有 `id`、也没有 `name`，只有 namespace 分节。

连接点挂载的插件**无法用 `dsh plugin remove` 卸载**（它不在 profile 的 `dependencies` 里），需要手工删连接点再摘掉 `dsh.profile.bundles` 条目。挂载状态可用 `Get-Item … -Force | Select-Object LinkType, Target` 核对，`Target` 必须等于你正在改的仓库路径（§6.1）。

## 实现要点（为什么这样做）

### 1. 宿主 `inject` 只列真正读取的服务

当前是 `['agents', 'settings', 'systemPrompt']`。**事件订阅不经过服务**：监听 `llm/stream`、`tools/result` 不需要把 `llm`、`tools` 写进 `inject`——官方 `dsh-repeat-tool-reminder` 一个宿主 inject 都不声明，照样在同一个流上监听。这三项之外的服务一旦被读取，运行时的测试 harness 会立刻抛错（它只提供这三个），所以误加读操作会在测试里暴露，而不是悄悄放宽声明。

### 2. 状态挂在 `WeakMap<Agent, …>` 上，准入快照另存一份

`states` 以 live Agent 对象为键，不挂到 Agent 上、也不用全局 `Map`（那会让 Agent 无法回收）。另一个 `WeakMap`（`admissionSnapshots`）单独存"本步骤准入时采样到的路由与开关"：设置和模型选择可能在流进行期间变化，而**已准入的步骤必须按准入时的快照跑完**，不能被中途改写。两者都是 `WeakMap`，所以 profile 用 `patchReload: live` 重载时，新实例不会复用旧实例留下的状态。

### 3. relay 一律 `surfaceOp: 'append'`，不用 replacement

`session.append('user/message', message, { surfaceOp: 'append' })` 把摘要作为**正常 durable 历史**写入，任何后续 provider/model 都能从 `Session.deriveMessages()` 读到；插件不安装路由过滤器、不追加空的 assistant replacement、不做二次遮蔽。旧版本曾用 replacement 遮蔽结束 turn 的 relay，结果是**不可逆的**：即便 raw log 里还在，当前 surface/derived history 已经被隐藏，移除代码也换不回来。这正是新代码不再使用 replacement 的原因。

### 4. reasoning-only 走 `agent.steer()`，同一 turn 内最多 3 次

模型只输出推理、既没有工具调用也没有用户可见答复时，插件用公开的 `agent.steer()` 在**同一 turn** 内排队一条 continuation notice，而不是新建用户 turn。上限 `MAX_REASONING_CONTINUATIONS = 3`，防止一个反复只输出推理的模型把 turn 拖成死循环。`continuationBlocked` 有**五条**置位路径，缺一条就会多推一次无谓的 notice：`max-tokens` 结束、流错误、流被中止、`agent/turn-stopping` 时 turn 已被中断、以及 `session/event` 上 `interrupted === true`。

消息对象缓存在 `state.continuationMessage` 上（同一 turn 内复用同一条），`relayAttempts >= 2` 是 relay 自己的上限——两者都是"失败不重试到天荒地老"的同一类护栏。

### 5. 文案常量集中在宿主半边，README 是第二落点

`PROMPT`、`MISSING_TEXT`、`PARTIAL_TEXT`、`REASONING_CONTINUATION_TEXT` 都定义在 `src/index.ts`，其中 `MISSING_TEXT` 与 `PARTIAL_TEXT` 被导出，供测试**按同一个字符串**断言（测试不重复写一遍文案，否则改文案就会静默失去覆盖）。README 的「流协议」一节里也抄了一份 `MISSING_TEXT` 与 `PARTIAL_TEXT` 的全文——那是**第二落点，不会自动同步**，见下面「面向模型的文案」。

### 6. 不依赖 `isAgentLoopRequest()`

`dsh-llm` 自带的 `isAgentLoopRequest()` 标记集是**模块局部**的。profile 插件可能解析到另一份物理副本，于是"宿主认得的标记"在插件这边可能不存在。插件改为自己判定：只处理没有 `purpose` 的主 Agent Loop 请求，并用当前步骤的取消信号确认请求归属，因此标题生成、压缩等复用同一 `sessionId` 的辅助调用不会进入摘要状态。durable `assistant/message` 上那条检查只是对"未经过本插件 stream hook"的调用方提供的防御性回退。

### 7. 标签配对取最近邻，且首个完整配对权威

`inspectSummary` 在**同一个文本块内**找最近邻的开/闭标签配对：前面的孤立开标签不会抢走后续的完整配对（模型常见的手误），而一旦出现完整配对该步骤的记录就定了。标签只在 text 通道里找——reasoning/thinking 内容一律不计为可用文本，摘要在插件看来是"缺失"。这条规则的落点是 README 的流协议：模型必须在可见文本里输出字面标签。

### 8. 客户端半边有两条身份字面量，必须与宿主逐字一致

`NS = 'reasoning-summary'` 必须与 `src/index.ts` 的 `SETTINGS_NAMESPACE` 逐字相同（它既是宿主注册的设置 namespace，也是卡片被分派时的插槽 key）；`PLUGIN_ID = '@zhourenke/dsh-reasoning-summary'` 必须与 `package.json` 的包名相同。浏览器半边不能 `import` 宿主半边，所以这两个字符串只能各写一份——`test/client.test.mjs` 会把两种拼写都断言一次，防止它们悄悄分叉。

### 9. 客户端 `inject` 同时列 `remote` 与 `remote.session`

`['slots', 'settingsScope', 'locale', 'remote', 'remote.session']`。客户端 `inject` 是**硬门禁**：漏声明的服务在运行期访问会被直接拒绝（`service "X" is not declared by your plugin`），名字不存在则插件停在 parked 状态并在装载结果里报 `waitingFor`——这与 `package.json` 的 `dsh.client.inject` 写错名字时**静默跳过**完全不同。两个都列有官方先例：同构的 `dsh-client-ui-settings-plugins` 与 `dsh-client-ui-model-selection` 同样同时声明这两个名字。

`sessionFace()` 因此保留三条解析路径——`ctx.get('remote.session')`、`ctx.get('remote').session`、`ctx.remote.session`——按"容器查找优先、属性访问兜底"排序。三者都有测试覆盖，**不要当成死代码删除**。

### 10. 插槽注册用 generator 形式，effect 交还给 `ctx.effect`

注册写成 `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({…}, Card))`：`slots.inject` 在插槽的注册作用域里跑回调，官方卡片（Bash / AgentLoop / SubagentModelSelection / WebSearch）也都用这个形状，返回值就是 disposer。locale 字典同理走 `ctx.effect(() => locale.register(NS, { zh, en }), …)`，把 disposer 交给 fiber，卸载时自动回收。**凡是返回 disposer 的注册都要交还**，否则重载后会留下重复注册。

### 11. 配置 schema 用 `transform` 归一化，声明用公开注解保持可移植

`configSchema` 在 `z.object({ models })` 外套一层 `z.transform(…, true)`：旧版本写过的无关字段会在读取时被丢掉，而 schema 只保留 `models`（空列表是唯一的关闭状态）。导出的 `Config` 带一句 `as unknown as ReturnType<typeof z.any>`——schemastery 的推断类型会带上内部包类型，直接暴露会让声明文件在别的 pnpm 布局下不可移植。

### 12. `\u0000` 是路由键的分隔符，宿主与客户端各有一份

宿主 `routeKey(provider, model)` 与客户端 `keyOf({ provider, model })` 都用 `\u0000` 拼接：`provider` 与 `model` 都可能含 `/`、`-` 这类字符，用可打印分隔符会出现"两个不同的路由拼出同一个键"。两份实现必须保持一致，否则卡片勾选的路由与宿主匹配的路由会错位。

### 13. 输出被缓冲成"伪非流式"，这是换稳定性与准确性付出的代价

`llm/stream` 的每个 chunk 都先进 `state.deferred`，直到步骤结束才由 `finishState` 一次性 `yield` 出去。缓冲换来两件做不到就要出错的事：**标签配对要在整段文本上做最近邻判断**（边流边判会在标签跨 chunk 时误判），以及**界面流的过滤必须在判定完成之后**（否则漏写标签的模型会把内部进度直接喷到界面上）。代价是被选中路由的回复不再逐字流式，用户感知为"伪非流式"——README 因此把它写在开头，作为安装前的衡量项。

**不要为了"恢复流式输出"把缓冲拆掉**：先确认上面两个前提能同时满足，再谈改动。

**2026-09 追加：缓冲不再"永远等到 finish"。** 实测某个 Codex 系 Provider 组合会把工具调用写成 claude-code 文本语法（`to=... (commentary) json {}`），DSH 不执行，模型于是在同一次输出里反复"思考→写摘要→重写坏调用→再思考"，直到输出预算耗尽（单步 output 可达 1.4–2 万 token、耗时 4–7 分钟，Provider 侧没有第二次请求）。这类自旋步会在同一输出内产生多个完整 `<summary>` 标签却零工具调用。插件据此判定疑似空转（`SPIN_RELEASE_SUMMARIES = 2`，最近邻配对计数）：立即放行本步已缓冲文本（用户可实时看到错误并中断止损），把本轮标记 finalized（避免 finish 再次走 relay/continuation 路径），并向后续上下文注入插件自己的提示（`[No tool call received]`，**不是**模型的未执行摘要）。放行只发生在 `sawToolCall === false` 的步骤，带真实工具调用的步骤完全不受影响；TTL 兜底留作后续，视效果再定。

### 14. 自旋判据只用插件自己的契约，不抓模型的外部特征

第一版方案是检测可见文本里的 `to=functions.pwsh`、`(commentary)`、`json {}` 这类 claude-code 文本工具调用痕迹。它被否掉的原因是**判据的归属**：这些字符串由模型与 Provider 定义，不在插件控制范围内，换模型、换 Provider、换版本就可能变样或消失，而失效是**静默的**——不报错，只是再也匹配不上，插件从"能识别"退化成"从不识别"，没有任何信号提示。

最终判据是"同一次输出里出现两个完整、互不包含的 `<summary>` 标签，且没有任何工具调用"（`countCompleteSummaryPairs` + `SPIN_RELEASE_SUMMARIES`）：`<summary>` 是插件自己要求模型产出的协议信号，模型是谁、坏调用写成什么形式都不影响判据成立，契约在判据就在。**新增任何"识别异常"的判断时，先找插件自身契约里有没有语义等价的信号，没有再看宿主稳定 API 与事件，最后才考虑外部特征**；采用外部特征时必须写明它是针对哪个模型的临时判据。

### 15. `missing` 大多来自机械执行步；用户中断不会丢掉注入的提示

某个 Codex 系 Provider 上的实测（8 个 turn、364 个工具步）：`[Action summary: missing]` 共 110 步（30%），其中 73 步是"有 reasoning 但没写可见摘要"（模型把计划留在思考里），37 步是**纯工具调用步**（`blocks` 只有 `tool-call`，连 reasoning 都没有，典型是连续 `edit` 的机械执行）；纯工具调用步 100% 记为 missing，单个 64 步的 turn 里 missing 占 23 步（36%）。这类步没有新的目标或思路，要求它输出摘要没有信息价值，**因此不增加"连续 missing 升级提醒"之类的机制**；观察指标是 missing 占比与纯工具调用步占比，等模型或 Provider 变化后再复核。

**用户中断的语义与类型注释给人的印象相反。** `inject()` 的实现是 `send(input, "next-step", false)`（进 `next-step` 队列、不唤醒 driver），`cancel(cause, options)` 只在 `!options.keepInbox` 时才 `inbox.clear()`——**丢弃是不传选项时的默认值**，而用户中断路径显式传 `keepInbox: true`（出处：`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-api-session-controller`，见指南 §4.11）。因此空转放行注入的 `[No tool call received]` 在用户中断后**仍留在队列里**，用户的下一条消息会唤醒模型并在同一个 pre-step 把它送进上下文（紧跟那条消息）——用户只需随口说一句，不必自己复述细节。凡是准备写进 README 的"用户操作后果"，都必须有实测或实现级调用点作证，不能只凭 `.d.ts` 里 `may` 的措辞推断。

## 测试要点

- **`core.test.mjs`**：纯函数。`inspectSummary` 的 complete/partial/missing 三态、最近邻配对与孤立标签、`normalizeTextBlocks` 的 `forcedStatus` 分支、`routeKey` 的分隔符语义。
- **`runtime.test.mjs`**：用模拟 ctx 调 `apply`，这是唯一能覆盖事件注册路径的办法。重点是**时序**——relay 必须等所有根工具调用的 durable `tool/result` 提交后才进 inbox；`session/event` 在 `Session.append` 的发布边界内触发，所以改写 inbox 要放进 `queueMicrotask`，否则会撞上 append 自身。另有跨路由可见性、A/B/C/D 序列、设置禁用与重新启用、已准入步骤中途切换后仍跑完、同 session 标题/异信号辅助流隔离、工具结果去重、失败步骤隐藏文本但不建 relay、`prepared-call` 防御性回退。
- **`client.test.mjs`**：唯一**真正执行** `lib/client.js` 的测试。先注入 `window.__ModuleLoader__` 捕获注册定义，再用桩 `require` 调用工厂、用模拟 ctx 调 `apply`，最后真的挂载一次卡片元素。文件头把实测到的宿主契约写进注释与桩里（`settings.plugin.item` 是不向卡片传 props 的 keyed 插槽、`settingsScope.bind({ namespace })` 的返回面与快照状态、`status !== 'ready'` 时卡片不渲染）——**桩一旦与真实契约漂移，测试就从"发现缺陷"变成"掩盖缺陷"**（§4.3）。
- **跨插件契约**：用**真实的** `dsh-repeat-tool-reminder` 代码验证"注入的消息不会重置它的重复计数"（该守卫只注册两个 handler、不依赖其它服务，所以能用两行 `ctx.on` 装进同一进程），并配一条**反向对照**——同样大小的 pre-step 批次里换成 `source.kind === 'user'` 的消息时链确实会被清除。没有这条对照，主测试可能因为"清除分支从未执行"而通过。这也是 `@deepseek-ai/dsh-repeat-tool-reminder` 出现在 `devDependencies` 里的**唯一**原因：本包从不 import 它，只有测试加载它，请勿当成未使用的残留删除。
- **检查器必须先验红**：断言里凡是出现"用正则/转义去匹配常量"的写法，都要先拿一个必然含元字符的样本确认它真的会失败。本项目就抓到过一条：`new RegExp(TEXT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'))` 的字符类提前闭合，实测一个字符都不转义，只因为常量里唯一的元字符是 `.`（不转义也能以通配符匹配自己）才一直通过。现在改用 `includes`。

## 面向模型的文案（两处落点，互不同步）

下面四段文案决定模型看到什么，其中两段在 README 里有一份副本：

| 常量 | 定义处 | README 副本 | 谁读它 |
|---|---|---|---|
| `PROMPT` | `src/index.ts` | 无（README 只描述协议） | 系统提示的 `reasoning-summary:instruction` 段 |
| `MISSING_TEXT` | `src/index.ts`（导出） | 有，全文 | relay 的 `[Action summary: missing]` 附注 |
| `PARTIAL_TEXT` | `src/index.ts`（导出） | 有，全文 | relay 的 `[Action summary: partial]` 附注 |
| `REASONING_CONTINUATION_TEXT` | `src/index.ts` | 无 | reasoning-only continuation 的正文 |

**改任何一段都必须回头核对 README**，反之亦然：副本不会自动同步，而它恰恰是使用者（和检索到 README 的 Agent）据以判断"模型该输出什么"的唯一依据。文案本身也有纪律：只说**要求与后果**，不描述内部实现，且改文案后必须重跑 `pnpm test`（测试按字符串断言）。

## 发布纪律

- **`lib/` 的四个产物必须与 `src/` 同一次提交。** `dsh plugin add github:...` 只接收 git 跟踪的文件，本仓库不在安装时构建，所以产物不同步会让 GitHub 安装静默运行旧代码。只提交 `.js` 而漏掉 `lib/types/` 会造成「装得上但没有类型声明」的半发布状态。
- **不要添加 `prepare` 脚本。** git 托管的包会在安装时执行它，而 pnpm 默认拦截依赖的构建脚本，这会让 `dsh plugin add` 直接失败，直到用户手动在 profile 的 `pnpm-workspace.yaml` 中放行。
- **`files` 只列不会被自动包含的产物。** 当前为 `lib/index.js`、`lib/client.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`。`package.json` / `README*` / `LICEN[CS]E*` 以及 `main` 指向的文件无论如何都会装上，列了是空操作；而 `types` 与 `exports` 的目标**不在**自动包含集里，`.d.ts` 一旦漏出 `files` 就会被静默丢弃。`DEVELOPMENT.md` 同样不在自动包含集里（`README*` 不等于所有 `.md`），所以它不会进入安装载荷。
- 新增产物（第二入口、运行时读取的数据文件）时，必须同步放宽 `files`，并用 `pnpm pack --dry-run` 核对真实载荷。

## 运行时依赖（与 DSH 版本匹配）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.2` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-agent` | `^0.1.5-rc.1` | `Agent`、`agent/pre-step` 等事件、`steer()` |
| `@deepseek-ai/dsh-llm` | `^0.1.5-rc.1` | `llm/stream` 瀑布、`StreamChunk`、`createUserMessage` |
| `@deepseek-ai/dsh-settings` | `^0.1.5-rc.1` | 设置注册与 `Context` 类型增强 |
| `@deepseek-ai/dsh-system-prompt` | `^0.1.5-rc.1` | 提示段注册与 `system-prompt/assemble` |
| `@deepseek-ai/dsh-tools` | `^0.1.5-rc.1` | `tools/result` 事件 |
| `@deepseek-ai/schemastery` | `^3.18.2` | 配置校验，**唯一真实的 `dependencies`** |

`devDependencies` 里的宿主包**钉死到精确版本**（`4.0.2` / `0.1.5-rc.1`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。`@deepseek-ai/dsh-client-ui-primitives`（浏览器半边的 `IconChevronDownOutline14` 与 `Tag`）与 `@deepseek-ai/dsh-repeat-tool-reminder`（跨插件契约测试）同样只在 `devDependencies` 里。

三个 `import type {} from '@deepseek-ai/dsh-…'` 是**类型增强导入**，只在类型层存在：这些包把各自的服务与事件并进 Cordis 的 `Context`/`Events` 接口，不加载声明文件就没有 `ctx.settings`、`ctx.systemPrompt`、`ctx.tools` 与订阅事件名的类型。`import type {}` 在运行时被完全擦除，因此不会拉进宿主包的私有副本，也不会被 `noUnusedLocals` 报为未使用。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md` §8 重新核对事件名、宿主符号与 peer 范围。

## 许可证

MIT
