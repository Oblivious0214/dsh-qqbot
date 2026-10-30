# dsh-qqbot

在 DeepSeek Harness（DSH）里做 QQ 聊天式角色扮演。插件注册一个独立的 `qqbot` Agent 预设，所有提示词、界面和压缩都只在这个预设的会话里生效；关闭或卸载插件后，DSH 和没装过一样。

当前是 0.1.0 开发版：有预设、提示词槽位、入口、提示词查看器、角色库、`/role` 命令、角色和破限预设编辑器、分段回复、表情规则和中文摘要模板。QQ 界面和语音还在迁移。

## 使用

- 侧边栏底部、左下角"更多"上面的 **新建 QQ 会话** 按钮（收起侧边栏时只显示图标）；或设置窗口"QQ Bot"页顶部的同名按钮；或在新会话界面的预设选择里选 **QQ Bot**。
- 插件不会把 `qqbot` 设为默认预设。如果你自己在 DSH 设置里把默认改成了 QQ Bot，关闭插件前请改回：设置 → Agent 预设 → 标准模式。否则关闭插件后新建会话会报 `Unknown agent preset`。
- 插件关闭期间，QQ Bot 的旧会话无法打开；重新启用后可以恢复。

### 角色

角色卡放在 `~/.dsh/qqbot/roles/`（设了 `DSH_HOME` 时在 `$DSH_HOME/qqbot/roles/`），每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`：

```md
---
id: alice
name: 爱丽丝
description: 同居室友
---

角色设定、性格、说话方式、示例对话……
```

选角色不用打命令：

- 新会话页：agent 模式选了 **QQ Bot** 以后，这一行右边出现角色菜单。选好再发第一条消息，这个会话从第一轮起就用这个角色，不再取新会话默认角色。也可以选"不用角色"。
- 会话开始后：输入栏左侧（联动按钮左边）显示当前角色，点开可以换人，下一条消息起生效。之前的消息和头像不变。
- 菜单底部的"管理角色…"打开角色编辑器。

两个菜单只在 QQ Bot 会话里出现。也可以用 `/role` 命令（只在 QQ Bot 会话里有）：

| 命令 | 作用 |
| --- | --- |
| `/role` | 当前角色、破限预设、新会话默认角色和角色列表 |
| `/role <id>` | 这个会话换成该角色，下一条消息起生效 |
| `/role none` | 这个会话不用角色 |
| `/role default <id>` / `/role default none` | 设置或取消新 QQ 会话的默认角色，已有会话不变 |

改了角色卡文件后，打开一次角色菜单或执行一次 `/role` 就会重新读取。没在新会话页选过角色的会话，角色在第一条消息时按新会话默认角色定下来，记在 `qqbot/sessions.json`，重启后保留。

### 分段回复

QQ Bot 会话里，模型用一个 `[qq]` 块把回复分成几段，界面按每段的 `durationMs` 依次显示，像对方一条条发消息。格式见 `src/vendor/dialogue-timing/protocol.js` 的 `SEGMENT_PROMPT`。

- 只有本页打开后生成的回复才逐段出现；历史消息直接全部显示。系统设置了"减少动态效果"时也直接全部显示。
- 生成过程中第一段一写完就出现，之后每段按间隔出现；到点了下一段还没生成出来，就等它生成出来再显示。切到别的会话时计时照常走。
- 逐段显示途中你发了新消息，没出现的段落就不再出现。这只记在页面内存里，刷新后完整显示。
- 中途停止生成时，已经写完的段落照常显示。
- `[qq]` 块格式不对时显示"分段回复格式无效，请让 AI 重试"。没有 `[qq]` 块的回复原样显示。
- 标准会话不处理 `[qq]` 块。

### 表情

装了 [dsh-meme](https://github.com/yyh-001/dsh-meme) 时，QQ Bot 会话的系统提示词里有一段表情规则：用 `send_meme` 找图、一次最多一张，以及当前角色的表情频率。dsh-meme 自己的"斗图规则"不进 QQ Bot 会话，发送方式（Web 标记、纯文字模式等）仍按 dsh-meme 的设置和工具说明。没装或关掉 dsh-meme 时这段不出现。

表情频率写在角色卡 frontmatter 里，也可以在编辑器里选：

```md
memeFrequency: low   # low 低 / medium 适中 / high 高 / off 不主动发；不写时为适中
```

### 长对话压缩

QQ Bot 会话用 DSH 原生的 compaction-basic 压缩：阈值、保留最近多少原文、自动压缩和 `/compact` 都和标准会话一样。只有摘要模板不同，改成中文聊天存档，栏目是人物与称呼、关系进展、经过、当前场景、约定与待办、用户偏好，没有内容的栏目整栏省略。标准会话仍用 DSH 的英文编程模板。

实现在 `src/compaction.ts`：继承 `BasicCompactionEngine`，只覆盖它注明的唯一子类钩子 `summarize()`，挂在 qqbot 预设自己的隔离组里。摘要前后的框定语（"This is an automatically generated checkpoint…"）由 compaction-basic 写入，没有换。

### QQ 界面

只在 QQ Bot 会话的聊天区生效，标准会话、侧边栏和弹窗保持 DSH 原样。在编辑器的"界面"页设置，保存后立即生效：

- 色板：经典蓝、鲜艳、简洁、绿色、黑色，各有浅色和深色两态，跟随 DSH 的主题。
- 气泡尾巴、助手头像、聊天区最大宽度、沉浸模式（隐藏思考和工具过程）。
- 聊天背景：一张图片，可选铺满、完整显示或拉伸。选图后在裁剪弹窗里取景，比例可选当前对话比例、16:9、4:3、9:16 或原图比例，保存时缩到最长边 1920 像素。
- 段间隔：[qq] 块里没写 `durationMs` 的段，按"随机区间"或"按字数（对数）"计算间隔。
- 角色头像：在角色页上传，选图后在裁剪弹窗里拖动取景、缩放，裁成正方形、缩到 256 像素。没有头像时显示角色名首字。

设置存在 `qqbot/ui.json`，图片存在 `qqbot/images/`（头像在 `avatars/<角色 id>.<扩展名>`）。删除角色时头像一起移到 `roles-trash/`。这些设置不进提示词，不影响前缀缓存。

每条回复显示当时那个角色的头像：换人后，之前的消息不变。每轮用的角色记在 `qqbot/sessions.json` 的 `turns` 里，只在换人时追加一条，不进提示词。角色改名后旧消息跟着显示新名字；删掉的角色在旧消息上不显示头像。没有选角色的会话（没选过角色，也没设新会话默认角色）不显示头像。

### 角色与破限预设编辑器

左下角"更多" → 设置 → **QQ Bot**；或在提示词查看器里点角色、破限预设段落旁的"编辑"（弹窗，直接定位到这一段）。两处是同一个编辑器。在设置窗口里，切换标签和条目前会提醒保存，但直接关掉设置窗口时不提醒，没保存的改动会丢。

- 角色：新建、修改名称/简介/设定/表情频率、删除、设为新会话默认、单独选破限预设。修改只换这几个字段，角色文件里的语音等其他字段原样保留。删除的角色移到 `qqbot/roles-trash/`，放回 `roles/` 就恢复。
- 破限预设：一份预设有开头、中间、结尾三段，分别放在系统提示词最前、角色设定之后、最后。可以新建、复制、修改、删除（至少留一份）、设为默认。没有单独选择的角色和无角色会话用默认预设。
- 保存后下一条消息起生效。改动会让用到它的会话下一轮的前缀缓存从改动处开始失效，平时不要频繁改。
- id 保存后不能改，会话绑定和预设选择都按 id 记录。

破限预设存在 `qqbot/presets.json`；没有这个文件时用内置默认预设（"所有角色均为成年人。"），第一次修改时才写盘。编辑接口走 DSH 自己的认证，只有 owner 能读写。

### 提示词查看器

QQ Bot 会话标题栏右侧的按钮，打开后只读显示这个会话发给模型的内容：

- 系统提示词的每一段：名称、order、来源插件、字数、在前缀里的位置。可以按段落或按来源分组。
- 和上一轮实际发出的系统提示词对比。有变化时标出从哪个字符开始不同，也就是下一轮前缀缓存从哪里失效。DSH 重启后要先发一条消息才有对比。
- runtime context（工作目录、各插件登记的运行时状态）和上一次请求带的工具。

查看器只读；角色和破限预设的段落旁有"编辑"，跳到编辑器。外部插件的内容到插件设置里改。接口走 DSH 自己的认证，局域网或远程访问的非 owner 读不到。会话要先打开或发过消息（agent 已加载）才能查看。

## 给其他插件：登记接口

host 层服务 `ctx.qqbot` 只做登记，内容只出现在 qqbot 会话里。用可选依赖接入，没装 dsh-qqbot 时什么也不注册：

```js
ctx.inject(['qqbot'], (child) => {
  // 规则：在提示词里的段名为 qqbot:ext:toy。文本应尽量稳定，每次变化都会让后面的前缀缓存失效。
  child.effect(() => child.qqbot.extension({ name: 'toy', text: session => '...' }))
  // 运行时状态：进入 qqbot:runtime context，不影响系统提示词前缀。
  child.effect(() => child.qqbot.runtime('toy', session => 'device=disconnected'))
})
```

- `name` 只能用小写字母、数字和连字符。
- 登记时会自动记下你的插件包名，提示词查看器里显示为这段内容的来源。
- `text` 可以是字符串，也可以是 `(session) => string`。返回空串表示该会话里不出现这一段。
- 外部条目统一排在角色和格式规则之后、破限预设结尾之前，同位置按名称排序。顺序表在 `src/order.ts`，外部插件不指定数字。
- qqbot 会话的系统提示词只由 dsh-qqbot 组装（一个 complete section）。直接调用 `ctx.systemPrompt.section` 注册的全局段落不会出现在 qqbot 会话里，DSH 自带段落也一样；工具不受影响。

### 浏览器端：分段显示时钟

浏览器端服务 `ctx.qqbotSegments` 让其他插件跟着 `[qq]` 分段的显示走，例如设备在每段出现时动作。只有 qqbot 会话里本页实时生成的回复会触发；历史消息和标准会话不触发。

```js
ctx.inject(['qqbotSegments'], (child) => {
  child.qqbotSegments.register({
    // 第 index 段显示后停多久（毫秒）；返回 undefined 时用 qqbot 自己的间隔。结果限制在 0–120000。
    durations: (session, reply, stages, index) => undefined,
    // 第 index 段刚显示。holdMs 是到下一段的预定间隔，回复已完整且这是最后一段时为 undefined。
    revealed: (session, reply, index, stage, holdMs) => {},
    // 这条回复不会再有新段落：complete / interrupted（用户发了新消息）/ failed / closed。
    ended: (session, reply, reason) => {},
  })
  const resume = child.qqbotSegments.pause(sessionId) // 文字停在当前段，resume() 后接着走剩余时间
})
```

- `reply` 是 `"<turn>:<step>"`，同一条回复在流式和完成后不变。`stage` 原样来自 `[qq]` 块，含 `motion`、`cycles` 等扩展字段。
- 每条实时回复：若干次 `revealed`，最后恰好一次 `ended`。流式时下一段可能晚于 `holdMs` 才出现；回复变完整时如果最后一段早已显示，会补一次 `holdMs` 为 `undefined` 的 `revealed`。
- 登记和暂停都随调用方插件停用自动撤销。回调抛出的错误只记日志，不影响文字显示。
- 类型见 `src/client/reply-clock.ts` 和 `src/client/segments-service.ts`；请按结构自己声明，不要运行时引用本插件的代码。

## 开发

需要相邻的 DSH 源码检出（`../../qqbot/src/deepseek-harness`，`0.2.1-rc.3`），开发依赖通过 `link:` 指向它。`@deepseek-ai/cordis`、`@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-llm` 是 peer 依赖，不打进 `lib/`，运行时用宿主的同一份。

```sh
pnpm install
pnpm run build   # 类型检查 + 构建 lib/
pnpm test
```

## 致谢

dsh-qqbot 建立在这些项目之上，感谢各位作者：

- [lispking/dsh-qq-skin](https://github.com/lispking/dsh-qq-skin)：QQ 聊天界面。本插件的分段显示（计时和打断），以及之后的界面、头像背景和语音条外观由它迁移而来。
- [yupaoa/dsh-persona-switcher](https://github.com/yupaoa/dsh-persona-switcher)：人设切换与吉祥物立绘。本插件的角色库、`/role` 命令和会话绑定由它迁移而来。
- [flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern)：独立 Agent 预设和隔离组压缩的写法参考了它。只借鉴了思路，没有复制代码。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主，以及预设、提示词和压缩的原生机制。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)：对话分段的行为规则（阈值、间隔公式）参考了它，没有复制代码。

## 许可

MIT，见 [LICENSE](LICENSE)。迁移代码的原版权声明和来源文件记录在 [NOTICE](NOTICE)。
