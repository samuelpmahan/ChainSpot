# Tidy

Tidy is deliberately small. It is a linter/guard around a version manifest, not a destination for cleaned files and not a promotion system.

## Surface

```sh
./tidy check
./tidy up -v TYPE:CURRENT_VERSION
```

`check` prints every check it performs and that check's result. A failing check makes the command fail.

`up` is guarded. `-v` does **not** tell Tidy what version to create. The caller supplies the version they believe is currently recorded for `TYPE`; Tidy independently reads `.tidy/manifest.json` and refuses to act if the supplied version does not exactly match. This is an accidental-invocation check.

If the guard matches and the manifest is valid, Tidy increments the patch component itself (`1.2.3 -> 1.2.4`) and writes the manifest atomically.

`S0`, `v1`, integers, and other non-`x.y.z` values are not valid versions.

## Manifest

`.tidy/manifest.json` is intentionally boring:

```json
{
  "schemaVersion": 1,
  "types": {
    "TIDY": "0.0.0"
  }
}
```

Types are explicit manifest entries. Tidy does not invent a missing type during `up`; add the type deliberately to the manifest first.

## Non-goals

Tidy does not move files into a `clean/` directory, decide what should be frozen, promote Scripts or other LAB objects, infer semantic versions from Stage names, or silently repair the manifest. Those are separate concerns.
