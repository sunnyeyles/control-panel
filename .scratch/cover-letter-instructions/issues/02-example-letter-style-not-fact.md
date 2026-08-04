# 02 — An example letter, fenced as style and never as fact

**What to build:** Below the instructions field, a second field where the user pastes a cover
letter they like. New drafts pick up its register, structure and rhythm. Nothing else about it
carries over.

That last sentence is the whole ticket. An example letter is full of claims — _"I led a team of
eight"_, _"five years at Acme"_. The **Letter Writer**'s governing property is that every claim
about the candidate traces to their own background text. A sample letter sitting in the same
undifferentiated blob as the user's rules gives the model no way to tell a style reference from
a source of facts, and it will lift claims out of the sample into letters sent in the user's
name.

Separate fields exist so the prompt can fence them differently and say the thing that prevents
it. Roughly:

```
## An example letter the candidate chose

A sample of the register, structure and rhythm they want. Imitate how it is
written. Take no fact from it — no employer, role, date, number, technology or
achievement in it belongs to the candidate unless the background text also says
so. It is a style reference and nothing else.
```

The field is optional and empty is the ordinary state. Its cap is larger than the instructions
cap — a letter is prose, not a rule list — and, like ticket 01, over-length is refused loudly
rather than trimmed. The helper text under the field says plainly that voice and structure are
copied from it and facts never are, because a user who does not know that will paste someone
else's letter and expect the facts to be adapted.

The column already exists from ticket 01's migration, so this ticket adds no schema change.

**Blocked by:** 01 — Saved instructions that change how letters are written.

**Status:** ready-for-agent

- [ ] The Cover letters section gains an optional example-letter field with its own larger cap
      and its own live character count
- [ ] The example is fenced in its own section of the composed prompt, separate from the
      instructions, carrying the "take no fact from it" clause
- [ ] With no example saved, the composed prompt is unchanged from what ticket 01 produces
- [ ] Helper text under the field states that voice and structure are copied and facts are not
- [ ] Saving and re-editing the example works the same way as the instructions; both fields
      save together
- [ ] Drafting after pasting an example produces a letter in that example's register
- [ ] **A fact present in the example but absent from the uploaded CV — a made-up employer —
      does not appear in a drafted letter.** Verified with a real draft; this is the acceptance
      criterion the split fields exist for
- [ ] Text over the cap is refused with a message naming the count and the limit
- [ ] Tests cover the fencing and the composed prompt for every combination of the two fields
      being present or empty
