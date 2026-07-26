# 09 — Reconcile the agents-core stub with the instruction surface

**What to build:** The repo stops contradicting itself about tests and build artifacts. Today an agent reads "there is no test setup, do not invent test commands" at the root and then finds a workspace declaring a test script — and has no way to tell which is authoritative.

The stub's actual state, all verified:

- Its source directory is empty; only its manifest and task config are tracked.
- It declares a test script and a build script. Neither has a corresponding task in the Turborepo config, so neither participates in the task graph, and the build's output directory is not declared as a cacheable output.
- Its dev dependency versions are not valid specifiers — several name a workspace package where a version range belongs — so this workspace cannot install as written.
- It uses a different package-name prefix from every other workspace, and its manifest carries placeholder repository metadata and a stray field that has no meaning at the top level of a manifest.
- It declares dependencies on an agent framework, which suggests real intent behind the stub rather than an accident.

Pick one of two resolutions and make the instruction surface match:

**Either** remove the stub, and the root file's statements about tests and build artifacts become true with no further qualification.

**Or** keep it and make it honest: correct the dependency specifiers so it installs, align its package name with the workspace convention, drop the placeholder metadata, and either wire its test and build tasks into the task graph — declaring the build output so it caches — or remove those scripts until there is something to run. Then document in the root file that this workspace is the one place a test runner exists, and what the repo-wide command is or is not.

Do not leave the third option, which is the current state: a package that cannot install, declares tasks that nothing runs, and quietly falsifies the root instructions.

Removal is the lighter change and is the right call if nothing is being built on this stub yet. That is a judgement call about intent, so confirm it rather than assuming — the framework dependencies suggest someone meant to start here.

**Blocked by:** 03 — the root file's test-setup statement is rewritten there; this ticket decides what that statement can truthfully say long-term.

**Status:** ready-for-agent

- [ ] A resolution is chosen and the reason recorded
- [ ] If kept: the workspace installs cleanly from a fresh lockfile-respecting install
- [ ] If kept: the package name follows the same prefix convention as every other workspace
- [ ] If kept: declared scripts either have matching tasks in the task graph, with build outputs declared, or are removed
- [ ] If kept: placeholder repository metadata and the meaningless top-level field are gone
- [ ] If removed: no workspace reference, task config, or documentation still mentions it
- [ ] The root file's statement about tests is true after this ticket, with no reader left guessing which source wins
