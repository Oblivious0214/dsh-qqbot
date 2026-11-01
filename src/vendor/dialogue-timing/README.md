# dialogue-timing（[qq] 分段协议）

2026-10-30 单包合并：QQ 分段与 `src/toy/` 共用本目录，不再各自打包一份。保留 QQbot 已有的 `voice:true` 支持；设备换算仍只读 motion/seconds，不消费 voice。正文及提示词没有因合并而改变。

从 ServeUDSH 工作区 `shared/dialogue-timing/` 原样复制（2026-10-29，2026-10-30 加 parseTimedStream、去掉 durationMs；段落多写的字段和无效时长改为丢掉；加 salvageTimedReply；2026-10-31 cycles 改为 seconds（5–120 整数），写在 motion 里的 seconds 挪到段落、cycles 丢掉），MIT。QQ 分段和设备插件共用这份解析规则，各自打包，发布包之间没有相对路径依赖。修改时先改工作区的共享模块，再同步这里。

2026-10-30：保留显式布尔值 `voice:true`，用于 QQ 按条选择语音；未标记和无效值保持文字。流式读取使用同样规则，损坏 JSON 的挽救不推测语音标记。本次没有同步或修改设备插件。

2026-10-31：删掉分段提示词末尾“此分段协议本身不授权任何设备动作”一句。未同步 `legacy/shared/` 下的旧副本。

2026-10-31（容错）：本目录已是唯一来源（工作区 `shared/` 不再存在）。解析改为宽容读取 flash 常见错误：标签变体、代码块／引用包裹、无标签 JSON、多块合并、结束缺 `[/qq]`（`parseFinishedReply`）、外壳与段落写法、JSON 小错修复；不替模型闭合段落、motion 或字符串。提示词加“开头和结尾始终用方括号”。详见 `work/qq-tag-tolerance-20261031/README.md`。

| 文件 | SHA-256 |
| --- | --- |
| protocol.js | 866ca3fdaa3d2bca597a3840c4780693109760861dea04e8c283915d502abd13 |
| protocol.d.ts | 5fa091bea3384ca1150ecbed69b6684cc1d36446ba3557c51866469263d25433 |
| interruptions.js | 6bb4929835571974ddfa619cd808a1e2e1d2443acb325b135f37fd231f2db505 |
| interruptions.d.ts | 44127a298770a81c4163694c3b2c2112ae1798c0074d424a552e0f71496ab322 |
