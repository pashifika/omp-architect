# Contributing

Create a short-lived topic branch from `main` and submit changes through a pull
request. Use the pinned toolchain and checks below before submitting.

## Development and verification

Use **Bun 1.3.14** and the locked **OMP 18.5.1** and **TypeScript 5.9.3**
dependencies from `package.json`.

```bash
bun install --frozen-lockfile
bun run check
bun run check:package
bun run check:workflows
bun run test:dev-install
```

`check` runs formatting, type checking, and unit tests. `check:package` packs,
inspects, and loads the tarball against the locked OMP host; it does not publish.
`check:workflows` validates workflow safety and the tracked branch policy.

For the Rasen integration suite, prepare the pinned development build first:

```bash
bun run prepare:rasen
bun run test:smoke
```

The preparation step downloads public upstream source and dependencies into an
isolated installation. Smoke tests fail rather than skip when that build is absent.
See [the verification record](docs/rasen-auto-verification.md) for provenance,
coverage, and recorded results. No model credentials are needed for these suites;
model responses use deterministic fixtures.

Use isolated homes for installer tests; never exercise an installer against
personal OMP configuration. The installer suite uses real native OMP commands,
temporary homes, and no model or network calls. Its Windows file-symlink refusal
tests require permission to create file symlinks (for example, Developer Mode);
they fail explicitly when unavailable. The installer itself uses OMP's directory
junctions and needs no such privilege.

CI runs installer tests on macOS and Windows. Workflows run for pull requests
and pushes to `main`, using pinned actions, least-privilege permissions,
nonpersistent checkout credentials, timeouts, and concurrency cancellation.
No release or publishing workflow or credentials are configured.

## Required status checks

[`.github/rulesets/main.json`](.github/rulesets/main.json) is the tracked **desired
state** of the default-branch ruleset. It is not applied automatically: editing
or merging this file does not change live GitHub repository settings. This follows
the [mado-pilot file convention](https://github.com/pashifika/mado-pilot/tree/main/.github/rulesets).

The intended policy requires a pull request, resolved review conversations,
merge commits and a successful `ci` status check. Branches do not need to be
up to date with the base branch. It blocks branch deletion and force pushes,
with no bypass actors. The approval count is zero to allow a solo maintainer
to submit their own changes; the JSON is authoritative for policy parameters.

`ci` is the stable aggregate gate in [CI](.github/workflows/ci.yml). It depends on
all quality, integration and cross-platform installer jobs, runs even when a
prerequisite fails or is skipped, and accepts only successful results. Keep this
name synchronized with the ruleset. `bun run check:workflows` validates both the
workflow and the tracked desired-state policy without changing GitHub settings.

After reviewing a ruleset change, a repository administrator must import/apply
that JSON separately through GitHub's repository Settings → Rules → Rulesets,
then verify its active enforcement and required check against live settings.
Do not treat the tracked `enforcement: "active"` value as proof it was applied.
Confirm that `ci` has reported successfully before making it a required check.
No administrator token, auto-apply workflow or additional CI write permission is
needed or provided by this repository.
