# Whiteboard evals

Scored, repeatable runs of the whiteboard agent against a real model, so that
"this prompt is better" stops being a claim about one canvas somebody looked at.

Nothing here runs in `pnpm test`. The **graders** do — they are pure functions
and their suites are ordinary vitest — but the runner spends real money and is
deliberately outside the default task.

```bash
pnpm turbo run eval --filter=@workspace/agents          # every case, once
EVAL_CASES=insert-cache,critique-only pnpm turbo run eval --filter=@workspace/agents
EVAL_REPEATS=3 pnpm turbo run eval --filter=@workspace/agents
EVAL_WRITE_BASELINE=1 pnpm turbo run eval --filter=@workspace/agents
```

`OPENAI_API_KEY` must be set; the run refuses immediately without one. A full
pass is nineteen cases — the per-case `maxLlmCalls` budgets sum to 81, so expect
somewhere around sixty agent calls in practice — plus twelve judge calls, one
for each case carrying a rubric. It takes a few minutes. Treat it as costing a
couple of dollars rather than as free, and use `EVAL_CASES` while iterating.

| variable              | default            | what it does                                                   |
| --------------------- | ------------------ | -------------------------------------------------------------- |
| `EVAL_CASES`          | all                | Comma-separated case names.                                    |
| `EVAL_REPEATS`        | `1`                | Runs per case. Raise it to see variance, not to raise a score. |
| `EVAL_MODEL`          | `WHITEBOARD_MODEL` | The agent under test.                                          |
| `EVAL_JUDGE_MODEL`    | `WHITEBOARD_MODEL` | The judge.                                                     |
| `EVAL_WRITE_BASELINE` | unset              | Overwrite `baseline.json` with this run.                       |

## Why the whiteboard is worth evaluating this way

A turn takes a `BoardContext` and a sentence, and produces a list of canvas ops,
a final board and a reply. All of that is plain data. There is no browser in the
loop, no screenshot to diff, and no human needed to say whether two boxes
overlap — so most of what makes a diagram good or bad is answerable by
arithmetic, and only the genuinely subjective part has to go to a model.

That split is the whole design. **The deterministic graders carry most of the
signal and cost nothing; the judge answers the two or three questions they
cannot reach.**

## Anatomy of a run

```
cases/*.ts   →  runner.ts  →  graders/structural.ts  ─┐
                                graders/judge.ts     ─┴→  report.ts  →  results/
                                                                          baseline.json
```

`runner.ts` streams the turn in `["values", "messages", "custom"]` mode. **The
`"custom"` channel is not optional**: the canvas tools write their ops to
`config.writer`, which only exists when the run streams that way. Swapping the
stream for an `invoke()` would produce a harness that grades an empty op list
against every case and reports an agent that does nothing.

## Writing a case

Add it to a file under `cases/` and export it from the group array. There is no
registry to update.

```ts
{
  name: "insert-cache",
  intent: "Insert a node into an existing edge and rewire it.",
  board: board({
    shapes: [shape("s1", "API", 0, 0), shape("s2", "Postgres", 600, 0)],
    connections: [arrow("s3", "s1", "s2", "queries")],
  }),
  prompt: "Add a Redis cache between the API and the database.",
  expect: {
    minCreated: 1,
    edges: ["API -> Redis", "Redis -> Postgres"],
    mayDelete: [],
    maxLlmCalls: 6,
    judge: "Whether the cache genuinely sits between the two…",
  },
}
```

Three rules, each learned from a grader that would otherwise lie:

- **Expectations are questions, not a golden diagram.** Pinning the exact boxes
  a model draws fails on the next run and teaches nothing. Ask for the shape of
  a good answer — this many boxes, these relationships, in this reading order.
- **Name shapes by label, never by id.** Ids are allocated per run. `edges` and
  `mayDelete` both match labels, loosely and in both directions, so an expected
  `Postgres` is satisfied by a drawn `PostgreSQL`. Keep expected labels
  distinctive: `DB` would match half a diagram.
- **Only ask the judge what arithmetic cannot answer.** A `judge` rubric that
  re-asks "did anything overlap" adds noise to the number and nothing else.

## The graders

`noOverlap`, `noUserDamage` and `idValidity` run on **every** case and cannot be
turned off — they are not case-specific questions, they are the floor. The rest
run only when the case asks for them, so a case's score is the mean of what it
actually posed.

| grader          | what it catches                                                           |
| --------------- | ------------------------------------------------------------------------- |
| `noOverlap`     | two shapes sharing area once the turn is over                             |
| `noUserDamage`  | deleting a shape the user drew, outside `mayDelete`                       |
| `idValidity`    | naming a shape that does not exist, read off the session's own correction |
| `minCreated`    | drew less than the request needed                                         |
| `edges`         | the arrows asked for, matched on labels and direction-sensitive           |
| `flow`          | arrows that advance along the reading axis                                |
| `labelled`      | a box with no label                                                       |
| `kinds`         | a decision drawn as a rectangle                                           |
| `mutationScope` | drawing at all when the case forbids it                                   |
| `callsTools`    | the tool the case is about was never reached                              |
| `focus`         | drew off screen and never moved the camera                                |
| `efficiency`    | model calls over the case's budget                                        |
| `asksAQuestion` | guessed at an ambiguous reference instead of asking                       |
| `shapeCount`    | a tidy-up that redrew instead of arranging                                |

`edges`, `flow`, `labelled`, `kinds` and `callsTools` give **partial credit** —
six of seven arrows is genuinely better than three, and a binary pass would
throw away the only signal that says whether a change helped.

The judge scores faithfulness, readability and reply quality from 1 to 5, and
those land on the same 0–1 scale as everything else. It reads the board as
`renderBoard()` text — the same description the agent itself works from — so no
screenshot is involved. **A judge that fails to answer is reported as the judge
failing, not as the agent scoring zero**, because folding a harness outage into
a baseline sends the next person looking for a prompt change that never happened.

## Reading the output

Each run writes `results/<timestamp>.json` and `.md` (both gitignored) and
prints the markdown. The table is scored against `baseline.json`:

```
| case            | score | vs baseline | spread | calls | notes |
| `insert-cache`  | 0.95  | · +0.01     | 0.0    | 4     | —     |
| `tidy-messy…`   | 0.62  | ▼ -0.31     | 0.1    | 7     | 2     |
```

**The delta is the point; the absolute score is context.** Nobody knows whether
0.82 is good. Everybody knows what `0.93 → 0.62` means. A move of less than
0.05 is called `·` — noise, not a change.

`spread` is the range across repeats and is a finding in itself: a case that
swings 0.4 between identical runs is not measuring anything reliable, and either
its expectations are too tight or the agent is genuinely unstable there.

The exit code is 0 for a low score and non-zero only when a case **crashed**. A
score is information; making it a build failure is how a case ends up deleted.

## Baselines

`baseline.json` is committed, and is the last set of scores anyone accepted.
**It does not exist yet** — there was no key available when the harness was
written, so the first person to run this creates it. Until then every case
reports as `new` and there is nothing to regress against.

The workflow when changing a prompt or a tool is: run on `main` first to see
where you are, make the change, run again, read the deltas. Update the baseline
with `EVAL_WRITE_BASELINE=1` only once the new numbers are ones you are prepared
to defend, and commit it in the same change as whatever moved them — a baseline
committed on its own is a record of nothing.

Because scores are stochastic, a baseline written from `EVAL_REPEATS=1` is
noisier than the threshold that reads it. Use 3 when writing one.

## In CI

`.github/workflows/evals.yml`, on `workflow_dispatch` or by putting the
`run-evals` label on a pull request. Never on push and never on an ordinary
pull request — a stochastic check wired to a required gate is one people learn
to re-run past. It needs an `OPENAI_API_KEY` repository secret, and the
pull-request path is guarded against forks, where secrets are absent.
