# Procsong for Unity

Music does **not** start when the scene loads. Call `Play()` when you want it.

The zip is unpacked **the first time you press Play**, into memory only (YAML + `AudioClip`s). It is not extracted onto disk, and it is not unpacked when the game starts. Later Play calls reuse that in-memory data until you assign a different zip or destroy the player.

## Install

**Package Manager (Git):** Window → Package Manager → **+** → **Add package from git URL…**

```
https://github.com/michaeldowd2/procsong.git
```

That URL only works after `package.json` is on the `main` branch of that repo. Unity looks for that file at the repository root.

**Or** copy this repo under `Assets` (for example `Assets/procsong`). Unity will not compile the web player; it only needs the scripts in this folder.

## Sequencing

This player **MUST** follow [`SPECIFICATION.md`](../../SPECIFICATION.md). Do not invent a second set of rules.

Same zip + same seed as the web player → same chosen parts, mute flags, and integer start times. Unity’s mixer may still sound slightly different from the browser.

In one sentence: each track starts clips on its own interval; it reuses a choice for `repeats` starts; evaluations use one shared PRNG in primary → secondary → standard order; mute does not clear the chosen part.

Turn on **Log Schedule** to print the first evaluations (compare with the spec golden test: seed `12345`).

## Add it to a scene

1. Install the package (Git URL or copy under `Assets`).
2. Create an empty GameObject and add **Procsong Player** (`Add Component` → Audio → Procsong Player).
3. Copy a procsong `.zip` into the project and drag it onto **Song Package**.
4. The scene still needs an **Audio Listener** (Unity puts one on the main camera by default).

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
| Song Package | The procsong `.zip` |
| Seed | Integer. Same package + seed always produces the same arrangement |
| Volume | Master gain |
| Spatial Blend | `0` is 2D (normal for music). Raise it if the object should be a 3D emitter |
| Log Schedule | Prints the first evaluations to the Console |

## Builds

Dragging a `.zip` onto Song Package is enough for the Editor and for a built game. Unity imports the zip as part of the project; you do not rename it.

Clips in the zip must be PCM WAV (8/16/24/32-bit or 32-bit float). That is what a typical procsong package already uses.

## Files

| File | Role |
| :--- | :--- |
| `ProcsongPlayer.cs` | MonoBehaviour: zip load, WAV decode, audio |
| `ProcsongEngine.cs` | Shared schedule / seed logic (same rules as the web player) |

The rest of the repo (`SPECIFICATION.md`, `players/web`, `schema.yaml`) is reference material. You can leave it in the project; it is not used in a build.
