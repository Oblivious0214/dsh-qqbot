/** 角色分享的唯一字段表与 v1/v2 校验；无 Node、文件、宿主或 UI 依赖。 */
import { isRecord } from './json-record.ts'
import { CONFIG_MAX_BYTES } from './config-types.ts'
import { validatePreset, type PresetDraft } from './preset-validation.ts'
import { validateRoleDraft, type RoleDraft } from './role-validation.ts'
import { jsonData, validateConfig } from './role-dynamics/validate.ts'
import type { RoleDynamicsConfig } from './role-dynamics/types.ts'
import type { LibraryRole, LibraryView } from './library-types.ts'
export interface PackageRole extends Omit<RoleDraft, 'id' | 'dynamics' | 'dynamicsBaseRevision' | 'dynamicsRenames' | 'resetDynamics' | 'voice' | 'memePacks'> { readonly dynamics?: RoleDynamicsConfig }
export interface ConfigPackage { readonly format: 'dsh-qqbot-config'; readonly version: 1 | 2; readonly presets: readonly PresetDraft[]; readonly roles: readonly PackageRole[] }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label}含有不支持的字段，请使用 QQ Bot 配置包格式`)
}

export function parseConfigurationPackage(value: unknown): ConfigPackage {
  jsonData(value)
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength > CONFIG_MAX_BYTES) throw new TypeError('配置文件不能超过 10 MB')
  if (!isRecord(value) || value['format'] !== 'dsh-qqbot-config' || ![1, 2].includes(value['version'] as number)) {
    throw new TypeError('不是支持的 QQ Bot 配置包，请使用格式为 dsh-qqbot-config、版本为 1 或 2 的 JSON 文件')
  }
  keys(value, ['format', 'version', 'presets', 'roles'], '配置包')
  const items = (key: string): unknown[] => {
    const list = value[key] ?? []
    if (!Array.isArray(list) || list.length > 100) throw new TypeError('每个配置包最多包含 100 个角色和 100 份预设')
    return list
  }
  const presets = items('presets').map(item => {
    if (!isRecord(item)) throw new TypeError('预设格式无效')
    keys(item, ['name', 'head', 'mid', 'tail'], '预设')
    const draft = validatePreset({ ...item, mid: item['mid'] ?? '', tail: item['tail'] ?? '' }, true)
    if (/[\u0000-\u001f\u007f]/.test(draft.name)) throw new TypeError('预设名称不能包含换行或控制字符')
    return draft
  })
  const roles = items('roles').map(item => {
    if (!isRecord(item)) throw new TypeError('角色格式无效')
    keys(item, ['name', 'description', 'persona', 'preset', 'memeFrequency', 'memeTags', 'memePrompt',
      'proactivity', 'proactivityTexts', 'motionActions', 'motionRanges', ...(value['version'] === 2 ? ['dynamics'] : [])], '角色')
    if (item['dynamics'] === null) throw new TypeError('分享包 dynamics 必须是完整对象')
    const role = validateRoleDraft({ ...item, description: item['description'] ?? '',
      persona: typeof item['persona'] === 'string' ? item['persona'].replace(/\r\n/g, '\n') : item['persona'] })
    if (/[\u0000-\u001f\u007f]/.test(role.name)) throw new TypeError('角色名称不能包含控制字符')
    return role
  })
  for (const [label, list] of [['预设', presets], ['角色', roles]] as const) {
    if (new Set(list.map(item => item.name)).size !== list.length) throw new TypeError(`配置包里有重名${label}，请先修改名称`)
  }
  if (presets.length + roles.length === 0) throw new TypeError('配置包里没有可导入的角色或预设')
  return { format: 'dsh-qqbot-config', version: value['version'] as 1 | 2, presets, roles: roles as PackageRole[] }
}


export function serializeRoleConfiguration(role: Pick<LibraryRole, 'name' | 'description' | 'persona'> & Partial<LibraryRole>): PackageRole {
  if (role.dynamicsError) throw new TypeError(role.dynamicsError)
  const { name, description, persona, memeFrequency, memeTags, memePrompt, proactivity, proactivityTexts, motionActions, motionRanges, dynamics } = role
  // JSON removes only absent optional properties; validate again at the public package boundary.
  return JSON.parse(JSON.stringify({ name, description, persona, memeFrequency, memeTags, memePrompt, proactivity, proactivityTexts, motionActions, motionRanges, dynamics: dynamics === undefined ? undefined : validateConfig(dynamics) })) as PackageRole
}
export function serializeConfigurationPackage(view: Pick<LibraryView, 'roles' | 'presets'> & Partial<Pick<LibraryView, 'currentPreset'>>, kind: 'roles' | 'presets' | 'all' = 'all'): ConfigPackage {
  const roles = kind === 'presets' ? [] : view.roles.map(role => serializeRoleConfiguration(role))
  const presets = (kind === 'roles' ? [] : view.presets).map(({ name, head, mid, tail }) => ({ name, head, mid, tail }))
  return parseConfigurationPackage({ format: 'dsh-qqbot-config', version: roles.some(r => r.dynamics !== undefined) ? 2 : 1, roles, presets })
}
