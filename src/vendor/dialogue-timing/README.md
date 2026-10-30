# dialogue-timing（[qq] 分段协议）

从 ServeUDSH 工作区 `shared/dialogue-timing/` 原样复制（2026-10-29，2026-10-30 加 parseTimedStream、去掉 durationMs；段落多写的字段和无效 cycles 改为丢掉；加 salvageTimedReply），MIT。QQ 分段和设备插件共用这份解析规则，各自打包，发布包之间没有相对路径依赖。修改时先改工作区的共享模块，再同步这里。

2026-10-30：保留显式布尔值 `voice:true`，用于 QQ 按条选择语音；未标记和无效值保持文字。流式读取使用同样规则，损坏 JSON 的挽救不推测语音标记。本次没有同步或修改设备插件。

| 文件 | SHA-256 |
| --- | --- |
| protocol.js | 30bfb4a6a24d6b0035d8f52bdb063fc1948872afc414aaba9a1ef04bbc7a9fdd |
| protocol.d.ts | 5fa091bea3384ca1150ecbed69b6684cc1d36446ba3557c51866469263d25433 |
| interruptions.js | 6bb4929835571974ddfa619cd808a1e2e1d2443acb325b135f37fd231f2db505 |
| interruptions.d.ts | 44127a298770a81c4163694c3b2c2112ae1798c0074d424a552e0f71496ab322 |
