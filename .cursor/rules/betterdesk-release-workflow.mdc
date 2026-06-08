---
description: dev→main release workflow — issues, labels, release notes, and post-merge sync
alwaysApply: true
---

# BetterDesk release workflow (dev → main)

When preparing or completing a **`dev` → `main`** merge / production release, do not leave gaps that operators must guess.

## Before merge

1. Follow [docs/PRE_RELEASE_CHECKLIST.md](../docs/PRE_RELEASE_CHECKLIST.md) and [branching-and-versioning.md](../docs/important/branching-and-versioning.md).
2. **`CHANGELOG.md`:** `[Unreleased]` must list every user-visible change in this release (fixes, manual steps, breaking notes).
3. **GitHub issue:** for each meaningful change shipping via panel update, open or update an issue with:
   - label **`Next Updates`** (and `enhancement` / `bug` as appropriate)
   - **what changed**, **who is affected**, **how to verify**
   - **terminal steps** when the panel alone is not enough (one-time root commands, paths, service names)
4. **Commit messages:** reference issues (`Fixes #NNN`) so release scope is traceable.

## Release notes must be self-contained

GitHub Release / issue text should answer without follow-up questions:

| Include | Example |
|---------|---------|
| Version & channel | stable `main` / dev channel unchanged |
| Panel vs manual | “ships via Settings → Updates” vs “run once as root: …” |
| Verify | preflight warning gone, service restarted, banner cleared |
| Related issues | links to reporter issues (#182, etc.) |

Avoid vague lines like “update the server” — specify **which component**, **which path**, and **expected outcome**.

## After merge to main

1. Confirm CI created tag `vX.Y.Z` and GitHub Release.
2. **Sync `main` → `dev`** (resolve version conflicts in favour of the new `main` minor baseline).
3. Close superseded open PRs (`dev` → `main`) with a short comment pointing to the merged release/hotfix.
4. Reply on linked GitHub issues in **English** — short, human, with verify steps.

## Direction reminder

- **Release:** `dev` → `main` (production)
- **Post-release sync:** `main` → `dev` (development baseline)
- Do not assume fixes live on `dev` — check branch tips before merging.
