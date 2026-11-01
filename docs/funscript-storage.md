# 动作库文件存储（0.7.0）

29 套内置轨迹从 `assets/motion-presets/*.funscript` 读取，名称、描述和默认三档动作池来自同目录 `index.json`。内置和用户导入都使用 `parseFunscript`。文件只包含单轴 `version: "1.0"` 与 `actions: [{at, pos}]`，时间是严格递增的整数毫秒，相对位置在 0–100 范围内。

用户保存后的目录位于 `<DSH_HOME>/toy-buttplug/`：

```text
motion-library.json                    当前名称、描述、单次/循环、三档动作池及轨迹引用
motion-library.json.bak                上一次成功保存的配置
motion-scripts/<sha256>.funscript       按内容生成的内部文件名
```

配置格式为 `dsh-motion-library-files` v1，包含 revision、library 与 pools；library 保留片段元数据与情景映射，clips 中每个片段用 `file` 引用轨迹，不含 points。界面和模型目录仍只使用中文名称。内存及既有接口继续提供校验后的 points，播放器、限速、暂停与保护预算不变。

可选 `burstPool` 保存独立爆发动作及权重，校验方式与三档池一致，至少一个动作。缺省时沿用当前最高可用速度档的动作池，不写入默认值；首次在爆发预设面板保存后独立持久化。它与三档池一起原子保存、备份和恢复，改名及删除保持引用一致；不进入模型的三档动作目录。可选 `aftercarePool` 保存温存动作，规则相同，缺省时沿用最低可用速度档的动作池。

保存时先校验整库与引用，写入不可变轨迹，再备份上一次有效索引，最后原子替换当前索引。重命名、描述和池调整复用同一轨迹文件。删除后的轨迹仍随上一份备份保留；后续保存使它不再被当前或备份引用时才回收。写入失败保留旧索引，未提交的轨迹在下一次成功保存后清理。

加载时核对轨迹摘要并调用同一解析器；当前索引损坏或缺失、轨迹缺失或校验失败时，尝试完整读取上一份备份。恢复成功前不切换索引，损坏的原索引保留为 `.corrupt-<内部编号>`。存在损坏现场时暂不回收轨迹。两份都无法读取时保留文件并拒绝保存覆盖；可恢复文件后重新加载，或使用已有的“清理全部数据”。

没有存储格式标记的索引按“动作库存储版本无效”处理：尝试 `.bak`，仍不可用时保留原文件并锁定保存（插件未发布过，不转换旧格式）。全部清理覆盖配置、备份和用户轨迹，并重新建立内置库。

转换与核验（Node 24，在仓库根目录）：

```powershell
node scripts/convert-motion-presets.mjs --check
node scripts/verify-motion-presets.mjs
pnpm exec vitest run tests/toy/motion-library tests/toy/library-integration.spec.ts
```

版权、来源与累计毫秒取整误差见 `assets/motion-presets/README.md` 和根 `NOTICE`。本次格式切换不修改内置提示词，不影响前缀缓存。
