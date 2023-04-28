const asyncSeries = require('async/series');
const asyncEachLimit = require('async/eachLimit');
const core = require('@actions/core');
const { exec } = require('node:child_process');
const fs = require('fs');
const { context } = require('@actions/github');
const path = require('path');
const request = require('request');
const tar = require('tar');

const EACH_LIMIT = 5;

const temp_dir = process.env.RUNNER_TEMP;
const npm_dir = path.join(temp_dir, 'npm');
const out_file = path.join(temp_dir, context.sha + '.tar.gz');
const latest_file = path.join(temp_dir, 'LATEST');

let cwd, files, shrinkwrap, s3prefix, s3npmPrefix;
try {
  cwd = core.getInput('cwd');
  shrinkwrap = core.getInput('shrinkwrap');
  s3prefix = core.getInput('s3prefix');
  s3npmPrefix = core.getInput('s3npmPrefix') || s3prefix;
  files = core
    .getInput('files', { required: true })
    .split('\n')
    .filter((x) => x !== '');

  asyncSeries(
    [
      handleCode,
      (done) => {
        if (shrinkwrap) {
          handleShrinkwrap(done);
        } else {
          done();
        }
      },
      updateLatest,
    ],
    (err) => {
      if (err) {
        core.setFailed(String(err));
        process.exit(-2);
      } else {
        core.setOutput('out_file', out_file);
        process.exit(0);
      }
    }
  );
} catch (error) {
  core.setFailed(error.message);
  process.exit(-1);
}

function handleCode(done) {
  const commit_file = path.join(cwd, '.git_commit_hash');
  fs.writeFileSync(commit_file, context.sha);
  asyncSeries(
    [
      (done) => {
        const list = Array.isArray(files) ? files : [files];
        const opts = { cwd, gzip: true, file: out_file, filter: tarFilter };
        tar.c(opts, list).then(
          () => {
            done();
          },
          (err) => {
            core.error('handleCode: tar err:' + err);
            done(err);
          }
        );
      },
      (done) => {
        const cmd = `aws s3 cp ${out_file} s3://${s3prefix}/`;
        core.info('cmd: ' + cmd);
        const proc = exec(cmd, (err) => {
          if (err) {
            core.error('handleCode: cp err:' + err);
          }
          done(err);
        });
        proc.stdout.pipe(process.stdout);
        proc.stderr.pipe(process.stderr);
      },
    ],
    done
  );
}

function handleShrinkwrap(done) {
  try {
    let list = [];
    const shrink_path = path.join(cwd, shrinkwrap);
    const file_contents = fs.readFileSync(shrink_path);
    const json = JSON.parse(file_contents);
    if (json && json.packages) {
      const map = {};
      Object.keys(json.packages).forEach((key) => {
        const value = json.packages[key];
        if (key && value.resolved) {
          map[value.resolved] = true;
        }
      });
      list = Object.keys(map);
    }
    asyncSeries(
      [
        (done) => fs.mkdir(npm_dir, done),
        (done) => asyncEachLimit(list, EACH_LIMIT, handleUrl, done),
        (done) => {
          const cmd = `aws s3 sync ${npm_dir} s3://${s3npmPrefix}/`;
          core.info('cmd: ' + cmd);
          const proc = exec(cmd, (err) => {
            if (err) {
              core.error('handleShrinkwrap: err:' + err);
            }
            done(err);
          });
          proc.stdout.pipe(process.stdout);
          proc.stderr.pipe(process.stderr);
        },
      ],
      done
    );
  } catch (e) {
    done(e);
  }
}
function handleUrl(url, done) {
  if (url.indexOf('http') === 0) {
    const url_path = url.replace(/http?s:\/\/[^/]*/, '');
    const dest_path = path.join(npm_dir, url_path);
    const dir = path.dirname(dest_path);
    fs.mkdirSync(dir, { recursive: true });
    const output = fs.createWriteStream(dest_path);
    const r = request(url).pipe(output);
    r.on('finish', () => done());
    r.on('error', (err) => {
      core.info('handleUrl err: ' + err);
      done(err);
    });
  } else {
    core.info('handleUrl: skip: ' + url);
    done();
  }
}
function updateLatest(done) {
  fs.writeFileSync(latest_file, context.sha);
  const cmd = `aws s3 cp ${latest_file} s3://${s3prefix}/`;
  core.info('lastest cmd: ' + cmd);
  const proc = exec(cmd, (err) => {
    if (err) {
      core.error('updateLatest: err:' + err);
    }
    done(err);
  });
  proc.stdout.pipe(process.stdout);
  proc.stderr.pipe(process.stderr);
}
function tarFilter(path, stat) {
  const is_git = path && path.indexOf('.git/') === 0;
  return !is_git;
}
