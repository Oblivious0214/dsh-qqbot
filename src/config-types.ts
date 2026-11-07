/** 可分享配置包只使用名称；本机内部键、凭据和授权不进入配置包。 */
export const CONFIG_PATH = '/api/qqbot/config'
export const CONFIG_MAX_BYTES = 10 * 1024 * 1024

export interface ConfigOptions {
  readonly presets: boolean
  readonly roles: boolean
  readonly conflict: 'skip' | 'copy'
}

/** 缺少或为空的分类不参与导入；完整格式仍由服务端校验。 */
export function configImportContents(value: unknown): Pick<ConfigOptions, 'presets' | 'roles'> {
  const config = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    presets: Array.isArray(config['presets']) && config['presets'].length > 0,
    roles: Array.isArray(config['roles']) && config['roles'].length > 0,
  }
}

export interface ConfigEntry {
  readonly kind: 'preset' | 'role'
  readonly name: string
  readonly target: string
  readonly status: 'add' | 'skip'
}

export interface ConfigPreview {
  readonly entries: readonly ConfigEntry[]
  readonly revision: string
}

export type ConfigRequest = {
  readonly action: 'preview' | 'import'
  readonly config: unknown
  readonly options: ConfigOptions
  readonly revision?: string
}

export interface ConfigResult {
  readonly presets: number
  readonly roles: number
  readonly skipped: number
}
