import { DeleteDocumentButton } from "@/components/documents/delete-document-button"
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents/document-type-labels"
import type { DocumentSummary } from "@/lib/documents/list-documents"
import { formatCalendarDate } from "@/lib/format-dates"
import { Badge } from "@workspace/ui/components/badge"
import { Empty, EmptyDescription } from "@workspace/ui/components/empty"
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

export function DocumentList({ documents }: { documents: DocumentSummary[] }) {
  if (documents.length === 0) {
    return (
      <Empty>
        <EmptyDescription>
          No documents yet. Upload a CV to get started.
        </EmptyDescription>
      </Empty>
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
            <TableRow key={document.documentId}>
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
                {/*
                  ⚠️ No `??` fallback, and one would be dead code.
                  `noUncheckedIndexedAccess` does not apply: a
                  `Record<DocumentType, string>` over a literal union is a mapped
                  type, not an index signature. At runtime the CHECK on
                  `documents.doc_type` covers it, and `doc_type` is NOT NULL —
                  an unrecognised label lands on `other`.
                */}
                <Badge variant="secondary">
                  {DOCUMENT_TYPE_LABELS[document.documentType]}
                </Badge>
              </TableCell>

              <TableCell className="text-right tabular-nums">
                {formatSize(document.size)}
              </TableCell>

              <TableCell className="text-muted-foreground">
                {formatCalendarDate(document.uploadedAt)}
              </TableCell>

              <TableCell>
                <DeleteDocumentButton
                  documentId={document.documentId}
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
