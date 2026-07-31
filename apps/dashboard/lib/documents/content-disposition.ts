/**
 * Turning a stored filename into a response header, safely.
 *
 * Its own module for the same reason `upload-validation.ts` is one: no imports,
 * so a test can reach it. It lived in `app/api/documents/[file]/route.ts`, which
 * transitively imports the auth SDK and therefore Next — which made the one
 * piece of escaping on this path the one piece nothing could exercise. The
 * filename here is user-supplied text on its way into an HTTP header, so that
 * was the wrong thing to have untested.
 */

/**
 * A `Content-Disposition` a browser will accept for any stored filename.
 *
 * `cleanFilename()` in `@workspace/user-storage` already stripped path
 * separators and non-ASCII at write time, so the quoted form is nearly always
 * fine — but "nearly always" is not a reason to skip escaping a value that
 * reaches a response header. A stray `"` would end the quoted string early and
 * let the rest of the filename be read as further header parameters.
 *
 * The RFC 5987 `filename*` is emitted alongside because it is what browsers
 * actually prefer, and it round-trips characters the quoted form cannot.
 */
export function contentDisposition(filename: string): string {
  // Controls first, then the escapes — stripping after escaping would leave a
  // backslash whose partner had just been removed.
  //
  // ⚠️ **A `quoted-string` cannot carry a control character, and CR or LF in
  // one is header injection.** `cleanFilename` strips everything outside
  // printable ASCII at write time, so nothing stored today can reach here with
  // one — but that guard lives in another package, on the *write* path, and
  // this function is now the thing responsible for producing a valid header
  // from any string. Depending on a sanitiser two modules away for that is how
  // the guarantee gets quietly dropped when someone relaxes the other end.
  // The `filename*` half already encoded these; this is the half that did not.
  const quoted = filename
    // `no-control-regex` exists to catch a control character that got into a
    // pattern by accident. Here they are the subject of the pattern, and the
    // whole point of the line.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')

  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeExtValue(filename)}`
}

/**
 * Percent-encode for an RFC 8187 `ext-value`, which is not what
 * `encodeURIComponent` produces.
 *
 * `encodeURIComponent` leaves `!'()*` alone, because they are legal in a URI
 * component. None of them is an `attr-char`, and `'` is the field's own
 * delimiter — it is what separates `UTF-8`, the language tag, and the value. So
 * a filename as ordinary as `Alice's CV.pdf` produced
 * `filename*=UTF-8''Alice's%20CV.pdf`, which has three apostrophes where the
 * grammar allows two. Browsers are lenient about it and would very likely have
 * kept working; "very likely" is a poor thing to rely on when the fix is five
 * characters in a character class.
 */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  )
}
