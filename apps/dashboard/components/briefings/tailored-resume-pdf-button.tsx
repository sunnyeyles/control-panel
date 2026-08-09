"use client"

import { useState } from "react"

import { ActionError } from "@/components/forms/action-error"
import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { tailoredResumeFilename } from "@/lib/tailored-resumes/tailored-resume-ref"

const FAILED = "The PDF could not be made. Try again in a moment."
const REFUSED = "Your session has expired. Reload the page and sign in again."
const GONE =
  "That tailored resume could not be found. Refresh the page and try again."

/**
 * Download one Posting's tailored resume as a PDF.
 *
 * ⚠️ **The PDF is made in the browser and never exists on the server.**
 * `exportMarkdownToPdf` (`packages/ui/src/lib/pdf-export.ts`) is a jsPDF
 * renderer that walks marked's token stream and draws text — so this fetches the
 * same `/api/tailored-resumes/[postingId]` the download link and the editor use,
 * and renders the markdown it gets back. There is no PDF route, no server-side
 * renderer and no second stored object; the only thing the server ever holds is
 * the markdown.
 *
 * That is worth stating because the alternative looks tidier and is not: a route
 * returning `application/pdf` would mean running jsPDF under Node, which needs a
 * DOM shim, and would put a second representation of the same document in the
 * response cache for a CV whose whole value is being current.
 *
 * ⚠️ **The renderer is fetched on click, not shipped with the page.** jsPDF and
 * the markdown parser behind it were a 453 KB chunk in `/jobs`'s first load —
 * about a third of it — because this component is reached statically from
 * `posting-detail.tsx`, and the table renders one of these per Posting while
 * most visits click none of them. `file-editor-dialog.tsx` imports the same
 * module and costs nothing, because it is already behind a `dynamic()`.
 *
 * ⚠️ **The chunk is requested *alongside* the markdown, not after it.** The two
 * are independent — the renderer does not depend on the bytes and the bytes do
 * not depend on the renderer — so awaiting them in series would put a download
 * behind a download for no reason. The `working` state already renders
 * "Making PDF…" over both, so neither is a button that looks dead.
 *
 * **A real, text-based PDF rather than a screenshot** — the renderer's own
 * comment explains why it avoids html2canvas: canvas capture proved unreliable
 * across browsers and could silently produce blank pages. The text is selectable,
 * which for a resume matters twice over, since applicant-tracking systems read
 * it.
 *
 * ⚠️ **This duplicates a button that already exists inside the editor**, and
 * deliberately. `FileEditorDialog` renders its own "Download PDF" over whatever
 * is in the editor, which is the right answer *while editing*. This one serves
 * the case that has nothing to do with editing: wanting the file, now, without
 * opening a dialog over a document you are not going to change.
 */
export function TailoredResumePdfButton({
  postingId,
  title,
  company,
}: {
  postingId: string
  title: string
  company: string
}) {
  const [state, setState] = useState<ActionState>(IDLE)
  const [working, setWorking] = useState(false)

  async function download() {
    setWorking(true)
    setState(IDLE)

    try {
      const [response, { exportMarkdownToPdf }] = await Promise.all([
        fetch(`/api/tailored-resumes/${postingId}`),
        import("@workspace/ui/lib/pdf-export"),
      ])

      if (!response.ok) {
        // The route conflates "no such resume" with "not yours" deliberately —
        // telling them apart would confirm another user's Posting exists — so
        // there are only three cases to tell apart here.
        setState({
          status: "error",
          message:
            response.status === 401
              ? REFUSED
              : response.status === 404
                ? GONE
                : FAILED,
        })
        return
      }

      // The `.md` name the download link offers, with the extension swapped, so
      // the two land in the downloads folder under one recognisable stem.
      const filename = tailoredResumeFilename({
        postingId,
        title,
        company,
      }).replace(/\.md$/i, ".pdf")

      exportMarkdownToPdf(await response.text(), filename)
    } catch (error) {
      // A dropped connection, a renderer chunk that would not load, or the
      // renderer throwing on something in the markdown — all three are the same
      // thing to the user, and all three land here now that the import is one
      // of the two promises above. Nothing they can act on beyond retrying,
      // which is what leaving the button released offers. But it must not
      // fail silently — a button that does nothing reads as a broken page.
      console.error("tailored-resumes: could not export a PDF", error)
      setState({ status: "error", message: FAILED })
    } finally {
      setWorking(false)
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      {/*
        A button rather than an anchor, because unlike the `.md` download there
        is no URL that produces this file — the bytes are made here. Styled as a
        link so the two read as the pair they are.
      */}
      <button
        type="button"
        onClick={() => void download()}
        disabled={working}
        className="self-start text-sm underline underline-offset-4 hover:no-underline disabled:no-underline disabled:opacity-60"
        aria-label={`Download the tailored resume for ${title} as a PDF`}
      >
        {working ? "Making PDF…" : "Download PDF"}
      </button>

      <ActionError state={state} />
    </span>
  )
}
