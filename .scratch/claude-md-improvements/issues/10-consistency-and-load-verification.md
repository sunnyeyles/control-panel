# 10 — Consistency and load-verification sweep

**What to build:** Proof that the finished instruction surface behaves as intended — the right files load at the right times, and no two of them disagree.

This ticket exists because the failure mode being fixed is not "the documentation is thin", it is "the documentation is confidently wrong in places". A sweep at the end is what stops the same drift from being reintroduced by the tickets that fixed it. Instructions are context, not enforced configuration; conflicting instructions get resolved arbitrarily, so contradiction is a real defect, not a tidiness concern.

Verify three things.

**What loads, and when.** In a fresh session at the repo root, confirm the root file and its import are in context and nothing else is. Then open a file in each workspace in turn and confirm that workspace's nested file loads at that point and not before. Then open a TypeScript source file and confirm the path-scoped rules trigger, and open a non-matching file and confirm they do not. There is a hook available that logs exactly which instruction files load, when, and why — use it rather than inferring from behaviour.

**That nothing contradicts.** Read the root file, every nested file, and every rule file together as one document, which is effectively how an agent receives them. Look specifically for: the same rule stated twice with different wording, a rule stated at the root that a nested file narrows without saying so, and any claim about commands, workspaces, or tooling that a quick check of the working tree falsifies. Every factual claim should be checked against the tree rather than trusted because a previous ticket wrote it.

**That it survives compaction.** The root file is re-read from disk and re-injected after compaction, but nested files are not — they reload the next time a file in their directory is read. Confirm the rules an agent must never lose are at the root, and that anything sitting only in a nested file is genuinely fine to lose mid-session until the next read of that directory. This is the one structural decision the earlier tickets cannot verify individually.

Finally, note the two remaining known-broken things that this ticket set documents rather than fixes — the pre-commit hook with no configuration, and the dead legacy lint config if ticket 08 chose to explain rather than remove it — so they are tracked as work rather than lost as footnotes.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09 — this is the integration check for the whole set.

**Status:** ready-for-agent

- [ ] Root file and its import confirmed loading in a fresh session
- [ ] Each nested file confirmed loading on first read in its directory, and not at launch
- [ ] Path-scoped rules confirmed triggering on matching files and not on non-matching ones
- [ ] Instruction-load logging used to verify this, rather than inferred from model behaviour
- [ ] All instruction files read together as one document, with no duplicated or conflicting rule found
- [ ] Every factual claim across all files re-checked against the working tree
- [ ] Compaction-survival reviewed: must-never-lose rules live at the root
- [ ] Root file still under 200 lines after all relocations
- [ ] Remaining known-broken items are recorded as follow-up work, not left as prose asides
