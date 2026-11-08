# Branch and release flow

This repository keeps `main` releasable at all times. Work for the next release
is integrated on a long-lived `release/next` branch, so several features can
land reviewably without forcing a release after each merge.

```mermaid
flowchart LR
    F["feat/* · fix/* · docs/*"] -->|"PR + CI"| R["release/next"]
    R -->|"release PR"| M["main"]
    H["hotfix/*"] -->|"PR + CI"| M
    M -->|"release-please PR"| M
    M -->|"tag + GitHub release"| NPM["npm publish"]
    M -->|"sync back"| R
```

## Day-to-day work

1. Branch from `release/next` (not from `main`):

   ```bash
   git switch release/next
   git pull
   git switch -c feat/short-description
   ```

2. Keep changes focused; use conventional commit subjects (`feat:`, `fix:`,
   `docs:`, `chore:`). release-please derives the version bump and changelog
   from them.
3. Open the pull request against `release/next`. CI runs on every pull request.
4. Merge only when CI is green. Delete the feature branch.

## Cutting the next release

1. Open a pull request from `release/next` to `main`.
2. Review the aggregate diff and the full test matrix.
3. Merge it with a **merge commit**, not a squash, so release-please still sees
   the individual conventional commits.
4. release-please opens its own release PR on `main`. Merging that PR creates
   the tag and GitHub release; the publish workflow then ships the package to
   npm.
5. Fast-forward or merge `main` back into `release/next` so the next cycle
   starts from the released state:

   ```bash
   git switch release/next
   git merge --ff-only main
   git push
   ```

## Hotfixes

Hotfixes must reach users without waiting for the next release:

1. Branch from `main`: `git switch -c fix/short-description main`.
2. Open the pull request against `main`.
3. After it is merged and released, merge `main` into `release/next`.

## Notes

- `main` is protected ground: only release PRs, hotfixes, and release-please
  land there.
- `release/next` may be recreated after a release; the name is intentionally
  versionless so the flow does not change for every minor release.
- Update this document if the workflow changes.
