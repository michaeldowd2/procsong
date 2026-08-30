# Procsong

An open-source schema for **deterministic, clip-based, infinite music**.

A Procsong package is a zip of audio clips plus a `definition.yml`. Together with a numeric **seed**, any compliant player produces the same arrangement.

The piece has **no fixed loop and no shared bar**. Each track has its own start interval. Tracks overlap and recombine forever. The same zip and seed always yield the same schedule of *which clip starts at which second*.

## How sequencing works

Full rules: [`SPECIFICATION.md`](SPECIFICATION.md). Short version:

1. **Time is integer seconds** starting at `t = 0`. There is no global tempo grid.
2. Each track starts a clip every `part_duration` seconds (rounded to an integer ≥ 1). The wav is usually *longer* than that interval, so tails overlap. The interval is when the *next* clip may start, not how long the file is.
3. A track does **not** pick a new clip on every start. It keeps the same choice for `repeats` starts, then **evaluates** again (new clip and mute flag).
4. At any given second, due tracks run in a fixed order: all **primary**, then **secondary**, then **standard** (and YAML order within each type). Later tracks in that same second see the new choices of earlier tracks.
5. Evaluation uses **one** shared PRNG for the whole song (not one per track). Each evaluation draws two numbers: pick a part, then maybe mute. Retriggers do not draw.
6. **Mute is volume, not “no part.”** A muted track still has a chosen part. Other tracks that filter on drums/organ still see that choice.

If two players disagree on what plays, the spec is right; the player is wrong.

## Use cases

- Background party music
- Background music for shops, cafes, and other commercial spaces
- Study music
- Game music
- Compositions for dancing
- Art installations
- A practice companion for musicians

## Players

- **Web** — open [`players/web/index.html`](players/web/index.html) in a browser. Load a library, pick a song, set a seed, press Play.
- **Unity** — Window → Package Manager → **Add package from git URL…** → `https://github.com/michaeldowd2/procsong.git` (needs `package.json` on that repo). Then add **Procsong Player** to a GameObject. See [`players/unity/README.md`](players/unity/README.md).

## Package shape

See [`schema.yaml`](schema.yaml) and the “How to make a procsong” notes in the web player. Minimal track:

```yaml
Drums:
  type: primary
  part_duration: 8
  repeats: 4
  probability_silence: 0
  parts:
    - Drums/A.wav
    - Drums/B.wav
```
