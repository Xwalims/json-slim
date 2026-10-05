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
- [Keys named `__proto__`](#keys-named-__proto__)
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
  []     false    opt-in: drops every empty array, whether it was already empty or became empty here
  {}     false    opt-in: drops every empty object, whether it was already empty or became empty here
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
| `--drop-empty-array` | off | Drop every empty array, already-empty ones included |
| `--drop-empty-object` | off | Drop every empty object, already-empty ones included |
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
| 2 | Usage error, unreadable file, invalid JSON, or an unwritable `--out` |
| 3 | `--check` and something would be removed |

Code 2 is the single bucket for "the tool could not do what you asked, and
nothing was written" — an unreadable input, an unknown flag, invalid JSON, or a
`--out` target that cannot be created. A stack trace is never the answer, and
code 1 always means the one thing the table says it means.

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

**…and one that was already empty is removed too.** This is the part worth
reading before you turn the flag on: `--drop-empty-object` and
`--drop-empty-array` drop *every* empty container, not only the ones pruning
emptied. `{"b": {}}` loses `b`, even though nothing was pruned:

```console
$ echo '{"b":{}}' | json-slim --drop-empty-object
{}
```

So an explicitly declared empty container is indistinguishable from an
accidentally emptied one, and this tool does not try to tell them apart. If your
documents use `{}` and `[]` as meaningful values, leave these flags off — that is
the default. `--keep-id-like` does still apply, so a protected name survives even
when its value is an empty container (`{"id": {}}` is kept), but it protects by
key *name* only and cannot rescue a key like `filters: {}`. Use `--keep-keys` for
those.

Array slots are never treated this way in either case: `[{}, {}]` survives
`--drop-empty-object --drop-empty-array`, because removing one would renumber
the array.

**`--drop-array-elements` renumbers.** `[1, null, 2]` becomes `[1, 2]`, and the
index of `2` changes from 2 to 1. Use it only where the array is a set of
values rather than an indexed structure:

```console
$ echo '{"i":[1,null,2]}' | json-slim --drop-array-elements
{"i":[1,2]}
```

**A gap the input already had is not the same as a removed element.** Removing an
element closes its slot up in both modes — that is the renumbering above. A gap
the document arrived with is a different thing, and by default it stays a gap:

```js
const a = [1, , 3];        // index 1 is a hole
slim({ a }).value.a;       // keys ['0','2'] — still a hole at index 1
slim({ a }, { compactArrays: true }).value.a;   // keys ['0','1'] — closed
```

The reason is that reading index 1 of a holey array yields `undefined`, so the
obvious `push`-based rebuild silently *densified* it: `[1, , 3]` came back as
`[1, 3]`, claiming index 1 held `3` when the document said index 2 did. Nothing
was dropped, no removal was reported, and positional information disappeared —
the one thing this tool promises not to do. The output text is
`{"a":[1,null,3]}`, because `JSON.stringify` renders a hole as `null` like every
other JSON implementation; the difference lives in the value, where `1 in a` is
`false`.

`--compact-arrays` is therefore the explicit request to close those gaps. It
never reorders and never changes *what* is removed.

## Keys named `__proto__`

A document may legitimately contain a key called `__proto__`, and `json-slim`
keeps it — through the walker, through `--sort-keys`, and in every output shape:

```console
$ echo '{"__proto__":{"polluted":true},"a":1}' | json-slim
{"__proto__":{"polluted":true},"a":1}
```

This is worth spelling out because the naive implementation loses the key with no
error at all. `__proto__` is not a property of the prototype; it is an **accessor**
defined on `Object.prototype`, so `out[k] = v` for that one name runs a setter
that replaces the object's prototype instead of creating a key:

```js
const o = {};
o.__proto__ = { polluted: true };
Object.keys(o);       // []  — the key is gone
JSON.stringify(o);    // {}
```

So a document containing `{"__proto__":{...},"a":1}` used to be slimmed into
`{"a":1}` *with the payload installed as the prototype of the result object* —
data silently deleted and every rebuilt container polluted, which is the
prototype-pollution footgun in a tool whose whole pitch is not destroying
meaning. `JSON.parse` creates a real own data property for exactly the same
bytes, and that is what `slim()` now produces: the key is written with
`Object.defineProperty`, the same approach `envjson` uses.

`constructor`, `toString`, `valueOf`, `hasOwnProperty` and `prototype` need no
special handling and get none: those are ordinary data properties on
`Object.prototype`, so plain assignment shadows them exactly as `JSON.parse`
does. Escaping them too would be a bug, not caution.

Consumers reading the output should do the same: `value.__proto__` is the
document's key, not the prototype.

## Running the tests

```console
$ node --test
ℹ tests 131
ℹ pass 131
ℹ fail 0
```

`node:test` and `node:assert` only — no test framework dependency.

## License

MIT. See `LICENSE`.
