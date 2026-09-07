# S1 validation

Validated locally against Dash's Track after the first-class Python core and S1 materialization bridge were assembled.

## Python core

```text
3 passed in 0.04s
```

Focused command:

```sh
PYTHONPATH=packages/quick_anno_py python -m pytest -q \
  packages/quick_anno_py/tests/test_first_class.py
```

## Real S1 materialization

Command:

```sh
python experiments/quick-anno-python/s1.py \
  ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg
```

Observed Python PQL result:

```json
{
  "badges": 18,
  "ownedPx": 37002,
  "mutedPx": 45813,
  "addedMutePx": 8811
}
```

The same run emitted the real Stage correctness panels:

```text
s0-fullimage.png
s0-croppedimage.png
s1-croppedimage.png
s1-masks.png
s1-badgepx-subtraction.png
s1-badge-mute-subtraction.png
s1-badge-objects.png
```

The materialized snapshot also reported:

```text
canonical: 1290x2083
badges: 18
bright components: 144
dark components: 708
family: 18
owned px: 37002
muted px: 45813
added mute px: 8811
remaining opaque px: 2641257
```

This establishes the bounded transfer pattern: production Stage -> snapshot/PxC material -> first-class Python PxC -> Python Calculation/PCR -> published scratch Part -> PQL query -> deterministic correctness render and Mermaid view.
