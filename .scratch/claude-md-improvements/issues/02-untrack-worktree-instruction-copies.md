# 02 — Stop tracking worktree copies of instruction files

**What to build:** Reading a file inside a git worktree no longer drags a stale, committed copy of the project's instructions into context.

The repo currently tracks a complete checkout of one worktree under `.claude/worktrees/`, including that worktree's own `CLAUDE.md` and `AGENTS.md`. Claude Code discovers `CLAUDE.md` files in subdirectories beneath the working directory and loads them on demand when it reads files in those directories — so those committed copies are not inert. They are live instruction files that will load, they are already out of date (they predate the database package), and they will diverge further with every edit made by the other tickets in this set. A second, older set of project rules loading mid-session is exactly the "conflicting instructions" failure mode that makes an agent pick a rule arbitrarily.

Ignore the worktrees directory and untrack what is already committed, keeping the files on disk so any in-progress worktree survives. A worktree is a local, per-machine artifact; nothing about it belongs in history. Confirm nothing else in the repo depends on those tracked paths before removing them, and check whether the existing `.worktreeinclude` convention needs a companion note — that file is currently undocumented and its purpose is not obvious from its contents.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `git ls-files` reports no tracked files under the worktrees directory
- [ ] The worktrees directory is gitignored, and a fresh worktree creates no untracked-file noise in `git status`
- [ ] Files on disk are untouched — no existing worktree is destroyed by the untracking
- [ ] Only the root instruction files remain as tracked `CLAUDE.md` / `AGENTS.md` copies
- [ ] The purpose of `.worktreeinclude` is either documented in one line or confirmed self-evident
