# Stage lanes

Every PxC Stage has three intentionally distinct development lanes:

- `clean/` — trusted, promoted baseline. tidy owns its checkpoint hash and semver.
- `work/` — intentional next implementation. Freely editable; expected to land after receipts/assertions pass.
- `exp/<meaningful-name>/` — exploratory alternatives. Observational by default; names describe the question/idea.

Transitions are semantic:

```text
exp/<idea>  --adopt-->  work/  --promote-->  clean/
```

`clean/` is never the scratch lane. A clean hash mismatch is a tidy failure, not a development state.

crisp may compile any lane through the same Stage → Tick → Calculation protocol and can DeltaBuild `work/` or `exp/*` against the promoted `clean/` baseline.

neat registers Calculation work with its lineage. Folder names communicate intent; lineage preserves provenance.
