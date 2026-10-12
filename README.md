# Node Package Action

Takes a node directory, tars up the source, uploads the tar to S3, and
optionally mirrors every resolved npm dependency into the same bucket.

## What it does

1. Tars the source tree (excluding `.git`) and uploads it to `s3prefix`.
2. If `shrinkwrap` is set, reads the lockfile and mirrors every `resolved`
   dependency into `s3npmPrefix`:
   - **Registry/http(s) tarballs** are downloaded byte-for-byte, so their
     existing `integrity` hash still verifies.
   - **git / GitHub dependencies** (`git+ssh://`, `git+https://`, `git://`,
     and the `github:` / `gitlab:` / `bitbucket:` / `gist:` shorthands) are
     packed into a `.tar.gz` with `npm pack`, and a fresh sha512 `integrity`
     is computed over the generated tarball.
3. If `rewriteShrinkwrap` is `true`, writes a copy of the lockfile with every
   mirrored `resolved` url rewritten to a public `https://` url under
   `s3BaseUrl` (updating `integrity` where the bytes changed), and uploads it
   next to the mirror.

With `rewriteShrinkwrap` enabled, a locked-down build host that can only reach
the S3 bucket over `https://` (no npm registry, no GitHub) can run `npm ci`
against the rewritten lockfile.

When `omitDev` is `true`, dev-only dependencies (lockfile entries flagged
`"dev": true`) are skipped: they are not mirrored to S3 and their `resolved`
urls are left untouched in the rewritten lockfile. The entries themselves stay
in the lockfile. Pair this with `npm ci --omit=dev` on the build host so the
untouched dev urls are never fetched.

## Runtime

Runs on the GitHub Actions **node24** runtime. Uses native `fetch` and
`async/await`; no `request` or `async` dependencies.

The action source is TypeScript (`src/node-package-action.ts`) and is bundled
with Rollup + esbuild into a single ESM file (`dist/node-package-action.mjs`)
with every dependency internalized (only Node builtins stay external).

## Inputs

| Input               | Required | Description                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `cwd`               | no       | Working directory for the tar command.                                      |
| `files`             | yes      | Newline-separated list of files/folders to archive.                         |
| `shrinkwrap`        | no       | Lockfile (e.g. `npm-shrinkwrap.json`) to mirror.                             |
| `s3prefix`          | yes      | S3 bucket and optional path prefix for code, no trailing `/`.               |
| `s3npmPrefix`       | no       | S3 bucket/path for the npm mirror. Defaults to `s3prefix`.                   |
| `rewriteShrinkwrap` | no       | Rewrite resolved urls to `s3BaseUrl` and upload the lockfile. Default false. |
| `s3BaseUrl`         | no       | Public https base url for the mirror. Required when `rewriteShrinkwrap`.     |
| `omitDev`           | no       | Skip dev-only dependencies when mirroring and rewriting. Default false.      |

## Outputs

| Output            | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `out_file`        | Path to the source tarball.                           |
| `shrinkwrap_file` | Path to the rewritten lockfile (if rewrite enabled).  |

## Develop

```sh
npm install
npm test          # unit tests for the pure helpers
npm run typecheck # type-check with tsc (no emit)
npm run lint      # eslint over src and tests
npm run build     # bundles src/node-package-action.ts into
                  # dist/node-package-action.mjs via rollup + esbuild
```

Node 24 runs the `.ts` source directly (native type stripping), so tests import
`src/node-package-action.ts` without a build step. The `build` script produces
the committed `dist/node-package-action.mjs` that the action actually runs.

