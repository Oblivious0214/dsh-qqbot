import { homedir } from 'node:os'
import { join } from 'node:path'
import { startLocal } from './local.ts'

const service = await startLocal({ dataDir: join(homedir(), '.serveu-device'), simulate: process.argv.includes('--simulate') })
console.log(`设备控制页：${service.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().then(() => process.exit(0)) })
