# Cover letter instructions

Let the user extend the **Letter Writer**'s prompt from the dashboard — save the text, edit it
whenever — so **Cover Letters** are drafted the way they want without a deploy.

`plan.md` holds the design and the reasoning behind each decision. The tickets below are vertical
slices of it, in dependency order.

| #                                                    | Ticket                                                 | Blocked by |
| ---------------------------------------------------- | ------------------------------------------------------ | ---------- |
| [01](issues/01-saved-instructions-change-letters.md) | Saved instructions that change how letters are written | —          |
| [02](issues/02-example-letter-style-not-fact.md)     | An example letter, fenced as style and never as fact   | 01         |
| [03](issues/03-fill-example-from-a-document.md)      | Fill the example from a document you have uploaded     | 02         |

## The property that must not be lost

An example letter is full of claims — _"I led a team of eight"_. The Letter Writer's governing
rule is that every claim about the candidate traces to their own background text. Keeping the
rules and the example in **separate fields** is what lets the prompt say _imitate its voice, take
no fact from it_; one undifferentiated textarea structurally cannot say that, and the model will
lift claims out of the sample into letters sent in the user's name.

Ticket 02's acceptance criterion is written as a live test of exactly this. If it fails, stop and
fix the fencing before building anything on top.

## Adjacent, deliberately not blocking

- **#104** — this feature adds a fifth copy of the Server Action scaffolding pattern #104 exists
  to collapse. #104's interface is undesigned, so waiting on it would stall this indefinitely.
- **#109** — ticket 01 adds a pure function to the agents package that #109 may later relocate.
  Additive, no shared state, low conflict risk.
- **#103** — a halted agent run would store its halt notice _as_ a Cover Letter. A live bug on
  the same draft path these tickets touch, out of scope here, and it will confuse anyone
  verifying ticket 01 with a real draft.
