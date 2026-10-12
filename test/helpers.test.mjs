import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';

// RUNNER_TEMP / GITHUB_SHA are read at module load; set before importing.
process.env.RUNNER_TEMP = process.env.RUNNER_TEMP || os.tmpdir();
process.env.GITHUB_SHA = process.env.GITHUB_SHA || 'testsha';

const { isHttpTarball, isGitSpec, verifyIntegrity, isDevOnly } = await import(
  '../src/node-package-action.ts'
);

test('isHttpTarball matches http and https', () => {
  assert.equal(isHttpTarball('https://registry.npmjs.org/x/-/x-1.0.0.tgz'), true);
  assert.equal(isHttpTarball('http://example.com/x.tgz'), true);
  assert.equal(isHttpTarball('git+ssh://git@github.com/a/b.git#abc'), false);
  assert.equal(isHttpTarball('github:a/b'), false);
});

test('isGitSpec matches git protocols and shorthands', () => {
  assert.equal(isGitSpec('git+ssh://git@github.com/a/b.git#abc'), true);
  assert.equal(isGitSpec('git+https://github.com/a/b.git#abc'), true);
  assert.equal(isGitSpec('git://github.com/a/b.git#abc'), true);
  assert.equal(isGitSpec('github:a/b'), true);
  assert.equal(isGitSpec('gitlab:a/b#v1'), true);
  assert.equal(isGitSpec('https://registry.npmjs.org/x/-/x-1.0.0.tgz'), false);
});

test('isDevOnly only flags entries marked dev:true', () => {
  assert.equal(isDevOnly({ dev: true }), true);
  assert.equal(isDevOnly({ devOptional: true }), false);
  assert.equal(isDevOnly({ dev: false }), false);
  assert.equal(isDevOnly({}), false);
  assert.equal(isDevOnly({ optional: true }), false);
});

const buf = Buffer.from('the quick brown fox');
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const sha256 = crypto.createHash('sha256').update(buf).digest('base64');
const sha1 = crypto.createHash('sha1').update(buf).digest('base64');

test('verifyIntegrity passes for a matching sha512 SRI', () => {
  assert.doesNotThrow(() => verifyIntegrity('sha512-' + sha512, buf, 'u'));
});

test('verifyIntegrity passes for matching sha256 / sha1', () => {
  assert.doesNotThrow(() => verifyIntegrity('sha256-' + sha256, buf, 'u'));
  assert.doesNotThrow(() => verifyIntegrity('sha1-' + sha1, buf, 'u'));
});

test('verifyIntegrity picks the strongest hash in a multi-hash SRI', () => {
  const sri = 'sha1-' + sha1 + ' sha512-' + sha512;
  assert.doesNotThrow(() => verifyIntegrity(sri, buf, 'u'));
});

test('verifyIntegrity throws on mismatch', () => {
  const wrong = crypto
    .createHash('sha512')
    .update('different bytes')
    .digest('base64');
  assert.throws(
    () => verifyIntegrity('sha512-' + wrong, buf, 'bad-url'),
    /integrity mismatch for bad-url/
  );
});

test('verifyIntegrity is a no-op when SRI is empty or unknown', () => {
  assert.doesNotThrow(() => verifyIntegrity('', buf, 'u'));
  assert.doesNotThrow(() => verifyIntegrity(undefined, buf, 'u'));
  assert.doesNotThrow(() => verifyIntegrity('md5-abc', buf, 'u'));
});
