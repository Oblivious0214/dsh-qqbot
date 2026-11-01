import type { PhoneAction } from '../phone-types.ts'
import { isRecord } from '../storage.ts'
import type { PhoneController } from './controller.ts'

/** 两种宿主传输共用同一请求处理，也供真实控制器回归验证。 */
export async function phoneResponse(controller: PhoneController, request: Request): Promise<Response> {
  if (request.headers.has('x-qqbot-phone-proxy')) return Response.json({ message: '请在电脑上管理手机连接。' }, { status: 403 })
  if (request.method === 'GET') return Response.json(controller.snapshot(), { headers: { 'cache-control': 'no-store' } })
  try {
    const body: unknown = await request.json()
    if (!isRecord(body) || !['start', 'stop', 'save'].includes(String(body['action'])) || typeof body['revision'] !== 'string'
      || body['action'] === 'save' && (typeof body['address'] !== 'string' || typeof body['port'] !== 'number' || typeof body['accessCode'] !== 'string')) return Response.json({ message: '手机连接请求无效。' }, { status: 400 })
    return Response.json(await controller.action(body as unknown as PhoneAction), { headers: { 'cache-control': 'no-store' } })
  } catch (error) { return Response.json({ message: error instanceof Error ? error.message : '操作未完成。', state: controller.snapshot() }, { status: 409 }) }
}
