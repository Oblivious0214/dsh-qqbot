# dsh-qqbot

在 DeepSeek Harness（DSH）里做 QQ 聊天式角色扮演。插件注册一个独立的 `qqbot` Agent 预设，所有提示词、界面和压缩都只在这个预设的会话里生效；关闭或卸载插件后，DSH 和没装过一样。

当前是 0.1.0 开发版：有预设、提示词槽位、入口、提示词查看器、角色库和 `/role` 命令。QQ 界面、破限预设编辑器、分段、表情和语音规则还在迁移。

## 使用

- 侧边栏"更多"菜单 → **新建 QQ 会话**；或在新会话界面的预设选择里选 **QQ Bot**。
- 插件不会把 `qqbot` 设为默认预设。如果你自己在 DSH 设置里把默认改成了 QQ Bot，关闭插件前请改回：设置 → Agent 预设 → 标准模式。否则关闭插件后新建会话会报 `Unknown agent preset`。
- 插件关闭期间，QQ Bot 的旧会话无法打开；重新启用后可以恢复。

### 角色

角色卡放在 `~/.dsh/qqbot/roles/`（设了 `DSH_HOME` 时在 `$DSH_HOME/qqbot/roles/`），每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。格式和 dsh-persona-switcher 相同：

```md
---
id: alice
name: 爱丽丝
description: 同居室友
---

角色设定、性格、说话方式、示例对话……
```

首次启动时，插件把 `~/.dsh/roles/`（dsh-persona-switcher 的角色库）里的角色复制过来，旧文件不动。只导入一次，之后在 qqbot 里删掉的角色不会被带回来。

在 QQ Bot 会话里用 `/role` 管理角色（只在 QQ Bot 会话里有这个命令）：

| 命令 | 作用 |
| --- | --- |
| `/role` | 当前角色、破限预设、新会话默认角色和角色列表 |
| `/role <id>` | 这个会话换成该角色，下一条消息起生效 |
| `/role none` | 这个会话不用角色 |
| `/role default <id>` / `/role default none` | 设置或取消新 QQ 会话的默认角色，已有会话不变 |

改了角色卡文件后，执行一次 `/role` 就会重新读取。会话的角色在第一条消息时定下来，记在 `qqbot/sessions.json`，重启后保留。

破限预设存在 `qqbot/presets.json`，可以按角色选择不同的预设。编辑界面还没做；没有这个文件时用内置默认预设（"所有角色均为成年人。"）。

### 提示词查看器

QQ Bot 会话标题栏右侧的按钮，打开后只读显示这个会话发给模型的内容：

- 系统提示词的每一段：名称、order、来源插件、字数、在前缀里的位置。可以按段落或按来源分组。
- 和上一轮实际发出的系统提示词对比。有变化时标出从哪个字符开始不同，也就是下一轮前缀缓存从哪里失效。DSH 重启后要先发一条消息才有对比。
- runtime context（工作目录、各插件登记的运行时状态）和上一次请求带的工具。

查看器只读，要改内容请到破限预设、角色卡或插件设置。接口走 DSH 自己的认证，局域网或远程访问的非 owner 读不到。会话要先打开或发过消息（agent 已加载）才能查看。

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
- 外部条目统一排在角色和格式规则之后、记忆说明之前，同位置按名称排序。顺序表在 `src/order.ts`，外部插件不指定数字。
- qqbot 会话的系统提示词只由 dsh-qqbot 组装（一个 complete section）。直接调用 `ctx.systemPrompt.section` 注册的全局段落不会出现在 qqbot 会话里，DSH 自带段落也一样；工具不受影响。

## 开发

需要相邻的 DSH 源码检出（`../../qqbot/src/deepseek-harness`，`0.2.1-rc.3`），开发依赖通过 `link:` 指向它。`@deepseek-ai/cordis` 是 peer 依赖，不打进 `lib/`，运行时用宿主的同一份。

```sh
pnpm install
pnpm run build   # 类型检查 + 构建 lib/
pnpm test
```

## 致谢

dsh-qqbot 建立在这些项目之上，感谢各位作者：

- [lispking/dsh-qq-skin](https://github.com/lispking/dsh-qq-skin)：QQ 聊天界面。本插件的界面、头像背景和语音条外观由它迁移而来。
- [yupaoa/dsh-persona-switcher](https://github.com/yupaoa/dsh-persona-switcher)：人设切换与吉祥物立绘。本插件的角色库、`/role` 命令和会话绑定由它迁移而来。
- [flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern)：独立 Agent 预设和隔离组压缩的写法参考了它。只借鉴了思路，没有复制代码。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主，以及预设、提示词和压缩的原生机制。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)：对话分段的行为规则（阈值、间隔公式）参考了它，没有复制代码。

## 许可

MIT，见 [LICENSE](LICENSE)。迁移代码的原版权声明和来源文件记录在 [NOTICE](NOTICE)。
