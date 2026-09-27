# Golden fixture

Normative schedule fixture for [SPECIFICATION.md](../../SPECIFICATION.md) §19.

| File | Role |
| :--- | :--- |
| `definition.yml` | Version-2 song definition |
| `expected-t0.json` | Expected pulses at `t = 0` for seed `12345` |

```text
node scripts/check-golden.mjs
```

Use `--write` only when intentionally regenerating `expected-t0.json` after a deliberate fixture change.

Audio files are not required for this schedule check: both players expose a pure engine/`Trace` path over the parsed definition.
