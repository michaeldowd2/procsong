const DEFAULT_ZIP_URL =
  'https://www.dropbox.com/scl/fi/19z670l6v810xwgaj4lcc/song_1.zip?rlkey=3jogpegrxn3trgvrgakme9c9r&st=l5y9caok&dl=0';

const FADE_SEC = 0.008;
const LOOKAHEAD_SEC = 1;
const CLOCK_MS = 250;
const PHASE = { primary: 0, secondary: 1, standard: 2 };
const PART_META = new Set(['weight', 'allowed_primary_parts', 'allowed_secondary_parts', 'path']);

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

function atLeastOne(n) {
  const value = Math.round(Number(n));
  return value > 0 ? value : 1;
}

function parsePart(entry) {
  if (typeof entry === 'string') {
    return { path: entry, weight: 1, allowed_primary_parts: null, allowed_secondary_parts: null };
  }
  if (!entry || typeof entry !== 'object') throw new Error('Invalid part entry');

  let path = typeof entry.path === 'string' ? entry.path : null;
  let nested = {};
  for (const key of Object.keys(entry)) {
    if (PART_META.has(key)) continue;
    path = key;
    if (entry[key] && typeof entry[key] === 'object') nested = entry[key];
    break;
  }
  return {
    path,
    weight: Number(nested.weight ?? entry.weight ?? 1),
    allowed_primary_parts: nested.allowed_primary_parts ?? entry.allowed_primary_parts ?? null,
    allowed_secondary_parts: nested.allowed_secondary_parts ?? entry.allowed_secondary_parts ?? null,
  };
}

function parseDefinition(yamlText) {
  const raw = jsyaml.load(yamlText.replace(/^\uFEFF/, ''));
  if (!raw || typeof raw !== 'object') throw new Error('definition.yml did not contain a track map');

  const tracks = [];
  for (const [name, spec] of Object.entries(raw)) {
    if (!spec || typeof spec !== 'object') continue;
    tracks.push({
      name,
      declIndex: tracks.length,
      type: spec.type,
      probability_silence: Number(spec.probability_silence ?? 0),
      loopSeconds: atLeastOne(spec.part_duration),
      repeats: atLeastOne(spec.repeats),
      parts: (spec.parts || []).map(parsePart).filter((part) => part.path),
    });
  }
  if (!tracks.length) throw new Error('No tracks found in definition.yml');
  tracks.sort((a, b) => {
    const phase = (PHASE[a.type] ?? 9) - (PHASE[b.type] ?? 9);
    return phase || a.declIndex - b.declIndex;
  });
  return tracks;
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

function allows(allowed, active) {
  return allowed == null || allowed.some((name) => active.includes(name));
}

function partLabel(chosen, muted) {
  if (!chosen) return 'silent';
  return muted ? `${chosen} (muted)` : chosen;
}

class ProcsongEngine {
  constructor(tracks, seed) {
    this.rng = new ProcsongRNG(seed);
    this.state = tracks.map((track) => ({
      track,
      chosen: null,
      muted: true,
      nextLoop: 0,
      remaining: 0,
    }));
  }

  chosenOfType(type) {
    return this.state.filter((slot) => slot.track.type === type && slot.chosen).map((slot) => slot.chosen);
  }

  candidatesFor(track) {
    if (track.type === 'primary') return track.parts;
    const primary = this.chosenOfType('primary');
    const secondary = this.chosenOfType('secondary');
    return track.parts.filter((part) => {
      if (track.type === 'secondary') return allows(part.allowed_primary_parts, primary);
      return allows(part.allowed_primary_parts, primary) && allows(part.allowed_secondary_parts, secondary);
    });
  }

  selectPart(track) {
    const rPart = this.rng.nextFloat();
    const rSilence = this.rng.nextFloat();
    const candidates = this.candidatesFor(track);
    const chosen = candidates.length ? weightedSelect(candidates, rPart).path : null;
    return { rPart, rSilence, chosen, muted: !chosen || rSilence < track.probability_silence };
  }

  pulse(slot, tick) {
    let evaluated = null;
    if (slot.remaining <= 0) {
      evaluated = this.selectPart(slot.track);
      slot.chosen = evaluated.chosen;
      slot.muted = evaluated.muted;
      slot.remaining = slot.track.repeats;
    }
    slot.remaining -= 1;
    slot.nextLoop = tick + slot.track.loopSeconds;
    return { track: slot.track, chosen: slot.chosen, muted: slot.muted, ...(evaluated || {}) };
  }

  peekNextTick() {
    return Math.min(...this.state.map((slot) => slot.nextLoop));
  }

  evaluateDue(tick) {
    return this.state.filter((slot) => slot.nextLoop === tick).map((slot) => this.pulse(slot, tick));
  }

  trace(limit = 100) {
    const rows = [];
    for (let step = 0; rows.length < limit && step < 100000; step += 1) {
      const tick = this.peekNextTick();
      const due = this.evaluateDue(tick);
      if (!due.length) break;
      for (const result of due) {
        if (result.rPart === undefined) continue;
        rows.push({ t: tick, ...result });
        if (rows.length >= limit) break;
      }
    }
    return rows;
  }
}

function dropboxDirectUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('dropbox.com')) {
      parsed.hostname = 'dl.dropboxusercontent.com';
      parsed.searchParams.set('dl', '1');
      parsed.searchParams.delete('st');
    }
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function fetchZipBuffer(url, onProgress) {
  const response = await fetch(dropboxDirectUrl(url));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) return response.arrayBuffer();

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Downloaded data was not a zip file');
  return bytes.buffer;
}

function clipKey(path) {
  return path.replace(/\\/g, '/').replace(/\.[^/.]+$/, '').toLowerCase();
}

async function unpackSongZip(buffer, onFile) {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([name, file]) => ({ name: name.replace(/\\/g, '/'), file }));

  const defs = files.map((entry) => entry.name).filter((path) => path.endsWith('definition.yml'));
  if (!defs.length) throw new Error('Zip does not contain definition.yml');
  defs.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  const defPath = defs[0];
  const root = defPath.slice(0, defPath.lastIndexOf('/') + 1);

  const definition = files.find((entry) => entry.name === defPath);
  const tracks = parseDefinition(await definition.file.async('string'));
  const clipBytes = new Map();
  const clips = files.filter((entry) => entry.name !== defPath);
  for (let i = 0; i < clips.length; i += 1) {
    const relative = clips[i].name.slice(root.length);
    if (!relative) continue;
    clipBytes.set(clipKey(relative), await clips[i].file.async('uint8array'));
    onFile(i + 1, clips.length);
  }
  return { tracks, clipBytes };
}

function equalPowerCurve(n, fn) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) curve[i] = fn(i / (n - 1));
  return curve;
}

const FADE_IN = equalPowerCurve(32, (t) => Math.sin(t * Math.PI * 0.5));
const FADE_OUT = equalPowerCurve(32, (t) => Math.cos(t * Math.PI * 0.5));

function formatChoices(rows, seed) {
  const cols = (row) =>
    [
      String(row.n).padStart(3),
      String(row.t).padEnd(6),
      row.track.padEnd(12),
      row.rPart.toFixed(8).padEnd(12),
      (row.chosen || '(none)').padEnd(28),
      row.rSilence.toFixed(8).padEnd(12),
      row.muted ? 'yes' : 'no',
    ].join('  ');

  const header = ['  #', 't'.padEnd(6), 'track'.padEnd(12), 'R_part'.padEnd(12), 'chosen'.padEnd(28), 'R_silence'.padEnd(12), 'muted'].join('  ');
  const lines = rows.map((row, i) => cols({ n: i + 1, ...row }));
  return `seed ${seed}  first ${rows.length} evaluations\n${header}\n${lines.join('\n')}`;
}

function td(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
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
    this.sources = new Set();
    this.loadedUrl = null;
    this.ui = {
      zipUrl: document.getElementById('zipUrl'),
      seed: document.getElementById('seed'),
      playBtn: document.getElementById('playBtn'),
      stopBtn: document.getElementById('stopBtn'),
      generateBtn: document.getElementById('generateBtn'),
      detailsBtn: document.getElementById('detailsBtn'),
      details: document.getElementById('details'),
      volume: document.getElementById('volume'),
      status: document.getElementById('status'),
      transport: document.getElementById('transport'),
      tracks: document.getElementById('tracks'),
      clock: document.getElementById('clock'),
      log: document.getElementById('log'),
    };
  }

  setStatus(message) {
    this.ui.status.textContent = message || '';
  }

  setClock(seconds) {
    this.ui.clock.textContent = `${Math.max(0, Math.floor(seconds))}s`;
  }

  setDetailsOpen(open) {
    this.ui.details.classList.toggle('open', open);
    this.ui.detailsBtn.setAttribute('aria-expanded', String(open));
  }

  setBar(mode) {
    this.ui.transport.classList.remove('loading', 'playing');
    if (mode) this.ui.transport.classList.add(mode);
  }

  setBusy(busy) {
    this.ui.playBtn.disabled = busy;
    this.ui.generateBtn.disabled = busy;
  }

  seedValue() {
    try {
      return BigInt(this.ui.seed.value.trim() || '12345');
    } catch (_) {
      throw new Error('Seed must be an integer');
    }
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = Number(this.ui.volume.value);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  async loadPackage() {
    const url = this.ui.zipUrl.value.trim();
    if (!url) throw new Error('No zip URL provided');
    if (this.pkg && this.loadedUrl === url) return this.pkg;

    this.setBar('loading');
    try {
      this.setStatus('Downloading procsong…');
      const buffer = await fetchZipBuffer(url, (received, total) => {
        this.setStatus(
          total
            ? `Downloading procsong… ${formatBytes(received)} / ${formatBytes(total)}`
            : `Downloading procsong… ${formatBytes(received)}`,
        );
      });

      this.setStatus('Unpacking procsong…');
      const pkg = await unpackSongZip(buffer, (done, total) => {
        this.setStatus(`Unpacking clips… ${done}/${total}`);
      });

      this.stopAudio();
      this.pkg = pkg;
      this.buffers = new Map();
      this.loadedUrl = url;
      this.engine = null;
      this.renderTracks();
      this.setStatus('');
      this.setBar(null);
      this.ui.stopBtn.disabled = true;
      return pkg;
    } catch (err) {
      this.setBar(null);
      throw err;
    }
  }

  async decodeClips() {
    const ctx = this.ensureContext();
    const paths = [...new Set(this.pkg.tracks.flatMap((track) => track.parts.map((part) => part.path)))];
    if (paths.every((path) => this.buffers.has(path))) return;

    this.setBar('loading');
    for (let i = 0; i < paths.length; i += 1) {
      if (this.buffers.has(paths[i]) || !this.pkg.clipBytes) continue;
      const bytes = this.pkg.clipBytes.get(clipKey(paths[i]));
      if (!bytes) continue;
      this.setStatus(`Decoding audio… ${i + 1}/${paths.length}`);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.buffers.set(paths[i], await ctx.decodeAudioData(copy));
    }
    if (paths.every((path) => this.buffers.has(path))) this.pkg.clipBytes = null;
    this.setStatus('');
  }

  stopAudio() {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const source of this.sources) {
      try {
        source.stop();
      } catch (_) {
        /* already stopped */
      }
    }
    this.sources.clear();
  }

  startFullClip(buffer, when) {
    const src = this.ctx.createBufferSource();
    const fade = this.ctx.createGain();
    src.buffer = buffer;
    src.connect(fade);
    fade.connect(this.master);
    fade.gain.value = 0;

    const fadeDur = Math.min(FADE_SEC, buffer.duration / 2);
    if (fadeDur > 0) {
      fade.gain.setValueCurveAtTime(FADE_IN, when, fadeDur);
      const fadeOutAt = when + buffer.duration - fadeDur;
      if (fadeOutAt >= when + fadeDur) fade.gain.setValueCurveAtTime(FADE_OUT, fadeOutAt, fadeDur);
    } else {
      fade.gain.setValueAtTime(1, when);
    }

    src.start(when);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
  }

  applyResults(tick, results) {
    this.renderTracks();
    for (const result of results) {
      if (result.muted || !result.chosen) continue;
      const buffer = this.buffers.get(result.chosen);
      if (buffer) this.startFullClip(buffer, this.audioOrigin + tick);
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
    this.setClock(nowSec);
    this.timer = setTimeout(() => this.schedulerPulse(), CLOCK_MS);
  }

  renderTracks() {
    const tracks = this.pkg?.tracks || [];
    this.ui.tracks.replaceChildren();
    if (!tracks.length) return;
    for (const track of tracks) {
      const slot = this.engine?.state.find((item) => item.track === track);
      const chosen = slot?.chosen;
      const muted = slot?.muted ?? true;
      const nextKnown = Boolean(slot && slot.remaining > 0);
      const row = document.createElement('tr');
      row.append(
        td(track.name),
        td(track.type, `type ${track.type}`),
        td(`${track.loopSeconds}s × ${track.repeats}`, 'clock'),
        td(partLabel(chosen, muted), !chosen || muted ? 'part silent' : 'part'),
        td(slot ? `${slot.nextLoop} s` : '—', 'clock'),
        td(nextKnown ? partLabel(chosen, muted) : '—', !nextKnown || !chosen || muted ? 'part silent' : 'part'),
      );
      this.ui.tracks.appendChild(row);
    }
  }

  async play() {
    this.setBusy(true);
    try {
      const pkg = await this.loadPackage();
      this.ensureContext();
      await this.ctx.resume();
      await this.decodeClips();
      this.stopAudio();
      this.playing = true;
      this.engine = new ProcsongEngine(pkg.tracks, this.seedValue());
      this.audioOrigin = this.ctx.currentTime + 0.08;
      this.ui.stopBtn.disabled = false;
      this.setBar('playing');
      this.applyResults(0, this.engine.evaluateDue(0));
      this.schedulerPulse();
    } catch (err) {
      this.setBusy(false);
      throw err;
    }
  }

  stop() {
    this.stopAudio();
    this.setBusy(false);
    this.ui.stopBtn.disabled = true;
    this.setClock(0);
    this.setStatus('');
    this.setBar(null);
    this.renderTracks();
  }

  async generate() {
    this.setBusy(true);
    try {
      const pkg = await this.loadPackage();
      const seed = this.seedValue();
      const rows = new ProcsongEngine(pkg.tracks, seed).trace(100).map((row) => ({
        t: row.t,
        track: row.track.name,
        rPart: row.rPart,
        chosen: row.chosen,
        rSilence: row.rSilence,
        muted: row.muted,
      }));
      this.ui.log.textContent = formatChoices(rows, seed.toString());
      this.ui.log.style.display = 'block';
      this.setDetailsOpen(true);
      this.setStatus('');
    } finally {
      this.setBusy(false);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const player = new WebPlayer();
  player.ui.zipUrl.value = DEFAULT_ZIP_URL;
  player.ui.playBtn.addEventListener('click', () => {
    player.play().catch((err) => {
      player.setStatus(`Play failed: ${err.message || err}`);
      player.stop();
    });
  });
  player.ui.stopBtn.addEventListener('click', () => player.stop());
  player.ui.detailsBtn.addEventListener('click', () => {
    player.setDetailsOpen(!player.ui.details.classList.contains('open'));
  });
  player.ui.generateBtn.addEventListener('click', () => {
    player.generate().catch((err) => {
      player.setBar(null);
      player.setStatus(`Generate failed: ${err.message || err}`);
    });
  });
  player.ui.volume.addEventListener('input', () => {
    if (player.master) player.master.gain.value = Number(player.ui.volume.value);
  });
});
