# Care-Hero fork of OmniRoute — patch ledger

Upstream: `diegosouzapw/OmniRoute`. Fork default branch: `release/v3.8.51` = upstream
`release/v3.8.51` (`2b8f89a65`) plus the patches below. `package.json` keeps the upstream
version (the docs-sync hook ties it to `openapi.yaml`, `CHANGELOG.md` and 41 locale mirrors);
the fork's identity is a **git tag** `v3.8.51-carehero.N` on each deployed merge commit, and
the running box reports the commit as `buildSha` (baked by `scripts/ship/omni-bump.sh` in
careheroai via `OMNIROUTE_BUILD_SHA`, health route `/api/monitoring/health`).

Bumping to a new upstream release: rebase (or cherry-pick) every row marked **carry** onto the
new upstream tag, drop rows marked **upstreamed** once upstream contains them, retag
`v<upstream>-carehero.1`, and update this table.

| Tag                | Commit              | Patch                                                                                                       | Status | Notes                                                            |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| v3.8.51-carehero.1 | `b6aae9c9d` (PR #1) | `fix(codex): admit long contexts and preserve upstream overflow errors` + docs                              | carry  | cx/ 872k context admission (Sol/Astra); upstream #12761-era gate |
| v3.8.51-carehero.1 | `b6aae9c9d`         | `fix(types): preserve refresh and successful tool-loop result types`                                        | carry  | release type declaration repairs                                 |
| v3.8.51-carehero.1 | `b6aae9c9d`         | `fix: restore release v3.8.51 validation gates`, `test(catalog)`, `test: UC video timeout`                  | carry  | base-red realignment for our CI                                  |
| v3.8.51-carehero.1 | `b6aae9c9d`         | `build: stamp and publish Care Hero source images`, `fix(ci): derive image namespace from repository owner` | carry  | image publish under the fork owner                               |
| v3.8.51-carehero.2 | PR #5               | `POST /v1/evaluation-model` (Vercel AI Gateway v4) + `POST /v1/systemone` (TypeSafe native) for Jev         | carry  | Jev via OmniRoute; jev-axi via `TYPESAFE_BASE_URL`               |

Deployed tag is whatever `/prod` §4 1d last shipped; check `buildSha` on the health route
against the commit column.
