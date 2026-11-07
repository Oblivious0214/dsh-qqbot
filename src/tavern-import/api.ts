/** 第 06 步由根入口显式挂载；此模块不自动接入聊天或界面。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Maintenance } from '../maintenance.ts'
import { isRecord } from '../storage.ts'
import { extract } from './extract.ts'
import { adoptStatic } from './static.ts'
import { TavernImportStore, type ImportData } from './store.ts'
import { LIMITS, TAVERN_IMPORT_PATH, type ExtractInput, type ImportPayload, type Preview, type Selection } from './types.ts'
import { fail, ImportError, json, jsonBytes, utf8 } from './util.ts'
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > LIMITS.envelope) return fail('too-large', '导入请求超过 64 MiB')
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) return fail('malformed', '缺少导入请求')
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break
      size += item.value.length
      if (size > LIMITS.envelope) { await reader.cancel(); return fail('too-large', '导入请求超过 64 MiB') }
      chunks.push(item.value)
    }
  } finally { reader.releaseLock() }
  return json(utf8(Buffer.concat(chunks)))
}
export function createImportHandler(getStore: () => TavernImportStore, available: () => boolean = () => true): (request: Request) => Promise<Response> {
  return async request => {
    let requestId: string | undefined, revision: string | number | undefined
    const response = (body: object, status = 200): Response => {
      const envelope = { requestId, revision, ...body }
      if (jsonBytes(envelope, false, LIMITS.normalized) > LIMITS.normalized) return fail('too-large', '导入响应超过 64 MiB，请减少资料后重试')
      return Response.json(envelope, { status, headers: { 'cache-control': 'no-store' } })
    }
    try {
      if (request.method === 'GET') return response({ actions: ['extract', 'preview', 'commit'] })
      if (request.method !== 'POST') return response({ code: 'malformed', message: '请求方法无效' }, 405)
      const store = getStore(), value = await readBody(request)
      if (!available() || getStore() !== store || request.signal.aborted) return fail('cancelled', '导入请求已取消或数据已清理')
      if (!isRecord(value) || typeof value['requestId'] !== 'string' || value['requestId'].length > 128 || !['string', 'number'].includes(typeof value['revision'])) return fail('malformed', '缺少请求编号或输入版本')
      if (typeof value['revision'] === 'string' && value['revision'].length > 128) return fail('malformed', '输入版本过长')
      requestId = value['requestId']; revision = value['revision'] as string | number
      if (value['action'] === 'extract') {
        const extraction = extract(value['input'] as ExtractInput)
        return response({ extraction })
      }
      if (value['action'] === 'preview') {
        const payload = value['input'] as ImportPayload
        // 静态采用仍使用同一请求契约；最终可编辑正文由调用方放入 payload.body。
        return response({ preview: store.preview(payload) })
      }
      if (value['action'] === 'commit') return response({ saved: store.commit(value['input'] as ImportPayload, value['preview'] as Preview) })
      return fail('malformed', '导入操作无效')
    } catch (error) {
      const e = error instanceof ImportError ? error : new ImportError('storage-failed', '导入未完成，请重试', { error: String(error) })
      const status = e.code === 'too-large' ? 413 : ['stale-preview', 'conflict', 'storage-failed'].includes(e.code) ? 409 : e.code === 'cancelled' ? 499 : 400
      return response({ code: e.code, message: e.message, ...e.details === undefined ? {} : { details: e.details } }, status)
    }
  }
}
/** 本地直接采用亦可被界面调用；不依赖模型。 */
export function directBody(input: ExtractInput, selections: Selection[]): string { return adoptStatic(extract(input), selections) }
export function registerTavernImport(ctx: Context, data: ImportData, maintenance: Maintenance): void {
  let store = new TavernImportStore(data), active = true
  // 初次恢复失败时保留路由，让用户取得可操作错误；不将整插件加载变成异常。
  try { store.recover() } catch (error) { ctx.logger.warn('qqbot tavern import recovery: %s', (error as Error).message) }
  ctx.effect(() => maintenance.register({ prepare: () => { store.dispose(); store = new TavernImportStore(data) }, reload: () => { store = new TavernImportStore(data) } }), 'qqbot: tavern import cleanup')
  ctx.effect(() => () => { active = false; store.dispose() }, 'qqbot: tavern import generation')
  ctx.effect(() => ctx.connection.fetch.register({ path: TAVERN_IMPORT_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: maintenance.route(createImportHandler(() => store, () => active)),
  }), 'qqbot: tavern import route')
}
