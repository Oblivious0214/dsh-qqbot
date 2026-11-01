import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { cp, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from './storage.ts'
import { UPDATE_PATH, type UpdateView } from './update-types.ts'
import { REPOSITORY, installUpdate, releaseUpdate, type NativeManager } from './updater.ts'

// Only in-flight promises survive disposal. The native manager owns package operations.
const key = Symbol.for('dsh-qqbot.update.jobs')
const globalJobs = globalThis as typeof globalThis & { [key]?: Map<string, Promise<void>> }
const jobs = globalJobs[key] ??= new Map<string, Promise<void>>()
const currentVersion = () => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const runningVersion = currentVersion()

async function verifyCopy(source: string, target: string): Promise<void> {
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name === 'node_modules') continue
    const a = join(source, item.name), b = join(target, item.name)
    if (item.isDirectory()) await verifyCopy(a, b)
    else if (createHash('sha256').update(await readFile(a)).digest('hex') !== createHash('sha256').update(await readFile(b)).digest('hex')) throw new Error('备份核对失败。')
  }
}
export const inject = ['qqbot', 'connection']
export function apply(ctx: Context): void {
  const file = join(dataDir(), 'updates', 'state.json')
  const load = (): UpdateView => {
    const saved = readJson(file, () => {}) as UpdateView | undefined
    const state = { ...saved, current: runningVersion }
    if (state.restart && saved?.current !== state.current) { state.restart = false; state.message = '升级已完成。' }
    if (state.busy && !jobs.has(file)) { state.busy = false; state.message = '上次升级被中断，请重新检查。' }
    return state
  }
  const save = (state: UpdateView) => { writeJson(file, state); return state }
  let checking: Promise<UpdateView> | undefined
  const check = (force: boolean): Promise<UpdateView> => {
    if (checking) return checking
    const state = load()
    if (state.busy || !force && state.checked && Date.now() - state.checked < 86400000) return Promise.resolve(state)
    checking = (async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-qqbot' }, signal: AbortSignal.timeout(15000),
        })
        if (response.status === 404) return save({ current: state.current, checked: Date.now(), message: '暂无正式发布版本。' })
        if (!response.ok) throw new Error(`检查更新失败（${response.status}），请稍后重试。`)
        const release = releaseUpdate(await response.json(), state.current)
        return save({ current: state.current, checked: Date.now(), ...release ? { release, message: `发现新版本 ${release.version}` } : { message: '当前已是最新版本。' } })
      } catch (error) { return save({ current: state.current, checked: Date.now(), message: error instanceof Error ? error.message : '检查更新失败。' }) }
    })().finally(() => { checking = undefined })
    return checking
  }
  ctx.effect(() => { void check(false); return () => {} }, 'qqbot: check release on startup')
  ctx.effect(() => ctx.qqbot.maintenance.register({ prepare: () => {
    if (jobs.has(file)) throw new Error('正在升级，请完成后再清理数据。')
  } }), 'qqbot: protect active update')
  ctx.effect(() => ctx.connection.fetch.register({ path: UPDATE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      if (request.headers.has('x-qqbot-phone-proxy')) return Response.json({ message: '请在电脑上升级插件。' }, { status: 403 })
      try {
        if (request.method === 'GET') return Response.json(await check(false), { headers: { 'cache-control': 'no-store' } })
        const body = await request.json() as { action?: string; version?: string }
        if (body.action === 'check') return Response.json(await check(true))
        if (body.action !== 'install') return Response.json({ message: '无效的更新操作。' }, { status: 400 })
        if (checking) await checking
        if (jobs.has(file)) return Response.json(load())
        const state = load(), release = state.release
        if (!release || body.version !== release.version) throw new Error('版本信息已变化，请重新检查。')
        // Capture native services before HMR disposes this plugin's context.
        const manager = ctx.get('pluginManager') as unknown as NativeManager | undefined
        const profile = ctx.get('profileContext') as unknown as { dir: string } | undefined
        const hmr = ctx.get('hmr') !== undefined
        if (!manager || !profile) throw new Error('当前 DSH 未提供原生插件安装服务。')
        const progress = (message: string) => save({ ...state, busy: true, message })
        progress('正在准备升级…')
        const backup = async () => {
          const dir = join(dirname(file), 'backups', randomUUID())
          await mkdir(dir, { recursive: true })
          for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
            const source = join(profile.dir, name), target = join(dir, name)
            await cp(source, target)
            if (!(await readFile(source)).equals(await readFile(target))) throw new Error('配置备份核对失败。')
          }
          const source = await realpath(join(profile.dir, 'node_modules', 'dsh-qqbot'))
          await cp(source, join(dir, 'plugin'), { recursive: true, dereference: true, filter: path => basename(path) !== 'node_modules' })
          await verifyCopy(source, join(dir, 'plugin'))
          // The previous source may be a moving Git branch; restore the verified local snapshot.
          return join(dir, 'plugin')
        }
        // Do not attach this promise to a Cordis effect: removal must not await its own upgrade.
        const job = Promise.resolve().then(async () => {
          try {
            const result = await installUpdate(manager, release, hmr, backup, progress)
            save({ current: state.current, checked: Date.now(), busy: false, restart: result.application === 'restart-required',
              message: result.application === 'restart-required' ? '升级已完成，请重启 DSH。' : '升级已完成。' })
          } catch (error) { save({ ...state, busy: false, message: error instanceof Error ? error.message : '升级失败。' }) }
        }).finally(() => { jobs.delete(file) })
        jobs.set(file, job)
        return Response.json(load())
      } catch (error) { return Response.json({ message: error instanceof Error ? error.message : '更新失败。' }, { status: 409 }) }
    }),
  }), 'qqbot: release updates')
}
