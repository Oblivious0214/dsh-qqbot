import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// 每个测试文件用自己的临时 DSH_HOME，不碰本机 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-qqbot-test-'))
process.env['DSH_HOME'] = home
// 回归用例沿用已有空角色库；首次使用的内置配置由 defaults.spec.ts 单独覆盖。
mkdirSync(join(home, 'qqbot', 'roles'), { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))
