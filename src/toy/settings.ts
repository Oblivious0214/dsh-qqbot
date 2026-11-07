/**
 * 持久化设置：`<DSH_HOME>/toy-buttplug/settings.json`。没有文件时用默认值（未授权），第一次保存时才写盘。
 * 文件坏了或字段不合法时按未授权的默认值运行，坏文件留给用户检查，不自动修复。
 */

import { join } from 'node:path'
import { BURST_SECONDS, type BurstSettings, type BurstSpeed, type ToySettings } from './api-types.ts'
import { defaultMotion, HARD_LIMITS, parseMotion } from './core/config.ts'
import { NO_HOTKEY, validHotkey } from './core/hotkey.ts'
import { parseSafetyWords } from './core/safety-words.ts'
import { parsePacing } from './core/pacing.ts'
import { DEFAULT_BEHAVIOR, DEFAULT_PROACTIVITY_TEXTS, MAX_BEHAVIOR_LENGTH, MAX_PROACTIVITY_TEXT_LENGTH, type ProactivityTexts } from './core/rules.ts'
import { PROACTIVITY_KEYS } from './core/safety.ts'
import { isRecord, readJson, writeJson, type Warn } from './storage.ts'
import { CLIMAX_PROMPT_KEYS, DEFAULT_CLIMAX_PROMPTS, MAX_CLIMAX_PROMPT_LENGTH, type ClimaxPrompts } from './climax-prompt.ts'

export function defaultSettings(): ToySettings {
  return { enabled: true, authorized: false, display: { actions: false, countdown: false }, motion: defaultMotion(), behavior: DEFAULT_BEHAVIOR, hotkey: NO_HOTKEY }
}

/** 只留和默认不同的档。没有这个字段时全用默认。 */
function parseProactivityTexts(value: unknown): ProactivityTexts | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('自主性说明格式无效')
  const result: Record<string, string> = {}
  for (const key of Object.keys(value)) {
    if (!(PROACTIVITY_KEYS as readonly string[]).includes(key)) throw new Error('自主性说明里有不认识的档位')
  }
  for (const key of PROACTIVITY_KEYS) {
    const text = value[key]
    if (text === undefined) continue
    if (typeof text !== 'string' || text.length > MAX_PROACTIVITY_TEXT_LENGTH) {
      throw new Error(`每档自主性说明须为文本，不超过 ${MAX_PROACTIVITY_TEXT_LENGTH} 字`)
    }
    if (text !== DEFAULT_PROACTIVITY_TEXTS[key]) result[key] = text
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** 只留和默认不同的提示词。没有这个字段时全用默认。 */
function parseClimaxPrompts(value: unknown): ClimaxPrompts | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('高潮提示词格式无效')
  for (const key of Object.keys(value)) {
    if (!(CLIMAX_PROMPT_KEYS as readonly string[]).includes(key)) throw new Error('高潮提示词里有不认识的项')
  }
  const result: ClimaxPrompts = {}
  for (const key of CLIMAX_PROMPT_KEYS) {
    const text = value[key]
    if (text === undefined) continue
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_CLIMAX_PROMPT_LENGTH) {
      throw new Error(`高潮／温存提示词须为非空文本，不超过 ${MAX_CLIMAX_PROMPT_LENGTH} 字`)
    }
    if (text !== DEFAULT_CLIMAX_PROMPTS[key]) result[key] = text
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function parseBurst(value: unknown): BurstSettings | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error('高潮设置无效')
  const seconds = (key: string, label: string) => {
    const n = value[key]
    if (!Number.isInteger(n) || (n as number) < BURST_SECONDS.min || (n as number) > BURST_SECONDS.max) {
      throw new Error(`${label}须为 ${BURST_SECONDS.min}–${BURST_SECONDS.max} 的整数秒`)
    }
    return n as number
  }
  if (value['after'] !== 'aftercare' && value['after'] !== 'stop') throw new Error('高潮结束后的选项无效')
  const speed = value['speed']
  if (speed !== undefined && speed !== 'medium' && speed !== 'high'
    && (!Number.isInteger(speed) || (speed as number) < HARD_LIMITS.minSpeed || (speed as number) > HARD_LIMITS.maxSpeed)) {
    throw new Error(`高潮速度须为中速、高速，或 ${HARD_LIMITS.minSpeed}–${HARD_LIMITS.maxSpeed} 的整数（unit/s）`)
  }
  return { seconds: seconds('seconds', '高潮持续'), ...speed === undefined ? {} : { speed: speed as BurstSpeed },
    after: value['after'], aftercareSeconds: seconds('aftercareSeconds', '温存持续') }
}

const HOTKEY_RULE = (name: string) => `${name}快捷键无效：用空格，或带 Ctrl、Alt、Meta 的组合键；剪切、复制、粘贴、撤销、重做、全选不能用`

/** 校验并规整设置。不合法时抛出中文错误。 */
export function parseSettings(value: unknown): ToySettings {
  if (!isRecord(value)) throw new Error('设置格式无效')
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') throw new Error('联动开关无效')
  if (value['deviceIntroSeen'] !== undefined && typeof value['deviceIntroSeen'] !== 'boolean') throw new Error('联动介绍状态无效')
  if (value['deviceConnected'] !== undefined && typeof value['deviceConnected'] !== 'boolean') throw new Error('设备连接记录无效')
  if (typeof value['authorized'] !== 'boolean') throw new Error('授权状态无效')
  const behavior = value['behavior']
  if (typeof behavior !== 'string' || behavior.length > MAX_BEHAVIOR_LENGTH) {
    throw new Error(`互动规则须为文本，不超过 ${MAX_BEHAVIOR_LENGTH} 字`)
  }
  // 旧设置里的默认自主性不再读取，保存时也不再写入。
  const proactivityTexts = parseProactivityTexts(value['proactivityTexts'])
  // 没有这个字段或空串都是不设暂停快捷键。
  const hotkey = value['hotkey'] ?? NO_HOTKEY
  if (hotkey !== NO_HOTKEY && !validHotkey(hotkey)) throw new Error(HOTKEY_RULE('暂停'))
  const resume = value['resumeHotkey']
  const resumeHotkey = resume === undefined || resume === null || resume === '' ? undefined : resume
  if (resumeHotkey !== undefined && !validHotkey(resumeHotkey)) throw new Error(HOTKEY_RULE('恢复'))
  if (resumeHotkey === hotkey) throw new Error('恢复快捷键不能和暂停快捷键相同')
  const display = value['display']
  if (display !== undefined && (!isRecord(display) || typeof display['actions'] !== 'boolean' || typeof display['countdown'] !== 'boolean')) {
    throw new Error('气泡显示设置无效')
  }
  const burst = parseBurst(value['burst'])
  const climaxPrompts = parseClimaxPrompts(value['climaxPrompts'])
  const safetyWords = value['safetyWords'] === undefined ? undefined : parseSafetyWords(value['safetyWords'])
  const pacing = value['pacing'] === undefined ? undefined : parsePacing(value['pacing'])
  return {
    enabled: value['enabled'] !== false, authorized: value['authorized'], motion: parseMotion(value['motion']), behavior, hotkey,
    ...value['deviceIntroSeen'] === undefined ? {} : { deviceIntroSeen: value['deviceIntroSeen'] },
    ...value['deviceConnected'] === undefined ? {} : { deviceConnected: value['deviceConnected'] },
    ...proactivityTexts === undefined ? {} : { proactivityTexts },
    ...resumeHotkey === undefined ? {} : { resumeHotkey },
    ...burst === undefined ? {} : { burst },
    ...climaxPrompts === undefined ? {} : { climaxPrompts },
    ...safetyWords === undefined ? {} : { safetyWords },
    ...pacing === undefined ? {} : { pacing },
    ...display === undefined ? {} : { display: { actions: display['actions'] as boolean, countdown: display['countdown'] as boolean } },
  }
}

/**
 * 读盘时，快捷键不再合法（例如早先存的 Ctrl+X，后来被列为编辑键）只去掉这个键，不连累授权和行程速度。
 * 下次保存时写回。
 */
function withUsableHotkeys(saved: unknown, warn: Warn): unknown {
  if (!isRecord(saved)) return saved
  const next: Record<string, unknown> = { ...saved }
  const hotkey = saved['hotkey']
  if (hotkey !== undefined && hotkey !== NO_HOTKEY && !validHotkey(hotkey)) {
    warn(`toy-buttplug: 暂停快捷键 ${String(hotkey)} 不能再用，已去掉，请在设置里重新录入`)
    next['hotkey'] = NO_HOTKEY
  }
  const resume = saved['resumeHotkey']
  if (resume !== undefined && resume !== null && resume !== '' && (!validHotkey(resume) || resume === next['hotkey'])) {
    warn(`toy-buttplug: 恢复快捷键 ${String(resume)} 不能再用，已去掉`)
    delete next['resumeHotkey']
  }
  return next
}

export class SettingsStore {
  private current: ToySettings

  constructor(private readonly file: string, warn: Warn) {
    const saved = readJson(file, warn)
    let settings = defaultSettings()
    if (saved !== undefined) {
      try {
        settings = parseSettings(withUsableHotkeys(saved, warn))
      } catch (error) {
        warn(`toy-buttplug: ${file} 无效，按未授权的默认设置运行：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.current = settings
  }

  static at(dir: string, warn: Warn): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'), warn)
  }

  reset(): void { this.current = defaultSettings() }

  get value(): ToySettings {
    return this.current
  }

  /** 校验后写盘。不合法时抛出，原设置不变。 */
  save(value: unknown): ToySettings {
    const next = parseSettings(value)
    writeJson(this.file, next)
    this.current = next
    return next
  }
}
