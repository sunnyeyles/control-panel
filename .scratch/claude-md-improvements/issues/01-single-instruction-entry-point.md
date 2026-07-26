# 01 — Make CLAUDE.md the single instruction entry point, importing AGENTS.md

**What to build:** An agent starting a session in this repo reads the Next.js 16 "read the local docs first" rule exactly once, from one source of truth, no matter which agent it is. Today that rule is written out in full in both `CLAUDE.md` and `AGENTS.md`; the two copies can drift silently and already differ in wording. Claude Code does not read `AGENTS.md` at all — it only reads `CLAUDE.md` — so the `AGENTS.md` copy exists purely for other tools, and the duplication is the only thing keeping Claude informed.

Restructure so `CLAUDE.md` pulls `AGENTS.md` in via the documented `@AGENTS.md` import, with Claude-specific content following the import. `AGENTS.md` keeps the generated `<!-- BEGIN/END:nextjs-agent-rules -->` block as the shared, tool-agnostic rule; whatever regenerates that block continues to own it. Remove the now-redundant restatement of the rule from `CLAUDE.md`, along with the sentence claiming the rule "also lives in AGENTS.md" — after this change that is structure, not a note.

Prefer the import over a symlink: the repo needs Claude-specific content below the shared rules, which a symlink cannot express.

This is a prefactor. Every later ticket edits the instruction surface, and doing them against two divergent copies means doing them twice.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The Next.js 16 rule text exists in exactly one file in the repo root
- [ ] `CLAUDE.md` imports `AGENTS.md` using the `@` import syntax, positioned so imported content loads before Claude-specific content
- [ ] Claude-specific sections still present and readable after the import
- [ ] `/context` in a fresh session lists `CLAUDE.md` under **Memory files**, and the imported Next.js rule text is present in context
- [ ] Any path mentioned in prose but not intended as an import is wrapped in backticks so it is not expanded
- [ ] No remaining sentence asserts the rule is duplicated across two files
