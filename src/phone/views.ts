import { PHONE_LOGIN } from '../phone-types.ts'

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function loginPage(error = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>QQ Bot · 手机连接</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f3f6fb;color:#24334a;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{width:min(100%,400px);padding:28px;background:white;border:1px solid #e0e7f0;border-radius:20px}h1{font-size:24px;margin:0 0 12px}p{color:#58687c}label{display:block;margin-bottom:8px}input,button{width:100%;font:inherit;border-radius:10px;padding:12px}input{border:1px solid #bbc9dc;min-width:0}button{margin-top:18px;border:0;background:#2477de;color:white;cursor:pointer}.error{color:#ac2736;overflow-wrap:anywhere}
</style></head><body><main><h1>QQ Bot</h1><p>继续电脑上的聊天</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}<form method="post" action="${PHONE_LOGIN}"><label for="code">访问码</label><input id="code" name="code" type="password" autocomplete="current-password" required maxlength="128" placeholder="输入电脑上显示的访问码"><button type="submit">进入聊天</button></form></main></body></html>`
}
