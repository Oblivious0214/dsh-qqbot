/** 每页已同步的数据代次；旧页面不能把清理前的草稿重新保存。 */
let epoch = ''
export function acceptCleanupEpoch(value: string): void { epoch = value }
export function writeHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-qqbot-data-epoch': epoch }
}
