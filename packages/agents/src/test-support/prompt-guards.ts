import { expect } from "vitest"

/**
 * The containment clauses every tool-less prompt here carries, asserted once
 * per suite instead of as three copied tests.
 *
 * Universal by design: the quoted-material fence (the document in the context
 * is data, not instruction), the statement that nothing can be looked up, and
 * the no-fence/no-preamble output shape. Everything else in a system prompt is
 * that agent's own and stays asserted clause-by-clause in its suite, so that
 * dropping a rule is a named test failure.
 */
export function expectSharedPromptGuards(prompt: string): void {
  expect(prompt).toMatch(/quoted material/i)
  expect(prompt).toMatch(/ignore it/i)
  expect(prompt).toMatch(/no tools/i)
  expect(prompt).toMatch(/no code fence/i)
  expect(prompt).toMatch(/no preamble/i)
}
