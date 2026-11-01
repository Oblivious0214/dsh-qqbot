# 内置动作轨迹（29 套）

由 `../../scripts/convert-motion-presets.mjs` 自动生成，名称、描述、生成轨迹和默认动作池定义在 `../../scripts/motion-preset-defs.mjs`。前 24 套轨迹来自 `legacy/dsh-serveu/src/catalog.json`，其中 normal 改名稳定节奏、takeit 改名滑动；后 5 套由程序生成（渐快、渐慢、间歇、快去慢回、慢去快回）。来源 SHA-256、名称、描述、循环方式与默认动作池在 [index.json](index.json)，轨迹只含 version/actions/at/pos。

全部循环播放；渐快、渐慢带 `loopFromMs`，走完一遍后只循环最后一个往返（保持最快／最慢）。默认动作池按档位拉开：慢档偏舒缓、中档以稳定节奏为主、快档偏激烈；爆发与温存没有自己的池时分别用快档、慢档池。内部文件名按顺序生成，界面只显示名称。

累计毫秒四舍五入，不逐段独立取整；位置、顺序及正时长停留原样保留。仅省略 zipper 末尾 [50,50,0] 空段。各点及各段误差见工作区 `work/funscript-presets-20261031/verification.json`。全部闭合；0.7.0 起运行时从这些文件读取，用户轨迹也单独保存为 funscript，名称与配置分开存储。

版权与来源沿用 [NOTICE](../../NOTICE) 和 [LICENSE](../../LICENSE)：同一项目作者将旧 dsh-serveu 内置数据按 MIT 纳入；原版权声明保留。分发这些资产时同时保留上述文件。

| 顺序 | 中文名称 | 轨迹文件 | 旧 catalog 键 |
| --- | --- | --- | --- |
| 1 | 稳定节奏 | [motion-1.funscript](motion-1.funscript) | normal |
| 2 | 峰谷连环 | [motion-2.funscript](motion-2.funscript) | mw |
| 3 | 温柔正弦 | [motion-3.funscript](motion-3.funscript) | classic |
| 4 | 深浅跌宕 | [motion-4.funscript](motion-4.funscript) | deep |
| 5 | 轻挑细捻 | [motion-5.funscript](motion-5.funscript) | tease |
| 6 | 极限冲刺 | [motion-6.funscript](motion-6.funscript) | edge |
| 7 | 强拍律动 | [motion-7.funscript](motion-7.funscript) | rhythm |
| 8 | 拉链爬升 | [motion-8.funscript](motion-8.funscript) | zipper |
| 9 | 长波缓涌 | [motion-9.funscript](motion-9.funscript) | risingheat |
| 10 | 深抽连颤 | [motion-10.funscript](motion-10.funscript) | angelbounce |
| 11 | 拱形中浪 | [motion-11.funscript](motion-11.funscript) | psytrance |
| 12 | 低吟渐起 | [motion-12.funscript](motion-12.funscript) | girlwants |
| 13 | 连击长落 | [motion-13.funscript](motion-13.funscript) | cpr |
| 14 | 细密渐强 | [motion-14.funscript](motion-14.funscript) | stepclimb |
| 15 | 冲顶碎颤 | [motion-15.funscript](motion-15.funscript) | tide |
| 16 | 中幅爆发 | [motion-16.funscript](motion-16.funscript) | slopburst |
| 17 | 锯齿大落 | [motion-17.funscript](motion-17.funscript) | gimmemore |
| 18 | 密颤变奏 | [motion-18.funscript](motion-18.funscript) | tikthots |
| 19 | 呼吸起伏 | [motion-19.funscript](motion-19.funscript) | sugardaddy |
| 20 | 逐级推移 | [motion-20.funscript](motion-20.funscript) | underground |
| 21 | 蓄势突进 | [motion-21.funscript](motion-21.funscript) | cyberdream |
| 22 | 全幅大浪 | [motion-22.funscript](motion-22.funscript) | swallowwave |
| 23 | 潮汐涨落 | [motion-23.funscript](motion-23.funscript) | premiumwave |
| 24 | 滑动 | [motion-24.funscript](motion-24.funscript) | takeit |
| 25 | 渐快 | [motion-25.funscript](motion-25.funscript) | 生成：accelerate |
| 26 | 渐慢 | [motion-26.funscript](motion-26.funscript) | 生成：decelerate |
| 27 | 间歇 | [motion-27.funscript](motion-27.funscript) | 生成：intermittent |
| 28 | 快去慢回 | [motion-28.funscript](motion-28.funscript) | 生成：fast_out |
| 29 | 慢去快回 | [motion-29.funscript](motion-29.funscript) | 生成：slow_out |

在工作区根目录执行：

```powershell
node plugins/dsh-qqbot/scripts/convert-motion-presets.mjs
node plugins/dsh-qqbot/scripts/convert-motion-presets.mjs --check
node plugins/dsh-qqbot/scripts/verify-motion-presets.mjs
```

转换需 Node 24；优先读取本工作区只读旧内置 JSON，独立仓库使用 scripts/fixtures/motion-presets 中的逐字节副本；无新增依赖。
