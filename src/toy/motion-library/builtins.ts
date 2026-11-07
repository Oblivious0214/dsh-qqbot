/** 内置轨迹源自 dsh-serveu，同作者 MIT 授权与原版权声明见 NOTICE。仅 host 读取文件。 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { MOTION_PRESET_ASSETS } from '../../motion-preset-assets.ts'
import { parseLibrary, type MotionLibrary } from './library.ts'
import { parseActionLibrary, type ActionLibrary } from './config.ts'
import { parseFunscript, parseJson, record } from './script.ts'
import type { PresetPool } from './catalog.ts'
import type { Tier } from '../core/config.ts'

export function defaultActionLibrary(): ActionLibrary {
  const index = record(parseJson(readFileSync(new URL('index.json', MOTION_PRESET_ASSETS), 'utf8')), '内置动作索引')
  if (index['format'] !== 'dsh-motion-preset-assets' || index['version'] !== 1 || !Array.isArray(index['presets'])) {
    throw new Error('内置动作索引格式无效')
  }
  const clips = index['presets'].map((value: unknown) => {
    const entry = record(value, '内置动作')
    const file = entry['file']
    if (typeof file !== 'string' || !/^motion-[1-9]\d{0,8}\.funscript$/u.test(file) || file !== `${entry['id']}.funscript`) {
      throw new Error('内置轨迹文件名无效')
    }
    const text = readFileSync(new URL(file, MOTION_PRESET_ASSETS), 'utf8')
    if (createHash('sha256').update(text).digest('hex') !== entry['sha256']) throw new Error('内置轨迹校验失败')
    return { ...entry, source: 'builtin', kind: 'loop', ...parseFunscript(text) }
  })
  return parseActionLibrary({ revision: 0,
    library: parseLibrary({ format: 'dsh-motion-library-preview', version: 2, clips, mappings: [] }),
    pools: index['pools'],
  })
}

export function builtinLibrary(): MotionLibrary { return defaultActionLibrary().library }
export function defaultPresetPools(): Record<Tier, PresetPool> { return structuredClone(defaultActionLibrary().pools) }
