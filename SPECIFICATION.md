# Procsong Player Conformance Specification

**Version:** 1.1.0  
**Status:** Standard Specification

---

## 1. Goal

A Procsong player turns a package (`definition.yml` plus audio clips) and a 64-bit integer **seed** into an infinite, deterministic arrangement.

Given the same package and seed, every compliant player **MUST** produce the same sequence of:

1. **Chosen parts** (which clip was selected on each track)
2. **Mute flags** (whether that clip is audible)
3. **Start times** (when each clip is triggered)

Audio engines may differ in mixing, but the schedule of *what starts when* **MUST** match.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

---

## 2. Package

A package **MUST** contain:

- `definition.yml` matching `schema.yaml`
- Audio files whose relative paths match the part names in that YAML (typically `Track/Part.wav`)

Each top-level YAML key is a **track**. Each track **MUST** have:

| Field | Meaning |
| :--- | :--- |
| `type` | `primary`, `secondary`, or `standard` |
| `parts` | Candidate clips for this track |
| `part_duration` | Start-to-start interval in **seconds** (not the wav length) |
| `repeats` | How many starts of the same choice before the next evaluation |
| `probability_silence` | Chance the chosen clip is muted (0–1, default 0) |

**Track roles**

- `primary` — driving tracks (e.g. drums). Parts are always eligible.
- `secondary` — depend on the **chosen** primary part (e.g. organ).
- `standard` — depend on the **chosen** primary and/or secondary parts (e.g. bass, lead).

---

## 3. Two clocks per track (independent)

Tracks **MUST NOT** share a global bar or wait for the longest track.

Each track has its own clocks, in **integer seconds**:

| Clock | Step | Purpose |
| :--- | :--- | :--- |
| **Start clock** | `part_duration` | Trigger the next clip start (or a muted start) |
| **Evaluation clock** | `part_duration × repeats` | Pick a new chosen part and mute flag |

Example: a track with `part_duration: 15` and `repeats: 4` starts clips at 0, 15, 30, 45, then **evaluates** again at 60. A track with `part_duration: 20` and `repeats: 3` starts at 0, 20, 40 and evaluates at 60. At t = 15 the 15-second track starts again while the 20-second track is still on its first clip. That phase offset is intentional.

Players **MUST** round `part_duration` to the nearest integer second ≥ 1.

At t = 0 every track is due. After that, the master scheduler **MUST** fire whichever track’s next **start** is soonest. When several tracks share the same second, evaluate them in this order:

1. All `primary` tracks (YAML declaration order)
2. All `secondary` tracks (YAML declaration order)
3. All `standard` tracks (YAML declaration order)

On a **start** that is not an evaluation, the track keeps its current chosen part and mute flag and only retriggers audio (if not muted).

On an **evaluation**, the player **MUST** run the selection algorithm below, then retrigger.

---

## 4. Chosen part vs mute (silence)

Silence is **not** “no part was chosen.”

Each track stores two values after every evaluation:

| Field | Meaning |
| :--- | :--- |
| `ChosenPart` | Clip path (e.g. `Drums/Drums 1`), or none if no candidate existed |
| `Muted` | Whether the clip is audible |

**Mute is volume.** It is applied **after** a part is chosen. A muted primary or secondary track **MUST** still expose `ChosenPart` to other tracks.

**MUST NOT** treat a muted track as having no part. Downstream candidate filters **MUST** use `ChosenPart` and **MUST** ignore `Muted`.

### 4.1 Evaluation (exactly two PRNG draws)

On every evaluation, including t = 0, draw exactly two floats from the PRNG in this order, even if there are no candidates and even if the track will be muted:

1. `R_part` — weighted pick among candidates
2. `R_silence` — mute check

### 4.2 Candidates

Build candidate list `C` from the track’s `parts`:

- **Primary:** every part is a candidate.
- **Secondary:** a part is a candidate if `allowed_primary_parts` is omitted, **or** at least one current primary `ChosenPart` is in that list. Mute on the primary does not matter.
- **Standard:** a part is a candidate if every *defined* constraint matches:
  - `allowed_primary_parts` (if present) matches a current primary `ChosenPart`
  - `allowed_secondary_parts` (if present) matches a current secondary `ChosenPart`

Omitted constraint = no restriction. Empty list = match nothing.

### 4.3 Choose, then maybe mute

1. If `C` is empty: `ChosenPart = none`, `Muted = true`. Still consume both PRNG draws.
2. If `C` is non-empty:
   - `W` = sum of weights (default weight 1)
   - `T_target = R_part × W`
   - Walk `C` in declaration order; pick the first part whose cumulative weight `> T_target` (last part if none)
   - `ChosenPart` = that part’s path
   - `Muted = true` if `R_silence < probability_silence`, otherwise `Muted = false`

`ChosenPart` **MUST** stay set for the whole evaluation cycle (`repeats` starts), including while `Muted` is true.

---

## 5. Audio

`part_duration` is **when the next clip may start**, not how long the wav is. Clip files are usually **longer** than `part_duration` (e.g. duration 20, wav 22 seconds).

Players **MUST**:

- Start the **entire** wav at each start time (do not stretch, squeeze, or crop to `part_duration`)
- Leave the previous wav playing until it ends naturally
- Allow **at least two overlapping voices per track** so the tail of clip N mixes with the start of clip N+1
- Start audio only when `ChosenPart` is set **and** `Muted` is false
- Resample all clips to one mix rate (44.1 kHz or 48 kHz recommended)

Players **SHOULD** apply a short (5–10 ms) equal-power fade at the **natural** start and end of each wav to avoid clicks. That fade is not a substitute for the overlap described above, and **MUST NOT** cut the wav off at `part_duration`.

---

## 6. PRNG

Players **MUST NOT** use language-native random (`Math.random()`, `rand()`, etc.). Use this 64-bit LCG:

- Multiplier `A` = `6364136223846793005`
- Increment `C` = `1442695040888963407`
- Modulus `2^64` (unsigned wrap)

```
state = (state * A + C) mod 2^64
next_float = (state >> 32) / 4294967296.0    // in [0, 1)
```

Initial `state` = seed masked to 64 bits.

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
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
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

---

## 7. Golden test

Package `examples/song_1`, seed `12345`. At t = 0 every track evaluates (primary → secondary → standard).

| Order | Track | Type | R_part | R_silence | ChosenPart | Muted | Next evaluation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Drums | primary | 0.10957861 | 0.26538530 | `Drums/Drums 1` | no | 60 s |
| 2 | Organ | secondary | 0.88562399 | 0.83573741 | `Organ/Organ 4` | no | 60 s |
| 3 | Bass | standard | 0.32563106 | 0.56047223 | `Bass/Bass 2` | no | 60 s |
| 4 | Lead | standard | 0.79386844 | 0.39149387 | `Lead/Mellotron 4` | no | 60 s |
| 5 | Percussion | standard | 0.81517936 | 0.18816854 | `Percussion/Percussion 2` | **yes** | 60 s |

Percussion **MUST** still have `ChosenPart = Percussion/Percussion 2`. It is muted because `R_silence < probability_silence`. Other tracks **MUST** be able to depend on that chosen part (and on any muted primary/secondary) as if it were audible.

A player **MUST** match this table for seed 12345.
