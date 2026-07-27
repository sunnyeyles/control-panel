# 01 — Walking skeleton: briefing-worker builds and runs locally

**What to build:** A new workspace app, `@workspace/briefing-worker`, that registers a daily timer and runs a stub task under the local Azure Functions host — the complete build-and-run path proven before any real agent work. The Turborepo build produces a single ESM bundle and a deployable `functionapp.zip` with no changes to `turbo.json`.

Governing material: handoff spec steps 1 and 3 (`.wayfinder/assets/handoff-spec.md`), wayfinder tickets 06 (placement, packaging, the trigger/task seam, esbuild-direct decision) and 05/07 (schedule in code).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Private package `@workspace/briefing-worker`, `"type": "module"`, Node 22 pinned in `engines.node`, depending only on `@workspace/agents-core` and `@workspace/agent-tools` (not `@workspace/agents`)
- [ ] Trigger/task seam per ticket 06: a shallow timer-registration module and a deep task module (stubbed for now) that owns the task contract
- [ ] NCRONTAB schedule `0 0 9 * * *` (09:00 UTC daily) registered directly in code — no app-setting indirection
- [ ] esbuild invoked directly from a build script (not tsup): bundle, ESM, `target: node22`, single-file output, `@azure/functions` bundled in
- [ ] A `zip` script produces `functionapp.zip` (bundle output + host config)
- [ ] `pnpm turbo build --filter=@workspace/briefing-worker` and `pnpm turbo typecheck --filter=@workspace/briefing-worker` pass with no `turbo.json` edits
- [ ] The bundled function starts and the stub task fires under the local Functions host
