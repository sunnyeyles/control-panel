# 07 — Nested CLAUDE.md for the dashboard app

**What to build:** An agent editing app code loads the app's conventions on demand, and the Next.js version trap is reinforced at the point of use rather than only at the repo root.

The rules that matter before the first edit:

- **The Next.js version here has breaking changes relative to most training data.** The shared rule already lives at the repo root and loads every session, so this file should not restate it in full — it should point at the version-specific local documentation bundled in the installed package and name the app-router section as the starting point. State that deprecation notices in those local docs win over remembered conventions. Restating the whole rule here would create the same duplication ticket 01 removes.
- **The package name does not match the directory name.** Turborepo filters, workspace filters, and dependency references all key off the package name. This is the mistake most likely to waste time, and it belongs where the app code is.
- **The shared UI package is compiled through Next.js transpilation,** so it must stay listed in the app's config. Removing it breaks the build in a way that looks like a module-resolution problem.
- **App-local aliases exist for app-specific code,** while the UI and utility aliases point into the shared package. New app-only components go in the app; anything shared goes in the UI package — and per ticket 06, shadcn components always go to the UI package regardless of where the CLI is invoked.
- **Theme handling is class-based and lives in a client component** that also registers a global single-key hotkey for toggling dark mode. The hotkey deliberately ignores repeats, modifier combinations, already-handled events, and any event whose target is a text-entry or contenteditable element. An agent that "simplifies" the guard reintroduces the bug where typing the letter in a form field flips the theme.
- **The root element carries a hydration-warning suppression** because the theme class is applied client-side. Removing it produces hydration noise; document why it is there so it survives cleanup passes.
- **Fonts are loaded through the framework's font module** and exposed as CSS variables consumed by the stylesheet in the UI package — so font changes touch both workspaces.

**Blocked by:** 04 — the root file must already be trimmed, so it is unambiguous which rules this file now owns.

**Status:** ready-for-agent

- [ ] A `CLAUDE.md` exists in the app directory
- [ ] The Next.js local-docs rule is referenced, not restated, and names where to start reading
- [ ] The package-name-vs-directory-name mismatch is documented with its practical consequence for filters
- [ ] The transpilation requirement is documented, including how its failure presents
- [ ] The alias conventions make clear what belongs in the app versus the shared package
- [ ] The theme hotkey's guard conditions are documented as intentional, with the bug they prevent
- [ ] The hydration-warning suppression is documented with its reason
- [ ] The cross-workspace coupling for fonts is noted
- [ ] Reading a file in the app causes the file to load — confirmed via `/context`
- [ ] Nothing in the file contradicts the root file or the UI package's file
