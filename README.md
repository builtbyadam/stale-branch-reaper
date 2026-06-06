<div align="center">

# 🌿 stale-branch-reaper

**Find and prune merged branches that have outlived their usefulness — safely, with a dry run by default.**

<br>

[![Marketplace](https://img.shields.io/badge/Marketplace-stale--branch--reaper-2088FF?logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/stale-branch-reaper)
[![CI](https://github.com/builtbyadam/actions/actions/workflows/test-stale-branch-reaper.yml/badge.svg)](https://github.com/builtbyadam/actions/actions/workflows/test-stale-branch-reaper.yml)
[![Release](https://img.shields.io/github/v/release/builtbyadam/stale-branch-reaper?sort=semver)](https://github.com/builtbyadam/stale-branch-reaper/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/builtbyadam/stale-branch-reaper?style=social)](https://github.com/builtbyadam/stale-branch-reaper/stargazers)

</div>

> 🪞 **This is a generated mirror** of [`builtbyadam/actions`](https://github.com/builtbyadam/actions). Issues and PRs are welcome there.

---

## The problem

Merged feature branches accumulate forever. The branch list becomes unusable, but nobody runs a bulk delete because the destructive version is scary and easy to get wrong.

## What it does

Lists branches, ages each one by its last commit's committer date, and reports what's stale. By default it only considers branches already merged into the default branch. Deletion is opt-in via `confirm` — until you flip it, the action performs zero deletions and just reports what it *would* do. The default branch, API-protected branches, and your own pattern list are always spared, even when `confirm` is `true`.

## Usage

Start with a dry run so you can read the report before anything is touched. A dry-run needs only `contents: read`:

```yaml
on:
  schedule:
    - cron: "0 4 * * 1"

jobs:
  reap:
    runs-on: ubuntu-latest
    permissions:
      contents: read       # read-only is enough for a dry-run
    steps:
      - id: reap
        uses: builtbyadam/stale-branch-reaper@v1
        with:
          older-than-days: 90
          confirm: false     # report first; flip to true when satisfied
      - run: echo "${{ steps.reap.outputs.report }}"
```

Once you trust the report, set `confirm: "true"` and grant `contents: write` so the action can delete refs:

```yaml
on:
  schedule:
    - cron: "0 4 * * 1"

jobs:
  reap:
    runs-on: ubuntu-latest
    permissions:
      contents: write      # required to delete branch refs
    steps:
      - uses: builtbyadam/stale-branch-reaper@v1
        with:
          older-than-days: 90
          merged-only: "true"
          protect-patterns: |
            main
            master
            release/**
          confirm: "true"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `older-than-days` | | `90` | Only consider branches whose last commit is older than this many days. Aged from the last commit's committer date. Non-negative integer. |
| `merged-only` | | `true` | When `true`, only branches already merged into the default branch are eligible; unmerged branches are reported `skipped-unmerged`. Set `false` to reap stale branches regardless of merge status. |
| `protect-patterns` | | `main`, `master`, `release/**` | Newline- or comma-separated globs of branch names to never delete, even with `confirm`. Supports `*`, `?`, and `**`. |
| `confirm` | | `false` | **Must be `true` to delete.** Otherwise dry-run: reports only, performs zero deletions. |
| `github-token` | | `${{ github.token }}` | Token used to list and delete branches. Needs `contents: write` to delete refs. |

## Outputs

| Output | Description |
|---|---|
| `deleted-count` | Number of branches actually deleted. Always `0` in dry-run. |
| `report` | JSON array of `{branch, last_commit_date, merged, action}`, where `action` is one of `would-delete`, `deleted`, `skipped-protected`, `skipped-recent`, or `skipped-unmerged`. |

## Safety

Dry-run is the default — nothing is deleted until you explicitly set `confirm: "true"`, and even then three protection layers are applied **unconditionally**:

1. The repository's **default branch** is never deleted.
2. Branches **protected via the API** (branch protection rules) are never deleted.
3. Branches matching **`protect-patterns`** are never deleted.

All three appear in the report as `skipped-protected`. A few deliberately conservative behaviors back that up:

- If a branch's last-commit date **can't be resolved**, it is treated as recent (`skipped-recent`) rather than deleted.
- If the **merge check fails** for a candidate, it is treated as unmerged (`skipped-unmerged`) rather than deleted.
- With no `github-token`, the action is a safe no-op: it inspects nothing and reports an empty result.

These cheap filters (protected / pattern / age) run **before** the merge check, so the expensive compare call only happens for branches that could actually be deleted.

A note on rate limits: the merge check costs **one compare API call per surviving candidate branch**. On a repository with hundreds of stale candidates this consumes REST API rate limit — narrow the field with `older-than-days` and `protect-patterns`, or set `merged-only: false` to skip the compare calls entirely. Note that "merged" means merged into the **default branch** specifically; a branch merged only into some other long-lived branch is treated as unmerged.

## License

[MIT](LICENSE)
