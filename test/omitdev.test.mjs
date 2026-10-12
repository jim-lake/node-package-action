import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RUNNER_TEMP / GITHUB_SHA are read by src/index.mjs at module load; set first.
const RUNNER_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'npa-omitdev-'));
process.env.RUNNER_TEMP = RUNNER_TEMP;
process.env.GITHUB_SHA = process.env.GITHUB_SHA || 'omitdev-' + Date.now();

const { handleShrinkwrap } = await import('../src/index.mjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'e2e-omitdev');
const SHRINKWRAP = 'npm-shrinkwrap.json';

const S3_BASE_URL = process.env.E2E_S3_BASE_URL;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

// Use a dedicated sub-prefix so this test's mirror is isolated and we can
// assert precisely which objects were (not) uploaded.
const S3_NPM_PREFIX = process.env.E2E_S3_NPM_PREFIX
  ? process.env.E2E_S3_NPM_PREFIX + '/omitdev'
  : undefined;
const BASE_URL = S3_BASE_URL ? S3_BASE_URL + '/omitdev' : undefined;

const configured = Boolean(S3_NPM_PREFIX && BASE_URL);

const DEV_URL = 'https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz';

test(
  'omitDev: dev-only deps are not mirrored and not rewritten',
  { skip: configured ? false : 'E2E_S3_* env not set (see .env.example)' },
  async (t) => {
    process.env.AWS_REGION = AWS_REGION;

    // Copy the fixture into a throwaway cwd; the lockfile is rewritten in place.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npa-omitdev-src-'));
    await fsp.copyFile(
      path.join(FIXTURE_DIR, 'package.json'),
      path.join(cwd, 'package.json')
    );
    await fsp.copyFile(
      path.join(FIXTURE_DIR, SHRINKWRAP),
      path.join(cwd, SHRINKWRAP)
    );

    await handleShrinkwrap({
      cwd,
      shrinkwrap: SHRINKWRAP,
      s3npmPrefix: S3_NPM_PREFIX,
      rewriteShrinkwrap: true,
      s3BaseUrl: BASE_URL,
      omitDev: true,
    });

    const rewritten_path = path.join(cwd, SHRINKWRAP);
    const rewritten = JSON.parse(await fsp.readFile(rewritten_path, 'utf8'));

    // The dev-only entry is still present and left pointing at the registry.
    const devEntry = rewritten.packages['node_modules/is-number'];
    assert.ok(devEntry, 'dev entry retained in lockfile');
    assert.equal(
      devEntry.resolved,
      DEV_URL,
      'dev-only resolved url left untouched (not rewritten to S3)'
    );

    // A production entry was rewritten to the S3 base url.
    const prodEntry = rewritten.packages['node_modules/accepts'];
    assert.ok(
      prodEntry.resolved.startsWith(BASE_URL + '/'),
      'prod dep rewritten to S3'
    );

    // The dev tarball was never uploaded. Keys are content-addressed by
    // sha512, so download the dev tarball from the registry, compute the key
    // it WOULD have had, and confirm that object is absent from the mirror.
    // (S3 returns 403 for a missing key when anonymous ListBucket isn't
    // granted, 404 if it is -- in either case, not 200.)
    const devBuf = Buffer.from(await (await fetch(DEV_URL)).arrayBuffer());
    const devSha = crypto.createHash('sha512').update(devBuf).digest('hex');
    const devMirrorUrl = BASE_URL + '/' + devSha + '.tar.gz';
    const devRes = await fetch(devMirrorUrl);
    await devRes.arrayBuffer();
    assert.notEqual(
      devRes.status,
      200,
      `dev dep must not be mirrored at ${devMirrorUrl} (got ${devRes.status})`
    );

    // The prod tarball IS fetchable from the mirror over anonymous https.
    const prodRes = await fetch(prodEntry.resolved);
    await prodRes.arrayBuffer();
    assert.equal(prodRes.status, 200, 'prod dep mirrored and reachable');

    t.diagnostic('omitDev correctly skipped the dev-only dependency');
  }
);
