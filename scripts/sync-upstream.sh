#!/usr/bin/env bash
#
# 同步作者上游（upstream）更新到你的 fork（origin）和功能分支。
# 使用 merge（而非 rebase）：不改写已推送的 commit，更安全。
#
# 用法:
#   ./scripts/sync-upstream.sh                      # 默认功能分支 feat/fanfic-init-file-upload
#   ./scripts/sync-upstream.sh my-other-branch      # 指定其他功能分支
#
# 前提:
#   origin   -> 你的 fork   (https://github.com/hy134300/inkos.git)
#   upstream -> 作者仓库    (https://github.com/Narcooo/inkos.git)
#
set -euo pipefail

FEATURE_BRANCH="${1:-feat/fanfic-init-file-upload}"
MAIN_BRANCH="master"
UPSTREAM="upstream"
ORIGIN="origin"

c_red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
c_cyan()   { printf '\033[0;36m%s\033[0m\n' "$*"; }
step()     { printf '\n\033[0;36m==> %s\033[0m\n' "$*"; }

# ---------- 0. 前置检查 ----------
step "检查环境"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  c_red "错误：当前目录不是 Git 仓库。"
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"

for remote in "$UPSTREAM" "$ORIGIN"; do
  if ! git remote get-url "$remote" >/dev/null 2>&1; then
    c_red "错误：缺少 remote '$remote'。请先配置："
    echo "  git remote add upstream https://github.com/Narcooo/inkos.git"
    echo "  git remote set-url origin https://github.com/hy134300/inkos.git"
    exit 1
  fi
done

if ! git diff --quiet || ! git diff --cached --quiet; then
  c_red "错误：工作区有未提交的改动。请先 git add && git commit，或 git stash 后再运行。"
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/$FEATURE_BRANCH"; then
  c_red "错误：本地分支 '$FEATURE_BRANCH' 不存在。"
  echo "当前本地分支："
  git branch --format='  %(refname:short)'
  exit 1
fi

c_cyan "origin   = $(git remote get-url "$ORIGIN")"
c_cyan "upstream = $(git remote get-url "$UPSTREAM")"
c_cyan "功能分支 = $FEATURE_BRANCH"

# ---------- 1. 拉取作者更新 ----------
step "拉取作者最新提交 (git fetch upstream)"
git fetch "$UPSTREAM" --prune
UPSTREAM_SHA="$(git rev-parse "$UPSTREAM/$MAIN_BRANCH")"
c_cyan "上游 $MAIN_BRANCH = ${UPSTREAM_SHA:0:12}"

# ---------- 2. 快进 fork 的 master ----------
step "更新本地 $MAIN_BRANCH 并推送到你的 fork"
git checkout "$MAIN_BRANCH"
if git merge --ff-only "$UPSTREAM/$MAIN_BRANCH"; then
  git push "$ORIGIN" "$MAIN_BRANCH"
else
  c_yellow "警告：$MAIN_BRANCH 无法快进（你的 fork master 上有自己的提交）。"
  c_yellow "请手动处理后重新运行："
  echo "  git rebase $UPSTREAM/$MAIN_BRANCH    # 或 git merge $UPSTREAM/$MAIN_BRANCH"
  exit 1
fi

# ---------- 3. 把作者更新 merge 进功能分支 ----------
step "将 $UPSTREAM/$MAIN_BRANCH 合并进 $FEATURE_BRANCH"
git checkout "$FEATURE_BRANCH"
if ! git merge --no-edit "$UPSTREAM/$MAIN_BRANCH"; then
  c_red "merge 出现冲突！请按以下步骤处理："
  echo "  1. 手动解决冲突文件（通常是 server.ts / ImportManager.tsx）"
  echo "  2. git add ."
  echo "  3. git commit --no-edit"
  echo "  4. 重新运行本脚本（或手动 git push origin $FEATURE_BRANCH）"
  exit 1
fi

# ---------- 4. 推送功能分支 ----------
step "推送功能分支到你的 fork"
git push "$ORIGIN" "$FEATURE_BRANCH"

# ---------- 完成 ----------
printf '\n'
c_green "同步完成！当前分支：$FEATURE_BRANCH"
c_cyan "作者更新已合入，你的改动历史完整保留。"
