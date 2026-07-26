import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

const root = import.meta.dirname
const CONFIG_NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
]
const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

// Lint rules live in each workspace's eslint.config.js, and there is no flat
// config at the root. The v10 flag makes ESLint resolve config from the file
// being linted instead of the cwd; files with no config above them are dropped
// so a commit never dies on an unlintable path.
function isLintable(file) {
  if (!LINTABLE.test(file)) return false
  let dir = dirname(file)
  while (dir.startsWith(root)) {
    if (CONFIG_NAMES.some((name) => existsSync(join(dir, name)))) return true
    dir = dirname(dir)
  }
  return false
}

const quote = (files) =>
  files.map((f) => `'${f.replaceAll("'", `'\\''`)}'`).join(" ")

// One glob, so the commands run in sequence rather than racing each other on
// the same file. ESLint fixes first; Prettier formats last and wins.
export default {
  "*": (files) => {
    const commands = []
    const lintable = files.filter(isLintable)
    if (lintable.length > 0) {
      commands.push(
        `eslint --flag v10_config_lookup_from_file --fix --no-warn-ignored ${quote(lintable)}`
      )
    }
    commands.push(`prettier --write --ignore-unknown ${quote(files)}`)
    return commands
  },
}
