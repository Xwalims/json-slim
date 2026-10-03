'use strict';

/**
 * Flag/help/README contract.
 *
 * json-slim had no contract test, which is why its README option table drifted:
 * `-h, --help` and `--version` were accepted and printed by `--help`, but
 * absent from the table, so the only place to learn they existed was the tool
 * itself. Both directions are pinned here:
 *
 *   1. every flag the parser accepts is documented in `--help` and the README;
 *   2. every flag `--help` names really parses (no phantom flags);
 *   3. the README's option table and `--help` agree on the flag set.
 *
 * The oracle is the parser's own comparisons in `src/cli.js`, so adding a flag
 * without documenting it fails the suite instead of shipping invisibly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'cli.js');
const BIN = path.join(ROOT, 'bin', 'json-slim.js');
const README = path.join(ROOT, 'README.md');

/** Every flag literal the parser compares its argument against. */
function parserFlags() {
  const source = fs.readFileSync(SRC, 'utf8');
  const flags = new Set();
  // The parser stores most flags in two exported Maps, keyed by the literal.
  // Reading them is the ground truth; anything else in the file is a comment.
  for (const m of source.matchAll(/BOOLEAN_FLAGS = new Map\(\[([\s\S]*?)\n\]\)/g)) {
    for (const k of m[1].matchAll(/\['(--[a-z0-9-]+)'/g)) flags.add(k[1]);
  }
  for (const m of source.matchAll(/VALUE_FLAGS = new Map\(\[([\s\S]*?)\n\]\)/g)) {
    for (const k of m[1].matchAll(/\['(--[a-z0-9-]+)'/g)) flags.add(k[1]);
  }
  // Flags handled inline by a direct comparison, including the short aliases.
  for (const m of source.matchAll(/arg === ['"](--?[a-zA-Z][\w-]*)['"]/g)) flags.add(m[1]);
  for (const m of source.matchAll(/case ['"](--[a-z][a-z0-9-]*)['"]/g)) flags.add(m[1]);
  return [...flags].sort();
}

/** Whole-token presence; a substring test is fooled by -h inside --help. */
function mentions(text, flag) {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(text);
}

const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).stdout;
const readme = fs.readFileSync(README, 'utf8');

test('the flag scanner sees the parser flags it claims to', () => {
  // Guard for the guard: a regex matching nothing makes every assertion below
  // vacuously true.
  const flags = parserFlags();
  assert.ok(flags.length >= 10, `only found ${flags.length}: ${flags.join(' ')}`);
  for (const known of ['--version', '--help', '--stats', '--pretty', '--check']) {
    assert.ok(flags.includes(known), `scanner should find ${known}`);
  }
});

test('every flag the parser accepts is documented in --help', () => {
  const hidden = parserFlags().filter((f) => !mentions(help, f));
  assert.deepEqual(hidden, [], `accepted but absent from --help: ${hidden.join(' ')}`);
});

test('every flag the parser accepts is documented in the README', () => {
  const missing = parserFlags().filter((f) => !mentions(readme, f));
  assert.deepEqual(missing, [], `accepted but absent from README: ${missing.join(' ')}`);
});

test('--compact-arrays and --stdin are options, not just passing mentions', () => {
  // Both appear in --help only as a cross-reference ("see --compact-arrays")
  // and a usage line ("cat data.json | json-slim --stdin"), which is enough for
  // a substring oracle but not for a reader. They belong in the options list.
  //
  // Note there is no literal "Options:" header to slice from -- the usage text
  // is grouped under "Pruning", "Protecting keys", "Output" and so on, and
  // indexOf('Options') returns -1, which slices to the final character.
  assert.match(help, /^ {2}--compact-arrays\s+after dropping/m);
  assert.match(help, /^ {2}--stdin\s+read the document/m);
});

test('the reverse direction holds: every flag in --help really parses', () => {
  const known = new Set(parserFlags());
  // Long flags named in the usage text must be accepted. Run the real binary:
  // several CLIs read stdin, so an in-process parse would not test the contract.
  const named = [...new Set([...help.matchAll(/(?<![-\w])(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 10, `only found ${named.length} flags in the usage text`);
  for (const flag of named) {
    if (known.has(flag)) continue;
    const res = spawnSync(process.execPath, [BIN, flag], {
      input: '{}\n', encoding: 'utf8', cwd: ROOT,
    });
    assert.doesNotMatch(
      `${res.stderr}`, /unknown option|unrecognised|not a known/,
      `${flag} is in --help but the parser rejects it`
    );
  }
});

test('the README option table lists every flag --help names', () => {
  // The section is headed "## CLI flags", not "### Options".
  const start = readme.indexOf('## CLI flags');
  assert.ok(start > -1, 'the README should have a CLI flags section');
  const table = readme.slice(start, readme.indexOf('\n## ', start + 1));
  // json-slim's usage text is grouped by topic, so there is no "Options:" line
  // to slice from; compare the flags of the whole help text against the table.
  const flagsIn = (text) => new Set([...text.matchAll(/(?<![-\w])(--[a-z][a-z0-9-]*)/g)]
    .map((m) => m[1]));
  const tabled = flagsIn(table);
  const real = flagsIn(help);

  const missing = [...real].filter((f) => !tabled.has(f));
  assert.deepEqual(missing, [], `README option table omits: ${missing.join(' ')}`);
});
