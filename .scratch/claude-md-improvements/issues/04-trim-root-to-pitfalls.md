# 04 — Trim the root CLAUDE.md to pitfalls, rationale, and non-default conventions

**What to build:** The root instruction file stops spending session context on things an agent can read off the codebase in one command, and keeps only what an agent cannot derive: the traps, the reasons, and the conventions that differ from tool defaults.

This is the documented trim criterion — directory layouts, dependency lists, and architecture overviews are derivable and should go; pitfalls, rationale, and non-default conventions should stay. Applied to this file, the high-value content that must survive is the part an agent gets wrong without it:

- The UI package is consumed as TypeScript source with no build step, so imports are per-subpath with no barrel index, and adding a component means adding a file with no export list to update.
- There is no Tailwind config file anywhere — the single stylesheet in the UI package is the only source of truth, and theme tokens belong there rather than in the app.
- The shadcn CLI is run against the app but writes through into the UI package.
- ESLint downgrades every rule to a warning, so a zero exit code from lint proves nothing. This one is a genuine trap: the natural inference from a passing command is the wrong one.
- TypeScript has `noUncheckedIndexedAccess` on, so indexed reads are possibly-undefined and must be narrowed.
- Turborepo filters key off package names, not directory names, and one package's name does not match its directory.
- Prettier's exact settings, which differ from its defaults, and the fact that some checked-in files predate it.

The low-value content to cut or compress is the tabulated workspace inventory, dependency and version enumeration, and prose restating what a config file already says plainly.

Where a rule only matters inside one workspace, do not delete the knowledge — it moves to a nested file or a path-scoped rule in tickets 05 through 08. Sequence this ticket before those so it is clear what each nested file is responsible for carrying. Note that splitting content into `@` imports does not reduce context, since imports load at launch; only nested files and path-scoped rules defer loading.

Target under 200 lines, which the file already meets — the goal here is adherence, not a line count. Shorter, more specific instructions are followed more consistently.

**Blocked by:** 03 — correct the facts before compressing them, or the trim deletes the wrong content.

**Status:** ready-for-agent

- [ ] Derivable inventory content (workspace tables, dependency and version lists) is gone or reduced to a pointer
- [ ] Every pitfall listed above survives in a form specific enough to act on
- [ ] The lint-exit-code trap and the `noUncheckedIndexedAccess` rule are both stated as concrete, verifiable instructions
- [ ] No two surviving statements contradict each other
- [ ] File is under 200 lines
- [ ] `/doctor`'s trim check proposes no further cuts, or the ones it proposes are consciously declined with a reason
- [ ] `/context` confirms the file still loads in a fresh session
