# json-slim

Shrink JSON documents by dropping redundant values, without silently
destroying meaning. Zero dependencies.

<!-- hero -->

[![CI](https://github.com/Xwalims/json-slim/actions/workflows/ci.yml/badge.svg)](https://github.com/Xwalims/json-slim/actions/workflows/ci.yml)
![node 20+](https://img.shields.io/badge/node-20+-brightgreen)
![MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![dependencies](https://img.shields.io/badge/dependencies-none-2f6f4f)

## Contents

- [What it is](#what-it-is)
- [Why "removing 0 and false" needs a policy](#why-removing-0-and-false-needs-a-policy)
- [Install](#install)
- [Usage](#usage)
  - [Review before committing to it](#review-before-committing-to-it)
  - [Whitespace only](#whitespace-only)
  - [Protected keys](#protected-keys)
- [CLI flags](#cli-flags)
  - [Exit codes](#exit-codes)
- [Notes on two edge cases](#notes-on-two-edge-cases)
- [Running the tests](#running-the-tests)

<!-- /hero -->

## What it is

- **Nothing is dropped by surprise.** Only `null` is pruned by default. Every
  other value class is opt-in, because `{"retries": 0}` and `{}` mean different
  things to whatever reads the document.
- **Keys and array slots are treated differently.** A `null` object key and an
  absent key are interchangeable, so `null` is pruned by default. A `null`
  *array slot* is positional: `[1, null, 2]` and `[1, 2]` address different
  things, so removing it takes an explicit `--drop-array-elements`.
- **Every removal is explained.** `--explain` lists each dropped value with its
  RFC 6901 JSON Pointer and the reason. `--stats` reports the size delta.
- **Non-destructive.** The input document is never mutated; the walker builds
  fresh containers.
- **Reviewable before it is destructive.** `--dry-run` and `--check` let an
  aggressive run be inspected before anything is written.

## Why "removing 0 and false" needs a policy

It is tempting to write a JSON "cleaner" that strips `0`, `false`, `""`, `[]`
and `{}`. That tool is wrong, and wrong in a way that only shows up in
production:

| Input | Meaning |
| --- | --- |
| `{"retries": 0}` | zero retries so far; a real count |
| `{"retries": null}` | unknown; often equivalent to absent |
| `{"can_edit": false}` | a permission was denied |
| `{"tags": []}` | the tag list exists and is empty |
| `{}` | there is no such field |

Only the `null` case is safe to remove by default, and even that is a
judgement call rather than a universal truth. So `json-slim` makes the whole
decision surface explicit and inspectable:

```console
$ json-slim --explain-policy
Default value policy:

  value  default  rationale
  null   true     dropped by default: absence and explicit null are interchangeable in practice
  false  false    opt-in: false is a real answer for flags and permissions
  0      false    opt-in: zero is a real count, offset or state
  ""     false    opt-in: empty string may be a deliberate value
  []     false    opt-in: only drops containers that became empty
  {}     false    opt-in: only drops objects that became empty
  NaN    false    opt-in: NaN is not valid JSON and may be a data bug

Anything other than null is opt-in: an empty list, a zero count and a
missing key are three different things to whoever reads the document.
```

## Install

Not published to npm — that name belongs to an unrelated JSON minifier. Clone and
run it directly:

```console
$ git clone https://github.com/Xwalims/json-slim.git
$ cd json-slim
$ node bin/json-slim.js --help
```

Or link it onto your `PATH`:

```console
$ npm link          # provides the `json-slim` command
```

## Usage

Given `demo.json`:

```json
{
  "id": "usr_8814",
  "email": "a@b.io",
  "retries": 0,
  "cached": false,
  "display_name": "",
  "tags": [],
  "meta": {},
  "last_seen": null,
  "plan": "free",
  "is_active": 1,
  "settings": { "theme": null, "tz": "UTC", "beta": false }
}
```

The default run removes only `null` values and re-emits without whitespace:

```console
$ json-slim demo.json
{"id":"usr_8814","email":"a@b.io","retries":0,"cached":false,"display_name":"","tags":[],"meta":{},"plan":"free","is_active":1,"settings":{"tz":"UTC","beta":false}}
```

An aggressive run opts into the other value classes. Note what survives:
`id` because id-like keys are protected, and `is_active` because it is `1`, not
a boolean.

```console
$ json-slim demo.json --drop-false --drop-zero --drop-empty-string \
      --drop-empty-array --drop-empty-object
{"id":"usr_8814","email":"a@b.io","plan":"free","is_active":1,"settings":{"tz":"UTC"}}
```

### Review before committing to it

```console
$ json-slim demo.json --drop-false --drop-zero --dry-run --explain
5 value(s) removed:

  /retries  zero  0
  /cached  false  false
  /last_seen  null  null
  /settings/theme  null  null
  /settings/beta  false  false
```

```console
$ json-slim demo.json --drop-false --drop-zero --stats
before   247 B (247 B)
after    125 B (125 B)
removed  122 B (49.4%)
values   5 removed (null=2, zero/nan=1, other=2)
```

### Whitespace only

`--minify-only` never touches a value. It is safe by construction:

```console
$ json-slim --minify-only data.json
```

### Protected keys

Id-like and flag-like keys survive every rule unless you turn that off:

```console
$ echo '{"id":null,"is_admin":false,"retries":0}' | json-slim --drop-false --drop-zero
{"id":null,"is_admin":false}
```

Add your own:

```console
$ json-slim config.json --drop-zero --keep-keys retries,timeout
$ json-slim config.json --drop-null --keep-key-pattern '^user_'
```

## CLI flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--drop-null` | on | Drop `null` values on object keys |
| `--drop-false` | off | Drop `false` booleans |
| `--drop-zero` | off | Drop `0` and `-0` |
| `--drop-empty-string` | off | Drop `""` |
| `--drop-empty-array` | off | Drop arrays that became empty |
| `--drop-empty-object` | off | Drop objects that became empty |
| `--drop-nan` | off | Drop `NaN` |
| `--drop-array-elements` | off | Remove droppable array slots; **renumbers** |
| `--compact-arrays` | off | After dropping elements, remove the holes left behind |
| `--keep-id-like` | on | Protect `id`, `uuid`, `version`, `etag`, … |
| `--keep-flags` | on | Protect `is_*`, `has_*`, `can_*` |
| `--keep-keys a,b` | none | Extra key names to protect |
| `--keep-key-pattern RE` | none | Protect keys matching a pattern |
| `--key-filter RE` | none | Only prune keys matching a pattern |
| `--pretty` | off | Indent the output |
| `--indent N` | `2` | Indent width for `--pretty` |
| `--sort-keys` | off | Emit keys in sorted order |
| `--out FILE` | stdout | Write the result to a file |
| `--stdin` | off | Read the document from standard input |
| `--stats` | off | Size report on stderr |
| `--explain` | off | List removed values on stderr |
| `--dry-run` | off | Write nothing, report only |
| `--check` | off | Exit 3 if anything would be removed |
| `--fail-on-change` | off | Exit 1 if anything was removed |
| `--explain-policy` | — | Print the active policy and exit |
| `--minify-only` | off | Whitespace removal only |
| `-h, --help` | — | Print usage |
| `--version` | — | Print the version |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | `--fail-on-change` and the document was modified |
| 2 | Usage error, unreadable file, or invalid JSON |
| 3 | `--check` and something would be removed |

`--check` is meant for CI: it fails the build when a payload has picked up
fields the pipeline does not expect, without rewriting anything.

## Library API

```js
const { slim, stringify, minify } = require('json-slim');

// Prune and inspect.
const result = slim(document, { dropZero: true, dropEmptyObject: true });

result.value;      // the new document
result.removals;   // [{ path: '/a/b', reason: 'zero', value: 0 }, ...]
result.stats;      // { total, nulls, falsy, emptyContainers, ... }

console.log(stringify(result.value, { format: 'pretty' }));
```

`slim` never mutates its input and never touches the document root: a scalar
document cannot be pruned away, and a single-key object that loses that key
becomes `{}`, not `null`.

### Custom policy

```js
const { createValuePolicy } = require('json-slim');

const policy = createValuePolicy({
  dropZero: true,
  keepKeys: ['retries', 'timeout'],
  keepKeyPattern: '^internal_',
});

policy.shouldDrop(0, 'retries', {});   // false, protected
policy.shouldDrop(0, 'count', {});     // true, droppable
```

Policies are frozen. A shared policy object cannot be mutated by accident from
two call sites.

## Notes on two edge cases

**Containers are judged after pruning.** A container that started non-empty but
became empty is a *result* of pruning, and `--drop-empty-object` removes it:

```console
$ echo '{"a":{"b":null}}' | json-slim --drop-empty-object
{}
```

**`--drop-array-elements` renumbers.** `[1, null, 2]` becomes `[1, 2]`, and the
index of `2` changes from 2 to 1. Use it only where the array is a set of
values rather than an indexed structure:

```console
$ echo '{"i":[1,null,2]}' | json-slim --drop-array-elements
{"i":[1,2]}
```

## Running the tests

```console
$ node --test
ℹ tests 105
ℹ pass 105
ℹ fail 0
```

`node:test` and `node:assert` only — no test framework dependency.

## License

MIT. See `LICENSE`.
