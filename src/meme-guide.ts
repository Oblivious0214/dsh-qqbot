/** 点击教程后作为新标准会话的普通用户消息发送，不进入 QQbot 系统提示词。 */
export function memeGuidePrompt(): string {
  return `帮我给 DSH 里 dsh-qqbot 插件的角色配上表情包。用中文，一步一步带我做，每次只问一个问题，能用工具查的直接查。
先查 dsh-meme 插件（https://github.com/yyh-001/dsh-meme）装了没有，没装就带我在“插件 → 添加插件”里输入 dsh-meme 安装，要重启 DSH 时告诉我。
然后问我：想用现成的表情包，还是导入自己 QQ 里收藏的？
【现成的】DSH 设置 → 表情包 → “发现”，挑喜欢的安装并启用。
【QQ 收藏】在装 QQ 的电脑上用 QQFavoriteExtract（https://github.com/VanillaNahida/QQFavoriteExtract/releases ）：先登录 QQ、把收藏翻到底让图片加载完，在工具里选账号和收藏，导出到新文件夹，打成 ZIP，再到 DSH 设置 → 表情包 → “图库 → 导入图库”导入并启用。
最后：DSH 设置 → QQ Bot → 角色，选角色，展开“表情包”，勾选“优先图库”，按喜好选标签和频率，点“保存”。设置页是装插件前打开的就关掉重开。回到 QQ Bot 会话让角色发张表情试试。`
}
