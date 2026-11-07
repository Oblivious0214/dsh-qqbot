# 从源码开发

普通安装在 DSH 的“添加插件”中填写仓库地址：https://github.com/Oblivious0214/dsh-qqbot 。安装入口使用默认分支，不追加版本标签。用于安装的公开分支需随版本提交 lib 构建产物；本地开发分支仍忽略 lib。不发布 npm。

## 环境与布局

Node.js 24、pnpm 10。开发依赖基线：DeepSeek Harness 0.2.1-rc.3，提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60。开发依赖链接到已准备好的宿主源码，目录按下列方式放置：

```text
workspace/
  plugins/dsh-qqbot/
  qqbot/src/deepseek-harness/
```

从 workspace 开始：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git qqbot/src/deepseek-harness
git -C qqbot/src/deepseek-harness checkout 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
git clone https://github.com/Oblivious0214/dsh-qqbot.git plugins/dsh-qqbot
cd qqbot/src/deepseek-harness
pnpm install
pnpm run build
cd ../../../plugins/dsh-qqbot
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --out ../../dsh-qqbot-0.43.2.tgz
```

宿主准备方式以 [官方源码运行文档](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/README.zh.md#run-from-source) 为准。插件运行时与宿主共用 cordis、compaction-basic 和 llm；它们是 peer 依赖，不打入插件。

清理旧 lib 产物后再构建；测试使用独立临时资料目录和模拟设备。设备及手机的真机验证范围见 [发布说明](https://github.com/Oblivious0214/dsh-qqbot/releases/tag/v0.36.2)。

## 角色表情范围（0.41.0）

`meme-agent.ts` 在每个 QQ Agent 内登记 scoped `send_meme`，通过宿主公开遮蔽机制替代该会话继承的全局工具。全局工具消失时撤销，恢复时重新登记；QQ 插件停用撤销全部本地登记，标准会话仍使用原工具。兼容已核对的 rc.5 Native／PTC；PTC 在既有410段呈现本工具声明。

`meme-source.ts` 只读 dsh-meme 的 `dsh-expression.json`（遵循其 `DSH_MEME_HOME`）和 GET `/dsh-memes-api`。按角色勾选与全局启用取交集，逐库请求并校验返回身份、路径和 URL；不读取 `packId=all`、不更新全局设置、不导入第三方模块。接口失败或图库失效不回落其他图库。`meme-api.ts` 经 owner connection 路由提供当前或历史轮次的范围，历史角色由已有轮次绑定解析。

`meme-scope.ts` 产生带图库与图片身份的 marker，QQ 正文显示投影转换为准确的 Markdown 图片；旧描述只在当轮角色范围内精确匹配。模型历史原文、语音分段、动作时钟不变。浏览器优先使用当前入口的完整图片网址，file 页面使用服务端入口；图片仍走 dsh-meme 原路由，不改变其访问设置。旧消息使用当轮角色当前配置，图库被关闭、移除或角色被删除后可能降为文字。

表情规则与教程修改已获用户授权，稳定系统段从410起变化；工具 schema 更新也会改变工具前缀，检索结果只走工具结果。清单补录运行 `node --experimental-transform-types scripts/update-meme-inventory.mjs`，只改表情条目及对应合成示例，保留其他清单原文。验证见 `work/meme-role-scope-20261104/README.md`，实际生产模型与用户图库尚未验收。

## 自定义预设（0.42.0）

动作库 v2 与已发布 v1 的迁移、原始备份和回收规则见 [存储说明](funscript-storage.md)。编辑器使用不可变原始源与整数毫秒选区，范围热力图使用相对运动量配色和位置包络，下方只保留选区折线图。显示采样不参与保存。用户手工选区后直接保存循环或完整片段；本地重复发现、独立模型分析及其接口已移除。

导入与编辑器的循环预览／保存统一使用 `prepareLoopSelection`：在手选起止点前后各 2000ms 的原始轨迹中逐毫秒匹配同位置、同相位和相近速度的接点，优先最小时间位移。两侧速度比至少 0.75，位置取整误差最多 0.1；微小误差只对齐终点，保留中间原点。按位置、相位和速度分桶索引，不做整段重复发现。短选区匹配后的时长限定在手选时长的 0.5–1.5 倍以内；所有结果保留 600 秒、20000 点边界。

找不到自然接点时，`closeLoop` 保持已有闭合轨迹，或按末尾最近的非零移动速度补回程；时长或点数无余量时插值接入尾部。源图保留手选双手柄并另标最终循环范围，折线图和时长展示最终准备数据，保存不再重复吸附。完整片段按手选原点保存。`MotionPlayer` 连续播放、暂停、限速限程和超时机制保持。

构建前须核对本插件 lib 的实际路径、备份后清理；验证使用模拟会话和设备，不改宿主或 profile。

## 角色动态设定（0.40.0）

当前实现和公开API见 [动态设定](role-dynamics.md)，用户操作见 [使用说明](usage.md#动态设定)。宿主运行适配以只读核对的实际0.2.1-rc.5为准；开发参考源码的同名版本不等于安装产物。动态历史使用公开sessionQuery观察租约、完整事件cut和sessions.flush，不新增宿主记录类型或私有写入接口。

第07独立复查已关闭四项阻断：PTC最终模型文本在430呈现已授权声明；卸载区分开放／闭合轮并处理跨await、失败写重试；seeded子分支复制全部相关历史角色基线；HTTP和命令在等待历史后重验当前Agent及队列。早期第06／07工作记录是历史证据，不作为当前未修状态。第08完成集成后另交第09独立验收，不能把模拟执行说成运行中DSH或真实模型验收。

提示词清单保留其余既有条目原文，在基础生成器之后运行 `node --experimental-transform-types scripts/update-dynamics-inventory.mjs`。该脚本仅补录已授权说明、无工具首句、PTC430和context1010呈现，并更新版本／顺序元数据；不修改内置提示词。先备份并核对本插件lib绝对路径且不是链接，清理旧lib后构建。本地包需与当前文件逐项摘要核对，保留LICENSE／NOTICE；不同版本包不覆盖旧tgz，安装另行授权。

## 全局预设（0.42.0）

预设文件v2只含version、current与presets。共享视图currentPreset，显式操作preset.current；角色不携带预设字段。普通组装、自动接话与查看器统一经QqbotData.jailbreakFor读取current。独立预设页选择只编辑，新建/复制保存不启用，使用中删除回退剩余第一份，末份不可删除。

v1迁移先独占保存presets.json.pre-v2原字节，以原default作为current，角色绑定只留备份。配置包接受并忽略旧role.preset，新导出无绑定，导入只追加；酒馆旧assignments仅兼容验证。三段原文和section order不改，切换或编辑当前预设仅沿既有机制改变下一次组装的前缀；不改进行中请求和历史。
