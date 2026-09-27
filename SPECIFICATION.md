# Procsong Player Conformance Specification

**Version:** 2.0.0  
**Status:** Major-version matrix specification

This document is the normative definition of sequencing for a version 2 procsong. Given the same package and 64-bit seed, compliant players **MUST** produce the same schedule of start time, track, chosen clip, mute flag, play seconds, and crop flag.

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

A package is a zip archive. After discarding ignored entries (below), it **MUST** contain:

- exactly one `definition.yml` matching `schema.yaml` and §17;
- exactly one resolvable audio file for every clip `path` (see §3.2).

Ignored zip entries (not counted toward the rules above):

- any path containing a `__MACOSX` segment (case-insensitive);
- any leaf name that is `.DS_Store` or begins with `._`.

### 3.1 Exactly one definition

Among remaining entries, an entry is a definition candidate when its leaf name equals `definition.yml` under Unicode case-folding (case-insensitive ASCII is sufficient).

- Zero candidates → reject the package.
- Two or more candidates → reject the package.
- Exactly one candidate → that file is the definition.

Players **MUST NOT** pick “shallowest” or otherwise break ties: multiplicity is an error.

The definition root **MUST** be:

```yaml
format_version: 2.0.0
tracks: ...
```

Only the keys `format_version` and `tracks` are permitted on the root. Unknown keys **MUST** be rejected.

### 3.2 Audio path resolution (`ClipKey`)

`path` is the normative `ChosenClip` string emitted by the scheduler. It is taken exactly from the YAML scalar (no case change, no extension stripping on the emitted schedule).

File lookup uses a derived key:

```text
ClipKey(path):
  s = path with every "\" replaced by "/"
  if s contains a "." in the final path segment:
    s = s without the final "." and everything after it
  return ASCII-lowercase(s)
```

Rules:

1. Every non-ignored zip entry other than the definition is keyed by `ClipKey(relativePathFromDefinitionDirectory)`.
2. If two entries produce the same `ClipKey`, the package **MUST** be rejected.
3. For each clip `path` in the definition, `ClipKey(path)` **MUST** match exactly one keyed entry. Missing or undecodable audio **MUST** reject package load. Players **MUST NOT** advance a schedule while silently omitting missing clips.
4. Matrix `columns` and row keys use clip `id`s only; they **MUST NOT** use `path` values or filenames.

### 3.3 Definition YAML dialect

`definition.yml` **MUST** be UTF-8 (optional leading BOM, which parsers strip). It **MUST** use only this YAML subset:

| Allowed | Forbidden |
| :--- | :--- |
| One document (no `---`-separated multi-doc streams) | Anchors, aliases, tags (`!!`), merge keys (`<<`) |
| Block and flow mappings / sequences | Custom types, binary nodes, timestamps-as-dates |
| Scalars that become JSON-compatible types after load | Duplicate keys in any mapping |

After load, every value **MUST** be one of: mapping, sequence, string, finite number, boolean, or null. Duplicate mapping keys **MUST** be rejected (not overwritten).

Scalar typing for fields is normative:

| Field kind | Required JSON type after load |
| :--- | :--- |
| `format_version`, track `name`, clip `id`, clip `path`, matrix column entries, matrix row keys | string |
| `clip_length`, `repeats`, `silence_probability`, `weight`, matrix cell values | finite number (not bool, not null unless optional-and-omitted) |
| `tracks`, `clips`, `columns`, matrix row arrays | sequence |

Unquoted YAML that parses as a non-string (for example `id: 1` → number, `weight: true` → bool) **MUST** be rejected for fields that require a string or finite number respectively. Authors **MUST** quote when needed so the loaded type matches the table.

Omitted optional fields use their defaults (`weight` → `1`, `silence_probability` → `0`, matrices absent → all modifiers `1`). Present-but-null for a required or numeric field **MUST** be rejected.

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

`repeats` may be fractional. `repeats: 2.4` with `clip_length: 10` keeps one choice for two full 10-second starts plus a 4-second partial start.

Fields:

| Field | Required | Meaning |
| :--- | :---: | :--- |
| `name` | yes | Unique track/group name. String; no `/`; no leading/trailing whitespace. |
| `clip_length` | yes | Start-to-start interval in seconds; not the WAV duration. Finite number `≥ 0`. |
| `repeats` | yes | How many times one evaluated choice is started before this track reevaluates. **MUST** be a finite number `> 0`. Need not be an integer: the last start of a non-integer cycle is a partial start (see §12). Values in `(0, 1)` mean every pulse evaluates and only a partial start is emitted. |
| `silence_probability` | no | Probability that the evaluated choice is silent. Finite number in `[0, 1]`. Default `0`. |
| `clips` | yes | Candidate clips in deterministic declaration order. |
| `intragroup_subsequent_weight_modifiers` | no | Same-group previous-to-next matrix. |
| `intergroup_consecutive_weight_modifiers` | no | Cross-group current-context matrix. |

Only the fields in this table are permitted on a track. Unknown keys **MUST** be rejected.

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
| `id` | yes | Identifier unique across the whole definition. Used as matrix column headers and row keys. **MUST** match `^[A-Za-z0-9_.-]+$`. |
| `path` | yes | Audio package path/string; becomes `ChosenClip`. Non-empty string with no leading/trailing whitespace. Never used as a matrix axis. |
| `weight` | no | Base selection weight. Finite number `≥ 0`. Default `1`. `Infinity` / `NaN` **MUST** be rejected. |

Only the fields in this table are permitted on a clip. Unknown keys **MUST** be rejected.

Clip IDs **MUST** be unique across the whole definition. Every matrix cell **MUST** be a finite number `≥ 0`.

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

`columns` **MUST** be exactly the concatenation of one contiguous block per represented upstream track:

```text
columns = concat(clip_ids(U) for each represented upstream track U
                 in top-level track declaration order)
```

where `clip_ids(U)` is U's clip `id`s in clip declaration order.

Therefore:

1. **all** clip IDs from each represented upstream track appear exactly once;
2. they appear as a **contiguous** block in that upstream track's clip declaration order;
3. represented upstream tracks appear in top-level track declaration order;
4. interleaving clips from different upstream tracks (for example `[c1, d1, c2, d2]`) **MUST** be rejected.

An earlier track that has no influence may simply be absent from the columns; that entire upstream track is then neutral `1`.

Matrix objects may only contain the keys `columns` and `rows`. Unknown keys **MUST** be rejected.

### 7.2 Row rules

If the matrix is present:

1. `rows` **MUST** contain exactly one row for every clip in the downstream group;
2. row keys are downstream candidate clip IDs (same `id` pattern as §5);
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

Because `next_float` is always in `[0, 1)`, `target < W` whenever `W` is finite and positive. If floating-point summation still leaves no clip with `running > target`, the player **MUST** select the **last** clip in declaration order whose `EffectiveWeight > 0`. A compliant implementation **MUST NOT** leave `ChosenClipId` as `none` when `W > 0`.

Then:

```text
Muted = R_silence < silence_probability
```

The comparison is strict `<`.

Mute changes audio only. It **MUST NOT** clear `ChosenClipId` or `ChosenClip` because downstream inter-group matrices must continue to see the selection.

The sentinel `none` means “no clip”. In dumps and APIs it **MUST NOT** be encoded as an empty string path; use a null/absent value.

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
  selected = false

  for (C, w) in weighted:
    running += w
    if running > target:
      T.ChosenClipId = C.id
      T.ChosenClip = C.path
      selected = true
      break

  if selected is false:
    for (C, w) in weighted in reverse declaration order:
      if w > 0:
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
| `RemainingFull` | 0 | Full starts still owed in the current evaluated cycle |
| `TailPending` | false | Whether the cycle still owes its fractional last start |

Split `repeats` once, when the track is parsed:

```text
FullRepeats  = floor(repeats)
TailFraction = repeats - FullRepeats
```

`TailFraction` is `0` when `repeats` is an integer. It is otherwise in `(0, 1)`.

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
  if T.RemainingFull <= 0 and T.TailPending is false:
    Evaluate(T)
    T.RemainingFull = T.FullRepeats
    T.TailPending   = (T.TailFraction > 0)

  if T.RemainingFull > 0:
    T.PlaySeconds = T.LoopSeconds
    T.CropAudio   = false
    T.RemainingFull -= 1
  else:
    T.PlaySeconds = AtLeastOne(T.TailFraction * T.LoopSeconds)
    T.CropAudio   = true
    T.TailPending = false

  T.NextStart = t + T.PlaySeconds

  emit schedule event:
    t
    T.name
    T.ChosenClip
    T.Muted
    T.PlaySeconds
    T.CropAudio
```

Those six fields are the normative schedule. Given the same package and seed, compliant players **MUST** agree on every field of every emitted event. Audio rendering (§15) may still differ.

`repeats` therefore counts starts, including the start on the evaluation pulse. A non-integer value means the cycle is `FullRepeats` full starts plus one partial start. Retriggers and the fractional last start do not consume PRNG draws.

A full start uses `PlaySeconds = LoopSeconds` and does not crop audio. A partial start uses `PlaySeconds = AtLeastOne(TailFraction × LoopSeconds)` and crops audio to that duration so tracks with different `clip_length` values can be authored to finish a cycle together.

Example: `clip_length = 15`, `repeats = 4` produces starts at `0,15,30,45,60...` and evaluations at `0,60,120...`. Every start is full (`PlaySeconds = 15`, `CropAudio = false`).

Example: `clip_length = 10`, `repeats = 2.4` produces starts at `0,10,20,24...` and evaluations at `0,24,48...`. Starts at `0` and `10` are full (`PlaySeconds = 10`, `CropAudio = false`). The start at `20` is partial (`PlaySeconds = 4`, `CropAudio = true`): 4 seconds of the chosen file, then the next evaluation at `24`. A 12-second track with `repeats = 2` evaluates on that same 24-second cycle.

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

`next_float` is therefore always in `[0, 1)`.

### 14.1 Seed input

The seed supplied to a player is a Unicode string. Parse it as follows:

```text
ParseSeed(text):
  s = text with leading and trailing Unicode whitespace removed
      (if text is null/absent, treat as "")

  if s is empty:
    return 12345

  if s does not match the regular expression ^[+-]?[0-9]+$ :
    reject

  n = signed integer value of s in base 10 (arbitrary magnitude)
  return n modulo 2^64 as an unsigned 64-bit integer
       (negative values wrap in two's-complement fashion)
```

Normative consequences:

- Decimal digits only. Hex (`0x…`), floats, underscores, and scientific notation **MUST** be rejected.
- Empty or whitespace-only input **MUST** become `12345` (not an error).
- Initial LCG state is exactly `ParseSeed(text)` (already reduced to 64 bits).

Only evaluations consume draws, exactly two per evaluation, in scheduler order.

---

## 15. Audio playback

A start event sounds only when `ChosenClip` is set and `Muted` is false.

On a full start (`CropAudio` is false), players **MUST** start the entire referenced audio file at the scheduled time, allow tails to overlap subsequent starts, and **MUST NOT** crop a clip to `LoopSeconds`.

On a partial start (`CropAudio` is true), players **MUST** start the referenced audio file at the scheduled time and **MUST** stop it after `PlaySeconds` (or at the file's natural end if shorter). That stop is the only case in which a start is cropped.

Because §3.2 rejects packages with missing or undecodable clips at load time, a running player always has audio bytes for every `ChosenClip`.

Audio resampling, mixing, sample-accurate stop alignment, and short click-prevention fades may differ between players. Schedule fields (§12 emit list) may not.

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

`schema.yaml` validates the basic YAML structure. A compliant validator/player **MUST** additionally check cross-reference and typing rules that JSON Schema draft 7 cannot fully express:

1. root and nested objects contain no unknown keys (§3.1, §4, §5, §7.1);
2. scalar JSON types match §3.3 (strings where required; finite numbers where required; never bool-as-number);
3. track names are unique, non-empty, contain no `/`, and have no leading/trailing whitespace;
4. clip IDs are unique across the whole definition and match `^[A-Za-z0-9_.-]+$`;
5. clip `path` values are non-empty strings with no leading/trailing whitespace;
6. every weight, matrix cell, `clip_length`, `repeats`, and `silence_probability` is finite and in range;
7. intra `columns` exactly equal that track's clip IDs in clip declaration order;
8. intra `rows` contain exactly those same clip IDs;
9. every intra row length equals intra column count;
10. inter row keys exactly equal the downstream track's clip IDs;
11. every inter row length equals inter column count;
12. inter `columns` equal the concatenation of complete upstream clip-id blocks in track declaration order (§7.1) — contiguous, no interleaving;
13. every inter column is a clip `id` that resolves to a clip on an earlier track;
14. no inter column references a clip on the same track or a later track;
15. package zip rules in §3–§3.2 (exactly one definition; unique ClipKeys; every path resolves and decodes).

Invalid input **MUST** be rejected rather than padded, truncated, reordered, type-coerced, or silently defaulted.

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

Historical note: an earlier draft of this section used a private migrated package whose `t = 0` picks were Drums/`Drums/Drums 1`, Organ/`Organ/Organ 4`, Bass/`Bass/Bass 2`, Lead/`Lead/Mellotron 4`, Percussion/`Percussion/Percussion 2` (muted). That package is not shipped here. The normative golden fixture is §19.

---

## 19. Golden test (in-repo fixture)

Compliant players **MUST** match `fixtures/golden/` for seed `12345`.

Authoritative files:

| File | Role |
| :--- | :--- |
| `fixtures/golden/definition.yml` | Song definition |
| `fixtures/golden/expected-t0.json` | Expected `t = 0` schedule events (all six fields) |
| `scripts/check-golden.mjs` | Regenerates/verifies `expected-t0.json` against the web engine |

At `t = 0`, with seed `12345`, the evaluations **MUST** yield:

| Order | Track | ChosenClip | Muted | PlaySeconds | CropAudio |
| :--- | :--- | :--- | :---: | ---: | :---: |
| 1 | Drums | `Drums/A.wav` | no | 10 | no |
| 2 | Bass | `Bass/A.wav` | no | 10 | no |
| 3 | Lead | `Lead/A.wav` | no | 8 | no |

Verify with:

```text
node scripts/check-golden.mjs
```

Unity: load the same `definition.yml`, seed `12345`, and compare Log Schedule / Dump First Evaluations against `expected-t0.json`.

This fixture exercises declaration-order evaluation, an inter-group matrix, fractional `repeats` on Bass (tail later, not at `t = 0`), and weighted Lead selection.

---

## 20. Implementer checklist

A version 2 implementation is compliant if it:

1. accepts `format_version: 2.0.0` and rejects unknown definition keys;
2. parses `definition.yml` under the §3.3 YAML dialect and scalar-type rules;
3. enforces §3 package rules (exactly one definition; ClipKey uniqueness; fail on missing audio);
4. treats each track as one clip group;
5. processes tracks in YAML declaration order;
6. preserves clip declaration order;
7. uses `intragroup_subsequent_weight_modifiers` only for this group's previous-selection → next-candidate weighting;
8. uses `intergroup_consecutive_weight_modifiers` only for other groups' current-selection → downstream-candidate weighting;
9. requires contiguous concatenated upstream blocks in inter `columns` (§7.1);
10. multiplies base, intra, and current inter-group factors;
11. uses one shared LCG with `ParseSeed` (§14.1) and exactly two draws per evaluation;
12. applies the §9 / §11 selection walk, including the last-positive-weight fallback;
13. leaves muted selections visible as current selections to downstream groups;
14. keeps independent track clocks and consumes no random draws on retriggers or on a fractional last start;
15. treats non-integer `repeats` as `floor(repeats)` full starts plus one cropped partial start;
16. rejects invalid matrix dimensions/references and out-of-range non-finite numbers;
17. emits and matches all six schedule fields (§12);
18. matches the golden test in section 19.
