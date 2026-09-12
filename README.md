[English](README.en.md) | **中文**

# @zhourenke/dsh-reasoning-summary

**让指定模型在每次调用工具前先交代一句"要做什么、凭什么"：这条摘要写进对话历史，之后换任何模型都看得到。**

DSH 的模型在工具循环里常常一口气连调好几个工具，而"为什么调、看到了什么、下一步干什么"只存在于当前这一步的上下文里——换了模型、或者隔了几轮回看，这些推理就没了。本插件要求被选中的路由在工具调用**之前**输出一条行动摘要，规范化后写进 durable session history，于是后续每一个 provider / model 都能读到完整的行动轨迹。**它只改变被选中路由的新步骤，不动其它模型，也不隐藏已有历史。** 装好即用，无需改动 DSH 源码。

## 它解决什么问题

- **换模型不再丢上下文**：摘要作为普通会话历史传递，中途切到别的模型也能接上前面在做什么。
- **工具循环留下可读的痕迹**：每个工具步骤一条 `[Action summary]`，而不是只剩一串工具调用与结果。
- **只对指定路由生效**：`provider` + `model` 精确匹配，没被选中的模型完全按原来的方式工作。
- **历史不会被藏起来**：摘要用普通追加写入，不安装路由过滤器、不遮蔽任何消息，所有模型看到的 durable history 是一样的。
- **随时可卸**：作为 profile 层插入，不修改 DSH 本体；不想要了就从设置里清空列表。

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

**安装后必须重启 DSH**——bundle 集合是进程启动时的快照，重启前新插件不会被加载，刷新页面无效。本插件是双半边插件，重启后还要**刷新页面**，设置里的卡片才会出现。

卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-reasoning-summary
```

## 快速上手

插件默认**完全关闭**（`models` 为空）：不注入提示、不改动任何流、不产生摘要。要启用，打开 **设置 → 插件 → 推理摘要**，在模型列表里勾选要触发的路由，然后保存。

等价的直接写法是编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: reasoning-summary
  name: '@zhourenke/dsh-reasoning-summary'
  config:
    models:
      - provider: cotton-codex
        model: gpt-5.6-luna
```

`id` 必须是 `reasoning-summary`：bundle 已经插入了这个条目，你写的是**同 id 的配置覆盖**。**不要再包一层 `- insert:`**——`insert` 是"无条件追加一行"的动作，写在这里会插入**第二个实例**，摘要逻辑随之跑两遍。

**改配置保存即生效，不需要重启。**（设置卡片保存后立即作用于**后续步骤**；已经在进行中的步骤会按它准入时的配置跑完。）只有**安装或卸载插件本身**才需要重启——这两件事经常被混为一谈，结论正好相反。

确认它真的在工作：让被选中的模型调用一次工具，然后看两条线索——模型必须在可见文本里输出 `<summary>…</summary>`，下一步会收到一条 `[Action summary]` 记录。如果模型忘了输出，你会看到 `[Action summary: missing]`，那就是插件在提醒它。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|:---:|---|
| `models` | array | `[]` | 触发路由列表，每项为 `{ provider, model }`。**空列表是唯一的关闭状态**，也是默认值。 |

取值规则：

- `provider` 与 `model` 必须**同时**匹配；同一个 model 挂在另一个 provider 下不会启用该路由。
- 一个条目的 provider 或 model 写错不会报错，只是那条规则永不生效——它们必须与 DSH 里实际的 provider id、model id 逐字一致（设置卡片里的列表可以直接勾选，不必手写）。
- schema 只保留 `models`：旧版本留下的无关字段会在读取时被归一化丢弃，不会导致加载失败。
- 设置卡片只改本插件的 namespace，不会动 DSH 通用的模型设置；模型目录里当前不可用、但已被启用的条目会**保留显示**在末尾的「已保存但当前不可用」分组里，等你手动取消勾选。

## 模型要输出什么

被选中的模型在准备调用工具时，必须把摘要作为**可见 assistant 文本**输出——也就是 text 通道，而不是只写在推理/思考内容里；只出现在 reasoning / thinking 中的摘要在插件看来等于没写。标签必须是字面文本，并且出现在第一个工具调用之前：

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

摘要是**下一步骤的执行记录**，不是泛泛的状态播报：写明相关的用户请求、文件 / 函数 / 命令、已经确认的观察或结果，以及紧接着要做的动作或决定。不要写成"继续分析""检查实现""取得进展"这类无法据此行动的话。

工具步骤不应该在标签外输出普通文案。若模型漏了协议，插件会在结束边界把该步骤的全部 text block 从界面流里移除（工具块顺序不变），这样界面不会泄露一段没有上下文的内部进度；如果 provider 以 `error` / `aborted` 结束或流抛异常，已出现工具调用的失败尝试同样隐藏缓冲文本，但**不会**生成 relay——失败的进度不会被误当成完成的执行记录。

一个步骤里没有完整标签时，插件不会把普通文本猜成摘要：

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.
```

非失败流在闭合标签之前结束时，已收到内容按不完整处理：

```text
Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

最终的普通答复**不要求**摘要，也不会创建 relay；无工具的答复完全跳过摘要解析与标签移除，即使里面出现字面 `<summary>…</summary>` 也会原样保留。

## 摘要长什么样、去哪里

每个工具步骤的摘要都以普通 `user/message` 写入或排队，模型看到的是紧凑形式：

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

只有不完整或缺失的状态才在标题里标 `partial` 或 `missing`。工具循环继续时，插件等所有根工具调用的 durable `tool/result` 提交之后，才把 relay 排进 Agent inbox；工具调用直接结束 turn 时，relay 也直接追加到 durable session。两种形式都留在正常会话历史里，任何后续 provider / model 都能读到，本插件不隐藏、不改写已有历史。

模型只输出推理、既没有工具调用也没有可见答复时，插件会用公开的 `agent.steer()` 在**同一个 turn** 内请求继续，通知标题是 `[Continue after reasoning-only response]`，最多 3 次——防止一个反复只输出推理的模型把 turn 拖住。

## 步骤准入：什么时候生效

每个步骤在**准入时**采样一次当前路由与设置：

| 步骤准入状态 | 当前步骤的新行为 | 已有摘要历史 |
|---|---|---|
| 精确路由已启用 | 注入提示；处理当前流；可创建 relay 或 reasoning-only continuation | 完整可见 |
| 精确路由未启用 | 普通流原样通过；不注入提示；不创建新的 relay / continuation | 完整可见 |

已准入的启用步骤拥有自己的流状态：模型切换或设置开关发生在流进行期间时，**不会**取消、清空或改写该步骤，它仍会写完摘要并持久化，变化只影响下一个步骤。因此下面这些行为都是有意设计的：

- A 启用 → B 禁用 → A 启用：B 能读到 A 的旧摘要但不产生新摘要，A 恢复后继续产生。
- 关掉设置再打开：关闭区间不产生摘要，旧摘要不消失，重新启用后从下一步骤恢复。
- A → B → C → D（A/C 启用、B/D 禁用）：四个模型都能读到完整的已有摘要历史，只有 A/C 的新工具步骤产生 relay。
- 从禁用的 B 开始且历史为空：B 不产生摘要；之后切到启用的 A，从空历史开始生成第一条。

## 给 Agent 的要点

- 本插件**不提供任何工具**，但它会**改变你该输出什么**：被选中的路由在调用工具前必须输出字面 `<summary>…</summary>`，写在 reasoning / thinking 里不算数。
- 摘要是给下一步看的执行记录，要具体到文件 / 命令 / 观察结果与下一步动作，别写"继续分析"这类空话。
- 工具步骤不要在标签外输出普通文案；多写了也会被隐藏，界面看不到，等于白写。
- 看到 `[Action summary: missing]` 或 `[Action summary: partial]` 是在提醒你上一条没写全：下一次调用工具前补上完整的字面标签。
- 看到 `[Continue after reasoning-only response]` 说明上一轮只输出了推理：请直接调用合适的工具或给出完整答复。
- 判断插件是否生效：**设置 → 插件**里能看到「推理摘要」卡片；被选中的路由会产生上面这些记录。

## 它管不到什么

- **不屏蔽推理内容**：`reasoning_content` / thinking 照常传递，本插件不选择屏蔽模型，也不删除历史里的 `thinking`。
- **不做工具门控或权限策略**：哪个工具能调用、调用几次，不由本插件决定。
- **不隔离会话历史**：`models` 只决定"新步骤是否产生摘要"，不改变任何模型能看到的历史范围。
- **不改写历史里的旧 relay**：已有会话中的摘要按原样继续传递。

## 已知限制（实测确认）

- **摘要只在 text 通道里找**：写在 reasoning / thinking 里的摘要在插件看来是缺失的，这是有意为之（避免把模型的思考当成行动总结）。
- **一个步骤只认第一个完整标签**：同一文本块内取最近邻的完整配对，前面的孤立开标签不会抢走后续配对；但一个步骤里写多个摘要时，只有第一个作数。
- **continuation 有次数上限**：reasoning-only 的续写请求同一 turn 内最多 3 次，超过后该 turn 结束，不会无限续下去。
- **旧版本的遮蔽不可逆**：早期版本用 replacement 遮蔽过结束 turn 的 relay，那种遮蔽不会因为升级而自动恢复——受影响的旧会话需要单独的 raw-log 重建或迁移。当前版本不再使用 replacement。
- **需要重启才能装/卸**：bundle 集合在进程启动时确定，`dsh plugin add/remove` 之后必须重启；改配置则不需要。

## 兼容性

在 **DSH v0.1.5-rc.1**（2026-09）下测试通过。本插件是双半边插件：宿主半边改完要重启 DSH，浏览器半边的改动还要刷新页面。

## 许可证

MIT
