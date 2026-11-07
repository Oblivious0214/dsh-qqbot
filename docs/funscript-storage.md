# 动作库文件存储（0.39.0）

29 套内置轨迹从 `assets/motion-presets/*.funscript` 读取，名称、描述和默认三档动作池来自同目录 `index.json`。内置和用户导入都使用 `parseFunscript`。文件只包含单轴 `version: "1.0"` 与 `actions: [{at, pos}]`，时间是严格递增的整数毫秒，相对位置在 0–100 范围内。

用户保存后的目录位于 `<DSH_HOME>/toy-buttplug/`：

```text
motion-library.json                    当前名称、描述、单次/循环、三档动作池及轨迹引用
motion-library.json.bak                上一次成功保存的配置
motion-library.json.pre-v2-<UUID>.bak   首次升级写入前的 v1 原始索引
motion-scripts/<sha256>.funscript       按内容生成的内部文件名
```

配置格式为 `dsh-motion-library-files` v2，包含 revision、library 与 pools；library 保留片段元数据与情景映射，clips 中每个片段用 `file` 引用轨迹，不含 points。内存及接口格式为 `dsh-motion-library-preview` v2，提供校验后的 points。`source: builtin|custom` 表示来源，`kind: loop|segment` 表示卡片类型，`playback: loop|once` 表示执行方式；来源、类型和执行方式独立。loop 类型或 loop 执行均要求闭合；导入与编辑器先由 prepareLoopSelection 在原始源两端前后各2秒内匹配自然接点，找不到再由 closeLoop 补回程，无时长或点数余量时改接尾部。预览与保存共用准备结果，完整片段保持手选原点。整库不设总点数上限，单段沿用 20000 点上限。界面和模型动作目录仍只使用名称。

兼容已发布 v1：读取时只在内存迁移，不重写索引；host 仅在 id 与完整规范化轨迹均匹配资产时识别旧内置（包括改名内置），不会补回删除的内置。首次成功写 v2 前保留 v1 原始 UTF-8 字节，普通备份恢复 v1 时同样保留。旧 once（含缺省 playback）增加 `legacyAiRepeat: true`，只在 AI 播放中维持旧连续重播；高潮和温存仍按 once 续选。仅改名称描述保留该标记，用户明确选择执行方式或改轨迹后按新语义校验。未知版本及缺少必填来源／类型的 v2 拒绝；旧版本插件不能直接读取 v2，降级需配合原始备份及其轨迹。

可选 `burstPool` 保存独立爆发动作及权重，校验方式与三档池一致，至少一个动作。缺省时沿用当前最高可用速度档的动作池，不写入默认值；首次在爆发预设面板保存后独立持久化。它与三档池一起原子保存、备份和恢复，改名及删除保持引用一致；不进入模型的三档动作目录。可选 `aftercarePool` 保存温存动作，规则相同，缺省时沿用最低可用速度档的动作池。

保存时先校验整库与引用，写入不可变轨迹，再备份上一次有效索引，最后原子替换当前索引。重命名、描述和池调整复用同一轨迹文件。回收保留当前索引、普通备份和全部 pre-v2 备份引用的轨迹；不再被这些索引引用的轨迹才回收。写入失败保留旧索引，未提交的轨迹在下一次成功保存后清理。角色偏好和待机名称引用在库提交前现读校验：拒绝悬空改名／删除，也拒绝将同名待机轨迹改成非闭合，不跨文件改用户选择。

加载时核对轨迹摘要并调用同一解析器；当前索引损坏或缺失、轨迹缺失或校验失败时，尝试完整读取上一份备份。恢复成功前不切换索引，损坏的原索引保留为 `.corrupt-<内部编号>`。存在损坏现场时暂不回收轨迹。两份都无法读取时保留文件并拒绝保存覆盖；可恢复文件后重新加载，或使用已有的“清理全部数据”。

没有存储格式标记的索引按“动作库存储版本无效”处理：尝试 `.bak`，仍不可用时保留原文件并锁定保存；本兼容只针对本插件已发布 v1，不导入旧独立插件数据。全部清理覆盖配置、备份和用户轨迹，并重新建立内置库。

编辑器保存选区的完整原始点，边界按原线段插值并重置起点为0；热力图、概览和曲线显示不会回写轨迹。不额外永久保存未选源文件，重开卡片可在已保存点内再裁剪，扩展范围需重新导入。

独立 DeepSeek 分析只在点击时派发。任务记录含确切 system、有界摘要、已解析调用配置和状态，最多最近10份、每份128KiB；不含角色历史、凭据、原文件路径或全量原点，不写入聊天轮次。清缓存／全清理删除记录，在途 POST 沿用既有写入互斥。取消／清理代次及停用阻止迟到写回。

转换与核验（Node 24，在仓库根目录）：

```powershell
node scripts/convert-motion-presets.mjs --check
node scripts/verify-motion-presets.mjs
pnpm exec vitest run tests/toy/motion-library tests/toy/library-integration.spec.ts
```

版权、来源与累计毫秒取整误差见 `assets/motion-presets/README.md` 和根 `NOTICE`。独立模型分析已移除，其余既有内置提示词保持原文。动作目录仍走原 runtime/context，聊天固定前缀不变。
