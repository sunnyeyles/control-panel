# 01 — Bring the file editor onto the branch

**What to build:** the markdown file editor from PR #118 is present on this
branch and compiles, so the two tickets below have something to consume. PR #118
adds `FileEditorDialog` to `@workspace/ui` — a dialog that edits a list of
markdown files as rich text and exports one as a PDF — and its own description
says nothing consumes it yet. This makes it available; it changes no behaviour a
user can see.

The PR is open, one commit, and cleanly mergeable onto `main`. Its branch is
`worktree-file-editor-popup`. Merge it rather than cherry-picking, so the commit
keeps its identity and merging PR #118 later collapses to a no-op instead of a
conflict.

It brings seven dependencies that are new to the repository — the TipTap editor
packages, `marked`, `turndown` and `jspdf` — so an install is not optional. A
worktree with no `node_modules` also fails every commit, because the pre-commit
hook cannot find lint-staged.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] PR #118's commit is on this branch as its own commit, not squashed or
      re-authored
- [ ] Dependencies are installed and every new subpath of `@workspace/ui`
      resolves from the dashboard
- [ ] `turbo typecheck` is clean for both `@workspace/ui` and the dashboard
- [ ] `turbo lint` emits **zero warnings** for both — the exit code proves
      nothing here, since this repo downgrades every lint rule to a warning
- [ ] `turbo test` for the dashboard still passes
