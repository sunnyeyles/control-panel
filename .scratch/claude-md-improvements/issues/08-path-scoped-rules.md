# 08 — Move cross-cutting code conventions into path-scoped rules

**What to build:** Conventions that only matter when Claude is actually looking at TypeScript source load only then, instead of occupying context in every session — including sessions that are purely about configuration, documentation, or planning.

Set up a project rules directory and move the cross-cutting code conventions into topic files scoped with `paths` frontmatter. Path-scoped rules trigger when Claude reads a matching file, not on every tool use, which fits conventions that are meaningless until there is source code in context.

Good candidates, each its own topic file:

- **Formatting.** The Prettier settings that differ from defaults — no semicolons, double quotes, two-space indentation, an 80-column width, ES5 trailing commas, LF endings. Include that the Tailwind class-sorting plugin is pointed at the UI package's stylesheet and also sorts classes inside the class-merging and variant helpers, and that some checked-in files predate the formatter so an unrelated reformat may appear in a diff. Scope to TypeScript and TSX sources.
- **TypeScript strictness.** Strict mode with unchecked indexed access enabled, so every indexed read is possibly-undefined and must be narrowed rather than asserted. Include the module-resolution split: the base config resolves as NodeNext, while the Next.js preset overrides to bundler resolution with no emit — which is why import extension style differs between workspaces. Scope to TypeScript and TSX sources.
- **Linting.** Every rule is downgraded to a warning by a plugin in the base config, so lint always exits zero and a clean exit code proves nothing — the warnings must be read. Note the legacy root eslintrc-format file, which is dead under flat config and should either be removed or explained; leaving an unexplained dead config invites an agent to edit it expecting an effect. Scope to source files, or leave unscoped if it should apply to any session that runs lint.

Two constraints to respect while doing this. Rules without `paths` frontmatter load at launch with the same priority as a project instruction file, so omitting the frontmatter defeats the purpose. And a rule is guidance, not enforcement — anything that must happen at a fixed point, such as before every commit, belongs in a hook instead. That distinction is worth applying to the currently non-functional pre-commit setup noted in ticket 03.

Remove from the root file whatever moves here, so there is one home per rule.

**Blocked by:** 04 — the root file must already be trimmed, so it is clear which conventions are being relocated rather than copied.

**Status:** ready-for-agent

- [ ] A project rules directory exists with one file per topic, each named for its topic
- [ ] Every rule intended to be conditional has `paths` frontmatter; none rely on an unscoped file by accident
- [ ] Opening a TypeScript source file loads the formatting and strictness rules — confirmed via `/context`
- [ ] Opening only a configuration or markdown file does not load them
- [ ] The lint-exits-zero trap is stated as a concrete instruction to read warnings
- [ ] The dead legacy lint config is either removed or explained in one line
- [ ] Content moved here is deleted from the root file, not duplicated
- [ ] Glob patterns are verified to actually match the intended files, not merely plausible
