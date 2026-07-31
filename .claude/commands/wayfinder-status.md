---
description: Render the wayfinder ticket board — which tickets are ready, which are blocked, and on what
argument-hint: "[map issue number]"
allowed-tools: Bash(gh issue list:*), Bash(gh issue view:*)
---

Render the current state of the wayfinder ticket board. Derive everything from
GitHub on demand — nothing about status is stored anywhere, so nothing can drift.

Map to report on: $ARGUMENTS (empty means every open map).

## Collect

One call. It returns only the fields that matter, so the board stays cheap to run:

```bash
gh issue list --state all --limit 200 --json number,title,state,labels,body --jq '.[] | select(any(.labels[]; .name | startswith("wayfinder"))) | {n:.number, t:.title, s:.state, kind:([.labels[].name | select(startswith("wayfinder"))][0] | ltrimstr("wayfinder:")), map:([.body | scan("Part of #[0-9]+") | scan("[0-9]+")][0]), blockedBy:([.body | split("\n\n")[] | select(test("^Blocked|Blocked until|Blocked by")) | scan("#[0-9]+")] | unique), blockedText:([.body | split("\n\n")[] | select(test("^Blocked|Blocked until|Blocked by"))])} | tojson'
```

`blockedBy` is scraped from whole paragraphs rather than lines, because these
bodies are hard-wrapped at 80 columns and a blocker reference routinely lands on
a different line from the word "Blocked".

## Derive

A ticket is **ready** when it is open and every issue in its `blockedBy` is
closed. It is **blocked** otherwise. Do not trust any status written in a title
or a label — the point of this command is that status is computed, not stored.

Then check three things the raw data will not tell you:

- **Mislinked blockers.** `blockedText` carries the markdown link text as well as
  the number. If the text names a ticket whose actual title belongs to a
  different number, say so — a blocker pointing at the wrong issue silently
  reports a ticket as ready, or holds it shut forever.
- **A blocker that resolved the ticket away.** Some tickets are written to close
  as out of scope depending on how their blocker lands. If a `blockedText`
  paragraph says so and the blocker is now closed, flag that the ticket may not
  need answering at all rather than listing it as ready.
- **Hinges.** A ready ticket that appears in more than one other ticket's
  `blockedBy` is worth doing first. Mark it with what it unblocks.

## Report

Per map, one tree. Terse — this is a board, not prose:

```
#59 Gmail as a tool the assistant can query

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

Annotate a ready ticket only when there is something to say — what it gates, that
it needs a human at a console, that it may be moot. Sort READY with hinges first.
Below the trees, list any mislinks or moot tickets you found, and nothing else.
No summary paragraph, no next-steps section unless asked.
