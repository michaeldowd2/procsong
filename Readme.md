# Procsong

An open-source schema for **deterministic, clip-based, infinite music**.

A Procsong package is a set of audio parts and a `definition.yml`. Together with a numeric **seed**, any compliant player produces the same arrangement: tracks of different lengths overlap and recombine, so the piece keeps going without a fixed loop.

## Use cases

- Background party music
- Background music for shops, cafes, and other commercial spaces
- Study music
- Game music
- DJ compositions
- Art installations
- A practice companion for musicians

## Player

Open [`players/web/index.html`](players/web/index.html) in a browser. Point it at a Procsong zip, set a seed, and press Play. The same seed always yields the same schedule.
