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
 * ⚠️ The PDF is made in the browser and never exists on the server. This fetches
 * the same `/api/tailored-resumes/[postingId]` the download link uses and hands
 * the markdown to `exportMarkdownToPdf`. A route returning `application/pdf`
 * would mean jsPDF under Node behind a DOM shim, and a second cached
 * representation of a document whose value is being current.
 *
 * ⚠️ The renderer is imported on click, not shipped with the page: jsPDF and the
 * markdown parser were a 453 KB chunk of `/jobs`'s first load, for a button most
 * visits never press. It is requested *alongside* the markdown, not after —
 * neither depends on the other.
 *
 * ⚠️ This deliberately duplicates `FileEditorDialog`'s own "Download PDF", which
 * renders unsaved edits. This one serves wanting the file without opening a
 * dialog over a document you are not going to change.
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
      // A dropped connection, a chunk that would not load, or the renderer
      // throwing — the same thing to the user, and retrying is all they can do.
      // It must not fail silently: a dead button reads as a broken page.
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
