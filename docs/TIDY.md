# Tidy

Tidy is deliberately small: a guard around Stage lineage in a shared working tree.

It does not decide what belongs in a Stage, freeze files, promote LAB objects, or own `clean/` contents.

## Surface

```sh
./tidy check
./tidy up -v TYPE:TARGET_VERSION [--parent_dir DIR] [--allow-test-failure]
```

`check` prints every check and its result.

`up` treats `-v` as an accidental-invocation guard over the intended destination. The caller states the exact target version; Tidy independently reads the current version from `.tidy/manifest.json` and accepts only one legal successor:

```text
patch  1.3.7 -> 1.3.8
minor  1.3.7 -> 1.4.0
major  1.3.7 -> 2.0.0
```

These refuse:

```text
1.3.7 -> 1.3.9
1.3.7 -> 1.4.1
1.3.7 -> 1.5.0
1.3.7 -> 2.1.0
```

Lower-order components must reset to zero for minor and major bumps.

## Stage `clean/` custody

Tidy has a default parent directory for Stages. `--parent_dir DIR` overrides it.

For type `TYPE`, `tidy up` requires this directory to already exist:

```text
<PARENT_DIR>/<TYPE>/clean
```

If it does not exist, Tidy refuses the bump.

Tidy does not decide what belongs inside `clean/`; it only requires that the Stage's clean boundary exists before advancing that Stage lineage.

This allows Stage-local custody such as:

```text
s0/
  clean/
s1/
  clean/
```

without turning Tidy into a freezer or promotion system.

## Relevant tests

Each registered Stage type owns a list of test commands in `.tidy/manifest.json`:

```json
{
  "schemaVersion": 1,
  "types": {
    "s0": {
      "version": "1.3.7",
      "tests": [
        "npm run test:s0"
      ]
    }
  }
}
```

Before advancing `s0`, Tidy runs the tests registered for `s0`.

Any failing relevant test refuses the bump by default.

A patch bump may explicitly bypass test failure with:

```sh
./tidy up -v s0:1.3.8 --allow-test-failure
```

The escape flag itself is refused for minor or major bumps.

## Commit backstop

The repository carries `.githooks/pre-commit` as a deliberately dumb accidental-mistake guard. It runs only:

```sh
./tidy check
```

and refuses the commit if Tidy is structurally unhealthy.

Enable the repository-carried hooks for a checkout with:

```sh
git config core.hooksPath .githooks
```

The hook does not inspect staged files, infer ownership, coordinate agents, or call `tidy up`.

## Manifest

The manifest may begin with no registered Stage types:

```json
{
  "schemaVersion": 1,
  "types": {}
}
```

Types are added deliberately when their Stage lineage exists. Tidy does not invent missing types.

## Non-goals

Tidy does not populate `clean/`, decide when something deserves freezing, promote Scripts or other LAB objects, infer versions from Stage names, silently repair the manifest, coordinate concurrent writers, or replace Git.
