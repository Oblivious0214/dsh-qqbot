# Device Remote Protocol v1（0.1.0）

本文件是 AstrBot 与 qq-bridge 共用的冻结接口。实现位于本目录，不依赖 DSH 服务。只接受单人私聊；群聊不继承绑定。所有帧为 JSON 对象，`v:1`，最大 64 KiB。设备端主动连接 `wss://服务器/device/ws`；生产禁止明文，测试仅允许显式打开的回环 ws。TLS 证书照常验证。

## 身份与配对

`route = {adapter, account, platform, conversation, user}`，各字段为 1–200 字符字符串；adapter 为 `astrbot` 或 `qq-bridge`。account 是机器人平台实例＋小号身份，conversation 是宿主会话键，user 是真实发言人。全部由已认证的平台事件生成，模型不能指定。route 按字段逐一比较。

用户在目标私聊调用配对命令，服务器产生一次性 128-bit 随机配对码（有效期 120 秒），绑定确切 route。设备端输入服务器地址与配对码，通过 TLS 首帧发送：

```json
{"v":1,"type":"hello","name":"桌面设备","pairCode":"一次性配对码"}
```

成功返回 `paired`：`{v:1,type:"paired",token:string}`。token 至少 256-bit，服务端仅持有 SHA-256，客户端只存本地；再次连接 hello 使用 token 代替 pairCode，两个字段互斥。重配对同一 route 撤销旧 token、连接和租约。失败返回 `{v:1,type:"error",code:string}` 并关闭。配对码和 token 不放 URL、日志、模型上下文。

服务器随后发 `lease`：

```json
{"v":1,"type":"lease","leaseId":"随机租约","route":{"adapter":"astrbot","account":"instance:bot","platform":"aiocqhttp","conversation":"private:peer","user":"peer"},"serverTime":1900000000000,"expiresAt":1900000010000,"seq":0,"generation":0}
```

每次新连接生成新租约；初始 seq=0、generation=0。每条后续服务器帧有同一 leaseId 和 route，seq 严格递增（heartbeat/command/cancel 共用）。设备端同时只接受一个 owner。租约最长 10 秒，服务器每 3 秒发 `heartbeat`（与 lease 相同时间字段，增加 seq）；续租不能恢复已失效租约。设备端以接收时单调时钟计租约，绝对时间经握手 serverTime 校准；本地墙钟跳变／休眠也使租约作废。断线立即停止，重连仅恢复在线，不重放任何历史命令。

## 动作与取消

消息发送成功取得平台 message_id 后，服务器发 command。完整回复先全部解析验证，片段最多 32 个，禁止流式半段执行。一个 command 对应一次成功发送，服务器重试必须保留 commandId，设备端按 seq 和 commandId 去重。

```json
{"v":1,"type":"command","leaseId":"随机租约","route":{"adapter":"astrbot","account":"instance:bot","platform":"aiocqhttp","conversation":"private:peer","user":"peer"},"seq":1,"generation":0,"commandId":"随机命令","turnId":"随机轮次","segment":0,"issuedAt":1900000000000,"expiresAt":1900000005000,"holdMs":5000,"motion":{"range":"full","tier":"low","action":"auto"}}
```

motion 必须完整 `{range,tier,action}` 或 `{stop:true}`；沿用 core/intent.ts 的 range、tier、action 校验，动作名由本地动作库选择，禁止传位置点或放宽本地设置。holdMs 为 1–30000 整数；expiresAt 是接受期限，最多 issuedAt+10000，未来时间最多容许 1000ms。运动持续时间最多 holdMs，同时受租约、本地限制及播放器自身看门狗约束。后续同选择继续使用既有播放器源游标。

`cancel`：公共字段＋`generation`（严格大于当前代次）、`reason`（最多80字符）。立即停止，清空当前段号记录；后续命令须精确匹配新 generation。每次新用户轮、发送失败、退出联动均提升 generation 并取消旧轮。每代只接受一个 turnId、segment 严格递增。较新代次必须先由 cancel 开启，command 不得自行提升。

设备回执：`{v:1,type:"ack",leaseId,commandId,status}`，status 为 `accepted|duplicate|rejected`，可带 code。accepted 只代表已调度，不代表硬件已完成。QQ 已发成功而设备拒绝时仅记录设备结果，不重复 QQ 消息。

时钟校准采用保守上界：设备从主动接入到收到 lease 的全部耗时记为 H，估算当前服务器时间为 serverTime+H，初始租约剩余 expiresAt-serverTime-H。H 超过租约则拒绝；后续帧依此校验。这样握手或代理排队不会把旧动作重新当成新动作，代价是高延迟连接更早停止。

设备本地暂停：立即停止、作废租约，发 `{v:1,type:"paused",leaseId}` 后关闭连接；服务器不能恢复。重新接入由本地用户操作建立新连接／租约，不续播旧动作。退出、窗口关闭、网络中断和卸载均停止。`stop` 与 cancel 不会解除本地暂停。

## 服务器集成边界

适配器内部接口建议 `begin(route): turn`、`sent(turn, segment, motion, holdMs): command`、`cancel(route)`；路由状态与在线连接独立。发送等待期间必须重验 turn 和 lease，失效则不执行；失败不重发聊天。平台回执只是发送成功，不是已读。

首版凭据保存在进程内，服务重启后重新配对；本地 token 不跨服务器复用。服务绑定回环地址，TLS 由反向代理提供，/device/ws 只代理到此服务；不信任转发头作为用户身份。后续持久化属于独立版本，不允许重放旧租约。
