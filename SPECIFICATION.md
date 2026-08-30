# Procsong Player Conformance Specification

**Version:** 1.2.0  
**Status:** Standard Specification

This document is the **only** definition of how a procsong is sequenced. Players (web, Unity, or anything else) **MUST** follow it. Mixing may differ; the schedule of *what starts when* **MUST** match.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

---

## 1. What a player produces

A player takes:

1. A **package** — `definition.yml` plus audio clips in a zip
2. A 64-bit integer **seed**

and produces an **infinite schedule**: a sequence of start events.

Each start event is exactly:

| Field | Meaning |
| :--- | :--- |
| `t` | Integer time in seconds from the beginning of playback (`t = 0` is the first instant) |
| `track` | Which track |
| `ChosenPart` | Clip path from the YAML (or none) |
| `Muted` | Whether that start is silent |

Given the same package and seed, every compliant player **MUST** emit the same sequence of those four fields.

Audio engines **MAY** mix, resample, and fade differently. They **MUST NOT** change which part is chosen, whether it is muted, or at which integer second it starts.

---

## 2. What sequencing is not

Read this first. These are the usual wrong models:

- **Not a shared bar or tempo grid.** There is no global BPM, bar, or “wait until every track finishes.”
- **Not one loop of the whole song.** Each track has its own interval and keeps going forever.
- **Not “pick a new clip every time something plays.”** A track reuses the same choice for `repeats` starts, then picks again.
- **Not “muted means this track was skipped.”** Mute is volume after a choice. The clock still advances. Other tracks still see the chosen part.
- **Not one random generator per track.** There is **one** PRNG for the whole player. It advances only when a track **evaluates** (two draws per evaluation), in a fixed track order.

---

## 3. Package

A package **MUST** contain:

- `definition.yml` matching `schema.yaml`
- Audio files whose paths can be matched to the part names in that YAML (typically `Track/Part.wav`)

**ChosenPart** in the schedule is the **YAML path string as written** (for example `Drums/Drums 1` or `Drums/Drums 1.wav`). File lookup **MAY** ignore case and **MAY** ignore a single file extension. Matching `allowed_primary_parts` / `allowed_secondary_parts` **MUST** use the YAML path string, not the filename after stripping an extension.

Each top-level YAML key is a **track**, in **declaration order** (the order the keys appear in the file). Each track **MUST** have:

| Field | Meaning |
| :--- | :--- |
| `type` | `primary`, `secondary`, or `standard` |
| `parts` | Candidate clips, in declaration order |
| `part_duration` | Start-to-start interval in seconds (not the wav length) |
| `repeats` | How many starts of the same `ChosenPart` and `Muted` before the next evaluation |
| `probability_silence` | After a part is chosen, probability it is muted (0–1). Default **0** if omitted |

**Track roles**

- `primary` — always eligible (e.g. drums). Other tracks may depend on whatever it chose.
- `secondary` — a part is eligible only if it is allowed with the current primary choice(s).
- `standard` — a part is eligible only if it is allowed with the current primary and/or secondary choice(s).

Unknown `type` values **MUST NOT** appear in a package.

---

## 4. Time

Playback begins at **`t = 0`**. Time for sequencing is an **integer number of seconds**.

Players **MUST** convert `part_duration` with `AtLeastOne` (below). Call that integer `LoopSeconds`. It is **≥ 1**.

`repeats` **MUST** be an integer **≥ 1**. If a player is given a non-integer, it **MUST** also run `AtLeastOne`.

```
AtLeastOne(n):
  if n is not a finite number: return 1
  value = floor(n + 0.5)        # ECMAScript Math.round for n ≥ 0
  if value > 0: return value
  return 1
```

Each track has two independent clocks, both in integer seconds:

| Clock | Step | What happens |
| :--- | :--- | :--- |
| **Start** | `LoopSeconds` | A start event: retrigger the current choice (or a silent start if muted) |
| **Evaluation** | `LoopSeconds × repeats` | Pick a new `ChosenPart` and `Muted`, then start |

Example — two tracks, no shared bar:

- Track A: `LoopSeconds = 15`, `repeats = 4` → starts at 0, 15, 30, 45; **evaluates** at 0 and 60, 120, …
- Track B: `LoopSeconds = 20`, `repeats = 3` → starts at 0, 20, 40; **evaluates** at 0 and 60, 120, …

At `t = 15`, A starts again while B is still on its first clip. That offset is required, not a bug.

---

## 5. Load: sorted track list

Parse `definition.yml`. Build a list of tracks. Then **sort once**, stably, as follows:

1. All `primary` tracks, in YAML declaration order
2. All `secondary` tracks, in YAML declaration order
3. All `standard` tracks, in YAML declaration order

Call this sorted list `Tracks[0 … N-1]`. The scheduler **MUST** always visit due tracks in this order.

Create **one** PRNG (section 9). Initial state = seed masked to 64 bits. Do not draw yet.

---

## 6. Per-track state

Each track slot stores:

| Field | Initial value | Meaning |
| :--- | :--- | :--- |
| `ChosenPart` | none | Last evaluated clip path |
| `Muted` | true | Last evaluated mute flag |
| `NextStart` | 0 | Next integer time this track is due |
| `Remaining` | 0 | Starts left in this evaluation cycle. `0` means “evaluate before this start” |

`Remaining = 0` at the beginning so **every track evaluates at t = 0**.

---

## 7. Master scheduler (normative)

There is no global phrase length. The scheduler is:

```
loop forever:
  t = minimum of NextStart over all tracks
  for each slot in Tracks (already sorted):
    if slot.NextStart == t:
      Pulse(slot, t)
```

`Pulse` **MUST** be:

```
Pulse(slot, t):
  if slot.Remaining <= 0:
    Evaluate(slot)                  # consumes exactly two PRNG draws
    slot.Remaining = slot.repeats
  slot.Remaining = slot.Remaining - 1
  slot.NextStart = t + slot.LoopSeconds
  emit start event:
    time t, this track, slot.ChosenPart, slot.Muted
```

So:

- **Evaluation** happens when `Remaining <= 0` (including every track at `t = 0`).
- Then the same pulse **always** emits a start at `t`.
- If it was not an evaluation, `ChosenPart` and `Muted` are unchanged; audio is only retriggered.
- After `repeats` starts of that choice, `Remaining` is 0 again, so the next due time evaluates.

Worked `repeats = 4`, `LoopSeconds = 15`:

| t | Remaining before pulse | Evaluates? | Remaining after pulse | NextStart |
| :--- | :--- | :--- | :--- | :--- |
| 0 | 0 | yes | 3 | 15 |
| 15 | 3 | no | 2 | 30 |
| 30 | 2 | no | 1 | 45 |
| 45 | 1 | no | 0 | 60 |
| 60 | 0 | yes | 3 | 75 |

When several tracks have the same `t`, Pulse them in sorted `Tracks` order. That is the only order the shared PRNG is used. **Primary always evaluates before secondary before standard** at a shared second, so later tracks see the new `ChosenPart` values from earlier tracks **in the same second**.

---

## 8. Evaluation (pick a part, then maybe mute)

`Evaluate(slot)` **MUST** draw **exactly two** floats from the shared PRNG, **in this order**, even if there are no candidates and even if the result will be muted:

1. `R_part` ∈ [0, 1)
2. `R_silence` ∈ [0, 1)

Then build candidate list `C` from that track’s `parts` **in YAML declaration order**:

### 8.1 Who is a candidate

Let `PrimaryChosen` be the list of `ChosenPart` from every **primary** slot whose `ChosenPart` is not none.  
Let `SecondaryChosen` be the same for **secondary** slots.

**Ignore `Muted` when building these lists.** A muted primary still contributes its `ChosenPart`.

A constraint **matches** if:

- the field is **omitted** (null / missing) → no restriction (always matches)
- the field is an **empty list** → matches nothing
- otherwise → at least one name in the list equals a current `ChosenPart` in the corresponding list (exact string match)

Then:

- **Primary track:** `C` = every part.
- **Secondary track:** a part is in `C` if `allowed_primary_parts` matches `PrimaryChosen`.
- **Standard track:** a part is in `C` if `allowed_primary_parts` matches `PrimaryChosen` **and** `allowed_secondary_parts` matches `SecondaryChosen`. Both constraints are independent; omit one to ignore that role.

If there are several primary (or secondary) tracks, “matches” means **any** of their current chosen parts is in the allow-list.

### 8.2 Choose, then mute

Default part weight is **1**.

1. If `C` is empty: `ChosenPart = none`, `Muted = true`. (Both PRNG draws were already consumed.)
2. If `C` is non-empty:
   - `W` = sum of weights in `C` (in declaration order)
   - `T_target = R_part × W`
   - Walk `C` in declaration order; keep a running sum of weights. Pick the **first** part whose running sum **>** `T_target`. If none (for example every weight is 0), pick the **last** part in `C`.
   - `ChosenPart` = that part’s YAML path
   - `Muted = true` if `R_silence < probability_silence`, else `Muted = false`  
     (`<`, not `≤`. If `R_silence == probability_silence`, the track is **not** muted.)

`ChosenPart` **MUST** remain set for the whole evaluation cycle (`repeats` starts), including while `Muted` is true.

**Mute is not “no part.”** Downstream filters **MUST** use `ChosenPart` and **MUST NOT** treat a muted track as having no part.

---

## 9. When audio actually sounds

The schedule is defined even for muted starts. For audible playback, players **MUST**:

- Start audio only if `ChosenPart` is set **and** `Muted` is false
- Start the **entire** wav at time `t` (do not stretch, squeeze, or crop to `LoopSeconds`)
- Leave the previous wav playing until it ends naturally
- Allow **at least two overlapping voices per track** (clip N’s tail under clip N+1)
- **MUST NOT** stop a wav at `LoopSeconds`

`LoopSeconds` is only when the **next** start is allowed. Clip files are usually longer than `LoopSeconds` (e.g. interval 20, file 22 seconds). That overlap is required.

Players **SHOULD** apply a short (5–10 ms) equal-power fade at the **natural** start and end of each wav to avoid clicks. That fade **MUST NOT** replace the overlap above.

Players **SHOULD** resample clips to one mix rate (44.1 kHz or 48 kHz recommended). Resampling **MUST NOT** change start times.

---

## 10. PRNG

Players **MUST NOT** use language-native random (`Math.random()`, `UnityEngine.Random`, `rand()`, etc.).

Use this 64-bit LCG:

- Multiplier `A` = `6364136223846793005`
- Increment `C` = `1442695040888963407`
- Modulus `2^64` (unsigned wrap)

```
state = (state * A + C) mod 2^64
next_float = uint32(state >> 32) / 4294967296.0    # in [0, 1)
```

Initial `state` = seed masked to 64 bits (`seed & 0xFFFFFFFFFFFFFFFF`).

There is **one** `state` for the whole arrangement. `next_float` is called only from `Evaluate`, twice per evaluation, in scheduler order.

### Reference

```python
class ProcsongRNG:
    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFFFFFFFFFF

    def next_float(self) -> float:
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
        return (self.state >> 32) / 4294967296.0
```

```javascript
class ProcsongRNG {
  constructor(seed) {
    this.state = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;
  }
  nextFloat() {
    this.state =
      (this.state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    return Number(this.state >> 32n) / 4294967296.0;
  }
}
```

```cpp
double next_float() {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return double(uint32_t(state >> 32)) / 4294967296.0;
}
```

```rust
self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
(self.state >> 32) as u32 as f64 / 4294967296.0
```

```csharp
state = unchecked(state * 6364136223846793005UL + 1442695040888963407UL);
return (double)(uint)(state >> 32) / 4294967296.0;
```

---

## 11. Golden test

Package `examples/song_1`, seed `12345`. At `t = 0` every track evaluates, in sorted order (primary → secondary → standard, YAML order within type).

| Order | Track | Type | R_part | R_silence | ChosenPart | Muted | Next evaluation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Drums | primary | 0.10957861 | 0.26538530 | `Drums/Drums 1` | no | 60 s |
| 2 | Organ | secondary | 0.88562399 | 0.83573741 | `Organ/Organ 4` | no | 60 s |
| 3 | Bass | standard | 0.32563106 | 0.56047223 | `Bass/Bass 2` | no | 60 s |
| 4 | Lead | standard | 0.79386844 | 0.39149387 | `Lead/Mellotron 4` | no | 60 s |
| 5 | Percussion | standard | 0.81517936 | 0.18816854 | `Percussion/Percussion 2` | **yes** | 60 s |

Percussion **MUST** still have `ChosenPart = Percussion/Percussion 2`. It is muted because `R_silence < probability_silence`. Other tracks **MUST** be able to depend on that chosen part (and on any muted primary/secondary) as if it were audible.

A player **MUST** match this table for seed 12345.

---

## 12. Implementer checklist

A player is compliant if, for any package and seed:

1. One LCG, seeded as in section 10
2. Tracks sorted as in section 5
3. Scheduler as in section 7 (integer `t`, independent `NextStart`)
4. Each evaluation consumes exactly two draws, then candidate filter, then weighted pick, then mute (`<`)
5. Retriggers do not draw
6. Mute does not clear `ChosenPart`
7. Start events match the golden test for `examples/song_1` + `12345`
