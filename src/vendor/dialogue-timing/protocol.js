// Shared display envelope. Motion extensions are opaque here; only the device
// plugin may interpret them, after its separate session authorization checks.
export const SEGMENT_PROMPT = `QQ 分段与显示间隔：
已开启分段回复。需要分段或安排说话节奏时，使用一个 [qq] JSON 块，正文放在 stages 的 text 中，不在块外重复：
[qq]{"version":1,"stages":[{"text":"先说这一句。","durationMs":1200},{"text":"稍等一下，再接着说。","durationMs":3000},{"text":"最后这一段。","durationMs":1000}]}[/qq]
每个 text 是一个完整气泡，可以含一句或多句话。第一段立即显示；durationMs 是本段显示后到下一段出现的等待时间，单位毫秒，可按内容、停顿和情绪自行安排。范围 0–120000，最多 20 段，总计不超过 600000 毫秒；通常使用较短间隔，确有长停顿才延长。
没有特别节奏要求时可以省略 durationMs，界面会按用户原有间隔设置显示；无需分段时直接正常回复。
整个回复只输出一个 [qq] 块，不放在代码块或引用中。只有得到其他已启用功能的规则时，才在对应段落添加其扩展字段。此分段协议本身不授权任何设备动作。`;

export function proseOnly(text) {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}
export function parseTimedReply(text) {
  const matches = [...proseOnly(text).matchAll(/\[qq\]([\s\S]*?)\[\/qq\]/g)];
  if (!matches.length) return null;
  if (matches.length !== 1 || matches[0][1].length > 30000) throw Error('分段回复格式无效。');
  let value;
  try { value = JSON.parse(matches[0][1]); } catch { throw Error('分段回复格式无效。'); }
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'stages,version'
    || !Array.isArray(value.stages) || !value.stages.length || value.stages.length > 20) throw Error('分段回复格式无效。');
  let duration = 0;
  for (const stage of value.stages) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)
      || Object.keys(stage).some(key => !['text', 'durationMs', 'cycles', 'motion'].includes(key))
      || typeof stage.text !== 'string' || !stage.text.trim() || stage.text.length > 4000
      || /\[\/?(?:qq|dsh)\]/.test(stage.text)
      || stage.cycles !== undefined && (!Number.isInteger(stage.cycles) || stage.cycles < 1 || stage.cycles > 100 || stage.durationMs !== undefined)
      || stage.durationMs !== undefined && (!Number.isInteger(stage.durationMs) || stage.durationMs < 0 || stage.durationMs > 120000))
      throw Error('段落文字或间隔无效。');
    duration += stage.durationMs ?? 10000; // Reserve the largest fallback interval.
  }
  if (duration > 600000) throw Error('分段回复总时长过长。');
  return value;
}

export function stripTimedReply(text) {
  return text.replace(/\[qq\][\s\S]*?(?:\[\/qq\]|$)/g, '')
    .replace(/\[(?:q(?:q(?:\])?)?)?$/g, '');
}
