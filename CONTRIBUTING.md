# Contributing

Create a short-lived topic branch from `main` and submit changes through a pull
request. See [development and verification](README.md#development-and-verification)
for the pinned toolchain and local checks. Use isolated homes for installer tests;
never exercise an installer against personal OMP configuration. The installer
suite uses real native OMP commands, temporary homes, and no model or network
calls. Its Windows file-symlink refusal tests require permission to create file
symlinks (for example, Developer Mode); they fail explicitly when unavailable.
The installer itself uses OMP's directory junctions and needs no such privilege.

## Required status checks

[`.github/rulesets/main.json`](.github/rulesets/main.json) is the tracked **desired
state** of the default-branch ruleset. It is not applied automatically: editing
or merging this file does not change live GitHub repository settings. This follows
the [mado-pilot file convention](https://github.com/pashifika/mado-pilot/tree/main/.github/rulesets).

The intended policy requires a pull request, resolved review conversations,
merge commits and the strict, up-to-date `ci` status check. It blocks branch
deletion and force pushes, with no bypass actors. The approval count is zero to
allow a solo maintainer to submit their own changes; the JSON is authoritative
for policy parameters.

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
