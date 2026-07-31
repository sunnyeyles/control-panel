import type { NextConfig } from "next"

import { MAX_ACTION_BODY_BYTES } from "./lib/documents/upload-validation"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui"],

  experimental: {
    serverActions: {
      /**
       * Documents are capped at 3 MiB by `lib/documents/upload-validation.ts`;
       * this leaves room for the multipart envelope around one. The default is
       * 1 MB, which a scanned CV does not reliably fit inside.
       *
       * **Imported rather than written as a string, so it cannot drift from
       * `MAX_REQUEST_BYTES`.** It used to read `"4mb"`, which the `bytes`
       * parser resolves to 4 MiB — the same number as the `content-length`
       * check it is supposed to sit above. Next enforces this limit while the
       * body streams, before the action function is called, so at parity it
       * always won and the app's own "That upload is too large." never ran. Two
       * literals that had to stay ordered were kept in two files; now there is
       * one, and a test asserts the ordering. The option takes a byte count as
       * happily as a string.
       */
      bodySizeLimit: MAX_ACTION_BODY_BYTES,
    },

    /**
     * ⚠️ **Must stay strictly above `serverActions.bodySizeLimit`. The ordering
     * is the whole design, not a coincidence.**
     *
     * This applies because the app has a `proxy.ts`: Next clones and buffers
     * every request body so the proxy and the handler can both read it, and
     * this caps that buffer. Exceeding it **does not fail the request** — Next
     * buffers the first N bytes, logs a warning, and lets the request continue
     * with a partial body. Stated outright in the local docs, at
     * `next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`:
     * "The request will not fail or return an error to the client."
     *
     * A truncated multipart body either fails to parse or yields a `File` whose
     * size reports the truncated length — so a size check on it would be
     * checking a number the truncation produced, and an oversized upload could
     * land in S3 as a silently corrupt document.
     *
     * Keeping this ceiling above the Server Action ceiling makes truncation
     * unreachable: the action layer rejects with a real, loud error before this
     * buffer is ever the binding constraint. **Inverting the two reintroduces
     * silent corruption**, and nothing fails loudly to tell you.
     *
     * The full ladder, smallest first, in the units each rung is actually
     * expressed in: client pre-check 3 MiB, authoritative byte check 3 MiB,
     * `content-length` check 4 MiB, the action limit 4.2 MiB, Vercel's platform
     * cap ~4.5 MB, this buffer 6 MiB. Every step is a strict inequality — where
     * two rungs were equal, the lower one was unreachable.
     */
    proxyClientMaxBodySize: "6mb",
  },
}

export default nextConfig
