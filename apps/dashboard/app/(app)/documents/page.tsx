import { DocumentList } from "@/components/documents/document-list"
import { DocumentUploader } from "@/components/documents/document-uploader"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  listDocuments,
  type DocumentSummary,
} from "@/lib/documents/list-documents"
import { getResumeStore } from "@/lib/storage"
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

export default async function DocumentsPage() {
  const user = await requirePageUser()

  // A storage outage should degrade this page to "upload is unavailable", not
  // replace it with an error boundary — the user can still read what the page
  // is for, and the upload form's own error handling takes over from there.
  let documents: DocumentSummary[] = []
  let listFailed = false

  try {
    documents = await listDocuments(user.userId, getResumeStore())
  } catch (error) {
    console.error("documents: could not list", error)
    listFailed = true
  }

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

          {listFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Your documents could not be loaded. Try again in a moment.
              </AlertDescription>
            </Alert>
          ) : (
            <DocumentList documents={documents} />
          )}
        </section>
      </div>
    </main>
  )
}
