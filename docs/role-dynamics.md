# 角色动态设定

动态设定把“当前数值”和“满足条件后使用的设定”放在一起。每个会话、每个角色各自保存进度；普通角色继续按原来的方式聊天。

## 开始使用

在 **QQ Bot 设置 → 角色 → 动态设定** 点“添加动态设定”，会直接带入一份简单模板：好感初值20、范围0–100，达到30后使用“熟悉”设定。可以修改或粘贴完整定义，点“确定”后随角色保存；保存后直接启用，没有额外启动开关。示例见 [三阶段定义](../examples/role-dynamics.json)。已有停用定义和进度保留，使用“修改设定”确认并保存角色后启用。

角色页直接显示字段当前值和生效设定。标题下一行依次是对话选择和“编辑数值”，下方展示状态，“修改设定”放在分组最下面；数值、文字、是否和选项均在“编辑数值”内修改。选择框只列出当前使用该角色的 QQ Bot 对话，从聊天进入优先当前对话；没有对应对话时显示初始状态，“编辑数值”不可用。预览不新建或改写进度，修改定义的草稿显示初值，保存角色后再读取会话进度。

字段支持数字、文字、是否和选项。`initial` 是首次使用的值，修改它不会重设已有进度。`visible` 控制模型能否看到字段；`aiWritable` 控制模型能否更新，可更新字段须填写 `updateRule`。隐藏字段只供本地状态、条件和明确授权的插件使用。

`entries` 按条件选择正文，多条同时满足时按配置顺序一起生效。`eq/ne` 比较同类型值，`gt/gte/lt/lte` 比较数字；`all` 表示全部满足，`any` 表示任一满足。名称由作者填写，内部身份由程序生成。三阶段示例在好感30和70处切换，初值20属于初识。

在角色设置中选择对话，点 **编辑数值** 修改字段。生成中也能编辑，已开始的回复仍使用本轮开始时的状态；新值供下一轮使用。如果其他页面先改过，保存会报告冲突并保留输入，重新读取前可选择继续编辑。对话换角色仍需等待回复及排队消息处理完。

## 生效与保存

一轮回复开始时冻结当前状态和生效正文。同轮多步调用、请求自动重试及运行时刷新都使用这份冻结输入。AI提交的是变化后的目标值；工具接收后先保存候选，匹配成功工具结果、完整助手消息及整轮成功结束，并确认宿主历史持久化后才提交。失败、取消或仍开放的轮次不应用候选。提交后的数值及新阶段从下一轮生效。

用户在生成中修改值会使旧AI候选冲突，保留用户值。切换角色保留各角色已有进度。编辑定义时，省略动态部分保留原配置；完整对象替换定义，明确移除配置则清除其进度关联。兼容调整保留值，新增字段补初值；删字段、改类型、收窄范围等影响已有值时，使用一次“重置后应用”确认。重置范围是该角色各会话进度。

定义可随角色分享，当前进度不分享。数据页导出所选角色含任意动态定义时使用配置包v2（包括停用的定义）；纯静态角色、仅提示词仍为v1。JSON和ZIP沿用原导入入口，导入到空库后从初值开始，再导出保留完整定义。酒馆静态摘录仍是静态角色，静态正文／表情／主动性编辑保留已有动态定义。

清理缓存保留定义、进度和去重回执；清理全部数据按原确认流程重置插件资料。角色回收和恢复连同进度使用同一归属。坏配置、坏日志或缺失历史基线会明确报错，原件保留。

## 历史分叉的准确边界

分叉继承所选历史事件前缀内的角色和状态。已成功结束的轮次包含有效提交；在工具调用之后、成功结束之前分叉，仍是轮前状态。创建动态子分支时复制其继承截点上全部相关历史角色的基线，后续子孙分支可以脱离父历史使用。

手动修改在原会话立即持久生效，但其历史位置是下一条真实宿主事件之前。例如尾部为事件100，之后手动改为80：按100分叉仍取修改前值；出现事件101后，包含101的分叉才继承80。尚无下一事件时，原会话关闭重开仍保留80。这里使用宿主精确分叉接口，没有新增原地回退界面，也不把请求自动重试当作历史回退。

宿主聊天导出不包含插件私有进度；跨机器只导入聊天不能还原这些日志。已发出的阶段正文可能仍在历史或摘要中，阶段不再生效只停止后续注入。

## 开发接口

类型从插件主入口导出：`DynamicsPublic`、`DynamicsSource`、`PublicOperation`、`DynamicsSnapshot`、`DynamicsTarget`。读取真实Cordis调用方的 `ctx.qqbot.dynamics`；`registerSource(显示名称)` 返回绑定该插件身份的来源对象，随调用方停用撤销。公共入口提供 `readSnapshot(target)`、`commit(target, operation)`、`projectModel(target)`、`subscribe(target, listener)`；来源对象另有 `readExtension`、`commitExtension` 和 `dispose`。同一身份同时只登记一份来源。

`target` 为 `{sessionId, roleId}`，均取程序已有身份。公共写入格式：

```ts
const source = ctx.qqbot.dynamics.registerSource('剧情状态')
const target = { sessionId, roleId }
const snapshot = await source.readSnapshot(target)
if (!snapshot) throw new Error('当前角色没有动态设定')
await source.commit(target, {
  operationId, // 调用方生成并在重试时复用
  baseRevision: snapshot.revision,
  configRevision: snapshot.configRevision,
  dataEpoch: snapshot.dataEpoch,
  progressId: snapshot.progressId,
  generation: snapshot.generation,
  changes: [{ name: '好感', value: 31 }],
})
```

整批提交核对来源、当前角色、配置、进度身份、维护代次和版本；任一字段错误则全部不改。同来源／generation／operationId及相同规范化内容返回持久回执，不重复增加版本；同键异内容冲突。插件仅能写 `pluginWritable:true` 的公共字段。完整快照供可信本地调用方使用，给模型只用 `projectModel`，不直接发送快照或诊断。

私有扩展按真实插件身份分区，定义沿用四类型校验且 `entries` 为空；A无法访问B的分区。扩展操作的 `baseRevision` 取私有分区版本，`configRevision` 是该私有定义的规范化SHA-256，其余进度身份及代次取公共快照。私有值不进入模型、公共条件或分享。`subscribe` 仅在公共状态成功变化后通知，返回撤销函数；维护换代重建来源内部句柄。

定义权威是 `roles/<id>/ROLE.md` 的单行 `dynamics` JSON，进度权威是插件 `role-dynamics/roles/<hash>/journal.json`；选择证据在 `role-dynamics/selections.json`。日志使用完整事件前缀、成功结果及before/after锚点；文件先临时写入再原子替换。ROLE与进度、选择与绑定、配置导入均由备份／manifest恢复事务保护。物理写持续失败会报错并重试，跨进程撤销以成功持久化为前提。

首版最多32字段、64条目、条件深8层／每树128节点；定义UTF-8 128KiB、模型投影64KiB。名称NFC＋trim后1–64字符且唯一；数字有限，不隐式转换／截断。文字值最多2000字符，选项1–32个，单项1–100字符；更新规则最多1000字符，正文单条8000／合计50000字符。未知键／版本及坏引用报错。

## 模型呈现与缓存

唯一说明原文为：“依据当前状态和已生效设定回应。按字段更新规则，用 qqbot_update_state 提交本轮变化后的值；更新从下一轮生效。” Native使用工具description和固定JSON Schema；参数只有 `changes:[{name,value}]`，返回仅 `{accepted:true}`。没有更新工具时，可见context使用首句。

rc.5 PTC的wire工具只有 `run_code`，complete会移除宿主 `tools:sdk`。因此实际登记了状态工具的qqbot Agent在唯一 `qqbot:prompt` 内，按 `SECTION_ORDER.DYNAMICS_TOOL=430` 呈现 `tools.qqbot_update_state`、上述description和完整固定Schema。顺序仅定义在 `src/order.ts`。Native不增加该片段；静态、停用、只读和无Agent诊断不提供更新能力。

数值、可见规则和命中正文只进入 `qqbot:role-dynamics` context（1010，required、interpolate:false）。隐藏字段、未命中条目、本地诊断和内部版本身份不发给模型。首次加入PTC声明从430起改变稳定前缀，工具启停也改变声明；同一启用状态下的日常数值／阶段／owner编辑只改变末尾冻结context，保持稳定sections。in-history仍可能追加变化后的context；供应商实际缓存率未测。

0.40.0本地集成的验证记录在工作区 `work/role-dynamics-plan-20261102/step-08-result.md`，最终独立验收交第09步。测试执行真实rc.5提示词／工具实现及真实文件、node:http和headless组件；会话／query／模型／PTC runtime／身份Peer为模拟，故障为注入。范围不含运行中DSH、生产Cookie、真实模型自主发现／质量、手机真机、实体设备或断电验收。
