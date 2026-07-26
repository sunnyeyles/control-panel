# 06 — Nested CLAUDE.md for the UI package

**What to build:** An agent editing the shared UI package loads that package's rules on demand, and the root instruction file can shed the detail it currently carries about this package.

The rules that matter before the first edit:

- **The package is consumed as TypeScript source, not as a build artifact.** It has no build step. Its export map points subpaths directly at source files, and the app compiles them through Next.js transpilation. An agent that adds a build step, a `dist` output, or a barrel index breaks the arrangement.
- **One file per export subpath, no barrel.** Components, hooks, and lib utilities each resolve through a wildcard subpath. Adding a component means adding a file — there is no export list to update, and there is no index to import from. The corollary is that imports are always the specific subpath.
- **The subpath wildcards are extension-specific.** Components resolve to `.tsx`, hooks and lib to `.ts`. A hook written as `.tsx` or a component written as `.ts` will not resolve.
- **This package owns the single Tailwind stylesheet.** There is no Tailwind config file anywhere in the repo — v4 configures itself from CSS. Theme tokens, base colors, and animations belong in that stylesheet, not in the app. The app imports the stylesheet through the package's export map.
- **shadcn/ui components land here, not in the app.** The CLI is pointed at the app but writes through into this package. Document the exact invocation and the fact that both component-config files must agree on style, base color, and CSS-variable mode for the write-through to behave.
- **The package's own tsconfig path-maps its subpaths to sources** so editor resolution works without a build; the app carries a matching path map. Changing one without the other breaks the editor but not the build, which is a confusing failure mode.

Where this content is already stated in the root file, remove it from the root as part of this ticket rather than leaving both copies.

**Blocked by:** 04 — the root file must already be trimmed, so it is unambiguous which rules this file now owns.

**Status:** ready-for-agent

- [ ] A `CLAUDE.md` exists in the UI package
- [ ] The consumed-as-source rule is stated with its consequence: no build step, no `dist`, no barrel
- [ ] The per-subpath import convention and the extension-specific wildcards are both documented
- [ ] Stylesheet ownership is stated, including that no Tailwind config file exists
- [ ] The shadcn write-through invocation is documented, with the config-agreement requirement
- [ ] The dual path-map requirement and its editor-only failure mode are documented
- [ ] Content moved here is deleted from the root file, not duplicated
- [ ] Reading a file in this package causes the file to load — confirmed via `/context`
