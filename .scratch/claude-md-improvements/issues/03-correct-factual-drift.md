# 03 — Correct the factual drift in the root CLAUDE.md

**What to build:** An agent that trusts `CLAUDE.md` and acts on it without checking is not misled. Right now several statements in the file are stale or wrong, and each one is a trap an agent walks into confidently.

The drift, all verified against the working tree:

- **Two packages are missing entirely.** The database package (Drizzle ORM over Postgres, consumed as source via subpath exports) and the agents-core package are both absent from the layout description. An agent reading the file believes there are four workspaces and one app.
- **The database commands are missing.** Four `db:*` scripts exist at the root and fan out through Turborepo, and `DATABASE_URL` is declared as a global environment variable that participates in task hashing. None of this is documented, so an agent invents its own `drizzle-kit` invocations.
- **The pre-commit hook is undocumented and actively blocks commits.** Husky is installed and the pre-commit hook shells out to lint-staged, but no lint-staged configuration exists anywhere in the repo. Worse, it does not merely no-op: in a checkout without installed dependencies — a fresh git worktree, for instance — the command is unresolvable and the hook exits non-zero, so **every commit fails** until it is bypassed. This was hit while producing this ticket set. Document the hook's existence and its current state honestly rather than describing an intended behaviour that does not happen, and record that bypassing it is currently expected rather than a workaround someone invented. If fixing it is in scope, that is a separate change — the instruction file's job here is to stop lying about it.
- **The Prettier PostToolUse hook is undocumented.** Project settings register a hook that reformats every file immediately after a Write or Edit. This materially changes what an agent should expect after an edit: the file on disk may not match what was written. An agent that does not know this will fight the formatter or misread a diff.
- **The "no test setup" claim now contradicts the repo.** The claim is still broadly true — there is no test runner wired into the Turborepo task graph and no root test script — but the agents-core package declares both a Vitest test script and a `tsc -b` build script, and the workspace configuration references a mocking library. State the situation precisely: no repo-wide test task exists, and the one package declaring test and build scripts is an unwired stub. Precision matters more than brevity here, because the current absolute phrasing plus a visible test script is exactly the contradiction that makes an agent guess.
- **The skills claim understates what is present.** Roughly twice as many skill symlinks exist on disk as are tracked in git. Either describe the set accurately or describe it loosely enough to stay true as skills are added — do not enumerate a list that goes stale.

Fix the facts in this ticket. Do not compress the file yet; ticket 04 does that, and trimming before the content is correct risks deleting the wrong things.

**Blocked by:** 01 — there must be a single instruction entry point, or every correction lands twice.

**Status:** ready-for-agent

- [ ] Both previously-undocumented packages appear with their package names, and the existing note about the app's directory-name-vs-package-name mismatch is verified still accurate
- [ ] The `db:*` commands and the `DATABASE_URL` global env var are documented
- [ ] The pre-commit hook is documented, including the fact that its lint-staged configuration is absent
- [ ] The post-edit Prettier hook is documented, framed as something that changes what an agent sees after writing a file
- [ ] The test-setup statement is true as written when read against the workspace scripts, and still tells an agent not to invent test commands
- [ ] Every remaining factual claim in the file has been checked against the working tree, not assumed
- [ ] No claim is added that will go stale the next time a package or skill is added
