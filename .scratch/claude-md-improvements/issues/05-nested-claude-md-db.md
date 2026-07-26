# 05 — Nested CLAUDE.md for the database package

**What to build:** An agent that opens a file in the database package gets that package's conventions loaded on demand, without those conventions costing context in every unrelated session. Nested `CLAUDE.md` files in subdirectories are discovered but not loaded at launch — they load when Claude reads files in that directory, which is exactly the shape this content wants.

The package already carries good explanatory comments in its sources, but comments are only found by an agent that happens to open the right file first. The rules that must be in effect _before_ the first edit:

- **The schema barrel is load-bearing.** Table definitions live in sibling files and are re-exported from the schema barrel. A table that is not re-exported there is invisible to both relational queries and migration generation — so a new table silently produces no migration. This is the single highest-value fact in the package.
- **Importing the package must never throw.** The connection string is read through a function rather than a module-level constant, deliberately, so that builds, typechecks, and tests that never touch the database do not require the env var. Do not "simplify" this into a top-level constant.
- **The shared client is a lazy singleton stashed on `globalThis`.** This exists to survive Next.js hot-reload module re-creation without leaking a connection pool per reload. Application code uses the shared accessor; tests that own their own pool use the explicit constructors; scripts must close the pool so the process can exit.
- **Query helpers are re-exported from the package root on purpose,** so consumers can build `where` clauses without taking a direct dependency on the ORM. Consumers should not add the ORM to their own dependencies.
- **Relative imports carry explicit `.js` extensions** because this package resolves under NodeNext, unlike the app. Copying import style from the app or the UI package into this package breaks it.
- **Migrations are generated, reviewed, and committed — never hand-edited,** and drizzle-kit runs in strict mode. Document the generate/migrate/push distinction and when `push` is acceptable, since `push` skips the migration history entirely.
- **drizzle-kit reads its own package-local env file** via dotenv, which is a different file from the app's env. An agent that sets the connection string in the app's env file and then runs a drizzle-kit command gets a confusing failure. Worth noting alongside this: the worktree-include convention only carries the app's local env file, so drizzle-kit commands do not work in a fresh worktree until its env file is created.

Keep this file short and specific. It should read as "things you will get wrong here", not as a tour of the package.

**Blocked by:** 03 — the root file must already describe this package accurately, so the nested file can add depth instead of contradicting the root.

**Status:** ready-for-agent

- [ ] A `CLAUDE.md` exists in the database package
- [ ] The schema-barrel trap is stated first and concretely enough to act on
- [ ] The never-throw-on-import rule is stated as a rule, with its reason, so it is not refactored away
- [ ] The client-access rules distinguish application code, tests, and scripts
- [ ] The NodeNext explicit-extension convention is stated, noting it differs from the other workspaces
- [ ] The generate / migrate / push distinction is documented, including that `push` bypasses migration history
- [ ] The package-local env file requirement for drizzle-kit is documented, including the worktree consequence
- [ ] Reading a file in this package causes the file to load — confirmed via `/context` after opening one
- [ ] Nothing in the file contradicts the root instruction file
