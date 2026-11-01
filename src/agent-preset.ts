import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

type PresetReader = Partial<Pick<Context['agentPresets'], 'presetForSession' | 'composedPreset'>>
type LiveAgent = { session: Parameters<NonNullable<PresetReader['presetForSession']>>[0]; ctx: Context }

/** 不同宿主构建的预设读取接口不同；回退只读实时绑定，不读创建时的 header。 */
export function presetForAgent(presets: PresetReader, agent: LiveAgent): string | null {
  if (typeof presets.presetForSession === 'function') return presets.presetForSession(agent.session)
  if (typeof presets.composedPreset === 'function') return presets.composedPreset(agent.ctx) ?? null
  return null
}
