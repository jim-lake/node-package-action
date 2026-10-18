import * as core from '@actions/core';
import { context } from '@actions/github';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as tar from 'tar';

const execFileAsync = promisify(execFile);

const EACH_LIMIT = 5;

const temp_dir = process.env.RUNNER_TEMP || os.tmpdir();
const out_file = path.join(temp_dir, context.sha + '.tar.gz');
const latest_file = path.join(temp_dir, 'LATEST');

// A single lockfile `packages` entry.
interface LockfilePackage {
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  [key: string]: unknown;
}

// Minimal shape of an npm lockfile (npm-shrinkwrap.json / package-lock.json).
interface Lockfile {
  packages?: Record<string, LockfilePackage>;
  [key: string]: unknown;
}

// A unique resolved dependency pulled from the lockfile.
interface MirrorItem {
  pkgKey: string;
  pkg: LockfilePackage;
  resolved: string;
}

// The outcome of mirroring one dependency: its content-addressed key, the
// (possibly updated) SRI integrity string, and whether the bytes were newly
// uploaded or already present in the mirror.
interface MirrorResult {
  key: string;
  integrity: string;
  action: 'skipped' | 'uploaded';
}

interface HandleShrinkwrapOptions {
  cwd: string;
  shrinkwrap: string;
  s3npmPrefix: string;
  rewriteShrinkwrap: boolean;
  s3BaseUrl: string;
  omitDev: boolean;
}

interface HandleCodeOptions {
  cwd: string;
  files: string | string[];
  s3prefix: string;
}

interface RewriteShrinkwrapOptions {
  cwd: string;
  json: Lockfile;
  shrinkwrap: string;
  s3BaseUrl: string;
  mirror_map: Map<string, MirrorResult>;
}

interface AwsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function main(): Promise<void> {
  const cwd = core.getInput('cwd');
  const shrinkwrap = core.getInput('shrinkwrap');
  const s3prefix = core.getInput('s3prefix');
  const s3npmPrefix = core.getInput('s3npmPrefix') || s3prefix;
  const rewriteShrinkwrap = core.getBooleanInput('rewriteShrinkwrap');
  const s3BaseUrl = core.getInput('s3BaseUrl');
  const omitDev = core.getBooleanInput('omitDev');
  const files = core
    .getInput('files', { required: true })
    .split('\n')
    .filter((x) => x !== '');

  if (rewriteShrinkwrap && !s3BaseUrl) {
    throw new Error('rewriteShrinkwrap requires s3BaseUrl to be set');
  }

  // Mirror dependencies and rewrite the lockfile FIRST, so the rewritten
  // shrinkwrap is in place in cwd before the source tree is tarred. The build
  // host unpacks the tar and runs `npm ci` against the rewritten lockfile.
  if (shrinkwrap) {
    await handleShrinkwrap({
      cwd,
      shrinkwrap,
      s3npmPrefix,
      rewriteShrinkwrap,
      s3BaseUrl,
      omitDev,
    });
  }

  await handleCode({ cwd, files, s3prefix });

  await updateLatest({ s3prefix });

  core.setOutput('out_file', out_file);
}

// Tar the source tree (excluding .git) and upload it to the code prefix.
async function handleCode({
  cwd,
  files,
  s3prefix,
}: HandleCodeOptions): Promise<void> {
  const commit_file = path.join(cwd, '.git_commit_hash');
  await fs.writeFile(commit_file, context.sha);

  const list = Array.isArray(files) ? files : [files];
  await tar.c({ cwd, gzip: true, file: out_file, filter: tarFilter }, list);

  await aws(['s3', 'cp', out_file, `s3://${s3prefix}/`], { log: true });
}

export async function handleShrinkwrap({
  cwd,
  shrinkwrap,
  s3npmPrefix,
  rewriteShrinkwrap,
  s3BaseUrl,
  omitDev,
}: HandleShrinkwrapOptions): Promise<void> {
  const shrink_path = path.join(cwd, shrinkwrap);
  const json = JSON.parse(await fs.readFile(shrink_path, 'utf8')) as Lockfile;

  // Collect unique resolved specs, keeping the package metadata for each.
  // When omitDev is set, skip packages that are only reachable through
  // devDependencies (lockfile entries flagged "dev": true). Entries flagged
  // "devOptional" are kept, matching `npm ci --omit=dev`.
  const items: MirrorItem[] = [];
  const seen = new Set<string>();
  if (json && json.packages) {
    for (const [pkgKey, pkg] of Object.entries(json.packages)) {
      if (!pkg || !pkg.resolved) {
        continue;
      }
      if (omitDev && isDevOnly(pkg)) {
        continue;
      }
      if (seen.has(pkg.resolved)) {
        continue;
      }
      seen.add(pkg.resolved);
      items.push({ pkgKey, pkg, resolved: pkg.resolved });
    }
  }

  // List every object already in the mirror prefix ONCE, up front, with a
  // single paginated list-objects-v2 call. Mirror keys are content-addressed
  // (identical content => identical key), so membership in this set is an
  // exact "already uploaded" check. This replaces the old per-package
  // `s3api head-object` spawn (one aws process + round-trip per dependency),
  // which was the dominant cost for large lockfiles.
  const existing_keys = await listExistingKeys(s3npmPrefix);

  // Mirror each unique dependency to S3, content-addressed by sha512, with
  // bounded concurrency. Each upload skips when its key is already in
  // existing_keys and verifies the bytes via S3's native sha512 checksum on
  // write. Newly uploaded keys are added to the set so two items that resolve
  // to identical bytes in the same run don't double-upload.
  const mirror_map = new Map<string, MirrorResult>();
  await mapLimit(items, EACH_LIMIT, async (item) => {
    const result = await mirrorResolved(item, s3npmPrefix, existing_keys);
    if (result) {
      mirror_map.set(item.resolved, result);
    }
  });

  if (rewriteShrinkwrap) {
    await rewriteShrinkwrapInPlace({
      cwd,
      json,
      shrinkwrap,
      s3BaseUrl,
      mirror_map,
    });
  }
}

// A lockfile entry is dev-only when npm marks it "dev": true, meaning every
// path that reaches it goes through devDependencies.
export function isDevOnly(pkg: LockfilePackage): boolean {
  return pkg.dev === true;
}

// Classify a resolved spec and mirror it. Emits exactly one log line per
// package summarizing the outcome. Returns { key, integrity, action } or null.
async function mirrorResolved(
  item: MirrorItem,
  s3npmPrefix: string,
  existingKeys: Set<string>
): Promise<MirrorResult | null> {
  const url = item.resolved;
  let result: MirrorResult | null;
  if (isHttpTarball(url)) {
    result = await mirrorHttpTarball(item, s3npmPrefix, existingKeys);
  } else if (isGitSpec(url)) {
    result = await mirrorGitSpec(item, s3npmPrefix, existingKeys);
  } else {
    core.info(`mirror: skip (unrecognized) ${url}`);
    return null;
  }
  core.info(`mirror: ${result.action} ${item.pkgKey} -> ${result.key}`);
  return result;
}

export function isHttpTarball(url: string): boolean {
  return /^https?:\/\//.test(url);
}

export function isGitSpec(url: string): boolean {
  return (
    /^git\+/.test(url) ||
    /^git:\/\//.test(url) ||
    /^(github|gitlab|bitbucket|gist):/.test(url)
  );
}

// Download an http(s) tarball, verify it against the lockfile's integrity, and
// store it content-addressed by its sha512 (<sha512-hex>.tar.gz). The key is
// derived from the bytes, so it is impossible for the stored object and its
// integrity to disagree.
async function mirrorHttpTarball(
  item: MirrorItem,
  s3npmPrefix: string,
  existingKeys: Set<string>
): Promise<MirrorResult> {
  const url = item.resolved;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`mirrorHttpTarball: ${url} returned ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // Verify against whatever the lockfile pinned. A mismatch means the registry
  // served different bytes than the lockfile expects -> hard error.
  verifyIntegrity(item.pkg.integrity, buf, url);

  return storeTarball(buf, s3npmPrefix, existingKeys);
}

// Compare downloaded bytes against a Subresource Integrity string from the
// lockfile. Checks the strongest algorithm present. Throws on mismatch.
// A missing/empty integrity is allowed (nothing to verify against).
export function verifyIntegrity(
  sri: string | undefined,
  buf: Buffer,
  url: string
): void {
  if (!sri) {
    return;
  }
  // SRI may contain multiple space-separated "<alg>-<base64>" hashes.
  const entries = sri
    .trim()
    .split(/\s+/)
    .map((s) => {
      const dash = s.indexOf('-');
      return dash === -1
        ? null
        : { alg: s.slice(0, dash), b64: s.slice(dash + 1) };
    })
    .filter((e): e is { alg: string; b64: string } => e !== null);

  // Prefer sha512, then sha256, then sha1.
  for (const alg of ['sha512', 'sha256', 'sha1']) {
    const entry = entries.find((e) => e.alg === alg);
    if (!entry) {
      continue;
    }
    const actual = crypto.createHash(alg).update(buf).digest('base64');
    if (actual !== entry.b64) {
      throw new Error(
        `integrity mismatch for ${url}: lockfile ${alg}-${entry.b64} ` +
          `but downloaded bytes are ${alg}-${actual}`
      );
    }
    return; // verified against the strongest available algorithm
  }
  // No recognized algorithm in the SRI; nothing we can verify.
}

// Content-address a tarball buffer and upload it to the mirror, skipping the
// upload when an identical object already exists. Returns { key, integrity }
// for the lockfile rewrite. The sha512 is computed once and reused as the hex
// key, the base64 S3 checksum, and the base64 SRI integrity (all free
// re-encodings of the same digest).
async function storeTarball(
  buf: Buffer,
  s3npmPrefix: string,
  existingKeys: Set<string>
): Promise<MirrorResult> {
  const digest = crypto.createHash('sha512').update(buf).digest();
  const hex = digest.toString('hex');
  const b64 = digest.toString('base64');
  const key = hex + '.tar.gz';

  const action = await putContentAddressed({
    buf,
    key,
    checksumB64: b64,
    s3npmPrefix,
    existingKeys,
  });

  return { key, integrity: 'sha512-' + b64, action };
}

// list-check-then-put: skip when the key is already present in the mirror
// (content-addressed, so an existing object is byte-identical), otherwise
// upload with S3's native sha512 checksum so the service verifies the bytes
// on write. existingKeys is the set of full keys discovered by the single
// up-front list-objects-v2 call; a newly uploaded key is recorded there so a
// later item with identical bytes in the same run short-circuits too.
// Returns 'skipped' or 'uploaded' so the caller can log one line per package.
async function putContentAddressed({
  buf,
  key,
  checksumB64,
  s3npmPrefix,
  existingKeys,
}: {
  buf: Buffer;
  key: string;
  checksumB64: string;
  s3npmPrefix: string;
  existingKeys: Set<string>;
}): Promise<'skipped' | 'uploaded'> {
  const [bucket, ...prefixParts] = s3npmPrefix.split('/');
  const fullKey = [...prefixParts, key].filter(Boolean).join('/');

  if (existingKeys.has(fullKey)) {
    return 'skipped';
  }

  // Write to a temp file so put-object can stream it from --body.
  const tmp = path.join(await fs.mkdtemp(path.join(temp_dir, 'put-')), key);
  await fs.writeFile(tmp, buf);
  await aws([
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    fullKey,
    '--body',
    tmp,
    '--checksum-sha512',
    checksumB64,
  ]);
  existingKeys.add(fullKey);
  return 'uploaded';
}

// List every object key under the mirror prefix with a single paginated
// list-objects-v2 call (1000 keys per page). Returns a set of full keys
// (prefix included) so putContentAddressed can test existence in memory
// instead of spawning an `s3api head-object` per dependency.
export async function listExistingKeys(
  s3npmPrefix: string
): Promise<Set<string>> {
  const [bucket, ...prefixParts] = s3npmPrefix.split('/');
  const prefix = prefixParts.filter(Boolean).join('/');
  const keys = new Set<string>();

  let token: string | undefined;
  do {
    const args = [
      's3api',
      'list-objects-v2',
      '--bucket',
      bucket,
      '--output',
      'json',
    ];
    if (prefix) {
      args.push('--prefix', prefix + '/');
    }
    if (token) {
      args.push('--starting-token', token);
    }
    // --max-items bounds how many items the CLI prints before emitting a
    // NextToken we can resume from. Do NOT add --query here: a JMESPath query
    // like `Contents[].Key` rewrites the whole response and drops the injected
    // NextToken field, which silently breaks pagination (the loop would stop
    // after the first 1000 keys). We parse Contents[].Key + NextToken from the
    // raw JSON ourselves instead.
    args.push('--max-items', '1000');

    const res = await aws(args, { ignoreError: true });
    if (!res.ok) {
      // The prefix may not exist yet (first run) or the account may lack
      // ListBucket. Treat as empty: every object will then be (re)uploaded,
      // which is safe because put-object + content-addressing is idempotent.
      core.info(
        `listExistingKeys: list failed (${res.code}); assuming empty mirror`
      );
      return keys;
    }

    // Parse Contents[].Key and NextToken from the raw list-objects-v2 JSON.
    const parsed = parseListPage(res.stdout);
    for (const k of parsed.keys) {
      if (k) {
        keys.add(k);
      }
    }
    token = parsed.nextToken;
  } while (token);

  core.info(`listExistingKeys: ${keys.size} objects already mirrored`);
  return keys;
}

// Parse one page of `s3api list-objects-v2 --output json` output. The raw
// response is a JSON object: { "Contents": [ { "Key": ... }, ... ],
// "NextToken": "..." }. When the result is truncated by --max-items the CLI
// injects a top-level "NextToken" we resume from; when exhausted there is no
// NextToken. We deliberately parse the full document (rather than a
// --query-projected array) because a JMESPath query drops the injected
// NextToken and silently caps pagination at the first page.
export function parseListPage(stdout: string): {
  keys: string[];
  nextToken: string | undefined;
} {
  const text = (stdout || '').trim();
  if (!text) {
    return { keys: [], nextToken: undefined };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { keys: [], nextToken: undefined };
  }

  const obj = (doc ?? {}) as { Contents?: unknown; NextToken?: unknown };

  let keys: string[] = [];
  if (Array.isArray(obj.Contents)) {
    keys = obj.Contents.map((c) =>
      c && typeof c === 'object' ? (c as { Key?: unknown }).Key : undefined
    ).filter((k): k is string => typeof k === 'string');
  }

  // A NextToken is present only while the listing is truncated. An empty
  // string or missing field means there are no more pages.
  const nextToken =
    typeof obj.NextToken === 'string' && obj.NextToken
      ? obj.NextToken
      : undefined;

  return { keys, nextToken };
}

// Pack a git dependency into a tarball via `npm pack`, compute its sha512, and
// store it content-addressed (<sha512-hex>.tar.gz). There is no pre-existing
// integrity to verify against, so the computed sha512 is authoritative.
async function mirrorGitSpec(
  item: MirrorItem,
  s3npmPrefix: string,
  existingKeys: Set<string>
): Promise<MirrorResult> {
  const url = item.resolved;

  const pack_dir = await fs.mkdtemp(path.join(temp_dir, 'gitpack-'));
  try {
    // `npm pack <spec>` clones/builds the exact git ref (the #<commit> is kept)
    // and emits one tarball into --pack-destination.
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', url, '--pack-destination', pack_dir, '--json'],
      { cwd: temp_dir, maxBuffer: 32 * 1024 * 1024 }
    );

    let filename: string | undefined;
    try {
      filename = JSON.parse(stdout)[0].filename;
    } catch {
      filename = undefined;
    }

    let packed: string | undefined = filename
      ? path.join(pack_dir, path.basename(filename))
      : undefined;
    if (!packed || !(await exists(packed))) {
      const entries = (await fs.readdir(pack_dir)).filter((f) =>
        f.endsWith('.tgz')
      );
      if (!entries.length) {
        throw new Error('mirrorGitSpec: no tarball produced for ' + url);
      }
      packed = path.join(pack_dir, entries[0]);
    }

    const buf = await fs.readFile(packed);
    return await storeTarball(buf, s3npmPrefix, existingKeys);
  } finally {
    await fs.rm(pack_dir, { recursive: true, force: true });
  }
}

// Rewrite every mirrored dependency's resolved url to the public S3 https base
// url (updating integrity where the bytes changed). The rewritten lockfile is
// written in place over cwd/<shrinkwrap> so it gets tarred into the source
// bundle; the build host unpacks the tar and runs `npm ci` against it. It is
// not uploaded anywhere separately -- the tar is its only home.
// Entries that were not mirrored (e.g. dev-only deps skipped via omitDev) keep
// their original resolved url untouched.
async function rewriteShrinkwrapInPlace({
  cwd,
  json,
  shrinkwrap,
  s3BaseUrl,
  mirror_map,
}: RewriteShrinkwrapOptions): Promise<void> {
  const base = s3BaseUrl.replace(/\/+$/, '');
  const rewritten = structuredClone(json);
  let count = 0;

  if (rewritten.packages) {
    for (const value of Object.values(rewritten.packages)) {
      if (!value || !value.resolved) {
        continue;
      }
      const info = mirror_map.get(value.resolved);
      if (!info) {
        continue;
      } // not mirrored (dev-only or unsupported) -> leave as-is
      value.resolved = base + '/' + info.key;
      if (info.integrity) {
        value.integrity = info.integrity;
      }
      count++;
    }
  }

  core.info(`rewriteShrinkwrapInPlace: rewrote ${count} resolved entries`);

  // Write in place so handleCode tars the rewritten lockfile into the bundle.
  const in_tree_path = path.join(cwd, shrinkwrap);
  await fs.writeFile(in_tree_path, JSON.stringify(rewritten, null, 2) + '\n');
  core.setOutput('shrinkwrap_file', in_tree_path);
}

async function updateLatest({ s3prefix }: { s3prefix: string }): Promise<void> {
  await fs.writeFile(latest_file, context.sha);
  await aws(['s3', 'cp', latest_file, `s3://${s3prefix}/`], { log: true });
}

// Run the aws cli with argv (no shell). Returns { ok, stdout, stderr, code }.
// With { ignoreError: true } a non-zero exit resolves (ok:false) instead of
// throwing. By default the call is quiet (no command echo, no stdout/stderr
// passthrough) so the mirror loop can emit a single line per package; pass
// { log: true } for the handful of top-level calls whose output is useful.
async function aws(
  args: string[],
  {
    ignoreError = false,
    log = false,
  }: { ignoreError?: boolean; log?: boolean } = {}
): Promise<AwsResult> {
  if (log) {
    core.info('aws ' + args.join(' '));
  }
  try {
    const { stdout, stderr } = await execFileAsync('aws', args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    if (log && stdout) {
      process.stdout.write(stdout);
    }
    if (log && stderr) {
      process.stderr.write(stderr);
    }
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err: unknown) {
    if (ignoreError) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        ok: false,
        stdout: e.stdout || '',
        stderr: e.stderr || '',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
    throw err;
  }
}

// Bounded-concurrency async map. Preserves fail-fast behavior via Promise.all.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  const queue = [...items.entries()];
  const workers: Promise<void>[] = [];
  const run = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await fn(next[1], next[0]);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(run());
  }
  await Promise.all(workers);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function tarFilter(entry: string): boolean {
  const is_git = entry && entry.indexOf('.git/') === 0;
  return !is_git;
}

// Only run the action when executed directly (not when imported by tests).
if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
