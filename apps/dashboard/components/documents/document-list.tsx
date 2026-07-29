import { DeleteDocumentButton } from "@/components/documents/delete-document-button"
import type { DocumentSummary } from "@/lib/documents/list-documents"
import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

/**
 * A server component: it renders dates and sizes to strings here, on the
 * server, and passes only strings down. Formatting a Date in a client component
 * uses the browser's locale and timezone, which will not match the server's —
 * and React reports that as a hydration mismatch rather than as the timezone
 * bug it is.
 */

/** Display labels for the stored values. `other` is a real choice, not a gap. */
const TYPE_LABELS: Record<string, string> = {
  resume: "Resume",
  "cover-letter": "Cover letter",
  portfolio: "Portfolio",
  reference: "Reference",
  other: "Other",
}

export function DocumentList({ documents }: { documents: DocumentSummary[] }) {
  if (documents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No documents yet. Upload a CV to get started.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>Uploaded</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {documents.map((document) => (
            <TableRow key={document.resumeId}>
              <TableCell className="font-medium">
                {/*
                  A plain anchor with `download`, not `next/link`. Prefetching a
                  download route would have the browser fetch the whole file on
                  hover — and the route answers with an attachment disposition,
                  which is not something the client router can navigate to.
                */}
                <a
                  href={`/api/documents/${document.file}`}
                  download={document.displayName}
                  className="underline underline-offset-4 hover:no-underline"
                >
                  {document.displayName}
                </a>
              </TableCell>

              <TableCell>
                {document.documentType ? (
                  <Badge variant="secondary">
                    {TYPE_LABELS[document.documentType] ??
                      document.documentType}
                  </Badge>
                ) : (
                  // Everything uploaded before document types existed lands
                  // here, so this fallback is load-bearing rather than
                  // defensive.
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>

              <TableCell className="text-right tabular-nums">
                {formatSize(document.size)}
              </TableCell>

              <TableCell className="text-muted-foreground">
                {formatDate(document.uploadedAt)}
              </TableCell>

              <TableCell>
                <DeleteDocumentButton
                  resumeId={document.resumeId}
                  extension={document.extension}
                  displayName={document.displayName}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(date: Date): string {
  // A fixed locale and timezone, not the runtime's. The server's default locale
  // is whatever the platform decides, which is neither stable across deploys
  // nor the user's.
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}
