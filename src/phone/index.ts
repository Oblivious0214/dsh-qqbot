import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '../index.ts'
import { join } from 'node:path'
import { PHONE_PATH } from '../phone-types.ts'
import { dataDir } from '../storage.ts'
import { PhoneController } from './controller.ts'
import { phoneResponse } from './route.ts'

export const inject = ['qqbot', 'connection']
export function apply(ctx: Context): void {
  // Desktop IPC 与 Web 共用 connection.fetch；没有 Web 载体时仅此功能不可用。
  let controller: PhoneController | undefined
  let unavailable = '当前 DSH 没有可用的本机网页入口。'
  ctx.inject(['webServer'], inner => {
    inner.effect(async () => {
      const web = inner.webServer
      const current = new PhoneController({ file: join(dataDir(), 'phone', 'settings.json'), upstream: () => web.getOrigin(),
        warn: message => inner.logger.warn(message), authenticate: async () => {
          const response = await fetch(inner.connection.authenticatedUrl(web.getOrigin()), { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
          const cookie = response.headers.get('set-cookie'); await response.body?.cancel()
          if (response.status !== 303 || !cookie) throw new Error('DSH 本机认证失败。')
          return cookie.split(';')[0]!
        } })
      controller = current
      try { await current.initialize() } catch (error) { unavailable = error instanceof Error ? error.message : unavailable }
      return async () => { if (controller === current) controller = undefined; await current.dispose() }
    }, 'qqbot: local phone gateway')
  })
  ctx.effect(() => ctx.qqbot.maintenance.register({
    prepare: () => controller?.prepareReset(), credentials: async () => { await controller?.reset() }, reload: () => controller?.reload(),
  }), 'qqbot: reset phone entry')
  ctx.effect(() => ctx.connection.fetch.register({
    path: PHONE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      // 网关转发使用 owner 身份；这个明确标记阻止手机读出或改写入口凭据。
      if (request.headers.has('x-qqbot-phone-proxy')) return Response.json({ message: '请在电脑上管理手机连接。' }, { status: 403 })
      if (!controller) return Response.json({ message: unavailable }, { status: 503 })
      return phoneResponse(controller, request)
    }),
  }), 'qqbot: phone settings')
}
