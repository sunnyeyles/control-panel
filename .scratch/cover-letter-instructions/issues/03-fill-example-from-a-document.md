# 03 — Fill the example from a document you have uploaded

**What to build:** Most people already have a cover letter they like, sitting in **Documents**
as a PDF or a `.docx`. Rather than making them open it, select all and paste, the Cover letters
section offers a picker: choose one of your Documents, and its text is extracted server-side
and dropped into the example field, where it can be edited and saved like anything typed there.

The extraction path already exists — it is what reads a CV to draft from, and it handles `.md`,
`.txt`, PDF and DOCX, refusing `.doc`, `.odt` and `.rtf` by name. Reuse it rather than adding a
second reader; a failure to parse becomes a message naming the document, never a throw.

**This is a one-time copy into the field, not a live link to the Document.** Storing a pointer
instead would put an object read and a PDF parse on every single draft, and would silently drop
the user's example if that Document were later deleted — a letter that quietly stops following
its own style reference is the failure mode this codebase refuses everywhere else. The cost is
stated plainly in the UI: re-uploading the Document does not update the example, and importing
replaces whatever is currently in the field.

The picker lists every Document whose format can actually be read, newest first, labelled with
its **Document Type** so a CV is not mistaken for a letter.

With this ticket the feature is complete, so `OVERVIEW.md` §Not built yet loses its
"regenerate it with instructions, choose a tone" clause and keeps the rest — rendering a
letter's text in the app, editing one, and sending it all remain unbuilt.

**Blocked by:** 02 — An example letter, fenced as style and never as fact.

**Status:** ready-for-agent

- [ ] The Cover letters section offers a document picker beneath the example field, listing the
      user's readable Documents newest first with their Document Type shown
- [ ] Choosing one and confirming extracts its text and fills the example field; the user can
      then edit and save it normally
- [ ] The UI states that importing replaces what is in the field, and that the copy is one-time
- [ ] A PDF and a `.docx` both import successfully
- [ ] A document that cannot be parsed — a scanned PDF with no text layer, a `.doc` — produces a
      message naming the document and what to do instead, not a throw and not an empty field
- [ ] Extracted text over the example cap is refused with a message naming the document, the
      count and the limit
- [ ] Importing another user's document is refused, and the refusal does not reveal whether it
      exists
- [ ] The picker and the extraction reuse the existing document listing and text extraction
      rather than introducing a second reader
- [ ] Tests cover a successful import, an unparseable document, an over-cap document, and the
      ownership refusal
- [ ] The picker and a successful import work under `DEV_AUTH_BYPASS=1` against the fixture
      documents, so the flow can be exercised without AWS credentials
- [ ] `OVERVIEW.md` §Not built yet is updated to reflect that instructions and tone are now built
