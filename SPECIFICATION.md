# Procsong Player Conformance Specification

**Version:** 2.0.0  
**Status:** Major-version matrix specification

This document is the normative definition of sequencing for a version 2 procsong. Given the same package and 64-bit seed, compliant players **MUST** produce the same schedule of start time, track, chosen clip, and mute flag.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

---

## 1. Core concept: two different matrices

A song contains tracks, and each track is a **group of clips**.

Version 2 has exactly two modifier matrices:

```yaml
intragroup_subsequent_weight_modifiers: ...
intergroup_consecutive_weight_modifiers: ...
```

They are **not synonyms** and they do **not** inspect the same state.

### 1.1 `intragroup_subsequent_weight_modifiers`

This controls **what tends to follow what inside one group**.

Question:

> Given the clip that this same group selected on its previous evaluation, how should the possible next clips in this group be weighted?

Matrix orientation:

```text
row    = previous/source clip in this group
column = possible NEXT candidate clip in this group
cell   = multiplier for that candidate
```

For the screenshot-style example:

```text
             next
          clp_1  clp_2
prev clp_1   1     0.5
     clp_2   1     0.5
```

means `clp_1` is twice as likely as `clp_2` to follow either previous clip, assuming all other weight factors are equal.

### 1.2 `intergroup_consecutive_weight_modifiers`

This controls **how another group's current queued/retained selection changes this group's candidate weights**.

Question:

> Given the clips currently selected by earlier groups, how should the candidates in this downstream group be weighted now?

Matrix orientation:

```text
row    = downstream candidate clip being considered
column = CURRENT selected clip in another/upstream group
cell   = multiplier for the downstream candidate
```

For example:

```text
                    upstream current selection
                    clp_1  clp_2
candidate clp_3       1      1
candidate clp_4       0      1
```

means `clp_4` cannot be chosen while the upstream group currently holds `clp_1`, but can be chosen normally while it holds `clp_2`. Column headers are clip `id`s, not audio paths.

### 1.3 The distinction is normative

The two matrices **MUST NOT** be collapsed into a generic transition property.

```text
INTRA-GROUP SUBSEQUENT
this group's PREVIOUS selection
            ↓
weights this group's NEXT candidates

INTER-GROUP CONSECUTIVE
other groups' CURRENT selections
            ↓
weight this group's CURRENT candidates
```

The fact that both use numeric multipliers does not make them the same operation.

---

## 2. Why the YAML is represented as matrix headers + row arrays

Expanding every matrix cell into nested YAML mappings makes a real song difficult to read. Version 2 therefore represents each matrix like a compact CSV table:

```yaml
intragroup_subsequent_weight_modifiers:
  columns: [clp_1, clp_2]
  rows:
    clp_1: [1, 0.5]
    clp_2: [1, 0.5]
```

The column header is written once; every matrix row is a single line.

The corresponding inter-group matrix is:

```yaml
intergroup_consecutive_weight_modifiers:
  columns: [clp_1, clp_2]
  rows:
    clp_3: [1, 1]
    clp_4: [0, 1]
```

`columns` and row keys are clip `id`s. They **MUST NOT** be `path` values, filenames, or `TrackName/clip_id` strings.

This is intentionally close to the spreadsheet representation and is the canonical version-2 YAML form.

---

## 3. Package

A package **MUST** contain:

- `definition.yml` matching `schema.yaml`;
- audio files referenced by the clip `path` fields.

The root YAML is:

```yaml
format_version: 2.0.0
tracks: ...
```

`path` is the normative chosen-clip string emitted by the scheduler. File lookup may ignore case or a single extension. Matrix `columns` and row keys use clip `id`s only; they **MUST NOT** use `path` values or filenames.

---

## 4. Track/group structure

Each item in `tracks` is both an audio track and one clip group:

```yaml
- name: trk_1
  clip_length: 20
  repeats: 3
  silence_probability: 0.2
  clips:
    - {id: clp_1, path: "trk_1/clp_1.wav", weight: 1}
    - {id: clp_2, path: "trk_1/clp_2.wav", weight: 1}
```

Fields:

| Field | Required | Meaning |
| :--- | :---: | :--- |
| `name` | yes | Unique track/group name. |
| `clip_length` | yes | Start-to-start interval in seconds; not the WAV duration. |
| `repeats` | yes | Number of starts retaining one evaluated choice before this track reevaluates. |
| `silence_probability` | no | Probability that the evaluated choice is silent. Default `0`. |
| `clips` | yes | Candidate clips in deterministic declaration order. |
| `intragroup_subsequent_weight_modifiers` | no | Same-group previous-to-next matrix. |
| `intergroup_consecutive_weight_modifiers` | no | Cross-group current-context matrix. |

Tracks **MUST** have unique names. The top-to-bottom `tracks` order is significant.

---

## 5. Clip structure and base weight

Each clip is normally written compactly on one line:

```yaml
- {id: d1, path: "Drums/Drums 1", weight: 0.8}
```

Fields:

| Field | Required | Meaning |
| :--- | :---: | :--- |
| `id` | yes | Identifier unique across the whole definition. Used as matrix column headers and row keys. |
| `path` | yes | Audio package path/string; becomes `ChosenClip`. Never used as a matrix axis. |
| `weight` | no | Base selection weight. Default `1`. |

Clip IDs **MUST** be unique across the whole definition. `weight` and all matrix values **MUST** be non-negative.

Clip declaration order is the deterministic weighted-selection walk order.

---

## 6. Intra-group subsequent matrix

Shape:

```yaml
intragroup_subsequent_weight_modifiers:
  columns: [candidate_1, candidate_2, ...]
  rows:
    previous_1: [modifier, modifier, ...]
    previous_2: [modifier, modifier, ...]
```

For group `G`, previous selected clip `P`, and candidate `C`:

```text
columnIndex = index_of(C.id, G.intragroup_subsequent_weight_modifiers.columns)
IntraModifier(C) = G.intragroup_subsequent_weight_modifiers.rows[P.id][columnIndex]
```

`columns` and row keys are clip `id`s of this group, never `path` values.

### 6.1 Column and row rules

If the matrix is present:

1. `columns` **MUST** list every clip ID in this group exactly once.
2. `columns` **MUST** use the same order as `clips`.
3. `rows` **MUST** contain exactly one row for every clip ID in this group.
4. Each row array length **MUST** equal `columns.length`.
5. Row keys are previous/source clips; column entries are possible next clips.

This makes the matrix complete and square.

### 6.2 First evaluation

At `t = 0`, the group has no previous selected clip. The intra-group multiplier is therefore neutral:

```text
IntraModifier(C) = 1
```

for every candidate.

### 6.3 Omission

If `intragroup_subsequent_weight_modifiers` is omitted, every same-group transition has modifier `1`.

### 6.4 Examples

Self-preference:

```yaml
intragroup_subsequent_weight_modifiers:
  columns: [clp_1, clp_2]
  rows:
    clp_1: [1, 0.5]
    clp_2: [0.5, 1]
```

Forced alternation:

```yaml
intragroup_subsequent_weight_modifiers:
  columns: [clp_1, clp_2]
  rows:
    clp_1: [0, 1]
    clp_2: [1, 0]
```

---

## 7. Inter-group consecutive matrix

Shape:

```yaml
intergroup_consecutive_weight_modifiers:
  columns: [a1, a2, b1, b2]
  rows:
    downstream_candidate_1: [1, 0, 1, 1]
    downstream_candidate_2: [0, 1, 1, 0]
```

Each column is a clip `id` from another/upstream group — the possible **current** selection in that group.

Each row belongs to one candidate clip in the downstream group, keyed by that candidate's `id`.

### 7.1 Column groups

A downstream track may reference only tracks declared **earlier** in the top-level `tracks` list. Column entries are those earlier tracks' clip `id`s.

If an upstream track is represented in `columns`, then:

1. **all** clip IDs from that upstream track **MUST** appear exactly once;
2. they **MUST** appear in that upstream track's clip declaration order;
3. represented upstream tracks **MUST** appear in top-level track declaration order.

An earlier track that has no influence may simply be absent from the columns; that entire upstream track is then neutral `1`.

### 7.2 Row rules

If the matrix is present:

1. `rows` **MUST** contain exactly one row for every clip in the downstream group;
2. row keys are downstream candidate clip IDs;
3. each row array length **MUST** equal `columns.length`.

This keeps the representation rectangular like the CSV matrix.

### 7.3 What `current` means

For inter-group weighting, a column reads the upstream track's **current retained `ChosenClipId` at the moment the downstream track evaluates**.

It is **not** the upstream track's previous-to-current transition. That is an intra-group concept belonging to the upstream track itself.

At a timestamp where several tracks are due, tracks evaluate in YAML declaration order. Therefore an earlier track can select a new clip and a later track at the same timestamp immediately sees that newly queued selection.

If the upstream track is not reevaluating at that timestamp, its existing retained `ChosenClipId` remains the current selection.

Mute does not clear the current selection. A muted upstream clip still contributes its matrix modifier.

### 7.4 Combining several upstream tracks

Suppose:

```yaml
intergroup_consecutive_weight_modifiers:
  columns: [c1, c2, d1, d2]
  rows:
    b1: [1, 0, 1, 0]
    b2: [0, 1, 1, 0]
```

If `Chords` currently holds `c1` and `Drums` currently holds `d1`, then:

```text
InterModifier(b1) = 1 × 1 = 1
InterModifier(b2) = 0 × 1 = 0
```

Only the cell corresponding to the **one current clip in each represented upstream track** contributes. Cells for the upstream track's other non-current clips do not contribute.

---

## 8. Effective weight

For candidate clip `C` in track `T`:

```text
EffectiveWeight(C)
  = BaseWeight(C)
  × IntraModifier(C)
  × product(CurrentIntergroupModifier(C, U)
            for every upstream track U represented in T's inter-group columns)
```

Interpretation:

- `0` = impossible in this context;
- `1` = neutral;
- `0.5` = half the relative weight;
- `2` = double the relative weight.

Example:

```text
base weight                       2
same-group previous→candidate     0.5
current Chords modifier           1
current Drums modifier            0.25
-------------------------------------
effective weight                  0.25
```

---

## 9. Weighted selection and silence

Each evaluation consumes exactly two floats from the shared PRNG:

```text
R_part
R_silence
```

The draws occur even if all effective weights are zero.

Calculate `EffectiveWeight` for every clip in declaration order and:

```text
W = sum(EffectiveWeight)
```

If `W == 0`:

```text
ChosenClipId = none
ChosenClip = none
Muted = true
```

Otherwise:

```text
target = R_part × W
```

Walk clips in declaration order and choose the first clip whose cumulative effective weight is strictly greater than `target`.

Then:

```text
Muted = R_silence < silence_probability
```

The comparison is strict `<`.

Mute changes audio only. It **MUST NOT** clear `ChosenClipId` or `ChosenClip` because downstream inter-group matrices must continue to see the selection.

---

## 10. Normative matrix lookup

For clarity, the two operations are shown separately.

### 10.1 Intra-group lookup

```text
GetIntraModifier(T, candidate C):
  if T.ChosenClipId is none:
    return 1

  if T.intragroup_subsequent_weight_modifiers is absent:
    return 1

  M = T.intragroup_subsequent_weight_modifiers
  col = index_of(C.id, M.columns)
  return M.rows[T.ChosenClipId][col]
```

`T.ChosenClipId` here is still the group's **previous selected clip**, because the new candidate has not yet been chosen.

### 10.2 Inter-group lookup

```text
GetInterModifier(T, candidate C):
  if T.intergroup_consecutive_weight_modifiers is absent:
    return 1

  M = T.intergroup_consecutive_weight_modifiers
  row = M.rows[C.id]
  result = 1

  for each represented upstream track U:
    if U.ChosenClipId is none:
      continue

    col = index_of(U.ChosenClipId, M.columns)
    result *= row[col]

  return result
```

The current clip of each represented upstream group selects **one column from that upstream group's column block**.

---

## 11. Evaluation algorithm

```text
Evaluate(T):
  R_part = RNG.next_float()
  R_silence = RNG.next_float()

  weighted = []
  total = 0

  for C in T.clips in declaration order:
    base  = C.weight if present else 1
    intra = GetIntraModifier(T, C)
    inter = GetInterModifier(T, C)

    w = base × intra × inter
    weighted.append((C, w))
    total += w

  if total == 0:
    T.ChosenClipId = none
    T.ChosenClip = none
    T.Muted = true
    return

  target = R_part × total
  running = 0

  for (C, w) in weighted:
    running += w
    if running > target:
      T.ChosenClipId = C.id
      T.ChosenClip = C.path
      break

  T.Muted = (R_silence < T.silence_probability)
```

A player's implementation may optimize matrix lookup, but the numerical result and evaluation order **MUST** be equivalent.

---

## 12. Time and scheduler

Sequencing uses integer seconds and independent track clocks. There is no global BPM/bar synchronization requirement.

Convert `clip_length` with:

```text
AtLeastOne(n):
  if n is not finite: return 1
  value = floor(n + 0.5)
  if value > 0: return value
  return 1
```

Call the result `LoopSeconds`.

Per track state:

| Field | Initial | Meaning |
| :--- | :--- | :--- |
| `ChosenClipId` | none | Current matrix clip ID |
| `ChosenClip` | none | Current path/string |
| `Muted` | true | Current mute state |
| `NextStart` | 0 | Next due integer second |
| `Remaining` | 0 | Starts left in current evaluated cycle |

Master scheduler:

```text
loop forever:
  t = minimum NextStart over all tracks

  for T in top-to-bottom YAML track order:
    if T.NextStart == t:
      Pulse(T, t)
```

Pulse:

```text
Pulse(T, t):
  if T.Remaining <= 0:
    Evaluate(T)
    T.Remaining = T.repeats

  T.Remaining -= 1
  T.NextStart = t + T.LoopSeconds

  emit:
    t
    T.name
    T.ChosenClip
    T.Muted
```

`repeats` therefore counts starts, including the start on the evaluation pulse. Retriggers do not consume PRNG draws.

Example: `clip_length = 15`, `repeats = 4` produces starts at `0,15,30,45,60...` and evaluations at `0,60,120...`.

---

## 13. Same-time track ordering

Version 2 removes the old track-role categories. Track declaration order now directly defines dependency/evaluation order.

At one shared second:

```text
track 1 evaluates / retains selection
        ↓
track 2 evaluates and may see track 1
        ↓
track 3 evaluates and may see tracks 1 and 2
```

This is why inter-group columns may only reference earlier tracks.

---

## 14. PRNG

Players **MUST NOT** use language-native random functions.

Use one shared unsigned 64-bit LCG:

```text
A = 6364136223846793005
C = 1442695040888963407
modulus = 2^64

state = (state * A + C) mod 2^64
next_float = uint32(state >> 32) / 4294967296.0
```

Initial state:

```text
seed & 0xFFFFFFFFFFFFFFFF
```

Only evaluations consume draws, exactly two per evaluation, in scheduler order.

---

## 15. Audio playback

A start event sounds only when `ChosenClip` is set and `Muted` is false.

Players **MUST** start the entire referenced audio file at the scheduled time, allow tails to overlap subsequent starts, and **MUST NOT** crop a clip to `LoopSeconds`.

Audio resampling, mixing, and short click-prevention fades may differ between players, but schedule fields may not.

---

## 16. Exact CSV ↔ YAML correspondence

### 16.1 Intra-group matrix

CSV:

| previous \\ next | clp_1 | clp_2 |
| :--- | ---: | ---: |
| clp_1 | 1 | 0.5 |
| clp_2 | 1 | 0.5 |

YAML:

```yaml
intragroup_subsequent_weight_modifiers:
  columns: [clp_1, clp_2]
  rows:
    clp_1: [1, 0.5]
    clp_2: [1, 0.5]
```

Mapping:

```text
CSV cell(row=P, column=C)
= rows[P][index_of(C, columns)]
```

### 16.2 Inter-group matrix

CSV:

| downstream candidate | clp_1 | clp_2 | clp_3 | clp_4 |
| :--- | ---: | ---: | ---: | ---: |
| clp_5 | 1 | 1 | 1 | 0 |
| clp_6 | 1 | 1 | 0 | 1 |

YAML:

```yaml
intergroup_consecutive_weight_modifiers:
  columns: [clp_1, clp_2, clp_3, clp_4]
  rows:
    clp_5: [1, 1, 1, 0]
    clp_6: [1, 1, 0, 1]
```

`clp_1`/`clp_2` belong to `trk_1`; `clp_3`/`clp_4` belong to `trk_2`. The YAML lists only the clip `id`s.

Mapping:

```text
CSV cell(row=C, column=P)
= rows[C][index_of(P, columns)]
```

where `C` and `P` are clip `id`s.

This is the recommended authoring representation because the YAML visually remains a matrix rather than becoming a deeply nested object tree.

---

## 17. Structural and semantic validation

`schema.yaml` validates the basic YAML structure. A compliant validator/player **MUST** additionally check cross-reference rules that JSON Schema draft 7 cannot fully express:

1. track names are unique;
2. clip IDs are unique across the whole definition;
3. intra `columns` exactly equal that track's clip IDs in clip declaration order;
4. intra `rows` contain exactly those same clip IDs;
5. every intra row length equals intra column count;
6. inter row keys exactly equal the downstream track's clip IDs;
7. every inter row length equals inter column count;
8. every inter column is a clip `id` that resolves to a clip on an earlier track;
9. no inter column references a clip on the same track or a later track;
10. if an upstream track appears in inter columns, every clip from it appears exactly once, in clip declaration order;
11. represented upstream tracks appear in top-level track declaration order.

Invalid matrices **MUST** be rejected rather than padded, truncated, reordered, or silently defaulted.

---

## 18. Migration from version 1

Version 1's role/allow-list dependency model is replaced by track declaration order plus `intergroup_consecutive_weight_modifiers`.

A former allow-list becomes a `0/1` inter-group matrix:

```text
1 = allowed upstream/current combination
0 = disallowed upstream/current combination
```

For example, if `b1` was permitted only with `o1` or `o2`:

```yaml
intergroup_consecutive_weight_modifiers:
  columns: [o1, o2, o3, o4]
  rows:
    b1: [1, 1, 0, 0]
    ...
```

The supplied version-1 song did not define same-group transition preferences, so its faithful migration omits `intragroup_subsequent_weight_modifiers`; omission means all intra-group modifiers are neutral `1`.

---

## 19. Golden test for the migrated supplied song

Using the rewritten `definition.yml` and seed `12345`, the `t = 0` evaluations **MUST** yield:

| Order | Track | ChosenClip | Muted |
| :--- | :--- | :--- | :--- |
| 1 | Drums | `Drums/Drums 1` | no |
| 2 | Organ | `Organ/Organ 4` | no |
| 3 | Bass | `Bass/Bass 2` | no |
| 4 | Lead | `Lead/Mellotron 4` | no |
| 5 | Percussion | `Percussion/Percussion 2` | yes |

This confirms that converting the supplied binary allow-lists into `0/1` inter-group matrices preserves the initial deterministic behaviour.

---

## 20. Implementer checklist

A version 2 implementation is compliant if it:

1. accepts `format_version: 2.0.0`;
2. treats each track as one clip group;
3. processes tracks in YAML declaration order;
4. preserves clip declaration order;
5. uses `intragroup_subsequent_weight_modifiers` only for this group's previous-selection → next-candidate weighting;
6. uses `intergroup_consecutive_weight_modifiers` only for other groups' current-selection → downstream-candidate weighting;
7. interprets `columns` and one-line `rows` exactly as the matrix headers and cells defined above;
8. multiplies base, intra, and current inter-group factors;
9. uses one shared LCG with exactly two draws per evaluation;
10. leaves muted selections visible as current selections to downstream groups;
11. keeps independent track clocks and consumes no random draws on retriggers;
12. rejects invalid matrix dimensions/references;
13. matches the golden test in section 19.
