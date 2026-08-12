/**
 * Turning a stored filename into a response header, safely.
 *
 * Its own module for the reason `upload-validation.ts` is one: no imports, so a
 * test can reach it. It lived in the download route, which transitively imports
 * Next — leaving user-supplied text on its way into an HTTP header as the one
 * piece of escaping nothing could exercise.
 */

/**
 * Module scope, not inline in the functions below.
 *
 * A regex literal constructs a fresh `RegExp` per evaluation, so inline ones
 * allocate four throwaway objects per download. ⚠️ Sharing is safe only because
 * every use is `String.prototype.replace`, which resets `lastIndex` — a shared
 * `/g/` regex used with `.test()` would skip every second match.
 */
// `no-control-regex` exists to catch a control character that got into a
// pattern by accident. Here they are the subject of the pattern, and the whole
// point of the line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/g
const BACKSLASH = /\\/g
const QUOTE = /"/g
const NON_ATTR_CHARACTERS = /[!'()*]/g

/**
 * A `Content-Disposition` a browser will accept for any stored filename.
 *
 * `cleanFilename()` in `@workspace/user-storage` already stripped path
 * separators and non-ASCII at write time, so the quoted form is nearly always
 * fine — but a stray `"` would end the quoted string early and let the rest be
 * read as further header parameters.
 *
 * The RFC 5987 `filename*` is emitted alongside because browsers prefer it and
 * it round-trips characters the quoted form cannot.
 */
export function contentDisposition(filename: string): string {
  // Controls first, then the escapes — stripping after escaping would leave a
  // backslash whose partner had just been removed.
  //
  // ⚠️ **A `quoted-string` cannot carry a control character, and CR or LF in
  // one is header injection.** `cleanFilename` strips those at write time, but
  // that guard is in another package on the *write* path — depending on it is
  // how the guarantee gets dropped when someone relaxes the other end. The
  // `filename*` half already encoded these; this is the half that did not.
  const quoted = filename
    .replace(CONTROL_CHARACTERS, "")
    .replace(BACKSLASH, "\\\\")
    .replace(QUOTE, '\\"')

  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeExtValue(filename)}`
}

/**
 * Percent-encode for an RFC 8187 `ext-value`, which is not what
 * `encodeURIComponent` produces.
 *
 * `encodeURIComponent` leaves `!'()*` alone as legal URI-component characters.
 * None is an `attr-char`, and `'` is the field's own delimiter — so
 * `Alice's CV.pdf` produced `filename*=UTF-8''Alice's%20CV.pdf`, three
 * apostrophes where the grammar allows two.
 */
function encodeExtValue(value: string): string {
  // No `padStart`: the class is exactly `!'()*`, code points 0x21–0x2A, so
  // every one of them is already two hex digits. A pad that can never fire
  // reads as though some input needs it.
  return encodeURIComponent(value).replace(
    NON_ATTR_CHARACTERS,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}
