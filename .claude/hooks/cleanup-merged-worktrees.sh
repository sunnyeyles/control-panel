#!/usr/bin/env bash
#
# SessionEnd hook — garbage-collect the worktrees whose pull request is finished.
#
# Claude Code leaves a worktree under .claude/worktrees/ behind whenever a
# session is kept rather than discarded, so they accumulate long after the work
# they held has been reviewed and merged. This removes such a worktree and its
# local branch, but only when every one of the following holds:
#
#   * it sits under .claude/worktrees/ (never the main checkout, never a
#     worktree someone added by hand elsewhere),
#   * no live claude session holds its lock,
#   * GitHub reports a MERGED or CLOSED pull request for the branch, and no
#     OPEN one — an open PR is still being iterated on,
#   * the working tree is clean and carries no commit the remote does not have.
#
# Anything failing a check is left exactly as it was and noted in the log. The
# hook is silent and makes no network call when there is nothing to consider.
#
# Log: ~/.claude/worktree-cleanup.log

set -uo pipefail

log_file="$HOME/.claude/worktree-cleanup.log"
say() {
  mkdir -p "$(dirname "$log_file")" 2>/dev/null
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$log_file"
}

command -v git >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0

# --git-common-dir resolves to the *main* repository even from inside a linked
# worktree, which is what every git call below needs to target.
repo=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
repo=${repo%/}
repo=${repo%/.git}
worktree_root="$repo/.claude/worktrees"
[ -d "$worktree_root" ] || exit 0

default_ref=$(git -C "$repo" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)
default_ref=${default_ref:-refs/remotes/origin/main}

path=""
branch=""
locked=0
lock_line=""
removed=0

consider() {
  [ -n "$path" ] || return 0
  case "$path" in
  "$worktree_root"/*) ;;
  *) return 0 ;;
  esac

  if [ -z "$branch" ]; then
    say "keep $path — detached HEAD, no branch to match against a PR"
    return 0
  fi

  # A lock reason looks like: claude session <name> (pid 81567 start <date>).
  # A dead pid means the session that owned this worktree is long gone.
  if [ "$locked" -eq 1 ]; then
    local pid
    pid=$(printf '%s' "$lock_line" | sed -n 's/.*(pid \([0-9][0-9]*\).*/\1/p')
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi

  # gh reads the repository from the working directory. A failure here (offline,
  # unauthenticated, no remote) yields no states, which falls through to "leave
  # it alone" rather than to a deletion.
  local states
  states=$(cd "$repo" && gh pr list --head "$branch" --state all --json state --jq '.[].state' 2>/dev/null)

  case "$states" in
  *OPEN*) return 0 ;;
  esac

  local outcome
  case "$states" in
  *MERGED*) outcome=merged ;;
  *CLOSED*) outcome=closed ;;
  *) return 0 ;;
  esac

  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    say "keep $path — $branch has uncommitted changes (PR $outcome)"
    return 0
  fi

  local ahead head
  ahead=$(git -C "$path" rev-list --count '@{u}..HEAD' 2>/dev/null)
  if [ -z "$ahead" ]; then
    # No upstream: usually the remote branch was deleted on merge. Accept only
    # if the commits landed in the default branch anyway.
    head=$(git -C "$path" rev-parse HEAD 2>/dev/null)
    if [ -z "$head" ] || ! git -C "$repo" merge-base --is-ancestor "$head" "$default_ref" 2>/dev/null; then
      say "keep $path — $branch has no upstream and is not contained in ${default_ref#refs/remotes/}"
      return 0
    fi
  elif [ "$ahead" != 0 ]; then
    say "keep $path — $branch has $ahead unpushed commit(s)"
    return 0
  fi

  git -C "$repo" worktree unlock "$path" >/dev/null 2>&1
  if ! git -C "$repo" worktree remove "$path" >/dev/null 2>&1 &&
    ! git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1; then
    say "keep $path — git worktree remove refused"
    return 0
  fi
  git -C "$repo" branch -D "$branch" >/dev/null 2>&1

  say "removed $path and branch $branch (PR $outcome)"
  removed=$((removed + 1))
}

while IFS= read -r line; do
  case "$line" in
  "worktree "*)
    path=${line#worktree }
    branch=""
    locked=0
    lock_line=""
    ;;
  "branch refs/heads/"*) branch=${line#branch refs/heads/} ;;
  "locked"*)
    locked=1
    lock_line=$line
    ;;
  "")
    consider
    path=""
    branch=""
    locked=0
    lock_line=""
    ;;
  esac
done < <(git -C "$repo" worktree list --porcelain)
consider

if [ "$removed" -gt 0 ]; then
  git -C "$repo" worktree prune >/dev/null 2>&1
  printf '{"systemMessage":"Removed %d finished worktree(s); see %s"}\n' "$removed" "$log_file"
fi

exit 0
