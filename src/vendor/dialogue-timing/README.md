# dialogue-timing（[qq] 分段协议）

从 ServeUDSH 工作区 `shared/dialogue-timing/` 原样复制（2026-10-29，2026-10-30 加 parseTimedStream、去掉 durationMs；段落多写的字段和无效 cycles 改为丢掉；加 salvageTimedReply），MIT。QQ 分段和设备插件共用这份解析规则，各自打包，发布包之间没有相对路径依赖。修改时先改工作区的共享模块，再同步这里。

| 文件 | SHA-256 |
| --- | --- |
| protocol.js | 9619080a6cdc62d58b5a84c4df27c17e77a11157f7b93ccec07f1bc6af9303ce |
| protocol.d.ts | 463073fbbbd6b283a76ae3b6761771ea08fcf14b1c01a0e6cda21f360f298987 |
| interruptions.js | 6bb4929835571974ddfa619cd808a1e2e1d2443acb325b135f37fd231f2db505 |
| interruptions.d.ts | 44127a298770a81c4163694c3b2c2112ae1798c0074d424a552e0f71496ab322 |
