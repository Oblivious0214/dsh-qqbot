# 从源码开发

普通安装在 DSH 的“添加插件”中填写仓库地址：https://github.com/Oblivious0214/dsh-qqbot 。安装入口使用默认分支，不追加版本标签。用于安装的公开分支需随版本提交 lib 构建产物；本地开发分支仍忽略 lib。不发布 npm。

## 环境与布局

Node.js 24、pnpm 10。宿主基线：DeepSeek Harness 0.2.1-rc.3，提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60。开发依赖链接到已准备好的宿主源码，目录按下列方式放置：

```text
workspace/
  plugins/dsh-qqbot/
  qqbot/src/deepseek-harness/
```

从 workspace 开始：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git qqbot/src/deepseek-harness
git -C qqbot/src/deepseek-harness checkout 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
git clone https://github.com/Oblivious0214/dsh-qqbot.git plugins/dsh-qqbot
cd qqbot/src/deepseek-harness
pnpm install
pnpm run build
cd ../../../plugins/dsh-qqbot
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack --out ../../dsh-qqbot-0.37.0.tgz
```

宿主准备方式以 [官方源码运行文档](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/README.zh.md#run-from-source) 为准。插件运行时与宿主共用 cordis、compaction-basic 和 llm；它们是 peer 依赖，不打入插件。

清理旧 lib 产物后再构建；测试使用独立临时资料目录和模拟设备。设备及手机的真机验证范围见 [发布说明](https://github.com/Oblivious0214/dsh-qqbot/releases/tag/v0.36.2)。
