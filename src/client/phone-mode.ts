import type { PhoneView } from '../phone-types.ts'

/** 启动前确认后端支持并保存了所选路线，旧后端不能把远程请求当局域网启动。 */
export function checkPhoneMode(view: PhoneView, mode: 'local' | 'tailscale'): void {
  if (mode === 'tailscale' && view.mode === undefined) {
    throw Object.assign(new Error('当前运行的插件尚未加载远程连接功能，请重启 DSH 后重试。'), { state: view })
  }
  if ((view.mode ?? 'local') !== mode) {
    throw Object.assign(new Error('连接方式未保存成功，请重新选择并保存后再启动。'), { state: view })
  }
}
