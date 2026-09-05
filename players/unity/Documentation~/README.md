# Procsong for Unity

Music does **not** start when the scene loads. Call `Play()` when you want it.

The package is unpacked **the first time you press Play**, into memory only (YAML + `AudioClip`s). It is not extracted onto disk, and it is not unpacked when the game starts. Later Play calls reuse that in-memory data until you assign a different package or destroy the player.

## Install

**Package Manager (Git):** Window → Package Manager → **+** → **Add package from git URL…**

```
https://github.com/michaeldowd2/procsong.git?path=/players/unity
```

Only this folder is the Unity package. `.meta` files live here next to the scripts Unity compiles, not next to the spec or the web player.

**Or** copy `players/unity` under `Assets`.

## Sequencing

This player **MUST** follow [`SPECIFICATION.md`](../../../SPECIFICATION.md) (`format_version: 2.0.0`). Do not invent a second set of rules. Legacy v1 packages (track-map YAML with `type` / `parts` / allow-lists) are not supported.

Same zip + same seed as the web player → same chosen clips, mute flags, and integer start times. Unity’s mixer may still sound slightly different from the browser.

In one sentence: each track starts clips on its own interval; it reuses a choice for `repeats` starts; evaluations use one shared PRNG in YAML track declaration order; mute does not clear the chosen clip.

Turn on **Log Schedule** to print the first evaluations (compare with the spec golden test: seed `12345`).

## Add it to a scene

1. Install the package (Git URL or copy `players/unity` under `Assets`).
2. Create an empty GameObject and add **Procsong Player** (`Add Component` → Audio → Procsong Player).
3. Copy the procsong zip into `Assets` and **rename the extension to `.bytes`** (`Song.zip` → `Song.bytes`). Drag that file onto **Song Package**.
4. The scene still needs an **Audio Listener** (Unity puts one on the main camera by default).

The file is still a zip; `.bytes` is only so Unity imports it as a TextAsset and includes it in builds. A raw `.zip` is an editor-only DefaultAsset and will not play in a player.

In Play mode, use the **Play** / **Stop** buttons on the component, or the gear menu → Play / Stop.

## Starting it from other systems

The public API is `Play()`, `Stop()`, `Restart()`, and `PlayWithSeed(string)`. Other tools should not import `Procsong` or take a `ProcsongPlayer` field. Put a **UnityEvent** on *your* component (a trigger, a Button **On Click**, a timeline signal) and wire it to those methods in the inspector:

1. Drag the Procsong Player object onto the event.
2. Choose `ProcsongPlayer.Play` (or `Stop` / `Restart`).

`Play()` does nothing if that player is already running. `Restart()` starts the arrangement from the beginning. `PlayWithSeed("99")` sets the seed and restarts.

Keep one player in the first scene and call `DontDestroyOnLoad` on it if the music should survive scene changes.

## Inspector

| Field | What it does |
| :--- | :--- |
| Song Package | The procsong zip renamed to `.bytes` |
| Seed | Integer. Same package + seed always produces the same arrangement |
| Volume | Master gain |
| Spatial Blend | `0` is 2D (normal for music). Raise it if the object should be a 3D emitter |
| Log Schedule | Prints the first evaluations to the Console |

## Builds

Assigning the `.bytes` file is enough for the Editor and for a built game. You do not put it in StreamingAssets.

Clips inside the package must be PCM WAV (8/16/24/32-bit or 32-bit float). That is what a typical procsong zip already uses.

## Files

| File | Role |
| :--- | :--- |
| `ProcsongPlayer.cs` | MonoBehaviour: zip load, WAV decode, audio |
| `ProcsongEngine.cs` | Shared schedule / seed logic (same rules as the web player) |
