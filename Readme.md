# Procsong

An open-source schema for **deterministic, clip-based, infinite music**.

A Procsong package is a zip of audio clips plus a `definition.yml`. Together with a numeric **seed**, any compliant player produces the same arrangement.

The piece has **no fixed loop and no shared bar**. Each track has its own start interval. Tracks overlap and recombine forever. The same zip and seed always yield the same schedule of *which clip starts at which second*.

## How sequencing works

Full rules: [`SPECIFICATION.md`](SPECIFICATION.md) (v2.0.0). Short version:

1. **Time is integer seconds** starting at `t = 0`. There is no global tempo grid.
2. Each track starts a clip every `clip_length` seconds (rounded to an integer ≥ 1). The wav is usually *longer* than that interval, so tails overlap. The interval is when the *next* clip may start, not how long the file is.
3. A track does **not** pick a new clip on every start. It keeps the same choice for `repeats` starts, then **evaluates** again (new clip and mute flag). `repeats` may be fractional: `2.4` on a 10-second track is two full starts plus 4 seconds of a third, so tracks of different lengths can be authored to finish a cycle together.
4. At any given second, due tracks evaluate in **YAML declaration order** (top to bottom). Later tracks in that same second see the new choices of earlier tracks.
5. Evaluation uses **one** shared PRNG for the whole song (not one per track). Each evaluation draws two numbers: pick a part, then maybe mute. Retriggers do not draw. Candidate weights are `base × intragroup × intergroup` (see the spec for the two distinct matrices).
6. **Mute is volume, not “no part.”** A muted track still has a chosen clip. Downstream inter-group matrices still see that choice.

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
- **Unity** — Package Manager → **Add package from git URL…** → `https://github.com/michaeldowd2/procsong.git?path=/players/unity`. Add **Procsong Player**, copy the song zip into `Assets` as `.bytes`, and assign it. See [`players/unity/Documentation~/README.md`](players/unity/Documentation~/README.md).
- **Python** — `python players/python/procsong.py song.zip --seed 12345`, or pass a public zip URL (Dropbox share links work). Prints each new choice and plays it. A terminal keeps the latest 100 choices. No extra Python packages. Optional YouTube Live output needs `ffmpeg`; the picture shows the song name (`--name`, or the file name), a running playtime, and a spectrum of the mix. See [`players/python/README.md`](players/python/README.md).

## Package shape

See [`schema.yaml`](schema.yaml) and the “How to make a procsong” notes in the web player. Minimal track:

```yaml
format_version: 2.0.0
tracks:
  - name: Drums
    clip_length: 8
    repeats: 4
    silence_probability: 0
    clips:
      - {id: d1, path: "Drums/A.wav", weight: 1}
      - {id: d2, path: "Drums/B.wav", weight: 1}
```

## Conformance

The normative golden schedule is [`fixtures/golden/`](fixtures/golden/). Same definition + seed `12345` → same `t = 0` events in [`expected-t0.json`](fixtures/golden/expected-t0.json).

```text
node scripts/check-golden.mjs
python players/python/procsong.py --check
```
