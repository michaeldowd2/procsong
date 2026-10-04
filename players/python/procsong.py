#!/usr/bin/env python3
"""Play a procsong package from the command line.

Same package and seed as the web and Unity players: the same clip, mute,
start time, play length, and crop flag. Speakers use only the Python standard
library. YouTube Live is optional and needs ffmpeg on PATH.

The package is a zip archive named `.zip` or `.prcs` (or a Unity `.bytes`
rename).

    python players/python/procsong.py song.zip --seed 12345
    python players/python/procsong.py song.prcs --seed 12345
    python players/python/procsong.py https://www.dropbox.com/.../song.prcs --seed 12345
    python players/python/procsong.py song.zip --stream-key YOUR_KEY

The sections below follow that path: seed, definition, schedule, package
audio, mix, then speakers or YouTube.
"""

from __future__ import annotations

import atexit
import argparse
import array
import ctypes
import functools
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from ctypes import wintypes
from pathlib import Path

FORMAT_VERSION = "2.0.0"
RATE = 44100
BLOCK = 2048
FADE_FRAMES = int(round(0.008 * RATE))
FADE_Q = 1024
# 8-bit WAV is unsigned. (sample - 128) << 8 is the signed 16-bit value, and
# the high byte of that value is sample XOR 0x80.
_U8_BIAS = bytes(i ^ 0x80 for i in range(256))
MASK64 = (1 << 64) - 1
LCG_A = 6364136223846793005
LCG_C = 1442695040888963407
SEED_RE = re.compile(r"^[+-]?[0-9]+$")
CLIP_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
DEFAULT_STREAM_URL = "rtmp://a.rtmp.youtube.com/live2"
YOUTUBE_FPS = 30
YOUTUBE_WIDTH = 1280
YOUTUBE_HEIGHT = 720

# YouTube's published live encoder settings: H.264, AAC, CBR, keyframe every
# 2 seconds. 240p–720p at 30 fps lists 4000 kbps H.264 as the recommended rate.
# https://support.google.com/youtube/answer/2853702
YOUTUBE_VIDEO_BITRATE = "4000k"
YOUTUBE_AUDIO_BITRATE = "128k"
# One band across the middle of the still card. x264 recodes the blocks
# that change and skips the rest, which is what keeps a long stream close
# to the cost of a motionless picture. Height and Y are even for yuv420.
SPECTRUM_H = 128
SPECTRUM_Y = (YOUTUBE_HEIGHT - SPECTRUM_H) // 2
CARD_BG = (36, 58, 78)
CARD_INK = (236, 230, 220)
CARD_DIM = (186, 206, 216)
CARD_GOLD = (228, 180, 90)
CHOICE_LOG_LIMIT = 100


class ProcsongError(Exception):
    pass


# ---------------------------------------------------------------------------
# Seed and PRNG (spec §14)
# ---------------------------------------------------------------------------

def parse_seed(text) -> int:
    raw = "" if text is None else str(text).strip()
    if not raw:
        return 12345
    if not SEED_RE.fullmatch(raw):
        raise ProcsongError("Seed must be a decimal integer")
    return int(raw, 10) & MASK64


class Rng:
    def __init__(self, seed: int):
        self.state = seed & MASK64

    def next_float(self) -> float:
        self.state = (self.state * LCG_A + LCG_C) & MASK64
        return ((self.state >> 32) & 0xFFFFFFFF) / 4294967296.0


def at_least_one(n: float) -> int:
    if not math.isfinite(n):
        return 1
    value = math.floor(n + 0.5)
    return int(value) if value > 0 else 1


# ---------------------------------------------------------------------------
# YAML subset. Same idea as the Unity player's MiniYaml: block and flow
# maps/lists and scalars, duplicate keys rejected, no tags or anchors.
# List-item continuation indent follows the next line, so both 2-space and
# 4-space definitions load.
# ---------------------------------------------------------------------------

class Map(dict):
    """Insertion-ordered mapping that rejects a repeated key."""

    def add(self, key, value):
        if key in self:
            raise ProcsongError(f'Duplicate YAML key "{key}"')
        self[key] = value


def _strip_comment(text: str) -> str:
    in_quote = False
    quote = ""
    i = 0
    while i < len(text):
        ch = text[i]
        if in_quote:
            if ch == "\\" and quote == '"' and i + 1 < len(text):
                i += 2
                continue
            if ch == quote:
                in_quote = False
        elif ch in ('"', "'"):
            in_quote = True
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] == " "):
            return text[:i].rstrip()
        i += 1
    return text


def _preprocess(text: str):
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for row in text.split("\n"):
        pos = 0
        indent = 0
        while pos < len(row):
            if row[pos] == " ":
                indent += 1
                pos += 1
            elif row[pos] == "\t":
                indent += 2
                pos += 1
            else:
                break
        body = _strip_comment(row[pos:]).rstrip()
        if not body or body in ("---", "..."):
            continue
        lines.append((indent, body))
    return lines


def _try_split(text: str):
    in_quote = False
    quote = ""
    i = 0
    colon = -1
    while i < len(text):
        ch = text[i]
        if in_quote:
            if ch == "\\" and quote == '"' and i + 1 < len(text):
                i += 2
                continue
            if ch == quote:
                in_quote = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_quote = True
            quote = ch
            i += 1
            continue
        if ch == ":" and (i + 1 >= len(text) or text[i + 1] == " "):
            colon = i
            break
        i += 1
    if colon <= 0:
        return None
    key = _unquote(text[:colon].strip())
    if not key:
        return None
    value = text[colon + 1:].strip() if colon + 1 < len(text) else ""
    return key, value


def _unescape(text: str, quote: str) -> str:
    if quote == "'":
        return text.replace("''", "'")
    out = []
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "r":
                out.append("\r")
            else:
                out.append(nxt)
            i += 2
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def _unquote(text: str) -> str:
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        return _unescape(text[1:-1], text[0])
    return text


def _looks_numeric(text: str) -> bool:
    if not text:
        return False
    i = 0
    if text[0] in "+-":
        i += 1
    if i >= len(text):
        return False
    digit = False
    dot = False
    exp = False
    while i < len(text):
        ch = text[i]
        if "0" <= ch <= "9":
            digit = True
            i += 1
            continue
        if ch == "." and not dot and not exp:
            dot = True
            i += 1
            continue
        if ch in "eE" and digit and not exp:
            exp = True
            digit = False
            if i + 1 < len(text) and text[i + 1] in "+-":
                i += 1
            i += 1
            continue
        return False
    return digit


def _parse_scalar(text: str):
    if text in ("~", "null", "Null", "NULL"):
        return None
    if text in ("true", "True", "TRUE"):
        return True
    if text in ("false", "False", "FALSE"):
        return False
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        return _unescape(text[1:-1], text[0])
    if _looks_numeric(text):
        try:
            return float(text)
        except ValueError:
            pass
    return text


def _split_comma(text: str):
    items = []
    buf = []
    in_quote = False
    quote = ""
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if in_quote:
            buf.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < len(text):
                buf.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                in_quote = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_quote = True
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch in "[{":
            depth += 1
            buf.append(ch)
            i += 1
            continue
        if ch in "]}":
            depth -= 1
            buf.append(ch)
            i += 1
            continue
        if ch == "," and depth == 0:
            items.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if buf:
        items.append("".join(buf))
    return items


def _parse_inline(text: str):
    if not text:
        return None
    if text[0] == "[":
        return _parse_inline_list(text)
    if text[0] == "{":
        return _parse_inline_map(text)
    return _parse_scalar(text)


def _parse_inline_list(text: str):
    if text == "[]":
        return []
    if len(text) < 2 or text[-1] != "]":
        return _parse_scalar(text)
    out = []
    for item in _split_comma(text[1:-1]):
        item = item.strip()
        if item:
            out.append(_parse_inline(item))
    return out


def _parse_inline_map(text: str):
    mapping = Map()
    if text == "{}":
        return mapping
    if len(text) < 2 or text[-1] != "}":
        return _parse_scalar(text)
    for item in _split_comma(text[1:-1]):
        split = _try_split(item.strip())
        if split:
            key, val = split
            mapping.add(key, _parse_inline(val))
    return mapping


class _Parser:
    def __init__(self, lines):
        self.lines = lines
        self.i = 0

    def parse_value(self, min_indent):
        if self.i >= len(self.lines):
            return None
        indent, text = self.lines[self.i]
        if indent < min_indent:
            return None
        if text == "-" or text.startswith("- "):
            return self.parse_list(indent)
        if _try_split(text):
            return self.parse_map(indent, None)
        self.i += 1
        return _parse_scalar(text)

    def parse_map(self, indent, injected):
        mapping = Map()
        use_injected = injected is not None
        while True:
            if use_injected:
                use_injected = False
                text = injected
            else:
                if self.i >= len(self.lines):
                    break
                line_indent, text = self.lines[self.i]
                if line_indent != indent:
                    break
                if text == "-" or text.startswith("- "):
                    break
                self.i += 1
            split = _try_split(text)
            if not split:
                raise ProcsongError(f"Invalid YAML mapping line: {text}")
            key, val = split
            if not val:
                if self.i < len(self.lines):
                    next_indent = self.lines[self.i][0]
                    next_text = self.lines[self.i][1]
                    nested_list = next_text == "-" or next_text.startswith("- ")
                    if next_indent > indent or (next_indent == indent and nested_list):
                        parsed = self.parse_value(indent + 1 if next_indent > indent else indent)
                    else:
                        parsed = None
                else:
                    parsed = None
            else:
                parsed = _parse_inline(val)
            mapping.add(key, parsed)
        return mapping

    def parse_list(self, indent):
        items = []
        while self.i < len(self.lines):
            line_indent, text = self.lines[self.i]
            if line_indent != indent:
                break
            if text == "-":
                rest = ""
            elif text.startswith("- "):
                rest = text[2:]
            else:
                break
            self.i += 1
            if not rest:
                items.append(self.parse_value(indent + 1))
                continue
            if rest[0] in "{[":
                items.append(_parse_inline(rest))
                continue
            split = _try_split(rest)
            if split:
                _key, val = split
                child = indent + 2
                if val and self.i < len(self.lines) and self.lines[self.i][0] > indent:
                    child = self.lines[self.i][0]
                items.append(self.parse_map(child, rest))
            else:
                items.append(_parse_inline(rest))
        return items


def parse_yaml(text: str):
    if text is None:
        raise ProcsongError("definition.yml did not contain a mapping")
    return _Parser(_preprocess(text)).parse_value(0)


# ---------------------------------------------------------------------------
# Definition (spec §3–7, §17)
# ---------------------------------------------------------------------------

class Clip:
    def __init__(self, clip_id: str, path: str, weight: float):
        self.id = clip_id
        self.path = path
        self.weight = weight


class Matrix:
    def __init__(self, columns, rows):
        self.columns = columns
        self.rows = rows


class Track:
    def __init__(self, name, decl_index, loop_seconds, repeats, full_repeats, tail_fraction,
                 silence, clips, intra, inter):
        self.name = name
        self.decl_index = decl_index
        self.loop_seconds = loop_seconds
        self.repeats = repeats
        self.full_repeats = full_repeats
        self.tail_fraction = tail_fraction
        self.silence = silence
        self.clips = clips
        self.intra = intra
        self.inter = inter


def _describe(node) -> str:
    if node is None:
        return "null"
    if isinstance(node, bool):
        return "boolean"
    if isinstance(node, float):
        return "number"
    if isinstance(node, str):
        return "string"
    if isinstance(node, Map):
        return "mapping"
    if isinstance(node, list):
        return "sequence"
    return type(node).__name__


def _require_string(node, where: str) -> str:
    if not isinstance(node, str):
        raise ProcsongError(f"{where} must be a string (got {_describe(node)})")
    if not node or node.strip() != node:
        raise ProcsongError(f"{where} must be a non-empty string without leading/trailing whitespace")
    return node


def _require_clip_id(node, where: str) -> str:
    clip_id = _require_string(node, where)
    if not CLIP_ID_RE.fullmatch(clip_id):
        raise ProcsongError(f'{where} must match ^[A-Za-z0-9_.-]+$ (got "{clip_id}")')
    return clip_id


def _require_finite(
    node,
    where: str,
    *,
    minimum: float = 0.0,
    maximum: float = math.inf,
    exclusive_min: bool = False,
) -> float:
    if isinstance(node, bool) or node is None or isinstance(node, (Map, list)):
        raise ProcsongError(f"{where} must be a finite number")
    if isinstance(node, float):
        number = node
    elif isinstance(node, str):
        try:
            number = float(node)
        except ValueError:
            raise ProcsongError(f"{where} must be a finite number") from None
    else:
        raise ProcsongError(f"{where} must be a finite number")
    if not math.isfinite(number):
        raise ProcsongError(f"{where} must be a finite number")
    too_low = number <= minimum if exclusive_min else number < minimum
    if too_low or number > maximum:
        raise ProcsongError(f"{where} out of range")
    return number


def _reject_unknown(mapping: Map, allowed, where: str):
    allowed = set(allowed)
    for key in mapping.keys():
        if key not in allowed:
            raise ProcsongError(f'{where} has unknown key "{key}"')


def _parse_matrix(raw, track_name: str, kind: str):
    if raw is None:
        return None
    where = f'Track "{track_name}" {kind}'
    if not isinstance(raw, Map):
        raise ProcsongError(f"{where} must be a mapping with columns and rows")
    _reject_unknown(raw, ("columns", "rows"), where)
    columns_node = raw.get("columns")
    if not isinstance(columns_node, list):
        raise ProcsongError(f"{where} is missing a columns array")
    rows_node = raw.get("rows")
    if not isinstance(rows_node, Map):
        raise ProcsongError(f"{where} is missing a rows mapping")
    columns = []
    seen = set()
    for i, item in enumerate(columns_node):
        clip_id = _require_clip_id(item, f"{where} column #{i + 1}")
        if clip_id in seen:
            raise ProcsongError(f"{where} columns must be unique clip ids")
        seen.add(clip_id)
        columns.append(clip_id)
    rows = {}
    for key, values in rows_node.items():
        row_key = _require_clip_id(key, f"{where} row key")
        if not isinstance(values, list):
            raise ProcsongError(f'{where} row "{row_key}" must be an array')
        cells = []
        for i, cell in enumerate(values):
            cells.append(_require_finite(cell, f'{where} row "{row_key}" cell #{i + 1}'))
        rows[row_key] = cells
    return Matrix(columns, rows)


def _parse_clip(entry, track_name: str, index: int) -> Clip:
    where = f'Track "{track_name}" clip #{index + 1}'
    if isinstance(entry, str):
        raise ProcsongError(f"{where} must be a mapping with id and path (legacy path-only parts are not supported)")
    if not isinstance(entry, Map):
        raise ProcsongError(f"{where} must be a mapping with id and path")
    _reject_unknown(entry, ("id", "path", "weight"), where)
    clip_id = _require_clip_id(entry.get("id"), f"{where} id")
    path = _require_string(entry.get("path"), f'{where} ({clip_id}) path')
    if "weight" in entry:
        weight = _require_finite(entry.get("weight"), f'{where} ({clip_id}) weight')
    else:
        weight = 1.0
    return Clip(clip_id, path, weight)


def _parse_track(raw, index: int) -> Track:
    where = f"Track #{index + 1}"
    if not isinstance(raw, Map):
        raise ProcsongError(f"{where} must be a mapping")
    _reject_unknown(raw, (
        "name", "clip_length", "repeats", "silence_probability", "clips",
        "intragroup_subsequent_weight_modifiers", "intergroup_consecutive_weight_modifiers",
    ), where)
    name = _require_string(raw.get("name"), f"{where} name")
    if "/" in name:
        raise ProcsongError(f'Track "{name}" name must not contain "/"')
    if "clip_length" not in raw:
        raise ProcsongError(f'Track "{name}" is missing clip_length')
    clip_length = _require_finite(raw.get("clip_length"), f'Track "{name}" clip_length')
    repeats = _require_finite(raw.get("repeats"), f'Track "{name}" repeats', exclusive_min=True)
    full_repeats = int(math.floor(repeats))
    tail = repeats - full_repeats
    if "silence_probability" in raw:
        silence = _require_finite(raw.get("silence_probability"), f'Track "{name}" silence_probability', maximum=1)
    else:
        silence = 0.0
    clip_list = raw.get("clips")
    if not isinstance(clip_list, list) or not clip_list:
        raise ProcsongError(f'Track "{name}" must define a non-empty clips array')
    clips = [_parse_clip(entry, name, i) for i, entry in enumerate(clip_list)]
    return Track(
        name=name,
        decl_index=index,
        loop_seconds=at_least_one(clip_length),
        repeats=repeats,
        full_repeats=full_repeats,
        tail_fraction=tail,
        silence=silence,
        clips=clips,
        intra=_parse_matrix(raw.get("intragroup_subsequent_weight_modifiers"), name, "intragroup_subsequent_weight_modifiers"),
        inter=_parse_matrix(raw.get("intergroup_consecutive_weight_modifiers"), name, "intergroup_consecutive_weight_modifiers"),
    )


def _same_ids(left, right) -> bool:
    return set(left) == set(right)


def _validate(tracks):
    names = set()
    for track in tracks:
        if track.name in names:
            raise ProcsongError("Track names must be unique")
        names.add(track.name)
    owners = {}
    for track in tracks:
        for clip in track.clips:
            if clip.id in owners:
                raise ProcsongError(f'Clip id "{clip.id}" is used more than once (must be unique across the whole definition)')
            owners[clip.id] = track
    for track in tracks:
        clip_ids = [clip.id for clip in track.clips]
        if track.intra is not None:
            matrix = track.intra
            if matrix.columns != clip_ids:
                raise ProcsongError(f'Track "{track.name}" intra columns must equal its clip ids in declaration order')
            if not _same_ids(list(matrix.rows), clip_ids):
                raise ProcsongError(f'Track "{track.name}" intra rows must contain exactly one row for each clip id')
            for key, cells in matrix.rows.items():
                if len(cells) != len(matrix.columns):
                    raise ProcsongError(
                        f'Track "{track.name}" intra row "{key}" length must equal column count ({len(matrix.columns)})'
                    )
        if track.inter is None:
            continue
        matrix = track.inter
        if not _same_ids(list(matrix.rows), clip_ids):
            raise ProcsongError(f'Track "{track.name}" inter rows must contain exactly one row for each clip id')
        for key, cells in matrix.rows.items():
            if len(cells) != len(matrix.columns):
                raise ProcsongError(
                    f'Track "{track.name}" inter row "{key}" length must equal column count ({len(matrix.columns)})'
                )
        represented = []
        seen = set()
        for col in matrix.columns:
            owner = owners.get(col)
            if owner is None:
                raise ProcsongError(f'Track "{track.name}" inter column "{col}" is not a known clip id')
            if owner.decl_index >= track.decl_index:
                raise ProcsongError(f'Track "{track.name}" inter column "{col}" references clip on the same or a later track')
            if owner.decl_index not in seen:
                seen.add(owner.decl_index)
                represented.append(owner)
        for i in range(1, len(represented)):
            if represented[i].decl_index <= represented[i - 1].decl_index:
                raise ProcsongError(f'Track "{track.name}" inter columns must list upstream tracks in declaration order')
        expected = []
        for upstream in represented:
            expected.extend(clip.id for clip in upstream.clips)
        if matrix.columns != expected:
            raise ProcsongError(
                f'Track "{track.name}" inter columns must be the concatenation of each upstream track\'s clip ids '
                "in declaration order (contiguous blocks, no interleaving)"
            )


def parse_definition(text: str):
    raw = parse_yaml(text)
    if not isinstance(raw, Map):
        raise ProcsongError("definition.yml did not contain a mapping")
    _reject_unknown(raw, ("format_version", "tracks"), "definition.yml")
    version = raw.get("format_version")
    if not isinstance(version, str):
        raise ProcsongError("format_version must be a string")
    if version != FORMAT_VERSION:
        raise ProcsongError(
            f'Unsupported format_version "{version}" (expected {FORMAT_VERSION}). '
            "Legacy track-map definitions are not supported."
        )
    track_list = raw.get("tracks")
    if not isinstance(track_list, list) or not track_list:
        raise ProcsongError("definition.yml must contain a non-empty tracks array")
    tracks = [_parse_track(item, i) for i, item in enumerate(track_list)]
    _validate(tracks)
    return tracks


# ---------------------------------------------------------------------------
# Scheduler (spec §8–13)
# ---------------------------------------------------------------------------

class Pulse:
    def __init__(self):
        self.tick = 0
        self.track = None
        self.chosen_id = None
        self.chosen = None
        self.muted = True
        self.play_seconds = 0
        self.crop = False
        self.evaluated = False


class _Slot:
    def __init__(self, track: Track):
        self.track = track
        self.chosen_id = None
        self.chosen = None
        self.muted = True
        self.next_loop = 0
        self.remaining_full = 0
        self.tail_pending = False
        self.intra_col = None if track.intra is None else {clip_id: i for i, clip_id in enumerate(track.intra.columns)}
        self.inter_col = None if track.inter is None else {clip_id: i for i, clip_id in enumerate(track.inter.columns)}
        self.inter_represented = []


class Engine:
    def __init__(self, tracks, seed: int):
        self.tracks = tracks
        self.rng = Rng(seed)
        owners = {}
        for track in tracks:
            for clip in track.clips:
                owners[clip.id] = track.decl_index
        self.state = [_Slot(track) for track in tracks]
        for slot in self.state:
            if slot.track.inter is None:
                continue
            seen = set()
            for col in slot.track.inter.columns:
                owner_index = owners.get(col)
                if owner_index is None or owner_index in seen:
                    continue
                seen.add(owner_index)
                slot.inter_represented.append(self.state[owner_index])

    def peek_tick(self) -> int:
        return min(slot.next_loop for slot in self.state)

    def evaluate_due(self, tick: int):
        return [self._pulse(slot, tick) for slot in self.state if slot.next_loop == tick]

    def _intra(self, slot: _Slot, clip: Clip) -> float:
        if slot.chosen_id is None or slot.track.intra is None:
            return 1.0
        return slot.track.intra.rows[slot.chosen_id][slot.intra_col[clip.id]]

    def _inter(self, slot: _Slot, clip: Clip) -> float:
        if slot.track.inter is None:
            return 1.0
        row = slot.track.inter.rows[clip.id]
        result = 1.0
        for upstream in slot.inter_represented:
            if upstream.chosen_id is None:
                continue
            result *= row[slot.inter_col[upstream.chosen_id]]
        return result

    def _evaluate(self, slot: _Slot, pulse: Pulse):
        r_part = self.rng.next_float()
        r_silence = self.rng.next_float()
        clips = slot.track.clips
        weights = []
        total = 0.0
        for clip in clips:
            weight = clip.weight * self._intra(slot, clip) * self._inter(slot, clip)
            weights.append(weight)
            total += weight
        if total > 0:
            target = r_part * total
            running = 0.0
            selected = False
            for clip, weight in zip(clips, weights):
                running += weight
                if running > target:
                    pulse.chosen_id = clip.id
                    pulse.chosen = clip.path
                    selected = True
                    break
            if not selected:
                # Float rounding can step past the last positive weight.
                for clip, weight in zip(reversed(clips), reversed(weights)):
                    if weight > 0:
                        pulse.chosen_id = clip.id
                        pulse.chosen = clip.path
                        break
        pulse.muted = pulse.chosen is None or r_silence < slot.track.silence

    def _pulse(self, slot: _Slot, tick: int) -> Pulse:
        # Draw a new choice only after the previous one has finished its repeats.
        pulse = Pulse()
        if slot.remaining_full <= 0 and not slot.tail_pending:
            self._evaluate(slot, pulse)
            slot.chosen_id = pulse.chosen_id
            slot.chosen = pulse.chosen
            slot.muted = pulse.muted
            slot.remaining_full = slot.track.full_repeats
            slot.tail_pending = slot.track.tail_fraction > 0
            pulse.evaluated = True
        if slot.remaining_full > 0:
            pulse.play_seconds = slot.track.loop_seconds
            pulse.crop = False
            slot.remaining_full -= 1
        else:
            pulse.play_seconds = at_least_one(slot.track.tail_fraction * slot.track.loop_seconds)
            pulse.crop = True
            slot.tail_pending = False
        pulse.tick = tick
        pulse.track = slot.track
        pulse.chosen_id = slot.chosen_id
        pulse.chosen = slot.chosen
        pulse.muted = slot.muted
        slot.next_loop = tick + pulse.play_seconds
        return pulse


# ---------------------------------------------------------------------------
# Package and WAV (spec §3.2, §15)
# ---------------------------------------------------------------------------

class _Status:
    """One stderr line that updates in place, then ends on the way out."""

    def __init__(self):
        self.shown = False
        self._width = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.shown:
            print(file=sys.stderr)
            self.shown = False

    def update(self, message: str):
        self.shown = True
        self._width = max(self._width, len(message))
        print(message.ljust(self._width), file=sys.stderr, end="\r", flush=True)


# Spec ClipKey is ASCII-lowercase, not Unicode casefold.
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def clip_key(path: str) -> str:
    text = path.replace("\\", "/")
    slash = text.rfind("/")
    dot = text.rfind(".")
    if dot > slash:
        text = text[:dot]
    return text.translate(_ASCII_LOWER)


def _skip_zip_path(name: str) -> bool:
    parts = name.lower().split("/")
    if any(part == "__macosx" for part in parts):
        return True
    leaf = parts[-1] if parts else name
    return leaf == ".DS_Store" or leaf.startswith("._")


def _is_definition(name: str) -> bool:
    leaf = name.rsplit("/", 1)[-1]
    return leaf.lower() == "definition.yml"


def _normalize_url(text: str) -> str:
    text = text.strip()
    # A pasted link sometimes loses the leading h. The web player repairs that too.
    if text.lower().startswith("ttps://"):
        return "h" + text
    return text


def _looks_like_url(text: str) -> bool:
    return _normalize_url(text).lower().startswith(("http://", "https://"))


def direct_download_url(url: str) -> str:
    """Turn a Dropbox share link into a direct file URL. Other URLs pass through."""
    text = _normalize_url(url)
    parts = urllib.parse.urlsplit(text)
    host = (parts.hostname or "").lower()
    if host != "dropbox.com" and not host.endswith(".dropbox.com"):
        return text
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in ("st", "dl")
    ]
    query.append(("dl", "1"))
    netloc = "dl.dropboxusercontent.com"
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urllib.parse.urlunsplit(parts._replace(netloc=netloc, query=urllib.parse.urlencode(query)))


def _format_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB"):
        if value < 1024.0:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} GB"


def _download_zip(url: str) -> bytes:
    original = url.strip()
    direct = direct_download_url(original)
    print(f"procsong: downloading {original}", file=sys.stderr, flush=True)
    request = urllib.request.Request(direct, headers={"User-Agent": "procsong/2.0"})
    try:
        with _Status() as status:
            with urllib.request.urlopen(request, timeout=60) as response:
                try:
                    total = int(response.headers.get("Content-Length") or 0)
                except ValueError:
                    total = 0
                chunks = []
                received = 0
                while True:
                    block = response.read(256 * 1024)
                    if not block:
                        break
                    chunks.append(block)
                    received += len(block)
                    if total:
                        status.update(
                            f"procsong: downloading {_format_bytes(received)} / {_format_bytes(total)}"
                        )
                data = b"".join(chunks)
    except urllib.error.HTTPError as exc:
        raise ProcsongError(f"download failed: HTTP {exc.code} for {original}") from exc
    except urllib.error.URLError as exc:
        raise ProcsongError(f"download failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ProcsongError(f"download timed out: {original}") from exc
    if len(data) < 2 or data[:2] != b"PK":
        raise ProcsongError("downloaded data was not a zip file")
    print(f"procsong: downloaded {_format_bytes(len(data))}", file=sys.stderr, flush=True)
    return data


def load_package(source: str):
    source = source.strip()
    if _looks_like_url(source):
        return _read_zip(io.BytesIO(_download_zip(source)), source)
    if not os.path.isfile(source):
        raise ProcsongError(f"package not found: {source}")
    return _read_zip(source, source)


def _read_zip(source, label: str):
    try:
        archive = zipfile.ZipFile(source)
    except zipfile.BadZipFile as exc:
        raise ProcsongError(f"not a zip file: {label}") from exc
    except OSError as exc:
        raise ProcsongError(str(exc)) from exc
    with archive:
        files = []
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            if not name or name.endswith("/") or _skip_zip_path(name):
                continue
            files.append((name, info))
        definitions = [(name, info) for name, info in files if _is_definition(name)]
        if not definitions:
            raise ProcsongError("Zip does not contain definition.yml")
        if len(definitions) > 1:
            raise ProcsongError(f"Zip contains {len(definitions)} definition.yml files; exactly one is required")
        def_path, def_info = definitions[0]
        try:
            yaml_text = archive.read(def_info).decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ProcsongError("definition.yml must be UTF-8") from exc
        slash = def_path.rfind("/")
        root = "" if slash < 0 else def_path[:slash + 1]
        wanted = []
        for name, info in files:
            if name.lower() == def_path.lower():
                continue
            if root and not name.startswith(root):
                continue
            relative = name[len(root):]
            if relative:
                wanted.append((relative, info))
        clips = {}
        total = len(wanted)
        with _Status() as status:
            for index, (relative, info) in enumerate(wanted, 1):
                status.update(f"procsong: unpacking {index}/{total}")
                key = clip_key(relative)
                if key in clips:
                    raise ProcsongError(f'Zip contains duplicate audio key "{key}" after ClipKey normalization')
                clips[key] = archive.read(info)
    return yaml_text, clips


# Clips are interleaved stereo int16 at 44100 Hz. 24-bit and 32-bit integer
# audio keeps its top 16 bits with slice copies, so a large library does not
# walk every sample in Python.


def _zeros(typecode: str, count: int) -> array.array:
    out = array.array(typecode)
    out.frombytes(b"\x00" * (count * out.itemsize))
    return out


def _clamp_i16(value) -> int:
    if value > 32767:
        return 32767
    if value < -32768:
        return -32768
    return int(value)


def _i16_from_le(raw) -> array.array:
    out = array.array("h")
    out.frombytes(raw)
    if sys.byteorder != "little":
        out.byteswap()
    return out


def _float_to_i16(value: float) -> int:
    if math.isnan(value):
        return 0
    return _clamp_i16(value * 32767.0)


def _pcm_i16(raw: bytes, pos: int, bits: int) -> int:
    if bits == 8:
        return (raw[pos] - 128) << 8
    if bits == 16:
        return int.from_bytes(raw[pos:pos + 2], "little", signed=True)
    if bits == 24:
        return int.from_bytes(raw[pos + 1:pos + 3], "little", signed=True)
    return int.from_bytes(raw[pos + 2:pos + 4], "little", signed=True)


def _expand_stereo(raw: bytes, channels: int, low_byte: int, high_byte: int) -> array.array:
    """Copy two bytes from each sample into interleaved little-endian int16.

    16-bit uses bytes 0 and 1. 24-bit and 32-bit use the top two bytes.
    """
    width = high_byte + 1
    frame = width * channels
    frames = len(raw) // frame
    raw = raw[:frames * frame]
    out = bytearray(frames * 4)
    if channels == 1:
        low = raw[low_byte::width]
        high = raw[high_byte::width]
        out[0::4] = low
        out[1::4] = high
        out[2::4] = low
        out[3::4] = high
    else:
        right = frame // 2
        out[0::4] = raw[low_byte::frame]
        out[1::4] = raw[high_byte::frame]
        out[2::4] = raw[right + low_byte::frame]
        out[3::4] = raw[right + high_byte::frame]
    return _i16_from_le(out)


def _expand_u8(raw: bytes, channels: int) -> array.array:
    frames = len(raw) // channels
    raw = raw[:frames * channels]
    out = bytearray(frames * 4)
    if channels == 1:
        high = raw.translate(_U8_BIAS)
        out[1::4] = high
        out[3::4] = high
    else:
        out[1::4] = raw[0::2].translate(_U8_BIAS)
        out[3::4] = raw[1::2].translate(_U8_BIAS)
    return _i16_from_le(out)


def _downmix_pcm(raw: bytes, bits: int, channels: int) -> array.array:
    width = bits // 8
    frames = len(raw) // (width * channels)
    out = _zeros("h", frames * 2)
    for i in range(frames):
        total = 0
        base = i * channels * width
        for ch in range(channels):
            total += _pcm_i16(raw, base + ch * width, bits)
        mixed = _clamp_i16(total / channels)
        out[i * 2] = mixed
        out[i * 2 + 1] = mixed
    return out


def _float_to_stereo(data: bytes, offset: int, length: int, bits: int, channels: int) -> array.array:
    if bits != 32:
        raise ProcsongError("Only 32-bit float WAV is supported")
    frames = (length // 4) // channels
    samples = array.array("f")
    samples.frombytes(data[offset:offset + frames * channels * 4])
    if sys.byteorder != "little":
        samples.byteswap()
    out = _zeros("h", frames * 2)
    if channels == 1:
        for i in range(frames):
            value = _float_to_i16(samples[i])
            out[i * 2] = value
            out[i * 2 + 1] = value
    elif channels == 2:
        for i in range(frames * 2):
            out[i] = _float_to_i16(samples[i])
    else:
        for i in range(frames):
            total = 0.0
            base = i * channels
            for ch in range(channels):
                total += samples[base + ch]
            value = _float_to_i16(total / channels)
            out[i * 2] = value
            out[i * 2 + 1] = value
    return out


def _pcm_to_stereo(data: bytes, offset: int, length: int, bits: int, fmt: int, channels: int) -> array.array:
    if fmt == 3:
        return _float_to_stereo(data, offset, length, bits, channels)
    if fmt != 1:
        raise ProcsongError("Only PCM and IEEE-float WAV files are supported")
    if bits not in (8, 16, 24, 32):
        raise ProcsongError(f"Unsupported WAV bit depth {bits}")
    width = bits // 8
    frames = length // (width * channels)
    raw = data[offset:offset + frames * width * channels]
    if channels > 2:
        return _downmix_pcm(raw, bits, channels)
    if bits == 8:
        return _expand_u8(raw, channels)
    if bits == 16:
        return _expand_stereo(raw, channels, 0, 1)
    if bits == 24:
        return _expand_stereo(raw, channels, 1, 2)
    return _expand_stereo(raw, channels, 2, 3)


def _resample_audioop(stereo: array.array, src_rate: int):
    # audioop.ratecv is C. It was removed in Python 3.13.
    try:
        import audioop
    except ImportError:
        return None
    pcm = stereo.tobytes()
    if sys.byteorder != "little":
        swapped = array.array("h", stereo)
        swapped.byteswap()
        pcm = swapped.tobytes()
    converted, _state = audioop.ratecv(pcm, 2, 2, src_rate, RATE, None)
    if not converted:
        return None
    return _i16_from_le(converted)


def _resample_linear(stereo: array.array, frames: int, src_rate: int) -> array.array:
    dst_frames = max(1, int(round(frames * RATE / src_rate)))
    out = _zeros("h", dst_frames * 2)
    if frames == 1:
        out[0] = stereo[0]
        out[1] = stereo[1]
        return out
    ratio = src_rate / RATE
    last = frames - 1
    for i in range(dst_frames):
        pos = min(i * ratio, last)
        i0 = int(pos)
        i1 = i0 + 1 if i0 < last else last
        frac = pos - i0
        for ch in range(2):
            a = stereo[i0 * 2 + ch]
            b = stereo[i1 * 2 + ch]
            out[i * 2 + ch] = _clamp_i16(round(a + (b - a) * frac))
    return out


def _resample(stereo: array.array, frames: int, src_rate: int) -> array.array:
    if src_rate == RATE or frames <= 0:
        return stereo
    converted = _resample_audioop(stereo, src_rate)
    if converted is not None:
        return converted
    return _resample_linear(stereo, frames, src_rate)


def decode_wav(data: bytes, label: str):
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ProcsongError(f"Clip is not a PCM WAV file: {label}")
    pos = 12
    channels = sample_rate = bits = fmt = 0
    data_off = -1
    data_len = 0
    while pos + 8 <= len(data):
        chunk = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little", signed=True)
        if size < 0:
            break
        body = pos + 8
        if chunk == b"fmt " and size >= 16 and body + 16 <= len(data):
            fmt = int.from_bytes(data[body:body + 2], "little")
            channels = int.from_bytes(data[body + 2:body + 4], "little")
            sample_rate = int.from_bytes(data[body + 4:body + 8], "little", signed=True)
            bits = int.from_bytes(data[body + 14:body + 16], "little")
            if fmt == 0xFFFE and size >= 40 and body + 26 <= len(data):
                fmt = int.from_bytes(data[body + 24:body + 26], "little")
        elif chunk == b"data":
            data_off = body
            data_len = min(size, len(data) - body)
        pos = body + size + (size & 1)
    if data_off < 0 or channels <= 0 or sample_rate <= 0 or bits <= 0:
        raise ProcsongError(f"Invalid WAV header: {label}")
    if not (1 <= channels <= 8) or not (8000 <= sample_rate <= 192000):
        raise ProcsongError(f"Unsupported WAV layout: {label}")
    stereo = _pcm_to_stereo(data, data_off, data_len, bits, fmt, channels)
    if len(stereo) < 2:
        raise ProcsongError(f"WAV has no samples: {label}")
    return _resample(stereo, len(stereo) // 2, sample_rate)


def load_audio(tracks, blobs):
    needed = []
    seen = set()
    for track in tracks:
        for clip in track.clips:
            key = clip_key(clip.path)
            if key not in seen:
                seen.add(key)
                needed.append((clip.path, key))
    audio = {}
    total = len(needed)
    with _Status() as status:
        for index, (path, key) in enumerate(needed, 1):
            status.update(f"procsong: decoding {index}/{total}")
            blob = blobs.pop(key, None)
            if blob is None:
                raise ProcsongError(f'Package is missing audio for clip path key "{key}"')
            try:
                audio[key] = decode_wav(blob, path)
            except ProcsongError as exc:
                raise ProcsongError(f'Could not decode "{key}": {exc}') from exc
    return audio


# ---------------------------------------------------------------------------
# Mix
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=None)
def _fade_curve(length: int) -> array.array:
    curve = _zeros("i", length)
    if length <= 1:
        if length == 1:
            curve[0] = FADE_Q
        return curve
    half_pi = math.pi * 0.5
    span = length - 1
    for i in range(length):
        curve[i] = int(round(math.sin((i / span) * half_pi) * FADE_Q))
    curve[0] = 0
    curve[-1] = FADE_Q
    return curve


class Voice:
    def __init__(self, data, end: int, offset: int):
        self.data = data
        self.pos = 0
        self.end = end
        self.offset = offset
        self.fade = min(FADE_FRAMES, end // 2)
        self.curve = _fade_curve(self.fade) if self.fade > 1 else None


def _mix(acc, voice: Voice, nframes: int):
    offset = voice.offset
    voice.offset = 0
    count = nframes - offset
    remain = voice.end - voice.pos
    if remain < count:
        count = remain
    if count <= 0:
        return
    data = voice.data
    pos = voice.pos
    end = voice.end
    fade = voice.fade
    curve = voice.curve
    for i in range(count):
        si = pos + i
        di = si * 2
        left = data[di]
        right = data[di + 1]
        if fade > 1 and (si < fade or end - si <= fade):
            env = FADE_Q
            if si < fade:
                env = curve[si]
            left_n = end - si
            if left_n <= fade:
                env = env * curve[left_n - 1] // FADE_Q
            left = left * env // FADE_Q
            right = right * env // FADE_Q
        ai = (offset + i) * 2
        acc[ai] += left
        acc[ai + 1] += right
    voice.pos = pos + count


def _to_s16(acc, gain: float) -> bytes:
    out = _zeros("h", len(acc))
    for i, sample in enumerate(acc):
        out[i] = _clamp_i16(sample * gain)
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


def format_clock(seconds: int) -> str:
    hours, rem = divmod(int(seconds), 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}"


def format_choice(pulse: Pulse) -> str:
    clip = pulse.chosen if pulse.chosen else "-"
    notes = []
    if pulse.muted:
        notes.append("muted")
    if pulse.crop:
        notes.append("crop")
    extra = (" " + " ".join(notes)) if notes else ""
    return f"{pulse.track.name}: {clip}{extra}"


def format_row(tick: int, pulses) -> str:
    return f"{format_clock(tick):>9}  " + " | ".join(format_choice(pulse) for pulse in pulses)


def _fit_columns(text: str, cols: int) -> str:
    text = text.replace("\t", " ").replace("\n", " ")
    if len(text) <= cols:
        return text
    if cols <= 3:
        return text[:cols]
    return text[: cols - 3] + "..."


def _console_vt() -> bool:
    """True when stdout is a terminal that can redraw in place."""
    try:
        if not sys.stdout.isatty():
            return False
    except Exception:
        return False
    if sys.platform != "win32":
        return True
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetConsoleMode.restype = wintypes.BOOL
    kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.SetConsoleMode.restype = wintypes.BOOL
    handle = kernel.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
    mode = wintypes.DWORD()
    if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
        return False
    enable = 0x0004  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    if mode.value & enable:
        return True
    return bool(kernel.SetConsoleMode(handle, mode.value | enable))


class _ChoiceLog:
    """Latest choices. A terminal redraws one screen so a long run does not fill scrollback.

    Redirected stdout still appends every line, so a log file keeps the whole schedule.
    """

    def __init__(self, caption: str):
        self.caption = caption
        self.lines = []
        self.footer = ""
        self.uses_screen = _console_vt()
        self._lock = threading.Lock()
        self._alt = False
        self._opened = False
        if self.uses_screen:
            atexit.register(self.close)

    def note(self, line: str):
        self._record(line, footer=True)

    def add(self, line: str):
        self._record(line, footer=False)

    def _record(self, line: str, footer: bool):
        with self._lock:
            if not self.uses_screen:
                print(line, file=sys.stderr if footer else sys.stdout, flush=True)
                return
            if footer:
                self.footer = line
            else:
                self.lines.append(line)
                del self.lines[:-CHOICE_LOG_LIMIT]
            if self._opened:
                self._paint()

    def open(self):
        with self._lock:
            if not self.uses_screen or self._alt:
                return
            self._alt = True
            self._opened = True
            # Alternate screen: the shell's scrollback stays where it was.
            sys.stdout.write("\033[?1049h\033[?25l\033[?7l")
            sys.stdout.flush()
            self._paint()

    def close(self):
        with self._lock:
            if not self._alt:
                return
            self._alt = False
            self._opened = False
            snapshot = list(self.lines)
            sys.stdout.write("\033[?7h\033[?25h\033[?1049l")
            sys.stdout.flush()
        try:
            atexit.unregister(self.close)
        except Exception:
            pass
        # Leave the latest choices in the normal scrollback once playback stops.
        for line in snapshot:
            try:
                print(line, flush=True)
            except (BrokenPipeError, OSError):
                return

    def _paint(self):
        cols, rows = shutil.get_terminal_size(fallback=(80, 24))
        cols = max(16, cols - 1)  # stay inside the width so the line does not wrap
        capacity = max(1, rows - 1)
        header = [
            _fit_columns(self.caption, cols),
            _fit_columns(
                f"Latest {CHOICE_LOG_LIMIT} choices. Repeats are not listed. Ctrl+C to stop.",
                cols,
            ),
            "",
        ]
        footer = ["", _fit_columns(self.footer, cols)] if self.footer else []
        room = max(1, capacity - len(header) - len(footer))
        visible = self.lines[-min(CHOICE_LOG_LIMIT, room):]
        block = header + [_fit_columns(line, cols) for line in visible] + footer
        block = block[:capacity]
        parts = ["\033[H"]
        last = len(block) - 1
        for index, line in enumerate(block):
            parts.append("\033[2K")
            parts.append(line)
            # A newline on the bottom row would scroll and grow scrollback.
            if index != last:
                parts.append("\n")
        parts.append("\033[J")
        try:
            sys.stdout.write("".join(parts))
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            self._opened = False
            self.uses_screen = False


def play(engine: Engine, audio, sink, gain: float, seconds: float, caption: str):
    """Mix the schedule in realtime. New picks that share a second print on one line."""
    limit = max(1, int(seconds * RATE)) if seconds > 0 else 0
    voices = []
    frame = 0
    log = _ChoiceLog(caption)
    if isinstance(sink, _PipeSink) and log.uses_screen:
        sink.on_line = log.note
    try:
        log.open()
        while limit <= 0 or frame < limit:
            nframes = BLOCK if limit <= 0 else min(BLOCK, limit - frame)
            end = frame + nframes
            while True:
                tick = engine.peek_tick()
                tick_frame = tick * RATE
                if tick_frame >= end:
                    break
                due = engine.evaluate_due(tick)
                fresh = [pulse for pulse in due if pulse.evaluated]
                if fresh:
                    try:
                        log.add(format_row(tick, fresh))
                    except BrokenPipeError:
                        return
                for pulse in due:
                    if pulse.muted or not pulse.chosen:
                        continue
                    data = audio[clip_key(pulse.chosen)]
                    dur = len(data) // 2
                    if pulse.crop:
                        dur = min(dur, pulse.play_seconds * RATE)
                    if dur <= 0:
                        continue
                    voices.append(Voice(data, dur, tick_frame - frame))
            acc = _zeros("q", nframes * 2)
            alive = []
            for voice in voices:
                _mix(acc, voice, nframes)
                if voice.pos < voice.end:
                    alive.append(voice)
            voices = alive
            sink.write(_to_s16(acc, gain))
            frame = end
    except KeyboardInterrupt:
        return
    finally:
        log.close()
        sink.close()


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

class _PipeSink:
    def __init__(self, args, label: str):
        self.label = label
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._lines = []
        self.on_line = None
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self):
        stderr = self.proc.stderr
        if stderr is None:
            return
        for raw in stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            self._lines.append(line)
            if len(self._lines) > 40:
                del self._lines[:-40]
            message = f"{self.label}: {line}"
            callback = self.on_line
            if callback is not None:
                callback(message)
            else:
                print(message, file=sys.stderr, flush=True)

    def _died(self) -> str:
        tail = "; ".join(self._lines[-8:]) or "no message"
        return f"{self.label} stopped ({tail})"

    def write(self, pcm: bytes):
        proc = self.proc
        if proc is None or proc.poll() is not None:
            raise ProcsongError(self._died())
        try:
            proc.stdin.write(pcm)
        except (BrokenPipeError, OSError) as exc:
            raise ProcsongError(self._died()) from exc

    def close(self):
        proc = self.proc
        self.proc = None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass


# 5x7 glyphs, one character per line: the character, a space, then 7 rows of
# 5 pixels joined by '/'. '#' is ink. Built in so the card needs no font file.
_GLYPHS = r"""
A .###./#...#/#...#/#####/#...#/#...#/#...#
B ####./#...#/#...#/####./#...#/#...#/####.
C .####/#..../#..../#..../#..../#..../.####
D ####./#...#/#...#/#...#/#...#/#...#/####.
E #####/#..../#..../####./#..../#..../#####
F #####/#..../#..../####./#..../#..../#....
G .####/#..../#..../#.###/#...#/#...#/.####
H #...#/#...#/#...#/#####/#...#/#...#/#...#
I #####/..#../..#../..#../..#../..#../#####
J ..###/...#./...#./...#./#..#./#..#./.##..
K #...#/#..#./#.#../##.../#.#../#..#./#...#
L #..../#..../#..../#..../#..../#..../#####
M #...#/##.##/#.#.#/#...#/#...#/#...#/#...#
N #...#/##..#/#.#.#/#..##/#...#/#...#/#...#
O .###./#...#/#...#/#...#/#...#/#...#/.###.
P ####./#...#/#...#/####./#..../#..../#....
Q .###./#...#/#...#/#...#/#.#.#/#..#./.##.#
R ####./#...#/#...#/####./#.#../#..#./#...#
S .####/#..../#..../.###./....#/....#/####.
T #####/..#../..#../..#../..#../..#../..#..
U #...#/#...#/#...#/#...#/#...#/#...#/.###.
V #...#/#...#/#...#/#...#/#...#/.#.#./..#..
W #...#/#...#/#...#/#...#/#.#.#/##.##/#...#
X #...#/#...#/.#.#./..#../.#.#./#...#/#...#
Y #...#/#...#/.#.#./..#../..#../..#../..#..
Z #####/....#/...#./..#../.#.../#..../#####
0 .###./#...#/#..##/#.#.#/##..#/#...#/.###.
1 ..#../.##../..#../..#../..#../..#../.###.
2 .###./#...#/....#/...#./..#../.#.../#####
3 .###./#...#/....#/..##./....#/#...#/.###.
4 ...#./..##./.#.#./#..#./#####/...#./...#.
5 #####/#..../####./....#/....#/#...#/.###.
6 .###./#..../#..../####./#...#/#...#/.###.
7 #####/....#/...#./..#../.#.../.#.../.#...
8 .###./#...#/#...#/.###./#...#/#...#/.###.
9 .###./#...#/#...#/.####/....#/....#/.###.
a ...../...../.###./....#/.####/#...#/.####
b #..../#..../####./#...#/#...#/#...#/####.
c ...../...../.####/#..../#..../#..../.####
d ....#/....#/.####/#...#/#...#/#...#/.####
e ...../...../.###./#...#/#####/#..../.####
f ..##./.#..#/.#.../###../.#.../.#.../.#...
g ...../...../.####/#...#/.####/....#/.###.
h #..../#..../####./#...#/#...#/#...#/#...#
i ..#../...../.##../..#../..#../..#../.###.
j ...#./...../..##./...#./...#./#..#./.##..
k #..../#..../#..#./#.#../##.../#.#../#..#.
l .#.../.#.../.#.../.#.../.#.../.#..#/..##.
m ...../...../##.#./#.#.#/#.#.#/#...#/#...#
n ...../...../####./#...#/#...#/#...#/#...#
o ...../...../.###./#...#/#...#/#...#/.###.
p ...../...../####./#...#/####./#..../#....
q ...../...../.####/#...#/.####/....#/....#
r ...../...../#.##./##..#/#..../#..../#....
s ...../...../.####/#..../.###./....#/####.
t .#.../.#.../###../.#.../.#.../.#..#/..##.
u ...../...../#...#/#...#/#...#/#..##/.###.
v ...../...../#...#/#...#/#...#/.#.#./..#..
w ...../...../#...#/#...#/#.#.#/#.#.#/.#.#.
x ...../...../#...#/.#.#./..#../.#.#./#...#
y ...../...../#...#/#...#/.####/....#/.###.
z ...../...../#####/...#./..#../.#.../#####
! ..#../..#../..#../..#../..#../...../..#..
" .#.#./.#.#./.#.#./...../...../...../.....
# .#.#./#####/.#.#./.#.#./#####/.#.#./.....
$ ..#../.####/#.#../.###./..#.#/####./..#..
% ##.../##..#/...#./..#../.#.../#..##/...##
& .##../#..#./.#.../.#.#./#.#.#/#..#./.##.#
' ..#../..#../..#../...../...../...../.....
( ..##./.#.../#..../#..../#..../.#.../..##.
) .##../...#./....#/....#/....#/...#./.##..
* ..#../#.#.#/.###./#.#.#/..#../...../.....
+ ...../..#../..#../#####/..#../..#../.....
, ...../...../...../...../..#../..#../.#...
- ...../...../...../.###./...../...../.....
. ...../...../...../...../...../..#../..#..
/ ....#/....#/...#./..#../.#.../#..../#....
: ...../..#../..#../...../..#../..#../.....
; ...../..#../..#../...../..#../..#../.#...
< ....#/...#./..#../.#.../..#../...#./....#
= ...../...../#####/...../#####/...../.....
> #..../.#.../..#../...#./..#../.#.../#....
? .###./#...#/...#./..#../..#../...../..#..
@ .###./#...#/#.#.#/#.#.#/#.##./#..../.####
[ .###./.#.../.#.../.#.../.#.../.#.../.###.
\ #..../#..../.#.../..#../...#./....#/....#
] .###./...#./...#./...#./...#./...#./.###.
^ ..#../.#.#./#...#/...../...../...../.....
_ ...../...../...../...../...../...../#####
` ..#../..#../...#./...../...../...../.....
{ ..##./.#.../.#.../#..../.#.../.#.../..##.
| ..#../..#../..#../..#../..#../..#../..#..
} .##../...#./...#./....#/...#./...#./.##..
~ ...../...../.#.#./#.#../...../...../.....
"""


@functools.lru_cache(maxsize=1)
def _glyph_font() -> dict:
    font = {" ": (0, 0, 0, 0, 0)}
    for raw in _GLYPHS.splitlines():
        if not raw.strip():
            continue
        ch = raw[0]
        rows = raw[2:].split("/")
        if len(rows) != 7 or any(len(row) != 5 for row in rows):
            raise ProcsongError(f"glyph {ch!r} must be 7 rows of 5")
        cols = [0, 0, 0, 0, 0]
        for y, row in enumerate(rows):
            for x, pixel in enumerate(row):
                if pixel == "#":
                    cols[x] |= 1 << y
                elif pixel != ".":
                    raise ProcsongError(f"glyph {ch!r} has {pixel!r}")
        font[ch] = tuple(cols)
    for ch in "ABCDEFabcdef0123456789.;-_":
        if ch not in font:
            raise ProcsongError(f"font is missing {ch!r}")
    return font


def _gap(scale: int) -> int:
    return max(2, scale // 2)


def _measure(text: str, scale: int) -> int:
    if not text:
        return 0
    return len(text) * (5 * scale + _gap(scale)) - _gap(scale)


def _ink(text: str, font) -> str:
    cleaned = text.replace("\n", " ").replace("\t", " ")
    return "".join(ch if ch in font else "?" for ch in cleaned)


def _truncate(text: str, scale: int, max_width: int, font) -> str:
    text = _ink(text, font)
    if _measure(text, scale) <= max_width:
        return text
    ellipsis = "..."
    while text and _measure(text + ellipsis, scale) > max_width:
        text = text[:-1]
    return text + ellipsis if text else ellipsis


def _fit_line(text: str, max_width: int, preferred: int, minimum: int, font):
    text = _ink(text, font)
    for scale in range(preferred, minimum - 1, -1):
        if _measure(text, scale) <= max_width:
            return text, scale
    return _truncate(text, minimum, max_width, font), minimum


def _pack_names(names, scale: int, max_width: int, font) -> list:
    lines = []
    current = ""
    for name in names:
        piece = _truncate(name, scale, max_width, font)
        nxt = piece if not current else current + "   " + piece
        if current and _measure(nxt, scale) > max_width:
            lines.append(current)
            current = piece
        else:
            current = nxt
    if current:
        lines.append(current)
    return lines


def _layout_tracks(names, max_width: int, max_lines: int, font):
    for scale in (3, 2):
        lines = _pack_names(names, scale, max_width, font)
        if len(lines) <= max_lines:
            return lines, scale
    lines = _pack_names(names, 2, max_width, font)[:max_lines]
    if lines:
        lines[-1] = _truncate(lines[-1] + " ...", 2, max_width, font)
    return lines, 2


def _canvas(width: int, height: int, rgb) -> bytearray:
    return bytearray(bytes(rgb) * (width * height))


def _fill_rect(buf, width: int, height: int, x: int, y: int, w: int, h: int, rgb):
    if w <= 0 or h <= 0:
        return
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(width, x + w)
    y1 = min(height, y + h)
    if x0 >= x1 or y0 >= y1:
        return
    stride = width * 3
    span = bytes(rgb) * (x1 - x0)
    for yy in range(y0, y1):
        start = yy * stride + x0 * 3
        buf[start:start + len(span)] = span


def _draw_text(buf, width: int, height: int, x: int, y: int, text: str, scale: int, rgb, font) -> int:
    gap = _gap(scale)
    stride = width * 3
    ink = bytes(rgb)
    for ch in text:
        cols = font.get(ch)
        if cols is None:
            cols = font.get("?", (0, 0, 0, 0, 0))
        for cx, bits in enumerate(cols):
            if not bits:
                continue
            px0 = x + cx * scale
            for cy in range(7):
                if (bits >> cy) & 1 == 0:
                    continue
                py0 = y + cy * scale
                for dy in range(scale):
                    py = py0 + dy
                    if not 0 <= py < height:
                        continue
                    row = py * stride
                    x0 = px0 if px0 > 0 else 0
                    x1 = px0 + scale if px0 + scale < width else width
                    if x0 < x1:
                        buf[row + x0 * 3:row + x1 * 3] = ink * (x1 - x0)
        x += 5 * scale + gap
    return x - gap


def _draw_centered(buf, width, height, y, text, scale, rgb, font):
    _draw_text(buf, width, height, (width - _measure(text, scale)) // 2, y, text, scale, rgb, font)


def _png_bytes(width: int, height: int, rgb: bytearray) -> bytes:
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        start = y * stride
        raw.extend(rgb[start:start + stride])

    def chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def _count_phrase(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def package_title(source: str) -> str:
    """Leaf name of a package path or URL, without .zip, .prcs, or .bytes."""
    text = source.strip()
    if _looks_like_url(text):
        leaf = urllib.parse.unquote(urllib.parse.urlsplit(text).path)
        leaf = leaf.rstrip("/").rsplit("/", 1)[-1]
    else:
        leaf = os.path.basename(text)
    lower = leaf.lower()
    for suffix in (".zip", ".prcs", ".bytes"):
        if lower.endswith(suffix):
            leaf = leaf[:-len(suffix)]
            break
    return leaf.strip() or "procsong"


def song_title(source: str, given: str) -> str:
    """The name on the picture. A given name wins; otherwise it comes from the file or URL."""
    text = "" if given is None else str(given).strip()
    if text:
        return text
    return package_title(source)


def _card_png(title: str, seed_text: str, track_names, clip_count: int, draw_bar: bool) -> bytes:
    """Still 1280x720 card. Text stays out of the center band, which a spectrum may cover."""
    width, height = YOUTUBE_WIDTH, YOUTUBE_HEIGHT
    font = _glyph_font()
    buf = _canvas(width, height, CARD_BG)
    margin = 64
    max_width = width - margin * 2
    if draw_bar:
        # Same light bar as the old frame, so a preview is obviously a picture.
        bar = tuple(min(255, channel + 150) for channel in CARD_BG)
        _fill_rect(buf, width, height, 0, height // 2 - 8, width, 16, bar)
    else:
        _fill_rect(buf, width, height, 0, SPECTRUM_Y - 8, width, 3, CARD_GOLD)
        _fill_rect(buf, width, height, 0, SPECTRUM_Y + SPECTRUM_H + 5, width, 3, CARD_GOLD)

    word = "PROCSONG"
    version = FORMAT_VERSION
    word_scale = 3
    group = _measure(word, word_scale) + 16 + _measure(version, word_scale)
    x = (width - group) // 2
    x = _draw_text(buf, width, height, x, 58, word, word_scale, CARD_GOLD, font)
    _draw_text(buf, width, height, x + 16, 58, version, word_scale, CARD_DIM, font)

    title_text, title_scale = _fit_line(title, max_width, 7, 4, font)
    _draw_centered(buf, width, height, 112, title_text, title_scale, CARD_INK, font)

    meta = (
        f"seed {seed_text}    "
        f"{_count_phrase(len(track_names), 'track', 'tracks')}    "
        f"{_count_phrase(clip_count, 'clip', 'clips')}"
    )
    meta_text, meta_scale = _fit_line(meta, max_width, 3, 2, font)
    _draw_centered(buf, width, height, 112 + 7 * title_scale + 22, meta_text, meta_scale, CARD_DIM, font)
    # y=216 through about y=264 is left empty. ffmpeg draws the running clock there.

    track_top = SPECTRUM_Y + SPECTRUM_H + 36
    track_lines, track_scale = _layout_tracks(track_names, max_width, 8, font)
    pitch = 7 * track_scale + _gap(track_scale) + 4
    for index, line in enumerate(track_lines):
        y = track_top + index * pitch
        if y + 7 * track_scale > height - 36:
            break
        _draw_centered(buf, width, height, y, line, track_scale, CARD_INK, font)
    return _png_bytes(width, height, buf)


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise ProcsongError(
            "ffmpeg was not found on PATH. YouTube Live only accepts an H.264 + AAC "
            "stream, which Python cannot encode by itself. Install ffmpeg and try again."
        )
    return exe


def _clock_font() -> str:
    """A font ffmpeg can draw. The clock is painted per frame, so it cannot live in the still card."""
    if sys.platform == "win32":
        fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
        names = [
            os.path.join(fonts, "consola.ttf"),
            os.path.join(fonts, "cour.ttf"),
            os.path.join(fonts, "arial.ttf"),
            os.path.join(fonts, "segoeui.ttf"),
        ]
    else:
        names = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        ]
    for path in names:
        if os.path.isfile(path):
            return path
    return ""


def _rgb_hex(rgb) -> str:
    return "{:02X}{:02X}{:02X}".format(*rgb)


def _clock_filter(fontfile: str) -> str:
    # Same shape as the terminal clock: hours keep growing, minutes and seconds are two digits.
    # Commas would split the filtergraph, so the minute and second fields avoid mod().
    text = (
        "%{eif\\:t/3600\\:d}"
        "\\:%{eif\\:t/60-floor(t/3600)*60\\:d\\:2}"
        "\\:%{eif\\:t-floor(t/60)*60\\:d\\:2}"
    )
    path = fontfile.replace("\\", "/").replace(":", "\\:")
    # y=216 sits in the gap between the seed line and the center band.
    return (
        f"drawtext=fontfile='{path}':text='{text}':fontsize=48:"
        f"fontcolor=0x{_rgb_hex(CARD_INK)}:x=(w-text_w)/2:y=216"
    )


def _video_graph(spectrum: bool, fontfile: str) -> str:
    """Filter graph for the picture. Empty when the card can be mapped as a still."""
    clock = _clock_filter(fontfile) if fontfile else ""
    if spectrum:
        # overlap is 1 - hop/window. The default of 1 runs an FFT per sample, which
        # is not cheap enough to leave on for weeks. 0.5 is about one FFT per frame.
        # colorkey drops the filter's black field so the bars sit on the card.
        head = (
            "[0:a]asplit=2[a][vis];"
            f"[vis]showfreqs=s={YOUTUBE_WIDTH}x{SPECTRUM_H}:mode=bar:fscale=log:"
            f"ascale=sqrt:win_size=2048:overlap=0.5:averaging=2:colors=0x{_rgb_hex(CARD_GOLD)}:"
            f"cmode=combined:rate={YOUTUBE_FPS},"
            "colorkey=black:similarity=0.08:blend=0[spec];"
            f"[1:v][spec]overlay=0:{SPECTRUM_Y}:format=auto"
        )
        if clock:
            return head + f",format=rgb24,{clock},format=yuv420p[v]"
        return head + ",format=yuv420p[v]"
    if clock:
        return f"[1:v]{clock},format=yuv420p[v]"
    return ""


def _graph_works(exe: str, spectrum: bool, fontfile: str) -> bool:
    """Try the picture graph locally before opening the ingest."""
    graph = _video_graph(spectrum, fontfile)
    if not graph:
        return True
    cmd = [
        exe, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", f"sine=frequency=220:sample_rate={RATE}:duration=1",
        "-f", "lavfi", "-i", f"color=c=0x{_rgb_hex(CARD_BG)}:s={YOUTUBE_WIDTH}x{YOUTUBE_HEIGHT}:r={YOUTUBE_FPS}",
        "-filter_complex", graph,
        "-map", "[v]",
    ]
    if spectrum:
        cmd += ["-map", "[a]"]
    else:
        cmd += ["-map", "0:a:0"]
    cmd += ["-frames:v", "1", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def _ffmpeg_command(exe: str, png: str, target: str, spectrum: bool, fontfile: str):
    # H.264 + AAC, CBR, keyframe every 2 seconds. The picture is required
    # because YouTube rejects audio-only. -re reads the audio pipe in realtime.
    gop = str(YOUTUBE_FPS * 2)
    command = [
        exe, "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-thread_queue_size", "1024",
        "-re", "-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0",
        "-thread_queue_size", "64",
        "-loop", "1", "-framerate", str(YOUTUBE_FPS), "-i", png,
    ]
    graph = _video_graph(spectrum, fontfile)
    if graph:
        command += ["-filter_complex", graph, "-map", "[v]"]
        command += ["-map", "[a]" if spectrum else "0:a:0"]
    else:
        command += ["-map", "1:v:0", "-map", "0:a:0"]
    command += ["-c:v", "libx264", "-preset", "veryfast"]
    # stillimage smears a clock that changes every second.
    if not spectrum and not fontfile:
        command += ["-tune", "stillimage"]
    command += [
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
        "-b:v", YOUTUBE_VIDEO_BITRATE, "-maxrate", YOUTUBE_VIDEO_BITRATE, "-bufsize", "8000k",
        "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
        "-x264-params", "nal-hrd=cbr:force-cfr=1:open-gop=0",
        "-c:a", "aac", "-b:a", YOUTUBE_AUDIO_BITRATE, "-ar", str(RATE), "-ac", "2",
        "-shortest", "-muxdelay", "0", "-muxpreload", "0",
        "-f", "flv", "-flvflags", "no_duration_filesize",
        target,
    ]
    return command


def _picture_mode(exe: str):
    """Spectrum and clock when ffmpeg can draw them, otherwise the still card."""
    font = _clock_font()
    candidates = []
    if font:
        candidates.append((True, font))
    candidates.append((True, ""))
    if font:
        candidates.append((False, font))
    for spectrum, fontfile in candidates:
        if _graph_works(exe, spectrum, fontfile):
            return spectrum, fontfile
    return False, ""


class YoutubeSink(_PipeSink):
    """H.264 + AAC FLV to an RTMP(S) ingest. YouTube rejects audio-only streams."""

    def __init__(self, target: str, title: str, seed_text: str, track_names, clip_count: int):
        exe = _ffmpeg()
        print("procsong: preparing the picture", file=sys.stderr, flush=True)
        self.spectrum, font = _picture_mode(exe)
        self.clock = bool(font)
        self.png = None
        fd, self.png = tempfile.mkstemp(prefix="procsong-", suffix=".png")
        try:
            try:
                os.write(fd, _card_png(title, seed_text, track_names, clip_count, draw_bar=not self.spectrum))
            finally:
                os.close(fd)
            super().__init__(_ffmpeg_command(exe, self.png, target, self.spectrum, font), "ffmpeg")
        except Exception:
            self._remove_temp()
            raise
        try:
            self.proc.wait(timeout=0.4)
        except subprocess.TimeoutExpired:
            return
        self._thread.join(timeout=0.5)
        message = self._died()
        self.close()
        raise ProcsongError(message)

    def close(self):
        super().close()
        self._remove_temp()

    def _remove_temp(self):
        path = self.png
        self.png = None
        if path:
            try:
                os.remove(path)
            except OSError:
                pass


WAVE_MAPPER = 0xFFFFFFFF
WHDR_DONE = 0x1
WHDR_PREPARED = 0x2
_PA_SAMPLE_S16LE = 3
_PA_STREAM_PLAYBACK = 1


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD),
    ]


class WAVEHDR(ctypes.Structure):
    _fields_ = [
        ("lpData", ctypes.c_void_p),
        ("dwBufferLength", wintypes.DWORD),
        ("dwBytesRecorded", wintypes.DWORD),
        ("dwUser", ctypes.c_void_p),
        ("dwFlags", wintypes.DWORD),
        ("dwLoops", wintypes.DWORD),
        ("lpNext", ctypes.c_void_p),
        ("reserved", ctypes.c_void_p),
    ]


class _PulseSpec(ctypes.Structure):
    _fields_ = [
        ("format", ctypes.c_int),
        ("rate", ctypes.c_uint32),
        ("channels", ctypes.c_uint8),
    ]


class _PulseBuffer(ctypes.Structure):
    _fields_ = [
        ("maxlength", ctypes.c_uint32),
        ("tlength", ctypes.c_uint32),
        ("prebuf", ctypes.c_uint32),
        ("minreq", ctypes.c_uint32),
        ("fragsize", ctypes.c_uint32),
    ]


class _WaveSlot:
    def __init__(self, nbytes: int):
        self.buf = ctypes.create_string_buffer(nbytes)
        self.hdr = WAVEHDR()
        self.hdr.lpData = ctypes.addressof(self.buf)
        self.hdr.dwBufferLength = nbytes
        self.busy = False


def _load_winmm():
    winmm = ctypes.WinDLL("winmm")
    handle = ctypes.c_void_p
    header = ctypes.POINTER(WAVEHDR)
    winmm.waveOutOpen.argtypes = [
        ctypes.POINTER(handle), wintypes.UINT, ctypes.POINTER(WAVEFORMATEX),
        ctypes.c_size_t, ctypes.c_size_t, wintypes.DWORD,
    ]
    winmm.waveOutOpen.restype = wintypes.UINT
    for name in ("waveOutPrepareHeader", "waveOutUnprepareHeader", "waveOutWrite"):
        fn = getattr(winmm, name)
        fn.argtypes = [handle, header, wintypes.UINT]
        fn.restype = wintypes.UINT
    winmm.waveOutReset.argtypes = [handle]
    winmm.waveOutReset.restype = wintypes.UINT
    winmm.waveOutClose.argtypes = [handle]
    winmm.waveOutClose.restype = wintypes.UINT
    return winmm


class WaveOutSink:
    """Windows speakers via winmm. No extra install."""

    def __init__(self):
        self._winmm = _load_winmm()
        self._handle = ctypes.c_void_p()
        self._slots = []
        fmt = self._format()
        rc = self._winmm.waveOutOpen(ctypes.byref(self._handle), WAVE_MAPPER, ctypes.byref(fmt), 0, 0, 0)
        if rc != 0:
            raise ProcsongError(f"could not open the speaker (waveOut {rc})")
        nbytes = BLOCK * 4
        for _ in range(4):
            self._slots.append(_WaveSlot(nbytes))

    def _format(self):
        fmt = WAVEFORMATEX()
        fmt.wFormatTag = 1
        fmt.nChannels = 2
        fmt.nSamplesPerSec = RATE
        fmt.wBitsPerSample = 16
        fmt.nBlockAlign = 4
        fmt.nAvgBytesPerSec = RATE * 4
        fmt.cbSize = 0
        return fmt

    def _wait(self):
        winmm = self._winmm
        while True:
            for slot in self._slots:
                if not slot.busy:
                    return slot
                if slot.hdr.dwFlags & WHDR_DONE:
                    winmm.waveOutUnprepareHeader(self._handle, ctypes.byref(slot.hdr), ctypes.sizeof(slot.hdr))
                    slot.hdr.dwFlags = 0
                    slot.busy = False
                    return slot
            time.sleep(0.004)

    def write(self, pcm: bytes):
        slot = self._wait()
        ctypes.memmove(slot.hdr.lpData, pcm, len(pcm))
        slot.hdr.dwBufferLength = len(pcm)
        slot.hdr.dwFlags = 0
        header = ctypes.byref(slot.hdr)
        size = ctypes.sizeof(slot.hdr)
        rc = self._winmm.waveOutPrepareHeader(self._handle, header, size)
        if rc != 0:
            raise ProcsongError(f"speaker prepare failed ({rc})")
        slot.busy = True
        rc = self._winmm.waveOutWrite(self._handle, header, size)
        if rc != 0:
            raise ProcsongError(f"speaker write failed ({rc})")

    def close(self):
        handle = self._handle
        self._handle = None
        if not handle:
            return
        winmm = self._winmm
        winmm.waveOutReset(handle)
        for slot in self._slots:
            if slot.busy or (slot.hdr.dwFlags & WHDR_PREPARED):
                winmm.waveOutUnprepareHeader(handle, ctypes.byref(slot.hdr), ctypes.sizeof(slot.hdr))
                slot.busy = False
        winmm.waveOutClose(handle)


def _load_pulse():
    last = None
    lib = None
    for name in ("libpulse-simple.so.0", "libpulse-simple.so"):
        try:
            lib = ctypes.cdll.LoadLibrary(name)
            break
        except OSError as exc:
            last = exc
    if lib is None:
        raise ProcsongError(f"libpulse-simple is not available ({last})")
    lib.pa_simple_new.restype = ctypes.c_void_p
    lib.pa_simple_new.argtypes = [
        ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p,
        ctypes.POINTER(_PulseSpec), ctypes.c_void_p, ctypes.POINTER(_PulseBuffer), ctypes.POINTER(ctypes.c_int),
    ]
    lib.pa_simple_write.restype = ctypes.c_int
    lib.pa_simple_write.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_int)]
    lib.pa_simple_free.argtypes = [ctypes.c_void_p]
    return lib


class PulseSink:
    """Linux speakers via libpulse-simple, which desktop PipeWire also provides."""

    def __init__(self):
        lib = _load_pulse()
        default = 0xFFFFFFFF
        spec = _PulseSpec(_PA_SAMPLE_S16LE, RATE, 2)
        attr = _PulseBuffer(default, RATE * 4 // 5, default, default, default)  # ~200 ms
        error = ctypes.c_int(0)
        handle = lib.pa_simple_new(
            None, b"procsong", _PA_STREAM_PLAYBACK, None, b"procsong",
            ctypes.byref(spec), None, ctypes.byref(attr), ctypes.byref(error),
        )
        if not handle:
            raise ProcsongError(f"PulseAudio open failed ({error.value})")
        self._lib = lib
        self._handle = handle
        self._error = error

    def write(self, pcm: bytes):
        rc = self._lib.pa_simple_write(self._handle, pcm, len(pcm), ctypes.byref(self._error))
        if rc != 0:
            raise ProcsongError(f"PulseAudio write failed ({self._error.value})")

    def close(self):
        handle = self._handle
        self._handle = None
        if handle:
            self._lib.pa_simple_free(handle)


def open_speakers():
    problems = []
    if sys.platform == "win32":
        try:
            return WaveOutSink()
        except ProcsongError as exc:
            problems.append(str(exc))
    else:
        try:
            return PulseSink()
        except ProcsongError as exc:
            problems.append(str(exc))
        aplay = shutil.which("aplay")
        if aplay:
            return _PipeSink([aplay, "-q", "-t", "raw", "-f", "S16_LE", "-c", "2", "-r", str(RATE)], "aplay")
    ffplay = shutil.which("ffplay")
    if ffplay:
        return _PipeSink(
            [ffplay, "-nodisp", "-autoexit", "-loglevel", "error",
             "-f", "s16le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0"],
            "ffplay",
        )
    detail = "; ".join(problems)
    extra = f"{detail}. " if detail else ""
    raise ProcsongError(
        extra + "No speaker output is available. Windows uses the built-in audio device. "
        "Linux uses PulseAudio/PipeWire or aplay. ffplay works too. "
        "To send the song to YouTube instead, pass --stream-key."
    )


def stream_target(url: str, key: str) -> str:
    url = url.strip()
    key = key.strip()
    if not url:
        url = DEFAULT_STREAM_URL
    if not (url.startswith("rtmp://") or url.startswith("rtmps://")):
        raise ProcsongError("--stream-url must start with rtmp:// or rtmps://")
    if any(ch in " \t\r\n/?#" for ch in key):
        raise ProcsongError("--stream-key contains characters that cannot go in the stream URL")
    base, sep, query = url.partition("?")
    if key:
        base = base.rstrip("/")
        if not base.endswith("/" + key):
            base = base + "/" + key
        return base + ("?" + query if sep else "")
    leaf = base.rstrip("/").rsplit("/", 1)[-1]
    if leaf in ("", "live2", "live", "app"):
        raise ProcsongError("Pass --stream-key, or include the key in --stream-url")
    return url


def redact_target(target: str, key: str) -> str:
    if key and key in target:
        return target.replace(key, "***")
    base, sep, query = target.partition("?")
    head, slash, leaf = base.rstrip("/").rpartition("/")
    if slash and leaf not in ("live2", "live", "app"):
        hidden = head + "/***"
        return hidden + ("?" + query if sep else "")
    return target


# ---------------------------------------------------------------------------
# Golden check and CLI
# ---------------------------------------------------------------------------

def event_dict(pulse: Pulse):
    return {
        "t": pulse.tick,
        "track": pulse.track.name,
        "ChosenClip": pulse.chosen,
        "Muted": bool(pulse.muted),
        "PlaySeconds": pulse.play_seconds,
        "CropAudio": bool(pulse.crop),
    }


def _expect(pulse: Pulse, **fields):
    for name, expected in fields.items():
        got = getattr(pulse, name)
        if got != expected:
            raise ProcsongError(f"t={pulse.tick} {pulse.track.name} {name}: expected {expected!r}, got {got!r}")


def _must_reject(fn):
    try:
        fn()
    except ProcsongError:
        return
    raise ProcsongError("expected the input to be rejected")


def run_check():
    if parse_seed("") != 12345 or parse_seed("   ") != 12345 or parse_seed("+12345") != 12345:
        raise ProcsongError("seed parse failed")
    if parse_seed("-1") != MASK64:
        raise ProcsongError("negative seed did not wrap to 64 bits")
    if parse_seed(str(1 << 64)) != 0:
        raise ProcsongError("seed modulo 2^64 failed")
    _must_reject(lambda: parse_seed("12.5"))
    _must_reject(lambda: parse_seed("0x10"))
    _must_reject(lambda: parse_definition("format_version: 2.0.0\ntracks: []\n"))

    golden = Path(__file__).resolve().parents[2] / "fixtures" / "golden"
    definition = golden / "definition.yml"
    expected_path = golden / "expected-t0.json"
    if not definition.is_file() or not expected_path.is_file():
        raise ProcsongError("golden fixture not found (run this from a procsong checkout)")
    tracks = parse_definition(definition.read_text(encoding="utf-8-sig"))
    engine = Engine(tracks, parse_seed("12345"))
    first = engine.evaluate_due(0)
    actual = [event_dict(pulse) for pulse in first]
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if actual != expected:
        raise ProcsongError(f"golden t=0 mismatch\nexpected {expected}\nactual   {actual}")

    later = []
    while True:
        tick = engine.peek_tick()
        if tick > 24:
            break
        later.extend(engine.evaluate_due(tick))
    by_tick = {}
    for pulse in first + later:
        by_tick.setdefault(pulse.tick, []).append(pulse)
    if set(by_tick) != {0, 8, 10, 16, 20, 24}:
        raise ProcsongError(f"unexpected pulse times: {sorted(by_tick)}")

    def only(tick, name):
        hits = [pulse for pulse in by_tick[tick] if pulse.track.name == name]
        if len(hits) != 1:
            raise ProcsongError(f"expected one {name} pulse at t={tick}, got {len(hits)}")
        return hits[0]

    drums0 = only(0, "Drums")
    bass0 = only(0, "Bass")
    lead0 = only(0, "Lead")
    _expect(only(8, "Lead"), chosen=lead0.chosen, muted=lead0.muted, play_seconds=8, crop=False, evaluated=False)
    _expect(only(10, "Drums"), chosen=drums0.chosen, muted=drums0.muted, play_seconds=10, crop=False, evaluated=False)
    _expect(only(10, "Bass"), chosen=bass0.chosen, muted=bass0.muted, play_seconds=10, crop=False, evaluated=False)
    _expect(only(16, "Lead"), chosen=lead0.chosen, muted=lead0.muted, play_seconds=8, crop=False, evaluated=False)
    # Drums' intra matrix keeps the t=0 clip. Bass crops the fractional repeat, then
    # at t=24 can only follow the drum clip that matrix allows.
    _expect(only(20, "Drums"), chosen="Drums/A.wav", play_seconds=10, crop=False, evaluated=True)
    _expect(only(20, "Bass"), chosen=bass0.chosen, muted=bass0.muted, play_seconds=4, crop=True, evaluated=False)
    _expect(only(24, "Bass"), chosen="Bass/A.wav", play_seconds=10, crop=False, evaluated=True)
    _expect(only(24, "Lead"), play_seconds=8, crop=False, evaluated=True)
    if package_title("C:/songs/My Set.zip") != "My Set":
        raise ProcsongError("package title did not drop the zip suffix")
    if package_title("C:/songs/My Set.prcs") != "My Set":
        raise ProcsongError("package title did not drop the prcs suffix")
    if package_title("https://www.dropbox.com/s/abc/Song.zip?dl=0") != "Song":
        raise ProcsongError("package title did not use the URL leaf")
    if package_title("https://example.com/Song.prcs?dl=0") != "Song":
        raise ProcsongError("package title did not drop the prcs URL suffix")
    if package_title("song.bytes") != "song":
        raise ProcsongError("package title did not drop the bytes suffix")
    if song_title("C:/songs/My Set.zip", "Night Shift") != "Night Shift":
        raise ProcsongError("an explicit song name was ignored")
    if song_title("C:/songs/My Set.zip", "   ") != "My Set":
        raise ProcsongError("a blank song name should fall back to the file name")
    names = [track.name for track in tracks]
    clip_count = sum(len(track.clips) for track in tracks)
    still = _card_png("Golden", "12345", names, clip_count, True)
    moving = _card_png("Golden", "12345", names, clip_count, False)
    if not still.startswith(b"\x89PNG\r\n\x1a\n") or not moving.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ProcsongError("video card was not a png")
    if still == moving:
        raise ProcsongError("spectrum card matched the still card")
    _card_png("A" * 180, "99", [f"Track{i}" for i in range(30)], 30, False)
    print(f"OK - python player matches fixtures/golden seed 12345 t=0 ({len(actual)} tracks)")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="procsong.py",
        description="Play a procsong package (.zip or .prcs). Prints each new choice, grouped by the second it starts. A terminal keeps the latest 100.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  python players/python/procsong.py song.zip
  python players/python/procsong.py song.prcs --seed 99
  python players/python/procsong.py https://www.dropbox.com/s/.../song.prcs?dl=0
  python players/python/procsong.py song.zip --name "Night Shift" --stream-key YOUR_KEY
  python players/python/procsong.py song.zip --stream-url rtmps://a.rtmps.youtube.com/live2 --stream-key YOUR_KEY

YouTube Studio shows the stream URL and stream key. The default URL is
rtmp://a.rtmp.youtube.com/live2. Use the lock icon in the live control room
for the RTMPS URL. ffmpeg must be on PATH for this output. Speakers do not
need ffmpeg or any pip packages.
""",
    )
    parser.add_argument("package", nargs="?", help="procsong .zip / .prcs, a Unity .bytes rename, or an http(s) link such as a public Dropbox URL")
    parser.add_argument("--seed", default="", help="decimal integer seed (empty means 12345)")
    parser.add_argument("--name", default="", help="song name on the picture and in the terminal (default: the file or URL name)")
    parser.add_argument("--stream-key", default="", help="YouTube stream key; switches output from speakers to live ingest")
    parser.add_argument("--stream-url", default="", help=f"RTMP(S) ingest URL (default {DEFAULT_STREAM_URL})")
    parser.add_argument("--gain", type=float, default=0.85, help="master gain, default 0.85")
    parser.add_argument("--seconds", type=float, default=0, help="stop after this many song seconds (default: until Ctrl+C)")
    parser.add_argument("--check", action="store_true", help="check the repo golden schedule and exit")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    try:
        if args.check:
            run_check()
            return 0
        if not args.package:
            parser.error("the following arguments are required: package")
        if not math.isfinite(args.gain) or args.gain < 0:
            raise ProcsongError("--gain must be a finite number >= 0")
        if not math.isfinite(args.seconds) or args.seconds < 0:
            raise ProcsongError("--seconds must be a finite number >= 0")
        seed_text = args.seed.strip() or "12345"
        seed = parse_seed(args.seed)
        streaming = bool(args.stream_key.strip() or args.stream_url.strip())
        target = stream_target(args.stream_url, args.stream_key) if streaming else None
        if streaming:
            _ffmpeg()
        print("procsong: loading package", file=sys.stderr, flush=True)
        yaml_text, blobs = load_package(args.package)
        tracks = parse_definition(yaml_text)
        audio = load_audio(tracks, blobs)
        shown = redact_target(target, args.stream_key.strip()) if target else "speakers"
        title = song_title(args.package, args.name)
        print(
            f"procsong: {title}, {len(tracks)} tracks, {len(audio)} clips, seed {seed_text}, output {shown}",
            file=sys.stderr,
            flush=True,
        )
        names = [track.name for track in tracks]
        if streaming:
            sink = YoutubeSink(target, title, seed_text, names, sum(len(track.clips) for track in tracks))
            parts = [
                "procsong: YouTube needs a picture. The card shows the song name and tracks.",
            ]
            if sink.clock:
                parts.append("A clock counts how long this run has been playing.")
            if sink.spectrum:
                parts.append("The center band is a spectrum of the mix.")
            else:
                parts.append("This ffmpeg build will not draw a spectrum.")
            print(" ".join(parts), file=sys.stderr, flush=True)
        else:
            sink = open_speakers()
        print("procsong: Ctrl+C to stop", file=sys.stderr, flush=True)
        play(Engine(tracks, seed), audio, sink, args.gain, args.seconds, f"{title}    seed {seed_text}")
        return 0
    except ProcsongError as exc:
        print(f"procsong: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
