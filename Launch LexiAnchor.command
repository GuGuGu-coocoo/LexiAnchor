#!/bin/bash

# Finder starts .command files from an arbitrary working directory.
LEXIANCHOR_REPOSITORY="$(cd "$(dirname "$0")" && pwd -P)"
cd "$LEXIANCHOR_REPOSITORY" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH:$HOME/Library/pnpm"
export COREPACK_ENABLE_NETWORK=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

printf '\nLexiAnchor 源码测试版 / Source test app\n'
printf '此启动器不会生成安装包，也不会安装或下载依赖。\n'
printf 'No app packaging, dependency installation, or dependency downloads.\n\n'

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  printf '需要 Node.js 24 和 pnpm 11。安装后，在本项目执行 pnpm install，再重新双击。\n'
  printf 'Node.js 24 and pnpm 11 are required. Install them, run pnpm install here, then retry.\n'
  read -r -p '按回车关闭 / Press Enter to close: ' LEXIANCHOR_CLOSE
  exit 1
fi

node "$LEXIANCHOR_REPOSITORY/tools/reader-source-smoke.mjs" launch --pnpm "$(command -v pnpm)"
LEXIANCHOR_RESULT=$?
printf '\n源码测试进程已结束 / Source test process has ended.\n'
read -r -p '按回车关闭 / Press Enter to close: ' LEXIANCHOR_CLOSE
exit "$LEXIANCHOR_RESULT"
