/**
 * ProcsongPlayer (v2) — embeddable web player for Procsong version-2 packages.
 *
 * This implements the version-2 conformance specification (format_version
 * 2.0.0): tracks are clip groups, dependency/evaluation order is track
 * declaration order, and candidate weighting uses two distinct matrices:
 *
 *   - intragroup_subsequent_weight_modifiers
 *       this group's PREVIOUS selection → weights this group's NEXT candidates
 *   - intergroup_consecutive_weight_modifiers
 *       other groups' CURRENT selections → weight this group's CURRENT candidates
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
 *   - title and artist                    → title • artist on one line
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
 * @param {string|number} [options.seed=12345]
 * @param {string} [options.heading=Player]
 */
(function (global) {
  'use strict';

  const FADE_SEC = 0.008;
  const LOOKAHEAD_SEC = 1;
  const CLOCK_MS = 250;
  const FORMAT_VERSION = '2.0.0';

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
  --ps-clip: var(--viz-clip, #3fb950);
  --ps-clip-on: var(--viz-clip-on, var(--transport-play, var(--secondary, #5ee0ff)));
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
.ps-player .ps-box {
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
  gap: 5px;
  margin: auto 0 0;
  padding: 8px 0 0;
  list-style: none;
}
.ps-player .ps-tags li {
  border: 1px solid var(--ps-line);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--ps-muted);
  font-size: 10px;
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
.ps-player .ps-viz {
  display: flex;
  align-items: flex-end;
  justify-content: space-around;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--ps-line);
  overflow-x: auto;
}
.ps-player .ps-viz[hidden] { display: none !important; }
.ps-player .ps-viz-track {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 1 1 0;
  min-width: 48px;
}
.ps-player .ps-viz-clips {
  display: flex;
  flex-direction: column-reverse;
  gap: 4px;
  align-items: center;
}
.ps-player .ps-viz-clip {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 28px;
  max-width: 100%;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--ps-clip);
  color: var(--ps-btn-text);
  opacity: 0.5;
  font-family: var(--ps-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.ps-player .ps-viz-clip.is-current {
  background: var(--ps-clip-on);
  opacity: 1;
  animation: ps-clip-pulse 1.1s ease-in-out infinite;
}
.ps-player .ps-viz-clip.is-current.is-muted {
  animation: none;
  opacity: 0.45;
  background: color-mix(in srgb, var(--ps-clip-on) 40%, transparent);
}
.ps-player .ps-viz-name {
  max-width: 76px;
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes ps-clip-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ps-clip-on) 55%, transparent);
  }
  50% {
    transform: scale(1.06);
    box-shadow: 0 0 9px 2px color-mix(in srgb, var(--ps-clip-on) 45%, transparent);
  }
}
@media (max-width: 640px) {
  .ps-player .ps-now { flex-wrap: wrap; }
  .ps-player .ps-controls-col {
    margin-left: auto;
    min-height: 0;
    align-self: flex-start;
    justify-content: flex-start;
  }
  .ps-player .ps-volume { margin-top: 8px; }
  .ps-player .ps-viz { gap: 6px; }
  .ps-player .ps-viz-clip { font-size: 9px; padding: 2px 5px; min-width: 24px; }
  .ps-player .ps-viz-name { font-size: 9px; max-width: 60px; }
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

  // ---------------------------------------------------------------------------
  // PRNG (spec §14): one shared unsigned 64-bit LCG, two draws per evaluation.
  // ---------------------------------------------------------------------------
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

  // spec §12: AtLeastOne
  function atLeastOne(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return 1;
    const rounded = Math.floor(value + 0.5);
    return rounded > 0 ? rounded : 1;
  }

  // ---------------------------------------------------------------------------
  // Parsing (spec §3–7) — array-based tracks, clip groups, and two matrices.
  // ---------------------------------------------------------------------------

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function parseWeight(value, context) {
    if (value == null) return 1;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`${context} must be a non-negative number (got ${JSON.stringify(value)})`);
    }
    return num;
  }

  function parseClip(entry, trackName, index) {
    const where = `Track "${trackName}" clip #${index + 1}`;
    if (!isPlainObject(entry)) throw new Error(`${where} must be a mapping with id and path`);
    const id = entry.id;
    const path = entry.path;
    if (typeof id !== 'string' || !id.trim()) throw new Error(`${where} is missing a string id`);
    if (typeof path !== 'string' || !path.trim()) throw new Error(`${where} (${id}) is missing a string path`);
    return {
      id,
      path,
      weight: parseWeight(entry.weight, `${where} (${id}) weight`),
    };
  }

  // Read a raw matrix into { columns:[ids], rows:{id:[numbers]} }. Structural
  // (shape) validation only; cross-reference checks happen in validateDefinition.
  function parseMatrix(raw, trackName, kind) {
    if (raw == null) return null;
    const where = `Track "${trackName}" ${kind}`;
    if (!isPlainObject(raw)) throw new Error(`${where} must be a mapping with columns and rows`);
    if (!Array.isArray(raw.columns)) throw new Error(`${where} is missing a columns array`);
    if (!isPlainObject(raw.rows)) throw new Error(`${where} is missing a rows mapping`);

    const columns = raw.columns.map((col, i) => {
      if (typeof col !== 'string' || !col.trim()) {
        throw new Error(`${where} column #${i + 1} must be a clip id string`);
      }
      return col;
    });
    if (new Set(columns).size !== columns.length) {
      throw new Error(`${where} columns must be unique clip ids`);
    }

    const rows = {};
    for (const [rowKey, values] of Object.entries(raw.rows)) {
      if (!Array.isArray(values)) throw new Error(`${where} row "${rowKey}" must be an array`);
      rows[rowKey] = values.map((v, i) => parseWeight(v, `${where} row "${rowKey}" cell #${i + 1}`));
    }
    return { columns, rows };
  }

  function parseTrack(spec, index) {
    const where = `Track #${index + 1}`;
    if (!isPlainObject(spec)) throw new Error(`${where} must be a mapping`);
    const name = spec.name;
    if (typeof name !== 'string' || !name.trim()) throw new Error(`${where} is missing a string name`);
    if (name.includes('/')) throw new Error(`Track "${name}" name must not contain "/"`);

    if (spec.clip_length == null) throw new Error(`Track "${name}" is missing clip_length`);
    const clipLengthNum = Number(spec.clip_length);
    if (!Number.isFinite(clipLengthNum) || clipLengthNum < 0) {
      throw new Error(`Track "${name}" clip_length must be a non-negative number`);
    }

    const repeats = spec.repeats;
    if (!Number.isInteger(repeats) || repeats < 1) {
      throw new Error(`Track "${name}" repeats must be an integer >= 1`);
    }

    let silenceProbability = 0;
    if (spec.silence_probability != null) {
      silenceProbability = Number(spec.silence_probability);
      if (!Number.isFinite(silenceProbability) || silenceProbability < 0 || silenceProbability > 1) {
        throw new Error(`Track "${name}" silence_probability must be between 0 and 1`);
      }
    }

    if (!Array.isArray(spec.clips) || !spec.clips.length) {
      throw new Error(`Track "${name}" must define a non-empty clips array`);
    }
    const clips = spec.clips.map((clip, i) => parseClip(clip, name, i));

    return {
      name,
      declIndex: index,
      loopSeconds: atLeastOne(spec.clip_length),
      repeats,
      silenceProbability,
      clips,
      intra: parseMatrix(spec.intragroup_subsequent_weight_modifiers, name, 'intragroup_subsequent_weight_modifiers'),
      inter: parseMatrix(spec.intergroup_consecutive_weight_modifiers, name, 'intergroup_consecutive_weight_modifiers'),
    };
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((item) => set.has(item));
  }

  // Cross-reference / semantic validation (spec §17). JSON Schema handles the
  // basic shape; these rules cannot be expressed there.
  function validateDefinition(tracks) {
    // 1. unique track names
    const trackNames = tracks.map((t) => t.name);
    if (new Set(trackNames).size !== trackNames.length) {
      throw new Error('Track names must be unique');
    }

    // 2. clip ids unique across the whole definition; also map id -> owner track
    const clipOwner = new Map();
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clipOwner.has(clip.id)) {
          throw new Error(`Clip id "${clip.id}" is used more than once (must be unique across the whole definition)`);
        }
        clipOwner.set(clip.id, track);
      }
    }

    for (const track of tracks) {
      const clipIds = track.clips.map((c) => c.id);

      // Intra-group matrix (spec §6.1)
      if (track.intra) {
        const m = track.intra;
        // 3. columns exactly equal this track's clip ids, in declaration order
        if (!arraysEqual(m.columns, clipIds)) {
          throw new Error(`Track "${track.name}" intra columns must equal its clip ids in declaration order`);
        }
        const rowKeys = Object.keys(m.rows);
        // 4. rows contain exactly those same clip ids (one row each)
        if (!sameSet(rowKeys, clipIds)) {
          throw new Error(`Track "${track.name}" intra rows must contain exactly one row for each clip id`);
        }
        // 5. every row length equals column count
        for (const [key, values] of Object.entries(m.rows)) {
          if (values.length !== m.columns.length) {
            throw new Error(`Track "${track.name}" intra row "${key}" length must equal column count (${m.columns.length})`);
          }
        }
      }

      // Inter-group matrix (spec §7.1, §7.2)
      if (track.inter) {
        const m = track.inter;
        const rowKeys = Object.keys(m.rows);
        // 6. row keys exactly equal the downstream track's clip ids
        if (!sameSet(rowKeys, clipIds)) {
          throw new Error(`Track "${track.name}" inter rows must contain exactly one row for each clip id`);
        }
        // 7. every row length equals column count
        for (const [key, values] of Object.entries(m.rows)) {
          if (values.length !== m.columns.length) {
            throw new Error(`Track "${track.name}" inter row "${key}" length must equal column count (${m.columns.length})`);
          }
        }

        // 8/9. every column resolves to a clip on an EARLIER track
        const repOrder = [];
        const seenTracks = new Set();
        for (const col of m.columns) {
          const owner = clipOwner.get(col);
          if (!owner) {
            throw new Error(`Track "${track.name}" inter column "${col}" is not a known clip id`);
          }
          if (owner.declIndex >= track.declIndex) {
            throw new Error(`Track "${track.name}" inter column "${col}" references clip on the same or a later track`);
          }
          if (!seenTracks.has(owner.declIndex)) {
            seenTracks.add(owner.declIndex);
            repOrder.push(owner);
          }
        }

        // 11. represented upstream tracks appear in top-level declaration order
        for (let i = 1; i < repOrder.length; i += 1) {
          if (repOrder[i].declIndex <= repOrder[i - 1].declIndex) {
            throw new Error(`Track "${track.name}" inter columns must list upstream tracks in declaration order`);
          }
        }

        // 10. each represented upstream track contributes all its clip ids
        //     exactly once, in that track's clip declaration order.
        for (const upstream of repOrder) {
          const upstreamIds = upstream.clips.map((c) => c.id);
          const colsForUpstream = m.columns.filter((col) => clipOwner.get(col) === upstream);
          if (!arraysEqual(colsForUpstream, upstreamIds)) {
            throw new Error(
              `Track "${track.name}" inter columns for upstream track "${upstream.name}" must be all of its clip ids in declaration order`,
            );
          }
        }
      }
    }

    return tracks;
  }

  function parseDefinition(yamlText) {
    const raw = jsyaml.load(yamlText.replace(/^\uFEFF/, ''));
    if (!isPlainObject(raw)) throw new Error('definition.yml did not contain a mapping');
    if (String(raw.format_version) !== FORMAT_VERSION) {
      throw new Error(`Unsupported format_version "${raw.format_version}" (expected ${FORMAT_VERSION})`);
    }
    if (!Array.isArray(raw.tracks) || !raw.tracks.length) {
      throw new Error('definition.yml must contain a non-empty tracks array');
    }
    const tracks = raw.tracks.map((spec, i) => parseTrack(spec, i));
    return validateDefinition(tracks);
  }

  // ---------------------------------------------------------------------------
  // Engine (spec §8–13) — matrix-weighted selection with declaration-order
  // evaluation and independent per-track clocks.
  // ---------------------------------------------------------------------------
  class ProcsongEngine {
    constructor(tracks, seed) {
      this.rng = new ProcsongRNG(seed);
      this.tracks = tracks;

      // Global clip id -> declaration index of owning track.
      this.clipOwnerIndex = new Map();
      tracks.forEach((track) => {
        track.clips.forEach((clip) => this.clipOwnerIndex.set(clip.id, track.declIndex));
      });

      this.state = tracks.map((track) => ({
        track,
        chosenId: null,
        chosen: null,
        muted: true,
        nextLoop: 0,
        remaining: 0,
        intraColIndex: track.intra ? new Map(track.intra.columns.map((id, i) => [id, i])) : null,
        interColIndex: track.inter ? new Map(track.inter.columns.map((id, i) => [id, i])) : null,
        interRepresented: [],
      }));

      // Precompute, per track, the ordered list of upstream track slots that
      // are represented in its inter-group columns.
      this.state.forEach((slot) => {
        if (!slot.track.inter) return;
        const seen = new Set();
        const represented = [];
        for (const col of slot.track.inter.columns) {
          const ownerIndex = this.clipOwnerIndex.get(col);
          if (ownerIndex == null || seen.has(ownerIndex)) continue;
          seen.add(ownerIndex);
          represented.push(this.state[ownerIndex]);
        }
        slot.interRepresented = represented;
      });
    }

    // spec §10.1
    getIntraModifier(slot, clip) {
      if (slot.chosenId == null) return 1;
      const intra = slot.track.intra;
      if (!intra) return 1;
      const col = slot.intraColIndex.get(clip.id);
      return intra.rows[slot.chosenId][col];
    }

    // spec §10.2
    getInterModifier(slot, clip) {
      const inter = slot.track.inter;
      if (!inter) return 1;
      const row = inter.rows[clip.id];
      let result = 1;
      for (const upstream of slot.interRepresented) {
        if (upstream.chosenId == null) continue;
        const col = slot.interColIndex.get(upstream.chosenId);
        result *= row[col];
      }
      return result;
    }

    // spec §9, §11 — exactly two draws, weighted walk in declaration order.
    evaluate(slot) {
      const rPart = this.rng.nextFloat();
      const rSilence = this.rng.nextFloat();

      const clips = slot.track.clips;
      const weights = new Array(clips.length);
      let total = 0;
      for (let i = 0; i < clips.length; i += 1) {
        const clip = clips[i];
        const w = clip.weight * this.getIntraModifier(slot, clip) * this.getInterModifier(slot, clip);
        weights[i] = w;
        total += w;
      }

      let chosenId = null;
      let chosen = null;
      if (total > 0) {
        const target = rPart * total;
        let running = 0;
        for (let i = 0; i < clips.length; i += 1) {
          running += weights[i];
          if (running > target) {
            chosenId = clips[i].id;
            chosen = clips[i].path;
            break;
          }
        }
      }

      const muted = chosen == null ? true : rSilence < slot.track.silenceProbability;
      return { rPart, rSilence, chosenId, chosen, muted };
    }

    // spec §12 — Pulse. Retriggers consume no PRNG draws.
    pulse(slot, tick) {
      let evaluated = null;
      if (slot.remaining <= 0) {
        evaluated = this.evaluate(slot);
        slot.chosenId = evaluated.chosenId;
        slot.chosen = evaluated.chosen;
        slot.muted = evaluated.muted;
        slot.remaining = slot.track.repeats;
      }
      slot.remaining -= 1;
      slot.nextLoop = tick + slot.track.loopSeconds;
      return {
        track: slot.track,
        chosenId: slot.chosenId,
        chosen: slot.chosen,
        muted: slot.muted,
        ...(evaluated || {}),
      };
    }

    peekNextTick() {
      return Math.min(...this.state.map((slot) => slot.nextLoop));
    }

    // spec §13 — at one shared second, tracks pulse in declaration order so a
    // later track immediately sees an earlier track's newly queued selection.
    evaluateDue(tick) {
      const results = [];
      for (const slot of this.state) {
        if (slot.nextLoop === tick) results.push(this.pulse(slot, tick));
      }
      return results;
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

  // spec §3 — file lookup may ignore case or a single extension.
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

  class ProcsongPlayer {
    /**
     * @param {object} options See file header for the public API.
     */
    constructor(options = {}) {
      this.target = options.target;
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
      this.vizBoxes = null;

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
        seed: this.el.querySelector('.ps-seed'),
        playBtn: this.el.querySelector('.ps-play'),
        stopBtn: this.el.querySelector('.ps-stop'),
        volume: this.el.querySelector('.ps-volume-input'),
        status: this.el.querySelector('.ps-status'),
        transport: this.el.querySelector('.ps-transport'),
        viz: this.el.querySelector('.ps-viz'),
        clock: this.el.querySelector('.ps-clock'),
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
        this.setBar(null);
        this.buildViz();
        this.setVizVisible(true);
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
        this.clearViz();
        this.setVizVisible(false);
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
            </div>
            <div class="ps-viz" hidden></div>
          </div>
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
    }

    register() {
      playersByEl.set(this.el, this);
      if (this.el.id) playersById.set(this.el.id, this);
    }

    emit(name, detail) {
      if (!this.el) return;
      this.el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} }));
    }

    updateMeta() {
      if (!this.ui) return;
      const title = this.title.trim();
      const artist = this.artist.trim();
      const imageUrl = this.imageUrl.trim();
      const url = this.procSongUrl.trim();
      const hasTitleAndArtist = Boolean(title && artist);

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
      const paths = [...new Set(this.pkg.tracks.flatMap((track) => track.clips.map((clip) => clip.path)))];
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

    // spec §15 — start the whole referenced clip; do not crop to LoopSeconds.
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
      this.renderViz();
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

    // Build the per-track clip visualisation: one column per track, a small box
    // per clip, with the track name underneath.
    buildViz() {
      if (!this.ui?.viz) return;
      this.vizBoxes = new Map();
      this.ui.viz.replaceChildren();
      const tracks = this.pkg?.tracks || [];
      if (!tracks.length) return;
      for (const track of tracks) {
        const col = document.createElement('div');
        col.className = 'ps-viz-track';

        const clipsWrap = document.createElement('div');
        clipsWrap.className = 'ps-viz-clips';
        const boxes = track.clips.map((clip) => {
          const box = document.createElement('span');
          box.className = 'ps-viz-clip';
          box.textContent = clip.id;
          box.title = clip.id;
          clipsWrap.appendChild(box);
          return box;
        });

        const name = document.createElement('div');
        name.className = 'ps-viz-name';
        name.textContent = track.name;
        name.title = track.name;

        col.append(clipsWrap, name);
        this.ui.viz.appendChild(col);
        this.vizBoxes.set(track, boxes);
      }
    }

    setVizVisible(show) {
      if (this.ui?.viz) this.ui.viz.hidden = !show;
    }

    clearViz() {
      if (!this.vizBoxes) return;
      for (const boxes of this.vizBoxes.values()) {
        boxes.forEach((box) => box.classList.remove('is-current', 'is-muted'));
      }
    }

    // Highlight the current clip per track: blue + pulse when audible, a dim
    // blue when the current selection is muted (silent but still selected).
    renderViz() {
      if (!this.vizBoxes) return;
      for (const [track, boxes] of this.vizBoxes) {
        const slot = this.engine?.state.find((item) => item.track === track);
        const chosenId = slot?.chosen ? slot.chosenId : null;
        const muted = slot?.muted ?? true;
        track.clips.forEach((clip, i) => {
          const current = chosenId != null && clip.id === chosenId;
          boxes[i].classList.toggle('is-current', current);
          boxes[i].classList.toggle('is-muted', current && muted);
        });
      }
    }
  }

  global.ProcsongPlayer = ProcsongPlayer;

  // Expose internals for headless testing / conformance checks (spec §19).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProcsongPlayer, ProcsongEngine, ProcsongRNG, parseDefinition, validateDefinition, atLeastOne };
  }
})(typeof window !== 'undefined' ? window : this);
