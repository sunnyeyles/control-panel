# 00 — Scope tracking parameters per board

**What to build:** a **Posting**'s id stops depending on which search surfaced it. Today
`normalisePostingUrl` drops `utm_*` and nine globally-named parameters, which is correct
for SEEK and insufficient for the boards 01 and 02 add. Board descriptors carry a
per-host set, and normalisation consults it.

**This is a live bug, not preparation.** Measured on 2026-08-05, two runs of the same
LinkedIn search twenty seconds apart produced **zero of nine** matching ids:

```
run1  3c2ccd59cf66c9bb  …-4446494860?position=60&…&refId=Is5ZuQho…&trackingId=D+HsFbhL…
run2  3cbcd7167f8f18ac  …-4446494860?position=60&…&refId=VFISQlvQ…&trackingId=j2rmVDCP…
```

`refId` and `trackingId` are regenerated per search; `position` and `pageNum` follow a
result's place in the list. `postings` is keyed `(user_id, posting_id)` and `status` is
the one column in that schema a person writes — `postings.ts` names the failure as
"splitting one Posting into two rows and stranding the status a person set on the first".
Every LinkedIn run would do exactly that.

**Do not append these names to the global set.** `TRACKING_PARAMETERS` documents the rule
it protects — anything not listed is kept, because a parameter can carry identity — and
`position` dropped globally silently reaches SEEK, Indeed and every board added after.

## The shape

A board descriptor carries its name, the hosts its results live on, and its tracking
parameters. `normalisePostingUrl` matches the URL's host against the descriptors and
drops the global set, `utm_*`, and that board's set. An unknown host gets the global
behaviour it has today.

Known values, from the measurement:

| Board    | Hosts             | Drop                                          | Keep                |
| -------- | ----------------- | --------------------------------------------- | ------------------- |
| SEEK     | `seek.com.au`     | — (the global `ref` already covers it)        |                     |
| Indeed   | `au.indeed.com`   | — (`url` is a bare `?jk=`)                    | **`jk` is identity** |
| LinkedIn | `au.linkedin.com` | `position`, `pageNum`, `refId`, `trackingId`  |                     |

Indeed's `from`/`tk`/`vjk` appear on `externalApplyLink`, not on `url`, so nothing needs
to strip them. Add them only if a real returned `url` is seen carrying them.

The descriptor is where 01 and 02 register their boards, so build it to be extended by
one entry rather than as a switch on board name.

**Blocked by:** —

**Status:** ready-for-agent

- [ ] Board descriptors exist in `@workspace/agents`, carrying name, hosts and per-host
      tracking parameters, and `JOB_SCOUT_SEARCH_TOOLS` derives from them
- [ ] `normalisePostingUrl` drops a board's parameters for that board's hosts only
- [ ] A LinkedIn URL differing only in `position`, `pageNum`, `refId` or `trackingId`
      yields one id — tested against the two real URLs above, pasted verbatim
- [ ] A SEEK or Indeed URL carrying `position=` keeps it, and `?jk=` survives untouched
- [ ] The global `TRACKING_PARAMETERS` set is unchanged, and its docblock still describes
      what it does
- [ ] An unrecognised host normalises exactly as it does today
- [ ] `postingId` is still a valid `@workspace/user-storage` key segment
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
