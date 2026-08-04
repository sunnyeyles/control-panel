# 07 — Draft Cover Letters from the stored Posting

**What to build:** Drafting a Cover Letter reads the Posting from the cumulative
record rather than re-reading it out of a Run's Findings, so any Posting visible
on screen can always be drafted from.

Two independent problems go away. Today drafting fails whenever a Posting has
aged out of its Briefing's most recent Run — an error the user sees for a
Posting plainly in front of them. And because recording Postings and recording
Findings are separate non-fatal steps, a Run can succeed having recorded one and
not the other, leaving a Posting whose originating Run holds nothing to read
back.

It also shrinks the client surface: the Run identifier stops travelling through
the form entirely, and ownership becomes structural — a Posting cannot be
addressed without naming a user, so filtering by the session's own identity
_is_ the check rather than a comparison bolted beside it.

**Blocked by:** 06 — Posting detail dialog

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Drafting works for a Posting whose originating Run no longer holds
      readable Findings.
- [ ] The Run identifier no longer travels through the submitted form.
- [ ] **The Posting body is still never accepted from the submission** — a
      submitted body is still ignored, and the existing test proving it passes
      unchanged. This is the property that keeps text of a caller's choosing out
      of a document written in the user's own voice.
- [ ] A Posting belonging to another user cannot be drafted for, and the refusal
      does not reveal whether it exists.
- [ ] The originating Run is still recorded as provenance on the stored letter —
      "which Run found this" stays worth knowing.
- [ ] Re-drafting the same Posting still supersedes one stored letter rather
      than creating a second.
- [ ] The superseded error messages about a Posting no longer being in the
      latest Run are gone, along with the Run lookup they belonged to.
- [ ] Works under `DEV_AUTH_BYPASS`, and any now-unreachable dev-mode query is
      removed rather than left answering a question nothing asks.
