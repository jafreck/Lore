---
name: release-draft
description: Prepare, open, merge, and publish a Lore release PR. Use when asked to draft a release, cut a release, bump the version, refresh release docs, create a changelog, tag a version, or publish to npm.
---

# Draft Lore Release

## Purpose

Run Lore's release workflow end to end:

- inspect the delta since the latest release
- refresh docs based on that delta
- bump the version in both `package.json` and `package-lock.json`
- open a release PR
- merge the PR
- publish a GitHub release with a clear changelog and matching git tag
- trigger the npm publish workflow in `.github/workflows/publish.yml`

## Repo-specific facts

- Release tags use the format `vX.Y.Z`.
- The package version must stay in sync in both `package.json` and `package-lock.json`.
- Publishing is triggered by a **published GitHub release**, not by a local tag push alone.
- `.github/workflows/publish.yml` runs on `release.published`, so the GitHub release must be published after the PR is merged.

## Instructions

When the user asks to draft, prepare, cut, or publish a release:

1. **Find the release baseline**
   - Read the latest GitHub release and latest tag.
   - Compare the current target branch, normally `main`, against that release tag.
   - Build a release delta from commits, merged PRs, changed files, and any docs that are now stale.

2. **Decide the target version**
   - If the user supplied a version, use it.
   - If the user did not supply a version, infer the likely next semver bump from the delta and ask for confirmation before changing files.
   - Always use `vX.Y.Z` for tags and `X.Y.Z` inside package files.

3. **Refresh documentation from the release delta**
   - Review the changes since the last release and update any docs that no longer match reality.
   - Check at least `README.md` and `docs/architecture.md`, plus any other documentation affected by the changed behavior.
   - Do not treat docs as optional for a release PR.
   - The release PR should include doc refreshes when the delta changes behavior, APIs, workflows, architecture, or supported capabilities.

4. **Create a release branch**
   - Create a branch for the release work, for example `release/vX.Y.Z`.
   - Never push the release changes directly to `main`.

5. **Update the version everywhere required**
   - Update `package.json` to `X.Y.Z`.
   - Update `package-lock.json` to the exact same `X.Y.Z`.
   - Verify both files match before opening the PR.

6. **Validate the release branch**
   - Run the project's relevant verification steps after the docs and version updates.
   - Prefer at least the normal build and test flow used by the repo.
   - If validation fails, fix the issue or stop and report the blocker before opening the PR.

7. **Prepare a clear release summary**
   - Summarize the release in plain language.
   - Highlight user-visible changes first.
   - Include the docs that were refreshed because of the release delta.
   - Include the previous release tag and the compare range used to build the summary.

8. **Open the release PR**
   - Open a pull request from the release branch into `main`.
   - Use a clear title such as `chore: release vX.Y.Z` unless repo conventions indicate a better format.
   - In the PR body, include:
     - the version bump
     - the docs refresh summary
     - the key changes since the last release
     - any validation results
     - the compare range from the previous tag to the new release target

9. **Merge the PR**
   - Do not create the GitHub release before the PR is merged.
   - Merge only after checks are green and the PR is ready.
   - Prefer the repo's normal merge method.

10. **Create and publish the GitHub release**
    - After the PR is merged, create a GitHub release from the merged state on `main`.
    - Ensure the git tag exists and is exactly `vX.Y.Z`.
    - Publish the release, not just save a draft.
    - The release body must contain a clear changelog derived from the delta since the last release.

11. **Confirm publish automation**
    - Note that publishing the GitHub release should trigger `.github/workflows/publish.yml`.
    - Confirm that the release event is the mechanism used to publish to npm.

## Changelog requirements

The GitHub release changelog should:

- be based on the actual delta since the last release
- lead with user-facing changes
- group items under clear headings such as `Features`, `Fixes`, `Docs`, and `Internal`
- mention important docs refreshes when they are part of the release
- include the full compare link or compare range when possible
- be clearer than a raw commit list

## Constraints

- Never skip the PR step.
- Never release directly from an unmerged branch.
- Never skip refreshing docs when the release delta affects them.
- Never bump `package.json` without also bumping `package-lock.json`.
- Never create a release tag that does not match the package version.
- Never leave the release as a draft if the goal is to trigger npm publishing.
- Never claim npm publish will happen from a tag alone in this repo; it happens from the published GitHub release event.

## Example triggers

- "draft a release"
- "cut the next Lore release"
- "prepare an npm release"
- "bump Lore to 0.3.3 and publish it"
- "make a release PR and ship it"
