import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// 每个测试文件用自己的临时 DSH_HOME，不碰本机 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-qqbot-test-'))
process.env['DSH_HOME'] = home
afterAll(() => rmSync(home, { recursive: true, force: true }))
