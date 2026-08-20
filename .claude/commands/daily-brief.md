---
description: Fan out research agents over the day's AI news and synthesise a dated markdown digest
argument-hint: "[output path] [since YYYY-MM-DD]"
allowed-tools: Agent, Bash, Read, Write
---

# Daily AI brief

Fan out three research agents over the last day of AI news, then synthesise one
dated markdown file.

Note on naming: `CONTEXT.md` owns "brief", "briefing" and "findings" for the
job-search product. This command is personal tooling, not that system — say
"item" and "digest" inside the output so a grep for the domain word stays clean.

## 1. Fix the window and the destination

Never trust a date from context — it can be a day stale. Resolve it:

```bash
date +%F          # today, the digest's date
date -v-1d +%F    # the cutoff; anything older is out of window (macOS)
```

`$ARGUMENTS` may carry an output path and/or `since YYYY-MM-DD`. Defaults: window =
last 24h, output `~/ai-briefs/<today>.md`. Resolve that to an **absolute** path and
create its parent before fanning out:

```bash
mkdir -p ~/ai-briefs
```

The default sits outside the repo on purpose. Digests accumulate day over day, and
one written under a `.claude/worktrees/` checkout does not survive: a git-ignored
path never shows in the cleanup hook's `git status --porcelain` check, and the hook
removes with `--force`.

## 2. Fan out the lanes

Launch all three in **one message** so they run concurrently. Each is a
`general-purpose` agent with web access.

| Lane       | Covers                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `models`   | New models, versions, context/pricing changes, API and SDK releases — Anthropic, OpenAI, Google, Meta, Mistral, DeepSeek, Qwen, xAI |
| `tooling`  | Coding agents, MCP servers and spec changes, agent frameworks (LangChain/LangGraph), harnesses, evals, dev-facing infra           |
| `research` | Notable arXiv papers, benchmark results, technique writeups with reproducible claims                                             |

Give every lane agent the same contract:

- **Prefer primary sources.** A vendor changelog, model card, docs page, release
  note, arXiv abstract or official blog post outranks any aggregator writing
  about it. Use aggregators (HN, r/LocalLLaMA, newsletters) to _discover_, then
  open the primary source and cite that.
- **Verify the date on the page**, not in the search snippet. Search engines
  surface undated reposts of old news constantly; an item whose primary source
  carries no date within the window is dropped, not guessed at.
- **Return raw, not prose.** The agent's final text is the return value. One
  block per item: `title | source URL | publication date | 2-3 sentence factual
summary | why it matters`. No preamble, no markdown headings, no ranking —
  ranking is the synthesiser's job.
- **Say when a lane is quiet.** Returning four real items beats padding to ten.
  An explicit "quiet day, N items" is a useful signal; invented volume is not.
- **Load the search tools before searching.** `WebSearch` and `WebFetch` may be
  deferred; fetch them with `ToolSearch` first. A lane that never managed to search
  returns nothing, which reads exactly like a quiet day — say so explicitly if it
  happens, because nothing downstream can tell the two apart.

## 3. Signal filter

The synthesiser applies this before writing anything. It is the whole difference
between a digest worth opening and a list of headlines.

**Inclusion bar.** An item earns a slot when it changes what could be built or
how: a model or version actually available to call, a pricing or context-window
change, a new or breaking API/SDK capability, a protocol or spec change, or a
technique with reproducible results. Out: funding rounds, executive moves,
opinion pieces, waitlists and teasers with nothing shipped, point releases with
no user-visible change.

**Preprints need substance.** Include a paper only if it ships code, weights, or
a benchmark table with a stated method. A claim alone does not qualify.

**Stack relevance lowers the bar.** Anything touching Anthropic models,
LangChain/LangGraph, MCP, Langfuse, Next.js/Vercel or Lambda-hosted agents clears
at a lower threshold and is marked as such — it can change this codebase
directly. A smaller change to the stack in use beats a larger change to one that
is not.

**Order by impact, not recency.** Within a lane: usable today > changes cost or
limits > changes how an agent would be designed > merely interesting. Recency
breaks ties only.

**Cap: 8 full items across all lanes.** Everything ranked below the cap becomes a
one-line mention under `## Also noted`. The cap forces ranking to bite; the
overflow list means a busy day is compressed rather than silently truncated.

## 4. Synthesise

One `general-purpose` agent, handed all three lanes' raw output at once (it needs
them together to dedupe a story that broke in two lanes) and the absolute output
path from step 1. It writes the file directly. Shape:

```markdown
# AI daily brief — <YYYY-MM-DD>

## The short version

<3-5 bullets. What a reader who stops here should still know.>

## Models & APIs

### <Item title>

<What happened, in plain sentences.> **Why it matters:** <one line.>
[Source](url) · <date>

## Agent & dev tooling

...

## Research

...

## Also noted

<One line each, with a link: everything that ranked below the cap.>

## Quiet lanes

<Named only if a lane returned little — so a thin section reads as a real
signal about the day rather than as a failed search.>
```

Rules for the synthesiser:

- **Every claim carries its source link.** An unsourced sentence is cut, not
  hedged.
- **No cross-lane duplicates.** Same story from two lanes merges into one item
  under the lane that fits best, keeping the better primary source.
- **Plain declarative sentences.** No hype adjectives, no "game-changing", no
  speculation about what a release "could mean" unless a source says it.
- **Return the tally, not the digest.** Its final text is the return value, and step
  5 has nothing else to print from: the path written, the item count per lane, and
  how many were deferred to `## Also noted`.

## 5. Report back

Print the output path and the item count per lane. Do not paste the digest into
the chat — the file is the deliverable.
