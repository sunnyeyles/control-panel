---
description: Reconcile the local plans/ directory against GitHub and render the wayfinder board
argument-hint: "[map issue number]"
allowed-tools: Bash(gh issue list:*), Bash(gh issue view:*), Bash(ls:*), Bash(mv:*), Bash(head:*), Read, Edit
---

Planning lives in `plans/<map-number>-<slug>/`, which is gitignored. One
directory per wayfinder map, one file per ticket, named
`<status>-<issue>-<slug>.md` with the map itself at `_map.md`. The filename
prefix is the board — `ls` is the status report.

Map to report on: $ARGUMENTS (empty means every directory under `plans/`).

## The contract, which matters more than the rendering

**The files are where planning happens. GitHub is the durable record.** So:

- **Never overwrite the body of a file that already exists.** It holds work that
  is not on GitHub. Reconciling means renaming and touching the `status:` line in
  frontmatter — nothing else.
- **Do create a file for a wayfinder issue that has none**, using the layout
  below. A ticket opened on GitHub since the last run should appear locally.
- **Never rename or retitle the GitHub issue.** The prefix is a local view. The
  issue title is the identity that `_map.md` and every cross-reference cite.

## Reconcile

Read the local frontmatter first — it carries `issue`, `blocked_by` and the
current `status` — then one call for the real states:

```bash
gh issue list --state all --limit 200 --json number,state,title,labels --jq '.[] | select(any(.labels[]; .name | startswith("wayfinder"))) | "\(.number)\t\(.state)\t\([.labels[].name | select(startswith("wayfinder"))][0] | ltrimstr("wayfinder:"))\t\(.title)"'
```

Compute each open ticket's status:

- `resolved` — the issue is CLOSED.
- `blocked` — any issue in its `blocked_by` is still open.
- `ready` — everything else.

Where the computed status differs from the filename prefix, `mv` the file and
update its `status:` frontmatter line to match. Report every rename you make. If
nothing moved, say so in one line rather than listing the whole board as unchanged.

`blocked_by` in frontmatter is the authority, because it was read once from the
issue's prose and prose drifts. When you create a _new_ file, derive it from the
body by scraping whole paragraphs that start with "Blocked" — these bodies are
hard-wrapped at 80 columns, so a blocker reference routinely lands on a different
line from the word "Blocked", and a line-based scrape silently drops the second
of a two-blocker sentence.

## New-file layout

```markdown
---
issue: 65
map: 59
kind: grilling
status: ready
blocked_by: [61]
url: https://github.com/sunnyeyles/control-panel/issues/65
---

# Where the Gmail credential lives

<the issue body>

## Thread

<each comment, separated by ---, so resolution comments survive locally>
```

## Report

Per map, one tree. Terse — this is a board, not prose:

```
#59 Gmail as a tool the assistant can query        plans/59-gmail-as-a-tool/

  READY
    #60 What we call a connected mailbox        (gates prose everywhere)
    #64 Stand up the Google Cloud project       (manual, console)
    #65 Where the Gmail credential lives        <- unblocks #68, #69
    #66 The tool surface the model sees
    #67 What a retrieved message looks like

  BLOCKED
    #68 What happens when Gmail is not connected  <- #65, #66
    #69 The connect and disconnect surface        <- #65

  CLOSED  #61 #62 #63 #70
```

Then flag anything the numbers alone do not say, and nothing else:

- **Mislinked blockers.** If a blocker's markdown link text names a ticket whose
  real title belongs to a different number, say so — a blocker pointing at the
  wrong issue reports a ticket ready when it is not, or holds it shut forever.
  #68 has one today: its second blocker reads "The tool surface the model sees"
  but points at `#65` rather than `#66`.
- **Tickets that may be moot.** Some are written to close as out of scope
  depending on how a blocker landed. If the body says so and the blocker is now
  closed, flag it rather than listing it as ready work.
- **Hinges.** A ready ticket that appears in more than one other ticket's
  `blocked_by`. Sort READY with hinges first and mark what they unblock.

No summary paragraph and no next-steps section unless asked.
