# Procsong on the command line

Plays a procsong package (`.zip` or `.prcs`) the same way as the web and Unity players: same seed, same clip, same mute, same start time. There is no window. Each new pick is printed, and picks that share a time share a line. Repeats of the current pick are not printed.

Python 3.8 or newer is enough. There is nothing to `pip install`.

Speakers on Windows use the built-in audio device. Speakers on Linux use PulseAudio or PipeWire (`libpulse-simple`, which a normal desktop already has) or `aplay`.

YouTube Live is the one case that needs an extra program: `ffmpeg` on `PATH`. YouTube will not accept audio by itself, and Python cannot encode the H.264 + AAC stream YouTube requires.

## Play

```text
python players/python/procsong.py song.zip
python players/python/procsong.py song.prcs --name "Night Shift" --seed 99
python players/python/procsong.py "https://www.dropbox.com/s/.../song.prcs?dl=0" --seed 99
```

On Linux the command may be `python3` instead of `python`.

`--name` is the song name in the terminal and, for a stream, on the picture. Leave it out and the name is taken from the file, or from the last part of the URL, without `.zip`, `.prcs`, or `.bytes`.

An empty seed is `12345`. `--gain` defaults to `0.85`. `--seconds 30` stops after 30 seconds of the song. Otherwise it runs until Ctrl+C.

A `.prcs` file is the same zip archive as `.zip`, with a procsong-specific extension. A `.bytes` file is still a zip, so a Unity package works here too.

A public `http` or `https` link works in place of a file. A Dropbox share link (`dl=0`, including the newer `/scl/fi/` links) is turned into a direct download the same way the web player does it. The link has to point at the package itself, and it has to be reachable without logging in.

After the download line, a large package still has work to do. The player prints `unpacking` while it opens the files, then `decoding` while it prepares the audio. Those counters mean it is still working.

Printed lines look like:

```text
  0:00:00  Drums: Drums/A.wav | Bass: Bass/A.wav | Lead: Lead/A.wav
  0:00:20  Drums: Drums/A.wav
  0:00:24  Bass: Bass/A.wav muted | Lead: Lead/B.wav
```

One line is every new pick that starts at that second, in track order. A clip that simply loops is left off, because that pick was already printed.

On a terminal the list stays on one screen and keeps the latest 100 lines, so a run of days or weeks does not fill the scrollback. Stopping prints those lines back into the normal scrollback. If stdout is redirected to a file, every line is appended instead, and that file grows for the whole run.

| Word | Meaning |
| :--- | :--- |
| `muted` | That pick is silent. Downstream tracks still see it |
| `crop` | This new pick is itself cut short |

A full start plays the whole file, so the tail overlaps the next start. That matches the other players.

## YouTube Live

In YouTube Studio: **Create → Go live → Stream**. Copy the **stream key**. The stream URL above it is normally:

```text
rtmp://a.rtmp.youtube.com/live2
```

That URL is the default, so the key is enough:

```text
python players/python/procsong.py song.zip --name "Night Shift" --seed 12345 --stream-key YOUR_KEY
```

YouTube recommends the encrypted ingest. Click the lock next to the stream URL and pass that URL yourself:

```text
python players/python/procsong.py song.zip --stream-url rtmps://a.rtmps.youtube.com/live2 --stream-key YOUR_KEY
```

The backup server works the same way:

```text
python players/python/procsong.py song.zip --stream-url "rtmp://b.rtmp.youtube.com/live2?backup=1" --stream-key YOUR_KEY
```

A full URL that already contains the key can be passed as `--stream-url` alone.

The picture is a card with the song name, the seed, and the track names. YouTube will not accept audio by itself, so the card is what fills the video track. A clock between the seed line and the center counts how long this run has been playing, as hours:minutes:seconds. The hours do not restart at 24. A band across the middle is a spectrum of the mix when ffmpeg can draw one. The rest of the card does not move, which keeps the encode close to the cost of a still image. If that filter is missing, the card is still and uses a light bar in the middle instead.

Wait until Studio says the stream is coming in, then click **Go live**. Ctrl+C stops it.

Encoder settings follow [YouTube's live encoder recommendations](https://support.google.com/youtube/answer/2853702):

| | |
| :--- | :--- |
| Video | H.264, 1280×720, 30 fps, constant 4000 kbps, keyframe every 2 seconds |
| Audio | AAC, 44.1 kHz, stereo, 128 kbps |
| Protocol | FLV over RTMP or RTMPS |

`ffmpeg` has to be on `PATH` (`ffmpeg` works in a terminal). On Linux that is the distro `ffmpeg` package. On Windows, install any normal ffmpeg build and add its `bin` directory to `PATH`.

The stream key is not printed. It is handed to ffmpeg, so it can appear in the process list on that computer. Treat it like a password.

## Check

From a checkout of this repo:

```text
python players/python/procsong.py --check
```

Seed `12345` is compared with [`fixtures/golden/expected-t0.json`](../../fixtures/golden/expected-t0.json).

## Audio files

PCM WAV (8, 16, 24, or 32-bit) or 32-bit float WAV, same as the Unity player. Sample rates from 8000 to 192000 Hz are resampled to 44100 Hz stereo. Anything else is rejected when the package loads.
