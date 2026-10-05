'use strict';

/**
 * Command line interface for `json-slim`.
 *
 * Hand-rolled argv parsing: no dependencies.
 *
 * Exit codes:
 *   0  success (and, with `--fail-on-change`, nothing was removed)
 *   1  `--fail-on-change` was given and the document was modified
 *   2  usage error, unreadable file, or invalid JSON
 *   3  output written with `--check` violations pending
 */

const fs = require('node:fs');
const path = require('node:path');

const { slim, minify, stringify, DepthLimitError } = require('./slim.js');
const { describePolicy } = require('./policies.js');
const { DEFAULTS, toBool, formatBytes, savedPercent } = require('./util.js');

const BOOLEAN_FLAGS = new Map([
  ['--drop-null', 'dropNull'],
  ['--drop-false', 'dropFalse'],
  ['--drop-zero', 'dropZero'],
  ['--drop-empty-string', 'dropEmptyString'],
  ['--drop-empty-array', 'dropEmptyArray'],
  ['--drop-empty-object', 'dropEmptyObject'],
  ['--drop-nan', 'dropNaN'],
  ['--keep-id-like', 'keepIdLike'],
  ['--keep-flags', 'keepFlags'],
  ['--drop-array-elements', 'dropArrayElements'],
  ['--compact-arrays', 'compactArrays'],
  ['--sort-keys', 'sortKeys'],
  ['--pretty', null],
  ['--dry-run', null],
  ['--stats', null],
  ['--explain', null],
  ['--check', null],
  ['--fail-on-change', null],
  ['--stdin', null],
]);

const VALUE_FLAGS = new Map([
  ['--indent', 'indent'],
  ['--keep-keys', 'keepKeys'],
  ['--keep-key-pattern', 'keepKeyPattern'],
  ['--key-filter', 'keyFilter'],
]);

const USAGE = `json-slim - shrink JSON documents without destroying meaning

Usage:
  json-slim FILE [options]
  cat data.json | json-slim --stdin [options]

Pruning (which value classes may be dropped):
  --drop-null              drop null                     [default: on]
  --drop-false             drop false                    [default: off]
  --drop-zero              drop 0 and -0                 [default: off]
  --drop-empty-string      drop ""                       [default: off]
  --drop-empty-array       drop [] (already empty, or emptied here)  [default: off]
  --drop-empty-object      drop {} (already empty, or emptied here)  [default: off]
  --drop-nan               drop NaN                      [default: off]
  --drop-array-elements    drop falsy ARRAY ELEMENTS     [default: off]
                           ^ renumbers the array; see --compact-arrays
  --compact-arrays         after dropping elements, remove the holes
                           [default: off]

Protecting keys:
  --keep-id-like           protect id/uuid/version/etag keys      [default: on]
  --keep-flags             protect is_*/has_*/can_* keys          [default: on]
  --keep-keys a,b,c        extra key names to protect
  --keep-key-pattern RE    protect keys matching RE
  --key-filter RE          only prune keys matching RE

Output:
  --pretty                indent the output
  --indent N              indent width for --pretty          [default: 2]
  --sort-keys             emit object keys in sorted order
  --out FILE              write result to FILE ('-' for stdout)
  --stdin                 read the document from standard input
  --stats                 print a size report to stderr
  --explain               list every removed value to stderr
  --dry-run               do not write; report only
  --check                 exit 3 if anything would be removed
  --fail-on-change        exit 1 if anything was removed
  --explain-policy        print the active value policy and exit
  --minify-only           whitespace removal only; never touch values
  -h, --help              this text
  --version               print the version

Exit codes:
  0  success
  1  --fail-on-change and the document was modified
  2  usage error, unreadable file, or invalid JSON
  3  --check and something would be removed

Examples:
  json-slim data.json --pretty --stats
  json-slim data.json --drop-false --drop-zero --dry-run
  json-slim config.json --keep-keys retries,timeout --drop-empty-object
`;

/**
 * Parse argv into an options object.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const out = {
    file: null,
    pretty: false,
    dryRun: false,
    stats: false,
    explain: false,
    check: false,
    failOnChange: false,
    stdin: false,
    out: null,
    minifyOnly: false,
    explainPolicy: false,
    help: false,
    version: false,
    indent: 2,
    options: {},
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    if (arg === '--version') { out.version = true; continue; }
    if (arg === '--out') {
      const value = argv[i + 1];
      // Without this, `--out` alone silently became '-' (stdout), which is
      // the opposite of what the user asked for.
      if (value === undefined || value.startsWith('-')) throw usageError('--out requires a value');
      out.out = value;
      i += 1;
      continue;
    }
    if (arg === '--minify-only') { out.minifyOnly = true; continue; }
    if (arg === '--explain-policy') { out.explainPolicy = true; continue; }
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }

    if (BOOLEAN_FLAGS.has(arg)) {
      const key = BOOLEAN_FLAGS.get(arg);
      if (key === null) {
        const flagName = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[flagName] = true;
      } else {
        // Support both "--drop-false" and "--drop-false=false".
        const eq = arg.indexOf('=');
        if (eq !== -1) out.options[key] = toBool(arg.slice(eq + 1), true);
        else out.options[key] = true;
      }
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const key = VALUE_FLAGS.get(arg);
      const value = argv[i + 1];
      if (value === undefined) throw usageError(`${arg} requires a value`);
      i += 1;
      if (key === 'indent') out.indent = Number(value);
      else if (key === 'keepKeys') out.options.keepKeys = value.split(',').map((s) => s.trim()).filter(Boolean);
      else out.options[key] = value;
      continue;
    }

    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1 && BOOLEAN_FLAGS.has(arg.slice(0, eq))) {
      const key = BOOLEAN_FLAGS.get(arg.slice(0, eq));
      if (key !== null) { out.options[key] = toBool(arg.slice(eq + 1), true); continue; }
    }

    if (arg.startsWith('-') && arg !== '-') throw usageError(`unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw usageError(`expected at most one input file, got ${positional.length}`);
  }
  out.file = positional[0] ?? null;
  return out;
}

/**
 * Build a usage error with a stable marker.
 *
 * @param {string} message
 * @returns {Error}
 */
function usageError(message) {
  const err = new Error(message);
  err.isUsageError = true;
  return err;
}

/**
 * Read the input document text.
 *
 * @param {object} opts
 * @returns {string}
 */
function readInput(opts) {
  if (opts.stdin || !opts.file) {
    return fs.readFileSync(0, 'utf8');
  }
  try {
    return fs.readFileSync(opts.file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${opts.file}: ${err.message}`);
  }
}

/**
 * Format the size report.
 *
 * @param {number} before
 * @param {number} after
 * @param {object} stats
 * @returns {string}
 */
function formatStats(before, after, stats) {
  const lines = [
    `before   ${formatBytes(before)} (${before} B)`,
    `after    ${formatBytes(after)} (${after} B)`,
    `removed  ${formatBytes(before - after)} (${savedPercent(before, after).toFixed(1)}%)`,
  ];
  if (stats && stats.total !== undefined) {
    const parts = [];
    if (stats.nulls) parts.push(`null=${stats.nulls}`);
    if (stats.falsy) parts.push(`zero/nan=${stats.falsy}`);
    if (stats.emptyContainers) parts.push(`empty=${stats.emptyContainers}`);
    if (stats.arrayElements) parts.push(`array-elements=${stats.arrayElements}`);
    if (stats.other) parts.push(`other=${stats.other}`);
    lines.push(`values   ${stats.total} removed${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @param {{stdout?: Function, stderr?: Function, exit?: Function}} [io]
 * @returns {number} exit code
 */
function main(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`json-slim: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  if (opts.help) { out(USAGE); return 0; }
  if (opts.version) {
    out(`${require(path.join(__dirname, '..', 'package.json')).version}\n`);
    return 0;
  }
  if (opts.explainPolicy) {
    out(renderPolicy());
    return 0;
  }
  if (opts.file === null && !opts.stdin && process.stdin.isTTY) {
    err(`json-slim: no input file; pass a path or --stdin\n\n${USAGE}`);
    return 2;
  }

  let text;
  try {
    text = readInput(opts);
  } catch (e) {
    err(`json-slim: ${e.message}`);
    return 2;
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch (e) {
    err(`json-slim: invalid JSON in ${opts.file || 'stdin'}: ${e.message}`);
    return 2;
  }

  const beforeBytes = Buffer.byteLength(text, 'utf8');
  let outputText;
  let stats = null;

  try {
    if (opts.minifyOnly) {
      outputText = `${minify(text, { sortKeys: opts.options.sortKeys })}\n`;
    } else {
      const result = slim(document, opts.options);
      stats = result.stats;
      if (opts.explain && result.removals.length) {
        err(renderRemovals(result.removals));
      }
      outputText = `${stringify(result.value, {
        format: opts.pretty ? 'pretty' : 'compact',
        indent: opts.indent,
        sortKeys: opts.options.sortKeys,
      })}\n`;
    }
  } catch (e) {
    if (e instanceof DepthLimitError) {
      err(`json-slim: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const afterBytes = Buffer.byteLength(outputText, 'utf8');

  if (opts.check && stats && stats.total > 0) {
    err(formatStats(beforeBytes, afterBytes, stats));
    return 3;
  }
  if (opts.failOnChange && stats && stats.total > 0) return 1;

  // A failed --out is a usage error (exit 2), like an unreadable input. It
  // used to be thrown out of here, so Node printed a raw stack trace and exited
  // 1 -- the code this package documents as "--fail-on-change and the document
  // was modified". A CI step reading that would conclude the input changed when
  // nothing had been written at all.
  if (!opts.dryRun) {
    const writeError = writeOutput(outputText, opts, out);
    if (writeError) {
      err(`json-slim: ${writeError}\n`);
      return 2;
    }
  }
  if (opts.stats) err(`${formatStats(beforeBytes, afterBytes, stats)}\n`);

  return 0;
}

/**
 * Write the result to a file or stdout.
 *
 * Returns an error message instead of throwing, because `main` owns the
 * exit-code contract and this used to escape it entirely.
 *
 * @param {string} text
 * @param {object} opts
 * @param {Function} out
 * @returns {string|null} a message when the write failed, else null.
 */
function writeOutput(text, opts, out) {
  if (!opts.out || opts.out === '-') { out(text); return null; }
  try {
    fs.writeFileSync(opts.out, text, 'utf8');
    return null;
  } catch (e) {
    return `cannot write ${opts.out}: ${e.message}`;
  }
}

/**
 * Render the removal list.
 *
 * @param {Array<object>} removals
 * @returns {string}
 */
function renderRemovals(removals) {
  const lines = [`${removals.length} value(s) removed:`, ''];
  for (const r of removals) {
    lines.push(`  ${r.path || '/'}  ${r.reason}  ${JSON.stringify(r.value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render the active default policy.
 *
 * @returns {string}
 */
function renderPolicy() {
  const { createValuePolicy } = require('./policies.js');
  const rows = describePolicy(createValuePolicy({}));
  const valueWidth = Math.max(...rows.map((r) => r.value.length));
  const lines = ['Default value policy:', ''];
  lines.push(`  ${'value'.padEnd(valueWidth)}  default  rationale`);
  for (const r of rows) {
    lines.push(`  ${r.value.padEnd(valueWidth)}  ${String(r.enabled).padEnd(7)}  ${r.why}`);
  }
  lines.push('');
  lines.push('Anything other than null is opt-in: an empty list, a zero count and a');
  lines.push('missing key are three different things to whoever reads the document.');
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, renderPolicy, renderRemovals, formatStats, USAGE, DEFAULTS };