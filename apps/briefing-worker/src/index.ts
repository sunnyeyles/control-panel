// The bundle entry point. Importing a trigger module is what registers it with
// the Functions host, so the import is the whole job — there is nothing to
// export. Any new module under `functions/` needs its own line here.
import "./functions/scheduled-run.js"
