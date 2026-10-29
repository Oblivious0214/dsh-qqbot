# dsh-qqbot

在 DeepSeek Harness（DSH）里做 QQ 聊天式角色扮演。插件注册一个独立的 `qqbot` Agent 预设，所有提示词、界面和压缩都只在这个预设的会话里生效；关闭或卸载插件后，DSH 和没装过一样。

当前是 0.1.0 骨架，只有预设、提示词槽位和入口。QQ 界面、角色库、破限预设编辑器等功能还在迁移。

## 使用

- 侧边栏"更多"菜单 → **新建 QQ 会话**；或在新会话界面的预设选择里选 **QQ Bot**。
- 插件不会把 `qqbot` 设为默认预设。如果你自己在 DSH 设置里把默认改成了 QQ Bot，关闭插件前请改回：设置 → Agent 预设 → 标准模式。否则关闭插件后新建会话会报 `Unknown agent preset`。
- 插件关闭期间，QQ Bot 的旧会话无法打开；重新启用后可以恢复。

## 给其他插件：登记接口

host 层服务 `ctx.qqbot` 只做登记，内容只出现在 qqbot 会话里。用可选依赖接入，没装 dsh-qqbot 时什么也不注册：

```js
ctx.inject(['qqbot'], (child) => {
  // 规则：section 名为 qqbot:ext:toy。文本应尽量稳定，每次变化都会让后面的前缀缓存失效。
  child.effect(() => child.qqbot.extension({ name: 'toy', text: session => '...' }))
  // 运行时状态：进入 qqbot:runtime context，不影响系统提示词前缀。
  child.effect(() => child.qqbot.runtime('toy', session => 'device=disconnected'))
})
```

- `name` 只能用小写字母、数字和连字符。
- `text` 可以是字符串，也可以是 `(session) => string`。返回空串表示该会话里不出现这一段。
- 外部条目统一排在角色和格式规则之后、记忆说明之前，同位置按名称排序。顺序表在 `src/order.ts`，外部插件不指定数字。

## 开发

需要相邻的 DSH 源码检出（`../../qqbot/src/deepseek-harness`，`0.2.1-rc.3`），开发依赖通过 `link:` 指向它。

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
