'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, formatStats, renderPolicy } = require('../src/cli.js');

const BIN = path.join(__dirname, '..', 'bin', 'json-slim.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'json-slim-'));

/**
 * Write a fixture and return its path.
 *
 * @param {string} name
 * @param {*} value
 * @returns {string}
 */
function fixture(name, value) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

/**
 * Run the CLI.
 *
 * @param {string[]} args
 * @param {{input?: string}} [opts]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: opts.input,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--drop-null/);
});

test('--version prints the package version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), require('../package.json').version);
});

test('a missing input file exits 2', () => {
  assert.equal(run(['/nonexistent/file.json']).status, 2);
});

test('no arguments at all exits 2', () => {
  assert.equal(run([]).status, 2);
});

test('two positional inputs exit 2', () => {
  const f = fixture('one.json', { a: 1 });
  assert.equal(run([f, f]).status, 2);
});

test('an unknown option exits 2', () => {
  const f = fixture('one2.json', { a: 1 });
  assert.equal(run([f, '--nonsense']).status, 2);
});

test('invalid JSON exits 2 and says where', () => {
  const file = path.join(tmp, 'broken.json');
  fs.writeFileSync(file, '{ not json');
  const r = run([file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON/);
});

test('null is dropped from keys by default', () => {
  const f = fixture('nulls.json', { a: 1, b: null, c: 2 });
  const r = run([f]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"a":1,"c":2}\n');
});

test('a null array slot survives the default run', () => {
  const f = fixture('arr.json', { i: [1, null, 2] });
  assert.equal(run([f]).stdout, '{"i":[1,null,2]}\n');
});

test('--drop-array-elements removes the slot and renumbers', () => {
  const f = fixture('arr2.json', { i: [1, null, 2] });
  assert.equal(run([f, '--drop-array-elements']).stdout, '{"i":[1,2]}\n');
});

test('--drop-false and --drop-zero apply only when asked', () => {
  const f = fixture('falsy.json', { a: false, b: 0, c: 'x' });
  assert.equal(run([f]).stdout, '{"a":false,"b":0,"c":"x"}\n');
  assert.equal(run([f, '--drop-false', '--drop-zero']).stdout, '{"c":"x"}\n');
});

test('id-like and flag-like keys survive aggressive pruning', () => {
  // Only genuinely id-shaped keys are protected by default. `retries` is not
  // an id, so --drop-zero takes it; pass --keep-keys retries to protect it.
  const f = fixture('ids.json', { id: null, retries: 0, is_admin: false });
  assert.equal(run([f, '--drop-false', '--drop-zero']).stdout, '{"id":null,"is_admin":false}\n');
  assert.equal(
    run([f, '--drop-false', '--drop-zero', '--keep-keys', 'retries']).stdout,
    '{"id":null,"retries":0,"is_admin":false}\n',
  );
});

test('--keep-keys protects the named keys', () => {
  const f = fixture('keep.json', { retries: 0, timeout: 0 });
  assert.equal(run([f, '--drop-zero']).stdout, '{}\n');
  assert.equal(run([f, '--drop-zero', '--keep-keys', 'retries']).stdout, '{"retries":0}\n');
  assert.equal(run([f, '--drop-zero', '--keep-keys', 'retries,timeout']).stdout, '{"retries":0,"timeout":0}\n');
});

test('--keep-keys accepts a comma separated list', () => {
  const f = fixture('keep2.json', { a: null, b: null, c: null });
  assert.equal(run([f, '--keep-keys', 'a, b']).stdout, '{"a":null,"b":null}\n');
});

test('--pretty indents the output', () => {
  const f = fixture('pretty.json', { a: 1 });
  assert.equal(run([f, '--pretty']).stdout, '{\n  "a": 1\n}\n');
});

test('--indent sets the width', () => {
  const f = fixture('indent.json', { a: 1 });
  assert.equal(run([f, '--pretty', '--indent', '4']).stdout, '{\n    "a": 1\n}\n');
});

test('--sort-keys orders keys deterministically', () => {
  const f = fixture('sorted.json', { b: 1, a: 2, c: 3 });
  assert.equal(run([f, '--sort-keys']).stdout, '{"a":2,"b":1,"c":3}\n');
});

test('--minify-only never touches values', () => {
  const file = path.join(tmp, 'spaced.json');
  fs.writeFileSync(file, '{\n  "a" : null,\n  "b" : []\n}\n');
  assert.equal(run([file, '--minify-only']).stdout, '{"a":null,"b":[]}\n');
});

test('--dry-run writes nothing', () => {
  const f = fixture('dry.json', { a: null });
  const r = run([f, '--drop-null', '--dry-run']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('--stats reports the size delta on stderr', () => {
  const f = fixture('stats.json', { a: 1, b: null, c: null });
  const r = run([f, '--stats']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /before/);
  assert.match(r.stderr, /after/);
  assert.match(r.stderr, /values/);
});

test('--explain lists every removed value', () => {
  const f = fixture('explain.json', { a: null, b: { c: null } });
  const r = run([f, '--explain']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\/a {2}null/);
  assert.match(r.stderr, /\/b\/c {2}null/);
  assert.match(r.stderr, /2 value\(s\) removed/);
});

test('--check exits 3 when something would be removed', () => {
  const f = fixture('check.json', { a: null });
  assert.equal(run([f, '--check']).status, 3);
  assert.equal(run([f, '--check']).stdout, '');
});

test('--check exits 0 on a clean document', () => {
  const f = fixture('clean.json', { a: 1, b: 'x' });
  assert.equal(run([f, '--check']).status, 0);
});

test('--fail-on-change exits 1 when the document changed', () => {
  const f = fixture('fail.json', { a: null });
  assert.equal(run([f, '--fail-on-change']).status, 1);
});

test('--fail-on-change exits 0 when nothing changed', () => {
  const f = fixture('nofail.json', { a: 1 });
  assert.equal(run([f, '--fail-on-change']).status, 0);
});

test('--out writes to a file and prints nothing', () => {
  const f = fixture('out.json', { a: null, b: 2 });
  const target = path.join(tmp, 'out-target.json');
  const r = run([f, '--out', target]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"b":2}\n');
});

test('--stdin reads the document from a pipe', () => {
  const r = run(['--stdin'], { input: '{"a":null,"b":1}' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"b":1}\n');
});

test('reading stdin without --stdin also works', () => {
  const r = run([], { input: '{"a":null}' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}\n');
});

test('--explain-policy documents the defaults', () => {
  const r = run(['--explain-policy']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /null\s+true/);
  assert.match(r.stdout, /false\s+false/);
});

test('policy columns are aligned', () => {
  const r = run(['--explain-policy']);
  // Rebuild the expected grid instead of probing for a column: the value
  // field is padded to the widest value, then two spaces, then a fixed
  // seven-wide status column. A regex hunt for "true|false" finds the
  // `false` VALUE on the false row and reports a phantom misalignment.
  const widths = [4, 5, 1, 2, 2, 2, 3]; // len of null,false,0,"",[],{},NaN
  const width = Math.max(...widths);
  const values = ['null', 'false', '0', '""', '[]', '{}', 'NaN'];

  const lines = r.stdout.split('\n');
  const statusColumn = lines
    .filter((l) => values.some((v) => l.trimStart().startsWith(v)) && l.includes('opt-in') || l.includes('dropped by default'))
    .map((l) => {
      const status = l.includes('true') ? 'true' : 'false';
      return l.indexOf(status, 2 + width);
    });

  assert.ok(statusColumn.length >= 7, `expected 7 policy rows, found ${statusColumn.length}`);
  assert.equal(new Set(statusColumn).size, 1, `status column not aligned: ${statusColumn}`);
});

test('the output is always valid JSON', () => {
  const f = fixture('valid.json', { a: null, b: [null], c: { d: null } });
  const r = run([f]);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('parseArgs keeps values out of the positional slot', () => {
  const o = parseArgs(['a.json', '--drop-zero']);
  assert.equal(o.file, 'a.json');
  assert.equal(o.options.dropZero, true);
});

test('parseArgs accepts --flag=value form', () => {
  const o = parseArgs(['--drop-zero=false', 'a.json']);
  assert.equal(o.options.dropZero, false);
});

test('parseArgs handles --out without a value by erroring', () => {
  assert.throws(() => parseArgs(['--out']), /requires a value/);
});

// A --out that cannot be written used to escape `main` as a thrown Error: Node
// printed a raw stack trace and the process exited 1, which this package
// documents as "--fail-on-change and the document was modified". Both halves
// are wrong, so both are asserted: the code is 2, and nothing that looks like a
// crash reached stderr.
test('an unwritable --out exits 2 instead of throwing', () => {
  const f = fixture('out.json', { a: 1, b: null });
  const r = run([f, '--out', path.join(tmp, 'no-such-dir', 'x.json')]);
  assert.equal(r.status, 2, `expected a usage error, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /json-slim: cannot write/);
  assert.doesNotMatch(r.stderr, /at Object\./, 'a stack trace leaked to the user');
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'a stack trace leaked to the user');
});

test('--out onto a directory exits 2 rather than crashing', () => {
  const f = fixture('outdir.json', { a: 1 });
  const r = run([f, '--out', tmp]);
  assert.equal(r.status, 2, `expected a usage error, got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'a stack trace leaked to the user');
});

test('a successful --out still writes and exits 0', () => {
  const f = fixture('writesrc.json', { a: 1, b: null });
  const dest = path.join(tmp, 'written.json');
  const r = run([f, '--out', dest]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(dest, 'utf8')).a, 1);
});

// The write happens only after the exit-code checks, so --dry-run must never
// touch the filesystem even when the target is unwritable.
test('--dry-run reports no write failure for an unwritable --out', () => {
  const f = fixture('dry.json', { a: 1, b: null });
  const r = run([f, '--dry-run', '--out', path.join(tmp, 'no-such-dir', 'x.json')]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /cannot write/);
});

test('parseArgs treats -h as help', () => {
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs passes everything after -- as positional', () => {
  const o = parseArgs(['--', '-weird-name.json']);
  assert.equal(o.file, '-weird-name.json');
});

test('parseArgs defaults indent to 2', () => {
  assert.equal(parseArgs(['a.json']).indent, 2);
});

test('formatStats prints three size lines', () => {
  const text = formatStats(100, 40, { total: 2, nulls: 2 });
  assert.match(text, /before\s+100 B/);
  assert.match(text, /after\s+40 B/);
  assert.match(text, /60\.0%/);
  assert.match(text, /null=2/);
});

test('formatStats tolerates a null stats object', () => {
  assert.match(formatStats(10, 10, null), /0\.0%/);
});

test('renderPolicy output parses as readable text', () => {
  const text = renderPolicy();
  assert.match(text, /Default value policy/);
  assert.match(text, /opt-in/);
});