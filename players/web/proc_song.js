const song_01_link =
  'https://www.dropbox.com/scl/fi/19z670l6v810xwgaj4lcc/song_1.zip?rlkey=3jogpegrxn3trgvrgakme9c9r&st=l5y9caok&dl=0';

const FADE_SEC = 0.008;
const LOOKAHEAD_SEC = 1;
const CLOCK_HZ = 4;
const VOICES_PER_TRACK = 2;
const PHASE = { primary: 0, secondary: 1, standard: 2 };
const GOLDEN_SEED = 12345n;
const GOLDEN_T0 = [
  { name: 'Drums', part: 'Drums/Drums 1', rPart: 0.10957861, rSilence: 0.26538530, nextTick: 60 },
  { name: 'Organ', part: 'Organ/Organ 4', rPart: 0.88562399, rSilence: 0.83573741, nextTick: 60 },
  { name: 'Bass', part: 'Bass/Bass 2', rPart: 0.32563106, rSilence: 0.56047223, nextTick: 60 },
  { name: 'Lead', part: 'Lead/Mellotron 4', rPart: 0.79386844, rSilence: 0.39149387, nextTick: 60 },
  { name: 'Percussion', part: 'SILENT', rPart: 0.81517936, rSilence: 0.18816854, nextTick: 60 },
];

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

function parsePart(entry) {
  if (typeof entry === 'string') {
    return {
      path: entry,
      weight: 1,
      allowed_primary_parts: null,
      allowed_secondary_parts: null,
    };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid part entry');
  }

  const reserved = new Set(['weight', 'allowed_primary_parts', 'allowed_secondary_parts', 'path']);
  let path = typeof entry.path === 'string' ? entry.path : null;
  let extra = null;
  for (const key of Object.keys(entry)) {
    if (!reserved.has(key)) {
      path = key;
      extra = entry[key];
      break;
    }
  }
  const nested = extra && typeof extra === 'object' ? extra : {};
  return {
    path,
    weight: Number(nested.weight ?? entry.weight ?? 1),
    allowed_primary_parts: nested.allowed_primary_parts ?? entry.allowed_primary_parts ?? null,
    allowed_secondary_parts: nested.allowed_secondary_parts ?? entry.allowed_secondary_parts ?? null,
  };
}

function parseDefinition(yamlText) {
  const raw = jsyaml.load(yamlText.replace(/^\uFEFF/, ''));
  if (!raw || typeof raw !== 'object') {
    throw new Error('definition.yml did not contain a track map');
  }
  const tracks = [];
  let index = 0;
  for (const [name, spec] of Object.entries(raw)) {
    if (!spec || typeof spec !== 'object') continue;
    tracks.push({
      name,
      declIndex: index++,
      type: spec.type,
      probability_silence: Number(spec.probability_silence ?? 0),
      part_duration: Number(spec.part_duration ?? 0),
      repeats: Number(spec.repeats ?? 1),
      parts: (spec.parts || []).map(parsePart).filter((part) => part.path),
    });
  }
  if (!tracks.length) throw new Error('No tracks found in definition.yml');
  return tracks;
}

function compareTracks(a, b) {
  const phase = (PHASE[a.type] ?? 9) - (PHASE[b.type] ?? 9);
  return phase !== 0 ? phase : a.declIndex - b.declIndex;
}

function weightedSelect(candidates, rPart) {
  let total = 0;
  for (const part of candidates) total += part.weight;
  const target = rPart * total;
  let cumulative = 0;
  for (const part of candidates) {
    cumulative += part.weight;
    if (cumulative > target) return part;
  }
  return candidates[candidates.length - 1];
}

class ProcsongEngine {
  constructor(tracks, seed) {
    this.tracks = tracks.slice().sort(compareTracks);
    this.reset(seed);
  }

  reset(seed) {
    this.rng = new ProcsongRNG(seed);
    this.activeParts = new Map();
    this.nextLoopTick = new Map();
    this.nextEvalTick = new Map();
    this.loopsRemaining = new Map();
    for (const track of this.tracks) {
      this.activeParts.set(track.name, 'SILENT');
      this.nextLoopTick.set(track.name, 0);
      this.nextEvalTick.set(track.name, 0);
      this.loopsRemaining.set(track.name, 0);
    }
  }

  loopSeconds(track) {
    const sec = Math.round(track.part_duration);
    return sec > 0 ? sec : 1;
  }

  cycleSeconds(track) {
    return this.loopSeconds(track) * Math.max(1, Math.round(track.repeats) || 1);
  }

  activeOfType(type) {
    const parts = [];
    for (const track of this.tracks) {
      if (track.type !== type) continue;
      const part = this.activeParts.get(track.name);
      if (part && part !== 'SILENT') parts.push(part);
    }
    return parts;
  }

  matchesActive(allowed, active) {
    if (allowed == null) return true;
    return allowed.some((name) => active.includes(name));
  }

  candidatesFor(track) {
    const primary = this.activeOfType('primary');
    const secondary = this.activeOfType('secondary');
    return track.parts.filter((part) => {
      if (track.type === 'primary') return true;
      if (track.type === 'secondary') {
        return this.matchesActive(part.allowed_primary_parts, primary);
      }
      return (
        this.matchesActive(part.allowed_primary_parts, primary) &&
        this.matchesActive(part.allowed_secondary_parts, secondary)
      );
    });
  }

  selectPart(track) {
    const rPart = this.rng.nextFloat();
    const rSilence = this.rng.nextFloat();
    const candidates = this.candidatesFor(track);
    let selected = 'SILENT';
    if (candidates.length) {
      const chosen = weightedSelect(candidates, rPart);
      if (!(rSilence < track.probability_silence)) selected = chosen.path;
    }
    return { rPart, rSilence, selected };
  }

  pulseTrack(track, tick) {
    let rPart;
    let rSilence;
    let evaluated = false;
    if ((this.loopsRemaining.get(track.name) || 0) <= 0) {
      const choice = this.selectPart(track);
      rPart = choice.rPart;
      rSilence = choice.rSilence;
      evaluated = true;
      this.activeParts.set(track.name, choice.selected);
      this.loopsRemaining.set(track.name, Math.max(1, Math.round(track.repeats) || 1));
      this.nextEvalTick.set(track.name, tick + this.cycleSeconds(track));
    }
    const selected = this.activeParts.get(track.name);
    this.loopsRemaining.set(track.name, this.loopsRemaining.get(track.name) - 1);
    this.nextLoopTick.set(track.name, tick + this.loopSeconds(track));
    return {
      track,
      selected,
      rPart,
      rSilence,
      evaluated,
      nextTick: this.nextEvalTick.get(track.name),
      nextLoopTick: this.nextLoopTick.get(track.name),
    };
  }

  peekNextTick() {
    let soonest = Infinity;
    for (const tick of this.nextLoopTick.values()) {
      if (tick < soonest) soonest = tick;
    }
    return soonest;
  }

  evaluateDue(tick) {
    const due = this.tracks.filter((track) => this.nextLoopTick.get(track.name) === tick);
    due.sort(compareTracks);
    return due.map((track) => this.pulseTrack(track, tick));
  }
}

function dropboxDownloadUrls(url) {
  const urls = [];
  const seen = new Set();
  const add = (value) => {
    if (value && !seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
  };

  add(url);
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('dl', '1');
    add(parsed.toString());
    if (parsed.hostname === 'www.dropbox.com' || parsed.hostname === 'dropbox.com') {
      parsed.hostname = 'dl.dropboxusercontent.com';
      add(parsed.toString());
    }
    parsed.searchParams.delete('st');
    add(parsed.toString());
  } catch (_) {
    /* keep original */
  }

  urls.sort((a, b) => {
    const score = (value) => (value.includes('dropboxusercontent.com') ? 0 : 1);
    return score(a) - score(b);
  });
  return urls;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function fetchZipBuffer(url, onProgress) {
  const variants = dropboxDownloadUrls(url);
  let lastError = null;
  for (const variant of variants) {
    try {
      const response = await fetch(variant, { mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      if (!response.body) {
        const buffer = await response.arrayBuffer();
        onProgress?.(buffer.byteLength, buffer.byteLength);
        return buffer;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.(received, total);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const sig = bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (!sig) throw new Error('Downloaded data was not a zip file');
      return bytes.buffer;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not download zip');
}

function packageRoot(paths) {
  const defs = paths.filter((path) => path === 'definition.yml' || path.endsWith('/definition.yml'));
  if (!defs.length) throw new Error('Zip does not contain definition.yml');
  defs.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  const def = defs[0];
  const slash = def.lastIndexOf('/');
  return slash === -1 ? '' : def.slice(0, slash + 1);
}

async function unpackSongZip(buffer, onFile) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .map((name) => name.replace(/\\/g, '/'))
    .filter((name) => !zip.files[name].dir);
  const root = packageRoot(names);
  const definitionFile = zip.file(root + 'definition.yml') || zip.file('definition.yml');
  if (!definitionFile) throw new Error('Could not read definition.yml from zip');
  const yamlText = await definitionFile.async('string');
  const tracks = parseDefinition(yamlText);

  const clipBytes = new Map();
  const files = names.filter((name) => name.startsWith(root) && name !== root + 'definition.yml');
  let done = 0;
  for (const name of files) {
    const relative = name.slice(root.length);
    if (!relative || relative.endsWith('/')) continue;
    const data = await zip.file(name).async('uint8array');
    const withoutExt = relative.replace(/\.[^/.]+$/, '');
    clipBytes.set(relative, data);
    clipBytes.set(withoutExt, data);
    clipBytes.set(relative.toLowerCase(), data);
    clipBytes.set(withoutExt.toLowerCase(), data);
    done += 1;
    onFile?.(done, files.length, relative);
  }
  return { tracks, clipBytes, yamlText };
}

function lookupClip(clipBytes, partPath) {
  const guesses = [
    partPath,
    `${partPath}.wav`,
    `${partPath}.mp3`,
    `${partPath}.ogg`,
    `${partPath}.flac`,
    `${partPath}.WAV`,
  ];
  for (const guess of guesses) {
    const hit = clipBytes.get(guess) || clipBytes.get(guess.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function equalPowerIn(n) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) curve[i] = Math.sin((i / (n - 1)) * Math.PI * 0.5);
  return curve;
}

function equalPowerOut(n) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) curve[i] = Math.cos((i / (n - 1)) * Math.PI * 0.5);
  return curve;
}

const FADE_IN = equalPowerIn(32);
const FADE_OUT = equalPowerOut(32);

function goldenCheck(tracks) {
  const engine = new ProcsongEngine(tracks, GOLDEN_SEED);
  const results = engine.evaluateDue(0);
  const mismatches = [];
  GOLDEN_T0.forEach((expected, i) => {
    const actual = results[i];
    if (!actual) {
      mismatches.push(`missing ${expected.name}`);
      return;
    }
    const rPartOk = Math.abs(actual.rPart - expected.rPart) < 1e-8;
    const rSilenceOk = Math.abs(actual.rSilence - expected.rSilence) < 1e-8;
    if (
      actual.track.name !== expected.name ||
      actual.selected !== expected.part ||
      actual.nextTick !== expected.nextTick ||
      !rPartOk ||
      !rSilenceOk
    ) {
      mismatches.push(
        `${expected.name}: got ${actual.selected} (Rpart=${actual.rPart.toFixed(8)}, Rsilence=${actual.rSilence.toFixed(8)})`,
      );
    }
  });
  return { ok: mismatches.length === 0, mismatches, results };
}

class WebPlayer {
  constructor() {
    this.pkg = null;
    this.buffers = new Map();
    this.ctx = null;
    this.master = null;
    this.engine = null;
    this.playing = false;
    this.audioOrigin = 0;
    this.timer = null;
    this.sources = [];
    this.trackVoices = new Map();
    this.loadedUrl = null;
    this.ui = {
      zipUrl: document.getElementById('zipUrl'),
      seed: document.getElementById('seed'),
      loadBtn: document.getElementById('loadBtn'),
      playBtn: document.getElementById('playBtn'),
      stopBtn: document.getElementById('stopBtn'),
      volume: document.getElementById('volume'),
      status: document.getElementById('status'),
      progress: document.getElementById('progress'),
      progressBar: document.querySelector('#progress > span'),
      tracks: document.getElementById('tracks'),
      clock: document.getElementById('clock'),
      conformance: document.getElementById('conformance'),
    };
  }

  setStatus(message) {
    this.ui.status.textContent = message;
  }

  setProgress(fraction) {
    this.ui.progress.style.display = fraction == null ? 'none' : 'block';
    this.ui.progressBar.style.width = `${Math.max(0, Math.min(1, fraction || 0)) * 100}%`;
  }

  seedValue() {
    const raw = this.ui.seed.value.trim() || '12345';
    try {
      return BigInt(raw);
    } catch (_) {
      throw new Error('Seed must be an integer');
    }
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor({ sampleRate: 44100 });
    this.master = this.ctx.createGain();
    this.master.gain.value = Number(this.ui.volume.value);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  async loadPackage() {
    const url = this.ui.zipUrl.value.trim();
    if (!url) throw new Error('No zip URL provided');
    if (this.pkg && this.loadedUrl === url) return this.pkg;

    this.ui.playBtn.disabled = true;
    this.setProgress(0);
    this.setStatus('Downloading zip…');
    const buffer = await fetchZipBuffer(url, (received, total) => {
      const fraction = total ? received / total : 0;
      this.setProgress(Math.min(0.7, fraction * 0.7));
      this.setStatus(
        total
          ? `Downloading zip… ${formatBytes(received)} / ${formatBytes(total)}`
          : `Downloading zip… ${formatBytes(received)}`,
      );
    });

    this.setStatus('Unpacking zip in memory…');
    const pkg = await unpackSongZip(buffer, (done, total) => {
      this.setProgress(0.7 + (done / total) * 0.2);
      this.setStatus(`Unpacking clips… ${done}/${total}`);
    });
    this.haltPlayback();
    this.pkg = pkg;
    this.buffers = new Map();
    this.loadedUrl = url;
    this.renderTracks(pkg.tracks, new Map(pkg.tracks.map((t) => [t.name, 'SILENT'])));
    const check = goldenCheck(pkg.tracks);
    this.ui.conformance.className = `status check ${check.ok ? 'pass' : 'fail'}`;
    this.ui.conformance.textContent = check.ok
      ? 'Conformance: seed 12345 t=0 matches the song_1 golden vector.'
      : `Seed 12345 t=0 does not match the song_1 golden vector: ${check.mismatches.join('; ')}`;
    this.setProgress(1);
    this.setStatus(`Loaded ${pkg.tracks.length} tracks. Ready to play.`);
    this.ui.playBtn.disabled = false;
    setTimeout(() => this.setProgress(null), 400);
    return pkg;
  }

  async decodeClips() {
    const ctx = this.ensureContext();
    const unique = [];
    const seen = new Set();
    for (const track of this.pkg.tracks) {
      for (const part of track.parts) {
        if (seen.has(part.path)) continue;
        seen.add(part.path);
        unique.push(part.path);
      }
    }
    for (let i = 0; i < unique.length; i += 1) {
      const path = unique[i];
      if (this.buffers.has(path)) continue;
      if (!this.pkg.clipBytes) continue;
      const bytes = lookupClip(this.pkg.clipBytes, path);
      if (!bytes) continue;
      this.setStatus(`Decoding audio… ${i + 1}/${unique.length}`);
      this.setProgress(i / unique.length);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const audioBuffer = await ctx.decodeAudioData(copy);
      this.buffers.set(path, audioBuffer);
    }
    this.pkg.clipBytes = null;
    this.setProgress(null);
  }

  haltPlayback() {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopSources();
    for (const voices of this.trackVoices.values()) {
      for (const gain of voices.slots) {
        try {
          gain.disconnect();
        } catch (_) {
          /* already disconnected */
        }
      }
    }
    this.trackVoices.clear();
    this.ui.stopBtn.disabled = true;
    this.ui.playBtn.disabled = !this.pkg;
  }

  stopSources() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch (_) {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  ensureTrackVoices(trackName) {
    let voices = this.trackVoices.get(trackName);
    if (!voices) {
      voices = {
        next: 0,
        slots: Array.from({ length: VOICES_PER_TRACK }, () => {
          const gain = this.ctx.createGain();
          gain.connect(this.master);
          return gain;
        }),
      };
      this.trackVoices.set(trackName, voices);
    }
    return voices;
  }

  startFullClip(trackName, buffer, when) {
    const voices = this.ensureTrackVoices(trackName);
    const bus = voices.slots[voices.next];
    voices.next = (voices.next + 1) % VOICES_PER_TRACK;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const fade = this.ctx.createGain();
    src.connect(fade);
    fade.connect(bus);
    fade.gain.value = 0;

    const duration = buffer.duration;
    const fadeInDur = Math.min(FADE_SEC, duration / 2);
    const fadeOutDur = Math.min(FADE_SEC, duration / 2);
    const fadeOutAt = when + duration - fadeOutDur;
    if (fadeInDur > 0) fade.gain.setValueCurveAtTime(FADE_IN, when, fadeInDur);
    else fade.gain.setValueAtTime(1, when);
    if (fadeOutDur > 0 && fadeOutAt >= when + fadeInDur) {
      fade.gain.setValueCurveAtTime(FADE_OUT, fadeOutAt, fadeOutDur);
    }

    src.start(when);
    src.onended = () => {
      this.sources = this.sources.filter((node) => node !== src);
    };
    this.sources.push(src);
  }

  startClipAt(trackName, partPath, startSec) {
    if (partPath === 'SILENT') return;
    const buffer = this.buffers.get(partPath);
    if (!buffer) return;
    this.startFullClip(trackName, buffer, this.audioOrigin + startSec);
  }

  applyResults(tick, results) {
    this.renderTracks(
      this.engine.tracks,
      new Map(this.engine.activeParts),
      this.engine.nextLoopTick,
    );
    for (const result of results) {
      this.startClipAt(result.track.name, result.selected, tick);
    }
  }

  schedulerPulse() {
    if (!this.playing) return;
    const nowSec = this.ctx.currentTime - this.audioOrigin;
    const horizon = Math.floor(nowSec + LOOKAHEAD_SEC);
    while (this.engine.peekNextTick() <= horizon) {
      const tick = this.engine.peekNextTick();
      const results = this.engine.evaluateDue(tick);
      if (!results.length) break;
      this.applyResults(tick, results);
    }
    this.ui.clock.textContent = `t = ${Math.max(0, Math.floor(nowSec))} s`;
    this.timer = setTimeout(() => this.schedulerPulse(), 1000 / CLOCK_HZ);
  }

  renderTracks(tracks, activeParts, nextStarts) {
    this.ui.tracks.replaceChildren();
    for (const track of tracks) {
      const part = activeParts?.get(track.name) || 'SILENT';
      const next = nextStarts?.get(track.name);
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = track.name;
      const typeCell = document.createElement('td');
      typeCell.className = `type ${track.type}`;
      typeCell.textContent = track.type;
      const lengthCell = document.createElement('td');
      lengthCell.className = 'clock';
      lengthCell.textContent = `${Math.round(track.part_duration) || 0}s × ${track.repeats || 1}`;
      const partCell = document.createElement('td');
      partCell.className = `part ${part === 'SILENT' ? 'silent' : ''}`;
      partCell.textContent = part === 'SILENT' ? 'silent' : part;
      const tickCell = document.createElement('td');
      tickCell.className = 'clock';
      tickCell.textContent = next == null ? '—' : `${next} s`;
      row.append(nameCell, typeCell, lengthCell, partCell, tickCell);
      this.ui.tracks.appendChild(row);
    }
  }

  async play() {
    this.ui.playBtn.disabled = true;
    const pkg = await this.loadPackage();
    this.ensureContext();
    await this.ctx.resume();
    await this.decodeClips();
    this.haltPlayback();
    this.playing = true;
    this.engine = new ProcsongEngine(pkg.tracks, this.seedValue());
    this.audioOrigin = this.ctx.currentTime + 0.08;
    this.ui.playBtn.disabled = true;
    this.ui.stopBtn.disabled = false;
    this.setStatus(`Playing with seed ${this.ui.seed.value.trim() || '12345'}.`);
    const first = this.engine.evaluateDue(0);
    this.applyResults(0, first);
    this.schedulerPulse();
  }

  stop() {
    this.haltPlayback();
    if (this.pkg) this.setStatus('Stopped.');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const player = new WebPlayer();
  player.ui.zipUrl.value = song_01_link;
  player.ui.loadBtn.addEventListener('click', () => {
    player.loadPackage().catch((err) => {
      player.setProgress(null);
      player.ui.playBtn.disabled = !player.pkg;
      player.setStatus(`Load failed: ${err.message || err}`);
    });
  });
  player.ui.playBtn.addEventListener('click', () => {
    player.play().catch((err) => {
      player.setProgress(null);
      player.setStatus(`Play failed: ${err.message || err}`);
      player.stop();
    });
  });
  player.ui.stopBtn.addEventListener('click', () => player.stop());
  player.ui.volume.addEventListener('input', () => {
    if (player.master) player.master.gain.value = Number(player.ui.volume.value);
  });
});
