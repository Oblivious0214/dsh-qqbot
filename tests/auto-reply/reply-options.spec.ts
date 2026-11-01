import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPTIONS_OPEN, OPTIONS_CLOSE, splitReplyOptions, projectReplyOptions, parseReplyOptions } from '../../src/auto-reply/reply-options.ts'
import { QuickReplySettings } from '../../src/auto-reply/quick-settings.ts'
import { QuickReplyState } from '../../src/client/auto-reply/quick-state.ts'
import { QUICK_REPLY_PROMPT } from '../../src/auto-reply/prompts.ts'
import type { QuickReplyView } from '../../src/auto-reply/types.ts'
import { decodeReply } from '../../src/client/decode.ts'
import { voiceBubbles, stageBlock } from '../../src/client/voice-bubbles.ts'

const replies = ['后来呢？', '听起来很有趣', '你最喜欢哪里？']
const suffix = `${OPTIONS_OPEN}${JSON.stringify({ replies })}${OPTIONS_CLOSE}`
describe('主回复末尾的快捷选项', () => {
  it('普通文字与分段都能分离选项，原正文和历史字符串不变', () => {
    for (const body of ['今天去公园了。', '[qq]{"version":1,"stages":[{"text":"第一句","motion":{"action":"slide"}},{"text":"第二句"}]}[/qq]']) {
      const source = `${body}\n${suffix}`
      expect(splitReplyOptions(source, false)).toEqual({ body: body + '\n', replies })
      expect(source.endsWith(suffix)).toBe(true)
    }
  })
  it('流式每个截断点都不暴露选项；等完成再显示三条', () => {
    for (let i = 2; i <= suffix.length; i++) {
      const result = splitReplyOptions(`正文\n${suffix.slice(0, i)}`, true)
      expect(result).toEqual({ body: '正文\n', replies: [] })
    }
    expect(splitReplyOptions('正文\n[qq-repl', false)).toEqual({ body: '正文\n', replies: [] })
    expect(splitReplyOptions(`正文\n${suffix}`, false).replies).toEqual(replies)
  })
  it('非法、重复、超长、额外字段或未闭合的选项不显示，正文保留', () => {
    const invalid = ['oops', '{}', '{"replies":[]}', '{"replies":["一","一","三"]}',
      JSON.stringify({ replies: ['甲', {}, '丙'] }), JSON.stringify({ replies: ['甲', 'x'.repeat(121), '丙'] }),
      JSON.stringify({ replies: ['甲', '[qq]x[/qq]', '丙'] }), JSON.stringify({ replies: ['甲', 'x\ny', '丙'] }),
      JSON.stringify({ replies, motion: {} })]
    for (const raw of invalid) {
      expect(parseReplyOptions(raw)).toEqual([])
      expect(splitReplyOptions(`正文\n${OPTIONS_OPEN}${raw}${OPTIONS_CLOSE}`, false)).toEqual({ body: '正文\n', replies: [] })
    }
    // 对象后多写的括号和换行截掉。
    const extra = `${OPTIONS_OPEN}${JSON.stringify({ replies })}]\n${OPTIONS_CLOSE}`
    expect(splitReplyOptions(`正文\n${extra}`, false)).toEqual({ body: '正文\n', replies })
    for (const bad of [`${OPTIONS_OPEN}{`, `${suffix}\n更多内容`, `${suffix}\n${suffix}`]) {
      expect(splitReplyOptions(`正文\n${bad}`, false)).toEqual({ body: '正文\n', replies: [] })
    }
  })
  it('代码和引用里的示例保持正文，不当作可点击选项', () => {
    for (const source of [`\`\`\`text\n${suffix}\n\`\`\``, `> ${suffix}`, `文字中提到 ${suffix}`]) {
      expect(splitReplyOptions(source, false)).toEqual({ body: source, replies: [] })
    }
    expect(splitReplyOptions(`\`\`\`\n示例\n\`\`\`\n${suffix}`, false).replies).toEqual(replies)
  })
  it('跨多个文本块清理后，保留图片位置且不把候选传入朗读', () => {
    const blocks = [{ kind: 'text', text: '正文\n[qq-rep' }, { kind: 'image', src: 'mock' }, { kind: 'text', text: suffix.slice(7) }]
    const projected = projectReplyOptions(blocks, false)
    expect(projected.replies).toEqual(replies)
    expect(projected.blocks).toEqual([{ kind: 'text', text: '正文\n' }, { kind: 'image', src: 'mock' }])
    const bubbles = voiceBubbles(projected.blocks as any, { voice: 'fake', revision: '1' } as any, 'test', 'all')
    expect(bubbles.map(b => b.clip?.text).filter(Boolean)).toEqual(['正文'])
    expect(blocks[0]!.text).toContain('[qq-rep')
  })
  it('分段与动作不增加条目，全部语音模式只读取原有正文', () => {
    const body = '[qq]{"version":1,"stages":[{"text":"原有正文","voice":true,"motion":{"action":"slide"}}]}[/qq]'
    const split = splitReplyOptions(body + '\n' + suffix, false)
    const decoded = decodeReply(split.body, false, null)
    expect(decoded.stream?.stages).toHaveLength(1)
    expect(decoded.stream?.stages[0]?.motion).toEqual({ action: 'slide' })
    const bubbles = voiceBubbles(decoded.stream!.stages.map(stageBlock), { voice: 'fake', revision: '1' } as any, 'test', 'all')
    expect(bubbles.map(b => b.clip?.text)).toEqual(['原有正文'])
  })
})

describe('按会话保存快捷选项勾选状态', () => {
  it('点击方式默认发送，独立保存并重载，不影响规则、开关或其他会话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-click-'))
    try {
      const settings = new QuickReplySettings(dir, () => {})
      expect(settings.clickMode('a')).toBe('send')
      settings.setClickMode('a', 'draft'); settings.setPrompt('a', '三个建议'); settings.set('a', false)
      const reloaded = new QuickReplySettings(dir, () => {})
      expect(reloaded.clickMode('a')).toBe('draft'); expect(reloaded.clickMode('b')).toBe('send')
      expect(reloaded.get('a')).toBe(false); expect(reloaded.promptView('a').prompt).toBe('三个建议')
      for (const bad of ['', 'auto', null, true]) expect(() => reloaded.setClickMode('a', bad)).toThrow('点击方式')
      expect(reloaded.clickMode('a')).toBe('draft')
      reloaded.setClickMode('a', 'send')
      expect(new QuickReplySettings(dir, () => {}).clickMode('a')).toBe('send')
      reloaded.setClickMode('a', 'draft'); reloaded.clear(); expect(reloaded.clickMode('a')).toBe('send')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('点击方式写盘失败保留原选择', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-click-'))
    try {
      const settings = new QuickReplySettings(dir, () => {})
      settings.setClickMode('a', 'draft')
      const file = join(dir, 'quick-replies.json'); rmSync(file); mkdirSync(file)
      expect(() => settings.setClickMode('a', 'send')).toThrow()
      expect(settings.clickMode('a')).toBe('draft')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('旧读取不能覆盖已保存的点击方式，失败及清理保留正确状态', async () => {
    let finish!: (view: QuickReplyView) => void
    const request = vi.fn(async (body: Record<string, unknown>): Promise<QuickReplyView> => {
      if (body['action'] === 'quick.get') return new Promise(resolve => { finish = resolve })
      return { enabled: true, clickMode: 'send' }
    })
    const state = new QuickReplyState(request)
    const old = state.refresh('a'); await state.setClickMode('a', 'send')
    finish({ enabled: true, clickMode: 'draft' }); await old
    expect(state.clickMode('a')).toBe('send'); expect(state.clickMode('b')).toBe('send')
    request.mockRejectedValueOnce(new Error('offline'))
    await expect(state.setClickMode('a', 'draft')).rejects.toThrow('offline')
    expect(state.clickMode('a')).toBe('send')
    state.clearCache(); expect(state.clickMode('a')).toBe('send'); state.dispose()
  })
  it('默认开启，关闭选择跨重启保存且不影响其他会话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-options-'))
    try {
      const first = new QuickReplySettings(dir, () => {})
      expect(first.get('a')).toBe(true); expect(first.prompt('a')).toBe(QUICK_REPLY_PROMPT)
      first.set('a', false)
      const second = new QuickReplySettings(dir, () => {})
      expect(second.get('a')).toBe(false); expect(second.get('b')).toBe(true)
      expect(second.prompt('a')).toBe('')
      second.set('a', true)
      expect(new QuickReplySettings(dir, () => {}).prompt('a')).toBe(QUICK_REPLY_PROMPT)
      second.clear(); expect(second.get('a')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('旧开关文件采用开启默认，新保存的关闭状态与自定义文本都可重读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-options-'))
    try {
      writeFileSync(join(dir, 'quick-replies.json'), JSON.stringify({ version: 1, sessions: ['a'] }))
      const settings = new QuickReplySettings(dir, () => {})
      expect(settings.get('a')).toBe(true); expect(settings.get('new')).toBe(true)
      settings.setPrompt('a', '根据聊天内容起草三个回复建议。')
      settings.set('a', false)
      const reloaded = new QuickReplySettings(dir, () => {})
      expect(reloaded.get('a')).toBe(false)
      expect(reloaded.promptView('a').prompt).toContain('根据聊天内容')
      expect(reloaded.promptView('other').prompt).toBe(QUICK_REPLY_PROMPT)
      reloaded.set('a', true); expect(reloaded.prompt('a')).toContain('根据聊天内容')
      reloaded.setPrompt('a', QUICK_REPLY_PROMPT)
      expect(new QuickReplySettings(dir, () => {}).prompt('a')).toBe(QUICK_REPLY_PROMPT)
      reloaded.setPrompt('a', '清理前的文本'); reloaded.clear()
      expect(reloaded.prompt('a')).toBe(QUICK_REPLY_PROMPT)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('无效文本和写盘失败不覆盖内存或已保存的开关及提示词', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-options-'))
    try {
      const settings = new QuickReplySettings(dir, () => {})
      settings.setPrompt('a', '保存的回复建议'); settings.set('a', false)
      for (const bad of ['', '   ', 'a'.repeat(6001), 123]) expect(() => settings.setPrompt('a', bad)).toThrow('提示词')
      expect(new QuickReplySettings(dir, () => {}).promptView('a').prompt).toBe('保存的回复建议')
      const file = join(dir, 'quick-replies.json')
      rmSync(file); mkdirSync(file)
      expect(() => settings.setPrompt('a', '无法写入的内容')).toThrow()
      expect(() => settings.set('a', true)).toThrow()
      expect(settings.get('a')).toBe(false)
      expect(settings.promptView('a').prompt).toBe('保存的回复建议')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('客户端只读写开关，过期读取不会覆盖刚保存的选择', async () => {
    let finish!: (value: { enabled: boolean }) => void
    const request = vi.fn(async (body: Record<string, unknown>) => {
      if (body['action'] === 'quick.get') return new Promise<{ enabled: boolean }>(resolve => { finish = resolve })
      return { enabled: true }
    })
    const state = new QuickReplyState(request)
    const old = state.refresh('s'); await state.set('s', true); finish({ enabled: false }); await old
    expect(state.get('s')).toBe(true)
    expect(request.mock.calls.map(([body]) => body['action'])).toEqual(['quick.get', 'quick.set'])
    state.dispose()
  })
  it('保存失败保留旧值，卸载后忽略晚到请求', async () => {
    const request = vi.fn(async () => ({ enabled: true }))
    const state = new QuickReplyState(request); await state.refresh('s')
    request.mockRejectedValueOnce(new Error('offline'))
    await expect(state.set('s', false)).rejects.toThrow('offline')
    expect(state.get('s')).toBe(true)
    let finish!: (value: { enabled: boolean }) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = state.refresh('s'); state.dispose(); finish({ enabled: true }); await pending
    expect(state.get('s')).toBe(false)
  })
})
