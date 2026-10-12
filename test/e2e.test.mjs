import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RUNNER_TEMP / GITHUB_SHA are read by src/index.mjs at module load; set first.
const RUNNER_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'npa-e2e-'));
process.env.RUNNER_TEMP = RUNNER_TEMP;
process.env.GITHUB_SHA = process.env.GITHUB_SHA || 'e2e-' + Date.now();

const { handleShrinkwrap } = await import('../src/index.mjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'e2e');
const SHRINKWRAP = 'npm-shrinkwrap.json';

const S3_NPM_PREFIX = process.env.E2E_S3_NPM_PREFIX;
const S3_BASE_URL = process.env.E2E_S3_BASE_URL;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

// This suite talks to real S3 / npm / GitHub. Skip (rather than fail) when the
// environment is not configured, so `npm test` stays green without a bucket.
const configured = Boolean(S3_NPM_PREFIX && S3_BASE_URL);

test(
  'end-to-end: mirror + rewrite + offline npm ci from S3',
  { skip: configured ? false : 'E2E_S3_* env not set (see .env.example)' },
  async (t) => {
    process.env.AWS_REGION = AWS_REGION;

    // Copy the fixture into a throwaway cwd. The action rewrites the lockfile
    // in place, so we must not point it at the committed fixture directory.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npa-src-'));
    await fsp.copyFile(
      path.join(FIXTURE_DIR, 'package.json'),
      path.join(cwd, 'package.json')
    );
    await fsp.copyFile(
      path.join(FIXTURE_DIR, SHRINKWRAP),
      path.join(cwd, SHRINKWRAP)
    );

    // 1. Run the real action flow: mirror every resolved dep to S3 and write a
    //    rewritten lockfile pointing at the public https base url.
    await handleShrinkwrap({
      cwd,
      shrinkwrap: SHRINKWRAP,
      s3npmPrefix: S3_NPM_PREFIX,
      rewriteShrinkwrap: true,
      s3BaseUrl: S3_BASE_URL,
    });

    // The rewritten lockfile is written in place in cwd (so it gets tarred).
    const rewritten_path = path.join(cwd, SHRINKWRAP);
    assert.ok(fs.existsSync(rewritten_path), 'rewritten lockfile was written');
    const rewritten = JSON.parse(await fsp.readFile(rewritten_path, 'utf8'));

    // 2. Every resolved url now points at the s3 base url, including the git dep.
    const resolvedUrls = Object.values(rewritten.packages)
      .filter((p) => p && p.resolved)
      .map((p) => p.resolved);
    assert.ok(resolvedUrls.length >= 2, 'has resolved entries');
    for (const url of resolvedUrls) {
      assert.ok(
        url.startsWith(S3_BASE_URL + '/'),
        `resolved rewritten to s3 base url: ${url}`
      );
    }
    // The git dependency (is-odd) must have been mirrored as a tarball too,
    // stored content-addressed by its sha512 (<128 hex chars>.tar.gz).
    const isOdd = rewritten.packages['node_modules/is-odd'];
    assert.ok(isOdd, 'is-odd present in lockfile');
    assert.match(
      isOdd.resolved,
      new RegExp(
        '^' +
          S3_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '/[0-9a-f]{128}\\.tar\\.gz$'
      ),
      'git dep rewritten to content-addressed sha512 tarball url'
    );
    assert.match(isOdd.integrity, /^sha512-/, 'git dep has sha512 integrity');

    // 3. Each rewritten url is fetchable over anonymous https from real S3.
    for (const url of resolvedUrls) {
      const res = await fetch(url, { method: 'GET' });
      assert.equal(res.status, 200, `unauthenticated GET 200 for ${url}`);
      // Drain the body so the socket is released.
      await res.arrayBuffer();
    }

    // 4. The decisive check: tar up the source tree exactly as the action does,
    //    extract it elsewhere (simulating the locked-down build host), then run
    //    `npm ci` from the extracted tree with the npm registry pointed at a
    //    dead port AND git disabled. If npm tried to reach GitHub it would
    //    invoke our fake git (which fails), so success proves the rewritten
    //    lockfile travelled inside the tar and every dep came from S3.
    const tarball = path.join(RUNNER_TEMP, 'source.tar.gz');
    await tar.c({ cwd, gzip: true, file: tarball }, ['./']);

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npa-ci-'));
    await tar.x({ cwd: projectDir, file: tarball });

    // Sanity: the lockfile that landed in the extracted tree is the rewritten
    // one (points at S3), not the original registry/git lockfile.
    const extractedLock = JSON.parse(
      await fsp.readFile(path.join(projectDir, SHRINKWRAP), 'utf8')
    );
    assert.ok(
      extractedLock.packages['node_modules/is-odd'].resolved.startsWith(
        S3_BASE_URL + '/'
      ),
      'rewritten lockfile is the one inside the tar'
    );
    // npm ci reads package-lock.json; copy to that name so it is picked up
    // deterministically.
    await fsp.copyFile(
      path.join(projectDir, SHRINKWRAP),
      path.join(projectDir, 'package-lock.json')
    );

    // A fake `git` that always fails, placed first on PATH. If npm resolves the
    // git dep from GitHub instead of the mirrored S3 tarball, this fires and
    // the install fails the test.
    const fakeBin = path.join(projectDir, 'fakebin');
    fs.mkdirSync(fakeBin);
    const fakeGit = path.join(fakeBin, 'git');
    fs.writeFileSync(
      fakeGit,
      '#!/bin/sh\necho "FAKE GIT INVOKED: $@" >&2\nexit 127\n'
    );
    fs.chmodSync(fakeGit, 0o755);

    const env = {
      ...process.env,
      PATH: fakeBin + path.delimiter + process.env.PATH,
      // Dead registry so npm cannot fall back to the public npm registry.
      npm_config_registry: 'http://127.0.0.1:1/',
      npm_config_cache: path.join(projectDir, '.npm-cache'),
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };

    t.diagnostic('running npm ci with git disabled + dead registry (S3 only)');
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: projectDir,
      env,
      stdio: 'inherit',
    });

    // 5. Both a registry dep and the git dep are actually installed.
    assert.ok(
      fs.existsSync(path.join(projectDir, 'node_modules', 'accepts')),
      'registry dep installed'
    );
    assert.ok(
      fs.existsSync(path.join(projectDir, 'node_modules', 'is-odd')),
      'git dep installed from mirrored tarball'
    );
    // is-odd is a CommonJS module; load it via a require scoped to projectDir.
    const require = createRequire(path.join(projectDir, 'package.json'));
    const installed = require('is-odd');
    assert.equal(typeof installed, 'function', 'is-odd module is usable');
    assert.equal(installed(3), true);
    assert.equal(installed(4), false);
  }
);
