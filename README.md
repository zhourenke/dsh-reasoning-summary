[English](README.en.md) | **中文**

# @zhourenke/dsh-reasoning-summary

**让看不到自己思考的模型，看见自己的内心。**

DSH 默认会保留模型的思考过程并传进下一步循环，只有触发上下文压缩时才会丢。**闭源模型是例外**：它们的加密思考不会完整进入 DSH 上下文，也无法用 provider 的原生状态接续，于是每进入下一步，模型都要重新推测上一步做了什么——这份推测在下一步又会作废，白白消耗时间与 token。

本插件让被选中的路由在调用工具前用可见文本留下一句行动摘要，并把它写进会话历史，下一步及其之后每一步都能直接读到。它只影响被选中的路由，不改动其它模型，也不隐藏任何历史。

> ⚠️ **安装前请衡量：** 启用后，被选中的模型会从流式输出变为**伪非流式**——回复内容由插件缓存后再一次性输出。其它模型不受影响。

## 它解决什么问题

- **补上加密思考的缺口**：闭源 provider 的加密推理不会进入 DSH 上下文，插件把"上一步做了什么"变成模型读得到的普通历史。
- **省下重复推导的开销**：模型不必每一步都重新推测自己的上一步。
- **换模型也不断线**：摘要作为普通会话历史传递，中途切换模型同样读得到。
- **只对你选中的路由生效**：`provider` + `model` 精确匹配。
- **随时可卸**：作为 profile 层插入，不修改 DSH 本体；清空列表即完全关闭。

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

安装后需要重启 DSH 并刷新页面，随后可以在 **设置 → 插件 → 推理摘要** 看到本插件的配置选项。

卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-reasoning-summary
```

## 快速上手

插件默认**完全关闭**（`models` 为空）。

在 **设置 → 插件 → 推理摘要** 里勾选要触发的路由并保存即可，卡片读的是 DSH 实时的模型目录。

也可以直接编辑 `~/.dsh/settings.yaml`：

```yaml
reasoning-summary:
  models:
    - provider: <provider-id>
      model: <model-id>
```

`provider` 与 `model` 必须与 DSH 里实际的 id 逐字一致，两个都要匹配；写错的条目不会报错，只是不生效（在设置卡片里勾选就不会写错）。

**保存即生效，无需重启无需刷新网页。**

确认它在工作：被选中的模型在每步最后一个工具调用之后，界面上会弹出 **注入上下文 · reasoning-summary** 提示。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|:---:|---|
| `models` | array | `[]` | 触发路由列表，每项为 `{ provider, model }`。**空列表是唯一的关闭状态**，也是默认值。 |

- `provider` 与 `model` 必须**同时**匹配；同一个 model 挂在另一个 provider 下不会启用那条路由。
- 旧版本留下的无关字段会在读取时被归一化丢弃，不会导致加载失败。
- 设置卡片只改本插件的 namespace，不影响 DSH 通用的模型设置；模型目录里当前不可用的已启用条目会保留在「已保存但当前不可用」分组中，等你手动取消勾选。

## 插件要求模型做什么

插件会在选中且已预热的路由准入当前步骤时，通过 `agent/pre-step` 返回值把这段要求作为一条普通上下文消息追加到 `decision.messages` 末尾：**调用工具之前，先用可见文本写一句行动摘要**，格式是一个字面标签：

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

摘要之后必须由 DSH 接收一个结构化的 DSH tool-call block 才会执行工具；把工具调用写成普通可见文本不会执行。摘要要写明相关的用户请求、涉及的文件 / 函数 / 命令、已经确认的观察或结果，以及紧接着要做的动作或决定；"继续分析""检查实现"这类无法据此行动的话没有意义。

### 普通上下文消息与复用

协议提示不再注册 `systemPrompt.context()`，也不再由 `system-prompt/assemble` 改写 `contexts`，因此不会产生 `source.form: 'snapshot'` 的运行时快照或重复的系统提示改写。它只在每个 turn 的首个选中且已预热步骤中追加到 `decision.messages`；同一 turn 后续的工具步骤和 continuation 不会再次追加。消息没有 `form`，属于普通 plugin user-message；宿主 Agent Loop 会把返回的 `decision.messages` 按正常 `user/message` 写入 durable session，但插件不会调用 `agent.inject()`，也不会把它写成 relay 或 next-step inbox 消息。当前步骤已有的用户消息和 durable relay 保持原顺序，协议提示位于它们之后。

这样既避免每一步重复累积相同提示，也让每个新 turn 获得一次新的协议边界。Provider 是否命中自己的前缀缓存仍取决于 Provider 的缓存键和请求投影，不能把这种消息通道表述成绝对的零成本缓存保证。路由未选中或仍在预热时不追加协议消息；模型选择和设置变化只影响下一次准入。

插件会缓存被选中路由中仍需摘要解析或工具文本过滤的输出。处于缓冲区安全前缀的完整 reasoning block 会在匹配的 `block-end` 到达时立即按 Provider 原始顺序输出，供下游流处理插件（例如 reasoning-merge）实时消费；普通文本、工具帧和 usage 仍会等待摘要判定或 `finish`。因此该路由是**部分伪非流式**：连续的 reasoning block 可以流式显示，但任何位于未决文本之后的内容不能越过该文本，以免重排输出或泄漏工具步骤普通文本。

判定只看**可见文本**：只写在推理 / 思考内容里的摘要等同没写。摘要还必须出现在第一个工具调用之前。工具步骤的这些文本（**包括摘要标签本身**）都不会显示在界面上。
模型漏写时，下一步会带上这段提醒：

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.
```

流在闭合标签之前就结束时（非失败），已收到的内容按不完整处理：

```text
Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

当同一次输出出现两个完整的 `<summary>` 标签却没有工具调用时，插件会判定疑似自旋：立即放行当前输出、向下一步排队 `[No tool call received]`，并让该 Session 进入自旋抑制。抑制期间已勾选路由的后续步骤都会透明预热，不注入本插件提示，也不解析或隐藏流；只有后续没有再次自旋、且完整成功的结构化工具步骤到达 `step/end` 后，才会解除抑制并在下一步恢复提示。


```text
[No tool call received]
DSH executes tools only when the assistant emits structured DSH tool-call blocks. Text that imitates a tool invocation is ordinary assistant text and is not executed.
Use the appropriate structured DSH tool-call block(s) now, or stop writing summaries and provide the complete user-facing answer.
```

这条提示排在下一步的 inbox 里：轮次自然结束时会随下一步自动到达模型，无需你干预；你**手动终止**回答也不会让它丢失——DSH 的用户中断会保留待领取的队列，你随后发出的下一条消息会唤醒模型，提示在同一个步骤边界紧跟那条消息进入上下文。所以中断空转后只需随口说一句（例如「注意工具调用格式」），插件自带的准确提示就会自动送达，不必由你复述细节。

最终的普通答复不要求摘要，也不会产生记录，其中的字面 `<summary>…</summary>` 会原样保留。

## 摘要去了哪里

每个工具步骤的摘要都以普通 `user/message` 写入或排队，模型看到的是紧凑形式：

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

只有不完整或缺失的状态才在标题里标 `partial` 或 `missing`。工具循环继续时，摘要会在所有根工具调用的 `tool/result` 提交后进入 Agent inbox；工具调用直接结束 turn 时，摘要直接追加到 durable session。两种形式都留在正常会话历史里，任何后续 provider / model 都读得到。

模型只输出推理、既没有工具调用也没有可见答复时，插件会在**同一个 turn** 内请求继续，通知标题为 `[Continue after reasoning-only response]`，最多 3 次。

## 预热与复用窗口

插件的预热状态只存在于进程内的 `WeakMap`，按 Session 隔离，不会追加插件自定义的 Session 事件或字段。冷启动、模型切换，或上一次工具步骤已超过 30 分钟时，选中路由的下一步是透明预热：不注入本插件提示，也不解析、隐藏、relay 或 continuation 当前流。

只有当这个步骤真正进入、产生结构化工具调用、助手消息正常完成、工具结果已经结算并到达 `step/end` 后，当前路由才会记录一条成功工具证据；这条证据不要求步骤当时已勾选，未勾选只影响当前步骤是否处理插件输出，不影响它作为预热证据。之后同一 Provider/Model 路由在距最近一次成功工具步骤严格少于 30 分钟时可以直接接续；正好 30 分钟、时钟回拨、没有成功工具步骤、失败或中断步骤都会重新预热。

每次切换 Provider/Model 都会强制重新预热，即使目标路由以前已经准备好，或切换前后都在启用列表中。首次直接回答不会让插件提前生效；例如第一轮没有工具调用，第二轮第一步出现工具调用时该步仍透明放行，第二轮后续步骤才可获得提示。

## 什么时候生效

每个步骤在**准入时**采样一次当前路由与设置：

| 步骤准入状态 | 当前步骤的新行为 | 已有摘要历史 |
|---|---|---|
| 精确路由已启用且已预热 | 注入提示；处理当前流；可产生 relay 或 continuation | 完整可见 |
| 精确路由已启用但正在预热 | 普通流原样通过；不解析、不隐藏、不产生 relay / continuation | 完整可见 |
| 精确路由未启用 | 普通流原样通过；不产生新的 relay / continuation | 完整可见 |

已准入的步骤不受中途变更影响：模型切换或设置变更只作用于下一个步骤，当前步骤仍会写完摘要并持久化。因此以下行为都是有意设计的：

- A 启用 → B 禁用 → A 启用：B 读到 A 的旧摘要但不产生新摘要，A 恢复后继续产生。
- 关掉设置再打开：关闭期间不产生摘要，旧摘要不消失。
- A → B → C → D（A/C 启用、B/D 禁用）：四个模型都读得到完整摘要历史，只有 A/C 的新工具步骤产生记录。
- 从禁用的 B 开始且历史为空：B 不产生摘要；切到启用的 A 后从空历史开始生成第一条。

## 给 Agent 的要点

- 本插件不提供任何工具，但会**改变被选中路由该输出什么**：调用工具前需要给出可见的 `<summary>…</summary>`，只写在推理 / 思考内容里不算数。
- 它不改变会话历史的可见范围，所有模型看到的历史是一致的。
- 摘要具体到文件 / 命令 / 观察结果与下一步动作。
- `[Action summary: missing]` / `[Action summary: partial]` 表示上一条摘要没写全；`[Continue after reasoning-only response]` 表示上一轮只有推理、没有动作也没有答复。
- 判断插件是否生效：工具步骤后界面上出现 **注入上下文 · reasoning-summary** 提示。

## 它管不到什么

- **不屏蔽推理内容**：`reasoning_content` / thinking 照常传递，也不删除历史里的 `thinking`。
- **不做工具门控或权限策略**：哪个工具能调用、能调用几次，不由本插件决定。
- **不隔离会话历史**：`models` 只决定新步骤是否产生摘要，不改变任何模型能看到的历史范围。
- **不改写历史里已有的摘要**：旧会话中的摘要按原样继续传递。

## 已知限制（实测确认）

- **摘要只在可见文本里找**：写在推理 / 思考内容里的摘要视为缺失。
- **一个步骤只认第一个完整标签**：同一文本块内取最近邻的完整配对；写了多个摘要时只有第一个作数。
- **continuation 有次数上限**：同一 turn 内最多 3 次。
- **较早的摘要会随压缩被合并**：触发上下文压缩时，较早的摘要并入检查点，最近的仍逐字保留，就像原生思考过程那样。
- **疑似空转的步骤会被放行**：同一输出出现两个完整 `<summary>` 标签却没有任何工具调用时，插件放行本步文本并注入自己的提示（而不是隐藏），便于及时中断；带真实工具调用的步骤不受影响。
- **旧版本的遮蔽不可逆**：早期版本用 replacement 遮蔽过结束 turn 的摘要，升级不会自动恢复，受影响的旧会话需要单独的 raw-log 重建或迁移。

## 兼容性

在 **DSH v0.1.5-rc.1**（2026-09）下测试通过。

## 许可证

MIT
