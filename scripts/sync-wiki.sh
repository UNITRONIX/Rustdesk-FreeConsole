#!/usr/bin/env bash
# Sync docs/wiki/ to GitHub Wiki (BetterDesk.wiki.git)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIKI_SRC="${REPO_ROOT}/docs/wiki"
WIKI_REPO="${WIKI_REPO:-https://github.com/UNITRONIX/BetterDesk.wiki.git}"
WIKI_DIR="${WIKI_DIR:-${TMPDIR:-/tmp}/BetterDesk-wiki-sync}"
COMMIT_MSG="${1:-Sync wiki from docs/wiki/}"

if [[ ! -d "$WIKI_SRC" ]]; then
  echo "error: wiki source not found: $WIKI_SRC" >&2
  exit 1
fi

if [[ ! -d "$WIKI_DIR/.git" ]]; then
  git clone "$WIKI_REPO" "$WIKI_DIR"
else
  git -C "$WIKI_DIR" pull --rebase origin master
fi

rsync -a --delete --exclude '.git' "$WIKI_SRC/" "$WIKI_DIR/"

cd "$WIKI_DIR"
if git diff --quiet && git diff --cached --quiet; then
  echo "wiki already up to date"
  exit 0
fi

git add -A
git commit -m "$COMMIT_MSG"
git push origin master
echo "wiki pushed to $WIKI_REPO"
