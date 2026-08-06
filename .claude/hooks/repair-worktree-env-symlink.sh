#!/usr/bin/env bash
#
# SessionStart hook — repair apps/dashboard/.env.local in a fresh worktree.
#
# apps/dashboard/.env.local is a symlink in the main checkout
# (-> ../../.env.local). .worktreeinclude lists it, but the worktree copier
# only copies real file content, not symlinks — so that entry never actually
# arrives, even though .worktreeinclude suggests it will. The root .env.local
# (a real file) does arrive, which is what makes this fixable here.
#
# This recreates apps/dashboard/.env.local as a relative symlink whenever:
#   * the session's cwd is inside a worktree under .claude/worktrees/ (never
#     the main checkout, never a worktree added by hand elsewhere),
#   * the worktree's own root .env.local is present, and
#   * apps/dashboard/.env.local is missing or not already a symlink.
#
# The symlink is relative (../../.env.local), not absolute, so it resolves to
# *this* worktree's own .env.local rather than the main checkout's.
#
# See CLAUDE.md and the "worktree-needs-env-local" memory for the full story.

set -uo pipefail

command -v git >/dev/null 2>&1 || exit 0

toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
repo=${common_dir%/.git}

# Only act inside a worktree under .claude/worktrees/.
case "$toplevel" in
  "$repo"/.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

[ -f "$toplevel/.env.local" ] || exit 0
[ -L "$toplevel/apps/dashboard/.env.local" ] && exit 0

ln -sf ../../.env.local "$toplevel/apps/dashboard/.env.local"
echo '{"systemMessage":"Repaired apps/dashboard/.env.local (worktree copier drops symlinks) — see CLAUDE.md"}'
