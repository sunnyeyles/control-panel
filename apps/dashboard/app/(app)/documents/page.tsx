import { Suspense } from "react"

import { DocumentList } from "@/components/documents/document-list"
import { DocumentListSkeleton } from "@/components/documents/document-list-skeleton"
import { DocumentUploader } from "@/components/documents/document-uploader"
import { requirePageUser } from "@/lib/auth/require-page-user"
import { getPrisma } from "@/lib/db"
import {
  listDocuments,
  type DocumentSummary,
} from "@/lib/documents/list-documents"
import { acceptedResumeExtensions } from "@workspace/user-storage"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * Governs the upload action too: a Server Action runs under the duration of the
 * segment that invoked it, and the default is short enough that a slow upload
 * of a few megabytes can be cut off mid-put.
 */
export const maxDuration = 30

/**
 * ⚠️ **This component awaits the session and nothing else, and keeping it that
 * way is the point.** The listing is inside a `<Suspense>` below, in a child
 * that awaits it — so the uploader, which needs no data at all, is on screen as
 * soon as the session resolves off its cookie rather than after Postgres
 * answers. Moving the query back up here would put the whole page behind it
 * again. Same arrangement as `/jobs` and `/jobs/letters`.
 */
export default async function DocumentsPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 lg:px-6">
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-medium">Upload a document</h2>
            <p className="text-sm text-muted-foreground">
              CVs, cover letters and anything else worth keeping alongside your
              job search.
            </p>
          </div>
          {/*
            The accepted list is resolved here, on the server, and passed
            down — so the client bundle never imports
            `@workspace/user-storage` and never carries the AWS SDK.
          */}
          <DocumentUploader acceptedExtensions={acceptedResumeExtensions()} />
        </section>

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-medium">Your documents</h2>
            <p className="text-sm text-muted-foreground">
              Stored privately. Only you can download these.
            </p>
          </div>

          <Suspense fallback={<DocumentListSkeleton rows={3} />}>
            <DocumentsSection userId={user.userId} />
          </Suspense>
        </section>
      </div>
    </main>
  )
}

/**
 * The listing, and the only thing on this page that waits on a query.
 *
 * A database outage degrades this to "your documents could not be loaded"
 * rather than replacing the page with an error boundary — the user can still
 * read what the page is for, still upload, and the upload form's own error
 * handling takes over from there. The `try`/`catch` lives here rather than in
 * the page so that degradation stays inside the boundary it belongs to.
 */
async function DocumentsSection({ userId }: { userId: string }) {
  let documents: DocumentSummary[] = []

  try {
    documents = await listDocuments(userId, getPrisma())
  } catch (error) {
    console.error("documents: could not list", error)

    return (
      <Alert variant="destructive">
        <AlertDescription>
          Your documents could not be loaded. Try again in a moment.
        </AlertDescription>
      </Alert>
    )
  }

  return <DocumentList documents={documents} />
}
