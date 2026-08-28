/**
 * ProcsongPlayer — embeddable web player for Procsong packages.
 *
 * A drop-in component: give it a target element and (optionally) song
 * metadata, then call initialise() to render and play() to start audio.
 *
 * Dependencies (include before this script):
 *   - JSZip   https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
 *   - js-yaml https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js
 *
 * @example
 *   const player = new ProcsongPlayer({
 *     target: 'player',            // id, selector, or HTMLElement
 *     title: 'Game Music',         // optional
 *     artist: 'Michael Dowd',       // optional
 *     imageUrl: 'https://…',      // optional; omitted → no image
 *     description: '…',          // optional
 *     tags: ['synth', 'game'],  // optional; string or array
 *     procSongUrl: 'https://….zip',
 *     showDebug: false,
 *     heading: 'Player',          // optional; empty string hides it
 *   });
 *   player.initialise();
 *   await player.play();
 *   player.stop();
 *
 * Display rules for the main play box:
 *   - no imageUrl                         → no image
 *   - no title and no artist              → package URL as text, if set
 *   - title only                          → title, URL beneath
 *   - title and artist                    → title • artist on one line;
 *                                           URL only in the debug panel
 *
 * Switch song (e.g. from ProcsongLibrary) and start playback:
 *   await player.play({ title, artist, imageUrl, description, tags, procSongUrl });
 *
 * Look up a player by the element it was rendered into:
 *   ProcsongPlayer.get('player')
 *
 * Events dispatched on the target element:
 *   procsong:play  { title, artist, imageUrl, description, tags, procSongUrl }
 *   procsong:stop  (after playback has started)
 *
 * @param {object} options
 * @param {string|HTMLElement} options.target
 * @param {string} [options.title]
 * @param {string} [options.artist]
 * @param {string} [options.imageUrl]
 * @param {string} [options.description]
 * @param {string|string[]} [options.tags]
 * @param {string} [options.procSongUrl]
 * @param {boolean} [options.showDebug=false]
 * @param {string|number} [options.seed=12345]
 * @param {string} [options.heading=Player]
 */
(function (global) {
  'use strict';

  const FADE_SEC = 0.008;
  const LOOKAHEAD_SEC = 1;
  const CLOCK_MS = 250;
  const PHASE = { primary: 0, secondary: 1, standard: 2 };
  const PART_META = new Set(['weight', 'allowed_primary_parts', 'allowed_secondary_parts', 'path']);

  const PLAYER_CSS = `
.ps-player {
  --ps-bg: var(--panel, #1a1a1a);
  --ps-line: var(--line, #3a3a3a);
  --ps-text: var(--text, #eee);
  --ps-muted: var(--muted, #999);
  --ps-accent: var(--accent, #ccc);
  --ps-btn-text: var(--on-accent, var(--bg, #111));
  --ps-secondary: var(--secondary, #888);
  --ps-standard: var(--standard, #aaa);
  --ps-silent: var(--silent, #666);
  --ps-input: var(--input-bg, #111);
  --ps-load: var(--transport-load, var(--accent, #888));
  --ps-playbar: var(--transport-play, var(--secondary, #666));
  --ps-sans: var(--sans, inherit);
  --ps-mono: var(--mono, ui-monospace, monospace);
  color: var(--ps-text);
  font-family: var(--ps-sans);
  margin: 0 0 10px;
}
.ps-player .ps-label {
  margin: 0 0 8px;
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ps-player .ps-box,
.ps-player .ps-details {
  background: var(--ps-bg);
  border: 1px solid var(--ps-line);
  border-radius: 8px;
  padding: 18px 18px 14px;
  margin-bottom: 10px;
}
.ps-player [hidden] { display: none !important; }
.ps-player .ps-now {
  display: flex;
  align-items: stretch;
  gap: 16px;
  min-width: 0;
}
.ps-player .ps-cover-wrap {
  flex: 0 0 96px;
  width: 96px;
  align-self: stretch;
  min-height: 96px;
}
.ps-player .ps-cover {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 6px;
  background: var(--ps-input);
}
.ps-player .ps-identity {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 96px;
}
.ps-player .ps-heading {
  margin: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4em;
  min-width: 0;
  line-height: 1.2;
}
.ps-player .ps-title {
  font-size: 1.25rem;
  font-weight: 600;
}
.ps-player .ps-dot { color: var(--ps-muted); flex: 0 0 auto; }
.ps-player .ps-artist {
  color: var(--ps-muted);
  font-weight: 400;
  font-size: 1rem;
}
.ps-player .ps-subtitle {
  margin: 6px 0 0;
  color: var(--ps-muted);
  font-size: 1rem;
}
.ps-player .ps-subtitle.is-url {
  font-family: var(--ps-mono);
  font-size: 12px;
  line-height: 1.4;
  word-break: break-all;
}
.ps-player .ps-desc {
  margin: 8px 0 0;
  color: var(--ps-muted);
  font-size: 13px;
  line-height: 1.4;
}
.ps-player .ps-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: auto 0 0;
  padding: 8px 0 0;
  list-style: none;
}
.ps-player .ps-tags li {
  border: 1px solid var(--ps-line);
  border-radius: 999px;
  padding: 2px 9px;
  color: var(--ps-muted);
  font-size: 12px;
}
.ps-player .ps-empty {
  margin: 0;
  color: var(--ps-muted);
  font-size: 1rem;
}
.ps-player.is-empty .ps-now { align-items: center; }
.ps-player .ps-volume input:disabled { opacity: 0.45; cursor: default; }
.ps-player .ps-controls-col {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: stretch;
  flex: 0 0 148px;
  width: 148px;
  min-height: 96px;
  gap: 8px;
}
.ps-player .ps-seed-field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  width: 100%;
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ps-player .ps-seed-field input {
  flex: 1;
  min-width: 0;
  width: auto;
  background: var(--ps-input);
  color: var(--ps-text);
  border: 1px solid var(--ps-line);
  border-radius: 4px;
  padding: 4px 6px;
  font: 12px/1.2 var(--ps-mono);
}
.ps-player .ps-seed-field input:disabled { opacity: 0.45; }
.ps-player .ps-transport-btns {
  display: flex;
  align-items: stretch;
  gap: 6px;
  width: 100%;
}
.ps-player button {
  background: var(--ps-accent);
  color: var(--ps-btn-text);
  border: 0;
  border-radius: 4px;
  padding: 8px 14px;
  font: 600 13px/1 var(--ps-sans);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}
.ps-player button.secondary {
  background: transparent;
  color: var(--ps-text);
  border: 1px solid var(--ps-line);
}
.ps-player button:disabled { opacity: 0.45; cursor: default; }
.ps-player .ps-play,
.ps-player .ps-stop {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  height: 32px;
  letter-spacing: 0;
  text-transform: none;
}
.ps-player .ps-play {
  flex: 1;
  min-width: 0;
  border-radius: 999px;
  font-family: var(--ps-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
}
.ps-player .ps-play svg {
  width: 16px;
  height: 16px;
  margin-left: 2px;
  fill: currentColor;
}
.ps-player .ps-play .ps-clock {
  display: none;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.ps-player .ps-play.is-playing { color: var(--ps-btn-text); cursor: default; }
.ps-player .ps-play.is-playing .ps-play-icon { display: none; }
.ps-player .ps-play.is-playing .ps-clock { display: flex; }
.ps-player .ps-stop {
  flex: 0 0 32px;
  width: 32px;
  border-radius: 50%;
}
.ps-player .ps-stop svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}
.ps-player button.icon {
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--ps-muted);
  flex: 0 0 auto;
  margin-left: auto;
}
.ps-player button.icon span {
  display: inline-block;
  transition: transform 0.15s ease;
}
.ps-player button.icon[aria-expanded="true"] span { transform: rotate(180deg); }
.ps-player .ps-volume {
  margin-top: auto;
  line-height: 0;
  width: 100%;
}
.ps-player .ps-volume input {
  width: 100%;
  accent-color: var(--ps-accent);
  display: block;
}
.ps-player .ps-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 0;
}
.ps-player .ps-footer:has(.ps-details-btn),
.ps-player .ps-footer:has(.ps-transport.loading),
.ps-player .ps-footer:has(.ps-transport.playing),
.ps-player .ps-footer:has(.ps-status:not(:empty)) {
  margin-top: 12px;
  min-height: 28px;
}
.ps-player .ps-status {
  margin: 0;
  color: var(--ps-muted);
  font-size: 13px;
  min-width: 0;
  flex: 0 1 auto;
}
.ps-player .ps-status:empty { display: none; }
.ps-player .ps-transport {
  display: none;
  position: relative;
  flex: 1;
  height: 6px;
  margin: 0;
  border-radius: 99px;
  overflow: hidden;
}
.ps-player .ps-transport.loading,
.ps-player .ps-transport.playing { display: block; }
.ps-player .ps-transport.loading { background: color-mix(in srgb, var(--ps-load) 35%, transparent); }
.ps-player .ps-transport.playing { background: color-mix(in srgb, var(--ps-playbar) 35%, transparent); }
.ps-player .ps-transport::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 42%;
}
.ps-player .ps-transport.loading::after {
  background: linear-gradient(90deg, transparent, var(--ps-load), transparent);
  animation: ps-sweep 1.15s linear infinite;
}
.ps-player .ps-transport.playing::after {
  background: linear-gradient(90deg, transparent, var(--ps-playbar), transparent);
  animation: ps-sweep 1.8s linear infinite;
}
@keyframes ps-sweep {
  from { transform: translateX(-120%); }
  to { transform: translateX(280%); }
}
.ps-player .ps-details { display: none; }
.ps-player .ps-details.open { display: block; }
.ps-player .ps-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ps-player .ps-zip-url {
  flex: 1;
  min-width: 0;
  color: var(--ps-text);
  font: 13px/1.3 var(--ps-mono);
  text-transform: none;
  letter-spacing: 0;
  word-break: break-all;
}
.ps-player table {
  width: 100%;
  border-collapse: collapse;
}
.ps-player th, .ps-player td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--ps-line);
  vertical-align: top;
}
.ps-player th {
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.ps-player .type { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.ps-player .type.primary { color: var(--ps-accent); }
.ps-player .type.secondary { color: var(--ps-secondary); }
.ps-player .type.standard { color: var(--ps-standard); }
.ps-player .part.silent { color: var(--ps-silent); font-style: italic; }
.ps-player .clock {
  font-family: var(--ps-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ps-muted);
}
.ps-player .ps-debug {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.ps-player .ps-debug p {
  margin: 0;
  color: var(--ps-muted);
  font-size: 13px;
}
.ps-player .ps-log {
  display: none;
  margin: 12px 0 0;
  max-height: 420px;
  overflow: auto;
  padding: 10px 12px;
  background: var(--ps-input);
  border: 1px solid var(--ps-line);
  border-radius: 4px;
  color: var(--ps-text);
  font: 12px/1.45 var(--ps-mono);
  white-space: pre;
}
@media (max-width: 640px) {
  .ps-player .ps-now { flex-wrap: wrap; }
  .ps-player .ps-controls-col {
    margin-left: auto;
    min-height: 0;
  }
}
`;

  const playersByEl = new WeakMap();
  const playersById = new Map();

  function ensureCss() {
    if (document.getElementById('procsong-player-css')) return;
    const style = document.createElement('style');
    style.id = 'procsong-player-css';
    style.textContent = PLAYER_CSS;
    document.head.appendChild(style);
  }

  function pick(obj, ...keys) {
    if (!obj) return '';
    for (const key of keys) {
      if (obj[key] != null && String(obj[key]).trim() !== '') return obj[key];
    }
    return '';
  }

  function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
    return String(tags).split(/[;,]/).map((tag) => String(tag).trim()).filter(Boolean);
  }

  function headingText(value, fallback) {
    if (value === false || value === '') return '';
    return String(value || fallback);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
  }

  function normalizeUrl(url) {
    if (!url) return '';
    let value = String(url).trim();
    if (/^ttps:\/\//i.test(value)) value = `h${value}`;
    return value;
  }

  function resolveElement(target) {
    if (!target) throw new Error('ProcsongPlayer requires a target element or id');
    if (target instanceof Element) return target;
    const selector = String(target);
    const byId = document.getElementById(selector.replace(/^#/, ''));
    if (byId) return byId;
    const found = document.querySelector(selector);
    if (!found) throw new Error(`ProcsongPlayer target not found: ${target}`);
    return found;
  }

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

  class ProcsongPlayer {
    /**
     * @param {object} options See file header for the public API.
     */
    constructor(options = {}) {
      this.target = options.target;
      this.showDebug = Boolean(options.showDebug);
      this.heading = headingText(options.heading, 'Player');
      this.seed = options.seed != null && String(options.seed).trim() !== '' ? String(options.seed) : '12345';

      this.title = '';
      this.artist = '';
      this.imageUrl = '';
      this.description = '';
      this.tags = [];
      this.procSongUrl = '';

      this.el = null;
      this.ui = null;
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
      this.playSeq = 0;
      this._busy = false;

      this.setSong(options);
    }

    /**
     * Return the player rendered into `target`, or null.
     * @param {string|HTMLElement|ProcsongPlayer} target
     * @returns {ProcsongPlayer|null}
     */
    static get(target) {
      if (target instanceof ProcsongPlayer) return target;
      if (target instanceof Element) return playersByEl.get(target) || null;
      if (target == null) return null;
      const id = String(target).replace(/^#/, '');
      if (playersById.has(id)) return playersById.get(id);
      const el = document.getElementById(id) || document.querySelector(String(target));
      return el ? playersByEl.get(el) || null : null;
    }

    /**
     * Build the player UI inside `options.target`. Safe to call more than once.
     * @returns {ProcsongPlayer}
     */
    initialise() {
      ensureCss();
      this.el = resolveElement(this.target);
      this.el.innerHTML = this.shellHtml();
      this.ui = {
        root: this.el.querySelector('.ps-player'),
        coverWrap: this.el.querySelector('.ps-cover-wrap'),
        cover: this.el.querySelector('.ps-cover'),
        heading: this.el.querySelector('.ps-heading'),
        title: this.el.querySelector('.ps-title'),
        dot: this.el.querySelector('.ps-dot'),
        artistEl: this.el.querySelector('.ps-artist'),
        subtitle: this.el.querySelector('.ps-subtitle'),
        desc: this.el.querySelector('.ps-desc'),
        tags: this.el.querySelector('.ps-tags'),
        empty: this.el.querySelector('.ps-empty'),
        urlDebug: this.el.querySelector('.ps-url-debug'),
        zipUrl: this.el.querySelector('.ps-zip-url'),
        seed: this.el.querySelector('.ps-seed'),
        playBtn: this.el.querySelector('.ps-play'),
        stopBtn: this.el.querySelector('.ps-stop'),
        generateBtn: this.el.querySelector('.ps-generate'),
        detailsBtn: this.el.querySelector('.ps-details-btn'),
        details: this.el.querySelector('.ps-details'),
        volume: this.el.querySelector('.ps-volume-input'),
        status: this.el.querySelector('.ps-status'),
        transport: this.el.querySelector('.ps-transport'),
        tracks: this.el.querySelector('.ps-tracks'),
        clock: this.el.querySelector('.ps-clock'),
        log: this.el.querySelector('.ps-log'),
      };
      this.bindUi();
      this.updateMeta();
      this.syncPlayButton();
      this.syncControls();
      this.register();
      return this;
    }

    /**
     * Start playback of the current package, or switch to `song` first.
     *
     * @param {object} [song]
     * @param {string} [song.title]
     * @param {string} [song.artist]
     * @param {string} [song.imageUrl]
     * @param {string} [song.description]
     * @param {string|string[]} [song.tags]
     * @param {string} [song.procSongUrl]
     * @returns {Promise<void>}
     */
    async play(song) {
      if (!this.ui) this.initialise();
      if (song) this.setSong(song);
      if (!this.hasSong()) return;
      const token = (this.playSeq += 1);
      this.setBusy(true);
      try {
        const pkg = await this.loadPackage();
        if (token !== this.playSeq) return;
        this.ensureContext();
        await this.ctx.resume();
        if (token !== this.playSeq) return;
        await this.decodeClips();
        if (token !== this.playSeq) return;
        this.stopAudio();
        this.playing = true;
        this.engine = new ProcsongEngine(pkg.tracks, this.seedValue());
        this.audioOrigin = this.ctx.currentTime + 0.08;
        this.setBusy(false);
        this.syncPlayButton();
        this.setBar('playing');
        this.applyResults(0, this.engine.evaluateDue(0));
        this.schedulerPulse();
        this.emit('procsong:play', {
          title: this.title,
          artist: this.artist,
          imageUrl: this.imageUrl,
          description: this.description,
          tags: this.tags,
          procSongUrl: this.procSongUrl,
        });
      } catch (err) {
        if (token !== this.playSeq) return;
        this.stop();
        this.setStatus(`Play failed: ${err.message || err}`);
        throw err;
      }
    }

    stop() {
      const wasPlaying = this.playing;
      this.playSeq += 1;
      this.stopAudio();
      this.setBusy(false);
      if (this.ui) {
        this.setClock(0);
        this.syncPlayButton();
        this.setStatus('');
        this.setBar(null);
        this.renderTracks();
        this.syncControls();
      }
      if (wasPlaying) this.emit('procsong:stop');
    }

    setSong(song = {}) {
      const nextUrl = normalizeUrl(pick(song, 'procSongUrl', 'proc_song_url', 'procsong_url'));
      if (nextUrl && nextUrl !== this.procSongUrl) {
        this.pkg = null;
        this.loadedUrl = null;
        this.buffers = new Map();
      }
      this.title = String(pick(song, 'title', 'songName', 'name') || '');
      this.artist = String(pick(song, 'artist') || '');
      this.imageUrl = normalizeUrl(pick(song, 'imageUrl', 'image_url'));
      this.description = String(pick(song, 'description') || '');
      this.tags = parseTags(song.tags);
      if (nextUrl) this.procSongUrl = nextUrl;
      this.updateMeta();
      return this;
    }

    shellHtml() {
      const debug = this.showDebug;
      const label = this.heading
        ? `<p class="ps-label">${escapeHtml(this.heading)}</p>`
        : '';
      return `
        <div class="ps-player">
          ${label}
          <div class="ps-box">
            <div class="ps-now">
              <div class="ps-cover-wrap" hidden>
                <img class="ps-cover" alt="">
              </div>
              <div class="ps-identity">
                <p class="ps-empty">Please select a procsong to play</p>
                <p class="ps-heading" hidden>
                  <span class="ps-title"></span>
                  <span class="ps-dot" hidden>•</span>
                  <span class="ps-artist" hidden></span>
                </p>
                <p class="ps-subtitle" hidden></p>
                <p class="ps-desc" hidden></p>
                <ul class="ps-tags" hidden></ul>
              </div>
              <div class="ps-controls-col">
                <label class="ps-seed-field">
                  Seed
                  <input class="ps-seed" type="text" value="${escapeHtml(this.seed)}" spellcheck="false" inputmode="numeric">
                </label>
                <div class="ps-transport-btns">
                  <button class="ps-play" type="button" aria-label="Play">
                    <svg class="ps-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5-9-5.5z"/></svg>
                    <span class="ps-clock">0:00</span>
                  </button>
                  <button class="ps-stop secondary" type="button" disabled aria-label="Stop">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
                  </button>
                </div>
                <label class="ps-volume">
                  <input class="ps-volume-input" type="range" min="0" max="1" step="0.01" value="0.85" aria-label="Volume">
                </label>
              </div>
            </div>
            <div class="ps-footer">
              <div class="ps-status"></div>
              <div class="ps-transport"></div>
              ${debug ? `
                <button class="ps-details-btn secondary icon" type="button" aria-expanded="false" title="Details">
                  <span aria-hidden="true">▼</span>
                </button>
              ` : ''}
            </div>
          </div>
          ${debug ? `
            <div class="ps-details">
              <p class="ps-field ps-url-debug">
                URL
                <span class="ps-zip-url"></span>
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Track</th>
                    <th>Type</th>
                    <th>Length</th>
                    <th>Now playing</th>
                    <th>Next start</th>
                    <th>Next part</th>
                  </tr>
                </thead>
                <tbody class="ps-tracks">
                  <tr><td colspan="6" class="clock">Play to load a package.</td></tr>
                </tbody>
              </table>
              <div class="ps-debug">
                <button class="ps-generate secondary" type="button">Generate</button>
                <p>Dump the first 100 part evaluations for this seed.</p>
              </div>
              <pre class="ps-log"></pre>
            </div>
          ` : ''}
        </div>
      `;
    }

    bindUi() {
      this.ui.playBtn.addEventListener('click', () => {
        if (this.playing || !this.hasSong()) return;
        this.play().catch(() => {});
      });
      this.ui.stopBtn.addEventListener('click', () => this.stop());
      this.ui.volume.addEventListener('input', () => {
        if (this.master) this.master.gain.value = Number(this.ui.volume.value);
      });
      if (this.ui.detailsBtn && this.ui.details) {
        this.ui.detailsBtn.addEventListener('click', () => {
          this.setDetailsOpen(!this.ui.details.classList.contains('open'));
        });
      }
      if (this.ui.generateBtn) {
        this.ui.generateBtn.addEventListener('click', () => {
          this.generate().catch((err) => {
            this.setBar(null);
            this.setStatus(`Generate failed: ${err.message || err}`);
          });
        });
      }
    }

    register() {
      playersByEl.set(this.el, this);
      if (this.el.id) playersById.set(this.el.id, this);
    }

    emit(name, detail) {
      if (!this.el) return;
      this.el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} }));
    }

    syncUrlDisplay() {
      if (this.ui?.zipUrl) this.ui.zipUrl.textContent = this.procSongUrl;
    }

    updateMeta() {
      if (!this.ui) return;
      const title = this.title.trim();
      const artist = this.artist.trim();
      const imageUrl = this.imageUrl.trim();
      const url = this.procSongUrl.trim();
      const hasTitleAndArtist = Boolean(title && artist);
      this.syncUrlDisplay();

      if (imageUrl) {
        if (this.ui.coverWrap) this.ui.coverWrap.hidden = false;
        this.ui.cover.hidden = false;
        this.ui.cover.src = dropboxDirectUrl(imageUrl);
        this.ui.cover.alt = title || artist || 'Cover art';
        this.ui.cover.onerror = () => {
          if (this.ui.coverWrap) this.ui.coverWrap.hidden = true;
          this.ui.cover.hidden = true;
        };
      } else {
        if (this.ui.coverWrap) this.ui.coverWrap.hidden = true;
        this.ui.cover.hidden = true;
        this.ui.cover.removeAttribute('src');
      }

      if (this.ui.heading) this.ui.heading.hidden = !title && !artist;

      if (title) {
        this.ui.title.hidden = false;
        this.ui.title.textContent = title;
      } else if (artist) {
        this.ui.title.hidden = false;
        this.ui.title.textContent = artist;
      } else {
        this.ui.title.hidden = true;
        this.ui.title.textContent = '';
      }

      if (this.ui.dot && this.ui.artistEl) {
        if (title && artist) {
          this.ui.dot.hidden = false;
          this.ui.artistEl.hidden = false;
          this.ui.artistEl.textContent = artist;
        } else {
          this.ui.dot.hidden = true;
          this.ui.artistEl.hidden = true;
          this.ui.artistEl.textContent = '';
        }
      }

      if (hasTitleAndArtist) {
        this.ui.subtitle.hidden = true;
        this.ui.subtitle.textContent = '';
        this.ui.subtitle.classList.remove('is-url');
      } else if (url) {
        this.ui.subtitle.hidden = false;
        this.ui.subtitle.textContent = url;
        this.ui.subtitle.classList.add('is-url');
      } else {
        this.ui.subtitle.hidden = true;
        this.ui.subtitle.textContent = '';
        this.ui.subtitle.classList.remove('is-url');
      }

      if (this.ui.urlDebug) this.ui.urlDebug.hidden = !url;

      const description = (this.description || '').trim();
      if (this.ui.desc) {
        this.ui.desc.hidden = !description;
        this.ui.desc.textContent = description;
      }

      if (this.ui.tags) {
        this.ui.tags.replaceChildren();
        if (this.tags.length) {
          this.ui.tags.hidden = false;
          this.tags.forEach((tag) => {
            const li = document.createElement('li');
            li.textContent = tag;
            this.ui.tags.appendChild(li);
          });
        } else {
          this.ui.tags.hidden = true;
        }
      }

      this.syncControls();
    }

    hasSong() {
      return Boolean((this.procSongUrl || '').trim());
    }

    setStatus(message) {
      this.ui.status.textContent = message || '';
    }

    setClock(seconds) {
      if (this.ui.clock) this.ui.clock.textContent = formatClock(seconds);
    }

    syncPlayButton() {
      if (!this.ui?.playBtn) return;
      const playing = this.playing;
      this.ui.playBtn.classList.toggle('is-playing', playing);
      this.ui.playBtn.setAttribute('aria-label', playing ? 'Playing' : 'Play');
    }

    setDetailsOpen(open) {
      if (!this.ui.details || !this.ui.detailsBtn) return;
      this.ui.details.classList.toggle('open', open);
      this.ui.detailsBtn.setAttribute('aria-expanded', String(open));
    }

    setBar(mode) {
      this.ui.transport.classList.remove('loading', 'playing');
      if (mode) this.ui.transport.classList.add(mode);
    }

    setBusy(busy) {
      this._busy = Boolean(busy);
      this.syncControls();
    }

    syncControls() {
      if (!this.ui) return;
      const ready = this.hasSong();
      if (this.ui.root) this.ui.root.classList.toggle('is-empty', !ready);
      if (this.ui.empty) this.ui.empty.hidden = ready;
      if (this.ui.playBtn) this.ui.playBtn.disabled = !ready || (this._busy && !this.playing);
      if (this.ui.stopBtn) this.ui.stopBtn.disabled = !ready || !this.playing;
      if (this.ui.volume) this.ui.volume.disabled = !ready;
      if (this.ui.seed) this.ui.seed.disabled = !ready;
      if (this.ui.detailsBtn) this.ui.detailsBtn.disabled = !ready;
      if (this.ui.generateBtn) this.ui.generateBtn.disabled = !ready || this._busy;
      if (!ready) this.setDetailsOpen(false);
    }

    seedValue() {
      try {
        return BigInt((this.ui.seed?.value || this.seed || '12345').trim() || '12345');
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
      const url = (this.procSongUrl || '').trim();
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
        this.procSongUrl = url;
        this.engine = null;
        this.renderTracks();
        this.setStatus('');
        this.setBar(null);
        return pkg;
      } catch (err) {
        this.setBar(null);
        throw err;
      }
    }

    async decodeClips() {
      const ctx = this.ensureContext();
      const paths = [...new Set(this.pkg.tracks.flatMap((track) => track.parts.map((part) => part.path)))];
      const missing = paths.filter((path) => !this.buffers.has(path));
      if (!missing.length || !this.pkg.clipBytes) return;

      this.setBar('loading');
      this.setStatus(`Decoding audio… 0/${missing.length}`);
      let done = 0;
      await Promise.all(missing.map(async (path) => {
        const bytes = this.pkg.clipBytes.get(clipKey(path));
        if (!bytes) return;
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const buffer = await ctx.decodeAudioData(copy);
        this.buffers.set(path, buffer);
        done += 1;
        this.setStatus(`Decoding audio… ${done}/${missing.length}`);
      }));
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
      if (!this.ui?.tracks) return;
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

  global.ProcsongPlayer = ProcsongPlayer;
})(typeof window !== 'undefined' ? window : this);
