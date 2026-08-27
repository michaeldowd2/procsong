# Procsong Player Conformance Specification

**Version:** 1.0.0  
**Status:** Standard Specification  
**Subject:** Deterministic Clip-Based Infinite Music Generation Engine Standard

---

## 1. Overview & Goal

The **Procsong** specification defines the playback engine requirements for clip-based, procedural, infinite music generation. 

The primary requirement of Procsong is **100% Cross-Platform Determinism**:
Given an identical Procsong package (containing `definition.yml` and audio clips) and an identical 64-bit integer **Seed ($S$)**, any compliant player implemented in **any programming language or audio framework MUST produce an identical playback schedule**.

---

## 2. Requirement Keywords (RFC 2119 / RFC 8174)

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) and [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt).

---

## 3. Data Model & Package Structure

### 3.1 Package Files
A compliant Procsong package **MUST** be structured as follows:
- `definition.yml` (**REQUIRED**): The song structure YAML matching `schema.yaml`.
- Audio Clip Subdirectories (**REQUIRED**): Relative audio clip files referenced in `definition.yml`.

### 3.2 Track Types
Every track defined in `definition.yml` belongs to one of three types:
1. `primary`: Root driving tracks (e.g. Drums).
2. `secondary`: Harmonic/rhythmic tracks depending on Primary parts (e.g. Rhythm Organ/Guitar).
3. `standard`: Supplementary tracks depending on Primary and/or Secondary parts (e.g. Bass, Lead, Percussion).

---

## 4. Mandatory Pseudorandom Number Generator (PRNG)

Compliant players **MUST NOT** use language-native random functions (e.g. `Math.random()`, `rand()`). Players **MUST** implement the following 64-bit Linear Congruential Generator (LCG).

### 4.1 LCG Mathematical Definition

- **State Size:** 64-bit unsigned integer ($S_{64}$).
- **Multiplier ($A$):** `6364136223846793005` (`0x5851F42D4C957F2D`)
- **Increment ($C$):** `1442695040888963407` (`0x14057B7EF767814F`)
- **Modulus:** $2^{64}$ (overflow wraps naturally in 64-bit unsigned arithmetic).

#### State Advance Formula:
$$S_{n+1} = (S_n \times 6364136223846793005 + 1442695040888963407) \pmod{2^{64}}$$

#### Floating-Point Extraction ($R \in [0.0, 1.0)$):
$$U_{32} = S_{n+1} \gg 32$$
$$\text{next\_float}() = \frac{U_{32}}{4294967296.0}$$

### 4.2 Reference PRNG Implementations

#### Python
```python
class ProcsongRNG:
    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFFFFFFFFFF
        
    def next_float(self) -> float:
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
        upper_32 = self.state >> 32
        return upper_32 / 4294967296.0
```

#### JavaScript / TypeScript (using `BigInt`)
```typescript
class ProcsongRNG {
    private state: bigint;

    constructor(seed: number | bigint) {
        this.state = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;
    }

    nextFloat(): number {
        this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
        const upper32 = Number(this.state >> 32n);
        return upper32 / 4294967296.0;
    }
}
```

#### C++
```cpp
#include <cstdint>

class ProcsongRNG {
private:
    uint64_t state;
public:
    ProcsongRNG(uint64_t seed) : state(seed) {}

    double next_float() {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        uint32_t upper32 = static_cast<uint32_t>(state >> 32);
        return static_cast<double>(upper32) / 4294967296.0;
    }
};
```

#### Rust
```rust
pub struct ProcsongRNG {
    state: u64,
}

impl ProcsongRNG {
    pub fn new(seed: u64) -> Self {
        ProcsongRNG { state: seed }
    }

    pub fn next_float(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let upper32 = (self.state >> 32) as u32;
        (upper32 as f64) / 4294967296.0
    }
}
```

---

## 5. Track Evaluation & Selection Algorithm

### 5.1 Constant 2-Draw PRNG Consumption Rule
Whenever any track is evaluated (whether at $t = 0$ or during playback), the player **MUST** draw exactly **two** random floating-point values from the PRNG in strict order:
1. $R_{\text{part}} = \text{next\_float}()$ — Used for weighted candidate part selection.
2. $R_{\text{silence}} = \text{next\_float}()$ — Used for the silence probability check.

> **CRITICAL:** Both $R_{\text{part}}$ and $R_{\text{silence}}$ **MUST** be drawn for every track evaluation regardless of whether the track has zero candidate parts or becomes silent. This ensures the PRNG state stream remains strictly synchronized.

### 5.2 Priority Phase Sorting Rule
When multiple tracks are scheduled for evaluation at the exact same millisecond tick $t$, they **MUST** be evaluated in the following priority order:
1. **Phase 1:** `primary` tracks (in YAML declaration order).
2. **Phase 2:** `secondary` tracks (in YAML declaration order).
3. **Phase 3:** `standard` tracks (in YAML declaration order).

### 5.3 Candidate Filtering Rules
Before performing selection on a track $T$, the player **MUST** filter $T$'s `parts` list to build the candidate list $C$:

- **Primary Track Part:** Included in $C$ unconditionally.
- **Secondary Track Part:** Included in $C$ **IF AND ONLY IF**:
  - `allowed_primary_parts` is omitted/null, **OR**
  - At least one currently active (non-silent) Primary track part matches an entry in `allowed_primary_parts`.
- **Standard Track Part:** Included in $C$ **IF AND ONLY IF**:
  - `allowed_primary_parts` (if defined) matches at least one active Primary track part, **AND**
  - `allowed_secondary_parts` (if defined) matches at least one active Secondary track part.

### 5.4 Weighted Selection Algorithm
If candidates list $C = [P_1, P_2, \dots, P_N]$ is non-empty:
1. Compute total weight $W = \sum_{i=1}^{N} \text{weight}(P_i)$. (Default weight $= 1.0$ if omitted).
2. Calculate target threshold: $T_{\text{target}} = R_{\text{part}} \times W$.
3. Iterate candidates in declaration order, accumulating weight $\text{Cum}_k = \sum_{i=1}^{k} \text{weight}(P_i)$.
4. Select the **first** candidate $P_k$ where $\text{Cum}_k > T_{\text{target}}$. (If numerical precision reaches end of list, select $P_N$).

### 5.5 Silence Decision
1. If candidate list $C$ is empty, the track result **MUST** be set to `SILENT`.
2. If $R_{\text{silence}} < \text{probability\_silence}$, the track result **MUST** be set to `SILENT`.
3. Otherwise, the track result **MUST** be the selected part $P_k$.

---

## 6. Master Timeline Scheduler Architecture

To support tracks with differing durations, players **MUST** maintain a Master Timeline Scheduler.

### 6.1 Time Unit
- All time ticks **MUST** be integer **milliseconds** ($1\text{ ms} = 0.001\text{ seconds}$).

### 6.2 Next Tick Calculation
When a track $T$ is evaluated at tick $t_{\text{current}}$, its next evaluation tick $t_{\text{next}}$ **MUST** be calculated as:
$$t_{\text{next}} = t_{\text{current}} + \text{round}( \text{part\_duration} \times \text{repeats} \times 1000 )$$

### 6.3 State Lifecycle
1. **At Initialization ($t = 0\text{ ms}$):**
   - Initialize PRNG with Seed $S$.
   - Create an empty `ActiveParts` map (`TrackName -> PartPath | SILENT`).
   - Evaluate all tracks in Priority Order ($t = 0\text{ ms}$).
   - Store results in `ActiveParts` and schedule next ticks.
2. **At Playback Tick $t$:**
   - Pop all tracks scheduled for tick $t$.
   - Sort popped tracks by Priority Order (Primary $\rightarrow$ Secondary $\rightarrow$ Standard).
   - Evaluate each track, update `ActiveParts`, trigger audio playback if non-silent, and schedule its next tick.

---

## 7. Audio Playback & Mixing Rules

1. **Sample-Accurate Scheduling:** Audio clip triggers **MUST** be scheduled with sample-accurate buffer alignment matching the calculated millisecond ticks.
2. **Micro-Crossfades:** Players **SHOULD** apply a 5ms to 10ms equal-power crossfade at clip boundaries to eliminate digital clicking.
3. **Resampling:** Players **MUST** resample all audio clips to a unified mixing rate (RECOMMENDED: 44.1 kHz or 48 kHz).

---

## 8. Conformance Verification (Golden Test Vector)

To verify that an implementation is compliant, run the player with the following reference input:
- **Package:** `examples/song_1`
- **Seed ($S$):** `12345`

### Expected Initial Selection at $t = 0\text{ ms}$:

| Evaluation Order | Track Name | Type | $R_{\text{part}}$ | $R_{\text{silence}}$ | Selected Part Result | Next Tick |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `Drums` | `primary` | `0.10957861` | `0.26538530` | `Drums/Drums 1` | 60000 ms |
| 2 | `Organ` | `secondary` | `0.88562399` | `0.83573741` | `Organ/Organ 4` | 60000 ms |
| 3 | `Bass` | `standard` | `0.32563106` | `0.56047223` | `Bass/Bass 2` | 60000 ms |
| 4 | `Lead` | `standard` | `0.79386844` | `0.39149387` | `Lead/Mellotron 4` | 60000 ms |
| 5 | `Percussion` | `standard` | `0.81517936` | `0.18816854` | `SILENT` | 60000 ms |

> Any player implementation **MUST** match the exact sequence above for `Seed = 12345`.
