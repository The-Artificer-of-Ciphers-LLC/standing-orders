# gsd-core git `capability install`: which `#ref` forms work

Date: 2026-11-07. Scope: gsd-core v1.19.0 and v1.20.1 (tags read with `git -C /Users/trekkie/projects/gsd-core show/grep <tag>:<path>`), checkout `next` compared by diff. git 2.54.0 (Apple Git-157) used for experiments.

## Upstream status

Re-checked 2026-11-08 against gsd-core v1.19.0, v1.20.1 and `origin/next`: `src/capability-source.cts` lines 1038 and 1047 are unchanged, and the CLI's own error at line 1032 recommends `#sha:<commit>`. The defect is already tracked upstream as [open-gsd/gsd-core#5297](https://github.com/open-gsd/gsd-core/issues/5297) (open, `confirmed-bug`), which covers the shallow clone, the unstripped `tag:`/`sha:` prefixes and the docs. No separate issue was filed.

## Summary answer

- gsd-core clones with `git clone --depth 1 -- <url> <dir>` and then, if a `#ref` was given, runs `git -C <dir> checkout <ref> --`. The clone is shallow and single-branch, so only the remote's default-branch tip (and tags that point at that exact commit) exist locally. Any other ref, or any commit that is not that tip, cannot be checked out.
- `#sha:<commit>` can never work in the released code: the `sha:` prefix is parsed only for update classification (`classifyGitRef`), and `resolveGit` passes the raw string `sha:<hex>` to `git checkout`, which answers `fatal: invalid reference: sha:<hex>`. This is the exact error observed in CI. It fails even when the commit is the tip (experiment E8).
- A plain full or short sha works only when it equals the cloned tip. A branch that is not the remote HEAD branch fails with `invalid reference` (the error seen for `...git#feat/3-manifest-loop-wiring`).
- The docs promise `#sha:abc123...` works (import how-to line 22, publish how-to line 110). The released code does not match the docs.
- Recommended honest fix for CI: have git itself rewrite the https GitHub URL to a local clone of the checked-out PR commit (`GIT_CONFIG_COUNT`/`url.<local>.insteadOf`), and pass the source with NO ref (or the full sha). gsd-core still runs its real clone and checkout path. Details in T5.

## T2. Code path (file:line@tag)

Same code at both tags; `git diff v1.19.0 v1.20.1 -- src/capability-source.cts` is empty, and `git diff v1.20.1 next -- src/capability-source.cts src/capability-lifecycle.cts` is empty (no difference on `next` for these files). Only `src/capability-lifecycle.cts` differs between 1.19.0 and 1.20.1 (moves `shellSingleQuote`, unrelated).

Source classification, `parseSpec` in `src/capability-source.cts`:
- v1.19.0 lines 955-960: git if `s.startsWith('git+')`, or `^https?://.+\.git$`, or `^https?://` containing `#`.
- v1.19.0 lines 961-974 (line 960 begins the block): strip `git+`; split at first `#` into `url` and `ref` (the whole fragment, verbatim); `assertSafeGitUrl(url)`; reject a ref matching `SHELL_METACHAR_RE` or starting with `-`; return `{kind:'git', target:url, ref}`. No `sha:` parsing occurs here.
- v1.20.1 line 968 calls `assertSafeGitUrl`; lines 523-529 at v1.20.1: `/^(https?|ssh|git):\/\//i` else throw `only https://, ssh://, and git:// are allowed`. So `file://` and bare paths are refused as git targets (v1.20.1 comment at lines 520-521).

Clone and checkout, `resolveGit`:
- v1.19.0 and v1.20.1: `src/capability-source.cts:1038` (identical at both tags):
  `execGit(['clone', '--depth', '1', '--', parsed.target, cloneDir], { timeout: 60_000 })`
- v1.19.0 and v1.20.1: `src/capability-source.cts:1047`:
  `execGit(['-C', cloneDir, 'checkout', parsed.ref, '--'], { timeout: 60_000 })`, only `if (parsed.ref)`; failure text at 1050: `git checkout "<ref>" failed (exit N): <stderr>`.
- No `fetch`, `--branch`, `--single-branch`, `--filter` or `--no-tags` is passed. `--depth 1` implies `--single-branch` (git help clone: "Implies --single-branch unless --no-single-branch is given").
- `sha:` handling: `classifyGitRef` (v1.20.1 `src/capability-source.cts:1393-1401`) splits `sha:`/`tag:`/bare for update/outdated classification only (comment at 1380-1392). `GIT_SHA_PIN_RE = /^sha:[0-9a-f]{7,40}$/i` at `src/capability-lifecycle.cts:219` (v1.20.1) is the pin-recognition regex. Neither is applied in `resolveGit`.
- `execGit` seam: `src/shell-command-projection.cts:682-713` (v1.20.1): spawns `git` with env = `readOnlyGitEnv()` (copy of `process.env` minus git location vars such as `GIT_DIR`; `src/read-only-git-env.cts`) plus `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`. Because the parent environment passes through, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` reach the git child. v1.19.0 `read-only-git-env.cts` spreads `process.env` as well (default `base = process.env`, line 47; location-var scrubbing only appears in v1.20.1). UNVERIFIED: that the npm-packed `@opengsd/gsd-core` dist matches these `.cts` sources line for line; the CI error text matches.
- Update-path ls-remote calls (not install): v1.20.1 lines 1424 and 1509.

## T3. Which ref forms can succeed

Reasoning: after `clone --depth 1`, the local repo has one remote-tracking branch (the remote HEAD branch) and one commit; `checkout <x>` can resolve only the local branch of that name, `origin/<default>`, tags that were fetched, or an object that exists. Tags are fetched only when they point into the fetched history (E1/E11 below).

Experiment: bare repo `origin.git` (default branch `main`; commits c1 tagged `v1`, c2, c4 = main tip `af09c89`; branch `side` at c3 `c7c86d6` off c2; tag `tiptag` on main tip). Each case ran the gsd argv, with `file://` substituted only for the clone target: `git clone -q --depth 1 -- file://.../origin.git <dir>` then `git -C <dir> checkout <ref> --`. Scripts: `.../scratchpad/try.sh`, `daemon.sh`, `rewrite.sh`, `shallow.sh` (in `/private/tmp/claude-501/-Users-trekkie-projects-standing-orders/89ce9f3c-ef26-400d-a724-2855e9e5f7ca/scratchpad/`).

| # | ref form | ref | result |
|---|---|---|---|
| E1 | tag not at tip | `v1` (on c1) | FAIL `fatal: invalid reference: v1` (exit 128) |
| E2 | tag at default tip | `tiptag` | OK `HEAD is now at af09c89 c4` |
| E3 | default branch | `main` | OK `Already on 'main'` |
| E4 | branch not default | `side` | FAIL `fatal: invalid reference: side` |
| E5 | full sha of side tip | `c7c86d63...9253` | FAIL `fatal: unable to read tree (c7c86d63...)` |
| E6 | short sha of side tip | `c7c86d6` | FAIL `fatal: invalid reference: c7c86d6` |
| E7 | full sha of default tip | `af09c891...1614` | OK `HEAD is now at af09c89 c4` |
| E8 | `sha:` + tip sha | `sha:af09c891...` | FAIL `fatal: invalid reference: sha:af09c891...` |
| E9 | `sha:` + side sha | `sha:c7c86d63...` | FAIL `fatal: invalid reference: sha:c7c86d63...` |
| E10 | short sha of default tip | `af09c89` | OK |
| E11 | older default-branch commit | `07ac0807...` | FAIL `fatal: unable to read tree` |
| E12 | `refs/heads/side`, `origin/side` | | FAIL `invalid reference` |

Per the task's forms:
- tag: succeeds only if the tag points at the cloned tip (E2); an older tag fails (E1).
- branch on the default branch: succeeds (E3), but it is already checked out by the clone.
- branch not on the default branch (`feat/3-manifest-loop-wiring`): cannot succeed (E4); matches the CI failure.
- full sha: succeeds only if it is the default-branch tip (E7); otherwise `unable to read tree` (E5, E11).
- `sha:<sha>`: cannot succeed, tip or not (E8, E9); matches CI failure for `#sha:<40-hex>`.
- short sha: same as full sha (E10 ok at tip, E6 fails otherwise).
- `pull/<N>/head`: by the same argv it cannot be checked out (not fetched by a depth-1 single-branch clone; it is not under `refs/heads`/`refs/tags`). Not run against GitHub (task forbids network); UNVERIFIED beyond the E4 analogy.

## T4. gsd-core docs vs code

- `docs/how-to/import-a-capability-from-a-url.md:16`: `...gsd-cap-example.git#v1.0.0` (tag); `:22`: `...git#sha:abc123def456...` (commit pin).
- `docs/how-to/publish-a-capability.md:104`: `#v1.0.0`; `:110`: `#sha:abc123def456...`.
- `docs/CLI-TOOLS.md`: grep for `sha:`, `git+`, `#<ref`, `#sha` returned no matches (no claim there).
- Code vs docs: the `#sha:<commit>` form documented at those lines fails in the released code (E8/E9; `resolveGit` checks out the literal `sha:...`). The tag form works only when the tag is at the default-branch tip (E1/E2), which the docs do not state. Docs example `#v1.0.0` works for a tag at the tip only. The documented behaviour is therefore not met by the code at v1.19.0/v1.20.1/`next` (the source file is unchanged on `next`).

## T5. Options for installing this PR's unmerged commit from git

Constraints from code: URL must be `https://`, `ssh://` or `git://` (v1.20.1 `capability-source.cts:523-529`); ref must survive a depth-1 single-branch clone (T3); `sha:` is unusable; env passes through to git (T2).

1. A ref form the code accepts: only works for the remote default-branch tip or a tag at it. For a PR branch it is impossible (E4, E5, E8). For a fork PR there is nothing to point at. Rejected.
2. `pull/<N>/head`: not fetched by the clone; fails like E4. Rejected (UNVERIFIED on GitHub).
3. Head repo's branch: same failure as option 1 unless that branch is the head repo's default (fork PRs from a fork's default branch only). Rejected as general solution.
4. `git daemon` over `git://127.0.0.1/...` (allowed transport). Tested locally: serving a repo whose HEAD is detached at the target commit, `git clone --depth 1 git://127.0.0.1/served/.git` yields that commit, and `checkout <full sha>` and `checkout <served branch>` both succeed (daemon.sh output). Works through gsd-core's real argv, but needs a background daemon and `git-daemon-export-ok`; `git daemon` availability on `ubuntu-latest` is UNVERIFIED.
5. Recommended: `url.<local>.insteadOf` rewrite (no daemon, no network). The source stays an allowed `https://github.com/<owner>/<repo>.git` string, so `assertSafeGitUrl` passes; git rewrites it to a local clone of the checked-out commit before cloning. Tested (rewrite.sh): `git clone --depth 1 -- https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git` with the rewrite cloned the local repo (`remote get-url origin` showed the `file://` path) at the detached commit; `checkout <full sha>` succeeded, `checkout sha:<sha>` failed. A shallow source repo (as `actions/checkout` produces with default `fetch-depth: 1`) also works (shallow.sh: `is-shallow-repository` true, clone and checkout succeeded). Git honors the `file://` target without gsd-core's URL check seeing it, because the rewrite happens inside git.

Recommended workflow steps (mirror the existing `host-contract` job; replace the stop-gap `STANDING_ORDERS_GIT_SOURCE` line):

```yaml
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      ...
      - name: Host contract tests
        env:
          GSD_CORE_DIR: ${{ runner.temp }}/gsd/package
          # Plain https URL so gsd-core's transport check passes; git rewrites it to the
          # checked-out commit below. No #ref: the clone's HEAD is that commit.
          STANDING_ORDERS_GIT_SOURCE: https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git
          GIT_CONFIG_COUNT: '1'
          GIT_CONFIG_KEY_0: url.file://${{ github.workspace }}/.git.insteadOf
          GIT_CONFIG_VALUE_0: https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git
        run: node --test tests/host-contract.test.cjs
```

Exact `STANDING_ORDERS_GIT_SOURCE` value: `https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git` (add `#<full 40-hex sha>` only if you want a pin; it works when the sha equals the checked-out HEAD, per E7 and rewrite.sh). Do not use `#sha:`.

Caveats on the env scope: set `GIT_CONFIG_*` only on this step; it also applies to any other git that `node --test` runs, so restrict the rewrite to the one URL (as above).

What this does NOT prove:
- That `git clone https://github.com/...` from GitHub works (no network clone happens); that the repo is publicly clonable at that URL.
- Behaviour of gsd-core's HTTPS transport/credentials; only its git argv, ref handling, and capability validation/staging of the commit are exercised.
- That the commit is reachable on origin as a ref (it proves the contents install, not that a user installing `#<branch>` would succeed; per T3 they cannot).
- The `GIT_CONFIG_COUNT` rewrite in the actual GitHub runner (git version there) is UNVERIFIED; locally it worked with git 2.54.0 (`GIT_CONFIG_COUNT` requires git >= 2.31).
- Fork PRs: `github.event.pull_request.head.sha` checkout works for forks in the same job, but untested.
- The main-push stop-gap (default-branch install over real https) remains the only check of the real network clone, so keep it on pushes to main.

## Out-of-scope observations

- gsd-core's docs/code mismatch for `#sha:` (T4) is a defect in gsd-core worth reporting upstream; not acted on.
- Likely upstream fix direction (not verified): strip `sha:`/`tag:` in `resolveGit` and fetch the commit (`git fetch --depth 1 origin <sha>`) before checkout.
