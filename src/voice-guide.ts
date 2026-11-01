/** 用户点“怎么做”后才作为新标准会话的普通用户消息发送；不注册为 QQbot 系统提示词。 */
import { ENGINE_KIND_LABELS, type EngineKind } from './voice-types.ts'

export type VoiceGuideRoute = EngineKind | 'auto'

const ROUTES: Record<EngineKind, string> = {
  fish: `【第一次用：Fish Audio】
1. 注册登录 https://fish.audio/zh-CN/ ，到 https://fish.audio/zh-CN/app/developers/ 创建 API 密钥。
2. DSH 设置 → QQ Bot → 语音 → 打开“启用语音” → 添加服务 → Fish Audio，把密钥填进“API 密钥”，保存。填好回我一声。
3. 到 https://fish.audio/zh-CN/app/discovery/ 挑喜欢的音色，点音色右边的三个小点，复制链接或 ID。
4. 语音页 → 添加音色，起个名字，把复制的内容粘到“音色链接或 ID”，保存后点“试听”。
试听连不上时，在 Fish 服务里打开“使用代理”，填 http://127.0.0.1:端口（端口在科学上网软件“设置 → 端口设置”里看 HTTP 或混合端口）。`,
  openai: `【已有 OpenAI 兼容语音服务】
语音 → 添加服务 → OpenAI 兼容接口：服务地址填基础地址（通常含 /v1）或完整 /audio/speech，模型填服务的语音模型，有密钥就填进“API 密钥”。添加音色时，“服务中的音色名称”填服务要求的 voice。服务要能直接返回音频。`,
  'gpt-sovits': `【已有 GPT-SoVITS】
语音 → 添加服务 → GPT-SoVITS：服务地址填 api_v2 地址（常见 http://127.0.0.1:9880），不是 WebUI 页面。添加音色时填参考音频路径（运行 GPT-SoVITS 那台电脑上的路径）、音频里说的文字、参考语言和朗读语言。服务要先启动并加载好模型。`,
}

/** 只接受枚举，不接收角色、地址、名称、已有配置或凭据，避免把私密信息拼进会话。 */
export function voiceGuidePrompt(kind: VoiceGuideRoute = 'auto'): string {
  const route = kind === 'auto'
    ? `先用工具看看我电脑上有没有 GPT-SoVITS 之类的语音服务、插件里有没有已配好的语音服务，再问我第一个问题：之前搞过 AI 语音吗？
有现成的服务就按对应方式接上；第一次碰就走 Fish Audio。
${ROUTES['gpt-sovits']}
${ROUTES.openai}
${ROUTES.fish}`
    : `${ROUTES[kind]}${kind === 'fish' ? '' : `\n没有现成服务时改走：\n${ROUTES.fish}`}`
  return `帮我在 DSH 的 dsh-qqbot 插件里配置${kind === 'auto' ? '' : `“${ENGINE_KIND_LABELS[kind]}”`}语音，让我的角色能发语音。用中文，一步一步带我做，每次只问一个问题。
${route}
试听成功后：DSH 设置 → QQ Bot → 角色，给我的角色选上这个音色并保存（也可以在语音页的音色上点“用于角色”）。之后在 QQ Bot 会话里让角色发语音就行。`
}
