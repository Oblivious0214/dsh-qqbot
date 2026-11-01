/** 用户点击“怎么做”后，作为新标准会话的普通用户消息发送。 */
export type PhoneGuideRoute = 'local' | 'tailscale'

const ROUTES: Record<PhoneGuideRoute, string> = {
  local: `我选的是“局域网”，手机和电脑连同一个 Wi-Fi。
1. 电脑上：DSH 设置 → QQ Bot → 远程控制 → 局域网，打开“启动连接”。有多个网络时选当前用的 Wi-Fi 或网线。
2. 把显示的手机网址发到手机上，用浏览器打开，输入设置里显示的访问码。
打不开时帮我查：电脑和手机是不是同一个 Wi-Fi（访客 Wi-Fi 不行）、防火墙有没有拦。
局域网是 HTTP，只能聊天；手机网页要连蓝牙设备得用“远程”方式，同一个 Wi-Fi 也能用。`,
  tailscale: `我选的是“远程”，手机不在同一个 Wi-Fi（比如用流量），或者要在手机上连蓝牙设备。
先问我：手机是安卓还是苹果？要不要在手机上连设备？
1. 我自己到 https://tailscale.com/download 给电脑和手机装 Tailscale，注册后两边登录同一个账号，装好告诉你。
2. 打开 https://login.tailscale.com/admin/dns ，开启 MagicDNS 和 HTTPS。
3. 电脑上：DSH 设置 → QQ Bot → 远程控制 → 远程，打开“启动连接”，会显示 HTTPS 手机网址。提示 443 被占用时，先查现有 Tailscale Serve 配置再问我怎么处理。
4. 手机打开这个网址，输入访问码，进入 QQ 对话。
要连蓝牙设备：安卓用 Chrome 打开；苹果装 Bluetooth Browser（https://apps.apple.com/app/bluetooth-browser/id6455128847 ）再在里面打开同一个网址，允许蓝牙。然后在会话右侧“设备联动”→“联动设置”完成授权，“连接设置”选“蓝牙”→“连接设备”→ 选设备 →“启用联动”。
电脑要保持开机不休眠；手机页面切后台或锁屏后回来要重新连接。手机开着别的 VPN 可能和 Tailscale 冲突。`,
}

export function phoneGuidePrompt(route: PhoneGuideRoute): string {
  return `帮我配置 DSH 的 dsh-qqbot“远程控制”，让手机打开网页就能和角色聊天。用中文，一步一步带我做，每次只问一个问题，能用工具查的直接查。
${ROUTES[route]}`
}
