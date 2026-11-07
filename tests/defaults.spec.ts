import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { DEFAULT_PRESET_HEAD, DEFAULT_ROLE_NAME, DEFAULT_ROLE_PERSONA } from '../src/default-content.ts'
import { initializeDefaultConfiguration } from '../src/defaults.ts'
import * as host from '../src/index.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import { imageResponse, UiStore } from '../src/ui.ts'
import { IMAGE_PATH } from '../src/ui-types.ts'

const dirs: string[] = []
const warn = () => {}
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-defaults-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('first-use defaults', () => {
  it('boots the real service with the default role, preset and original avatar', async () => {
    const home = temp()
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    const root = new Context()
    try {
      const fiber = await root.plugin(host)
      const { content, ui } = root.qqbot
      const role = content.roleFor({ id: 'new-qqbot-session' })!
      expect(role.name).toBe(DEFAULT_ROLE_NAME)
      expect(role.persona).toBe(DEFAULT_ROLE_PERSONA)
      expect(role.id).toMatch(/^r-[0-9a-f]{8}$/)
      expect(content.bindings.defaultRole).toBe(role.id)
      expect(content.presets.current()).toMatchObject({ id: 'default', head: DEFAULT_PRESET_HEAD, mid: '', tail: '' })
      expect(content.presets.snapshot()).not.toHaveProperty('roles')
      const response = imageResponse(ui, new Request(`http://localhost${IMAGE_PATH}?kind=avatar&role=${role.id}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(new URL('../assets/default-avatar.png', import.meta.url)))
      expect(Object.keys(ui.avatarVersions())).toEqual([role.id])
      expect(readdirSync(home)).toEqual(['qqbot'])
      expect(readdirSync(join(home, 'qqbot')).some(name => name.startsWith('.initial-defaults-'))).toBe(false)
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('keeps user edits, default choices and replacement avatars on reload', () => {
    const dir = temp()
    expect(initializeDefaultConfiguration(dir, warn)).toBe(true)
    const roles = new RoleLibrary(join(dir, 'roles'), warn)
    const role = roles.list()[0]!
    roles.save({ ...role, persona: '用户修改后的正文。' }, false)
    const presets = JailbreakStore.at(dir, warn)
    presets.save({ ...presets.current(), head: '用户修改后的通用规范。' }, false)
    SessionBindings.at(dir, warn).setDefaultRole(undefined)
    const avatar = new UiStore(dir, warn).avatar(role.id).find()!.file
    writeFileSync(avatar, Buffer.from('用户替换的图片'))
    const paths = ['presets.json', 'sessions.json', join('roles', role.id, 'ROLE.md')].map(path => join(dir, path)).concat(avatar)
    const before = paths.map(path => readFileSync(path))
    expect(initializeDefaultConfiguration(dir, warn)).toBe(false)
    expect(paths.map(path => readFileSync(path))).toEqual(before)
  })

  it.each(['roles', 'roles-trash', 'presets.json', 'sessions.json', 'presets.json.corrupt', 'sessions.json.corrupt'])(
    'does not initialize over existing %s', name => {
      const dir = temp()
      const path = join(dir, name)
      if (name.startsWith('roles')) mkdirSync(path)
      else writeFileSync(path, '已有资料（包括待修复文件）')
      expect(initializeDefaultConfiguration(dir, warn)).toBe(false)
      expect(readdirSync(dir)).toEqual([name])
    },
  )

  it('does not restore a deleted default role or removed avatar', () => {
    const dir = temp()
    initializeDefaultConfiguration(dir, warn)
    const roles = new RoleLibrary(join(dir, 'roles'), warn)
    const role = roles.list()[0]!
    new UiStore(dir, warn).avatar(role.id).remove()
    roles.remove(role.id)
    expect(initializeDefaultConfiguration(dir, warn)).toBe(false)
    expect(roles.list()).toEqual([])
    expect(new UiStore(dir, warn).avatarVersions()).toEqual({})
  })

  it('rolls back only new entries if an existing image path prevents initialization', () => {
    const dir = temp()
    writeFileSync(join(dir, 'images'), '已有文件，不能覆盖')
    expect(() => initializeDefaultConfiguration(dir, warn)).toThrow()
    expect(readFileSync(join(dir, 'images'), 'utf8')).toBe('已有文件，不能覆盖')
    expect(existsSync(join(dir, 'roles'))).toBe(false)
    expect(readdirSync(dir)).toEqual(['images'])
  })

  it('preserves a concurrent avatar and rolls back files already copied before the conflict', () => {
    const dir = temp()
    const save = RoleLibrary.prototype.save
    let avatar = ''
    vi.spyOn(RoleLibrary.prototype, 'save').mockImplementation(function (this: RoleLibrary, value, create) {
      const role = save.call(this, value, create)
      mkdirSync(join(dir, 'images', 'avatars'), { recursive: true })
      avatar = join(dir, 'images', 'avatars', `${role.id}.png`)
      writeFileSync(avatar, '另一个窗口写入的头像')
      return role
    })
    expect(() => initializeDefaultConfiguration(dir, warn)).toThrow()
    expect(readFileSync(avatar, 'utf8')).toBe('另一个窗口写入的头像')
    expect(readdirSync(dir)).toEqual(['images'])
  })
})
