/**
 * ProcsongLibrary — embeddable song list that drives a ProcsongPlayer.
 *
 * Renders a list of procsongs into a target element. Each row has a Play
 * button that looks up the player by target id and calls player.play().
 *
 * No extra script dependencies. Include after proc_song.js if you want Play
 * to drive a ProcsongPlayer on the same page.
 *
 * @example
 *   // From an in-memory list:
 *   const library = new ProcsongLibrary({
 *     target: 'library',
 *     player: 'player',            // id of the player's target div
 *     heading: 'Library',          // optional; empty string hides it
 *     library: [
 *       { title, artist, description, tags, procsong_url, image_url },
 *     ],
 *   });
 *   library.initialise();
 *
 *   // From a remote CSV or JSON URL:
 *   const library = new ProcsongLibrary({
 *     target: 'library',
 *     player: 'player',
 *     library: 'https://example.com/library.csv',
 *   });
 *   await library.initialise();
 *
 * Entry fields (all optional except procsong_url):
 *   title, artist, description, tags, procsong_url, image_url
 *
 * `library` may be:
 *   - an array of entry objects
 *   - a single entry object
 *   - a URL string ending in .json or .csv (format is sniffed if unclear)
 *
 * JSON may be an array, or an object with a songs / library / entries array.
 *
 * @param {object} options
 * @param {string|HTMLElement} options.target
 * @param {string|object|object[]} options.library
 * @param {string|HTMLElement|ProcsongPlayer} options.player
 * @param {string} [options.heading=Library]
 */
(function (global) {
  'use strict';

  const LIBRARY_CSS = `
.pslib {
  --ps-bg: var(--panel, #1a1a1a);
  --ps-line: var(--line, #3a3a3a);
  --ps-text: var(--text, #eee);
  --ps-muted: var(--muted, #999);
  --ps-accent: var(--accent, #ccc);
  --ps-btn-text: var(--on-accent, var(--bg, #111));
  --ps-input: var(--input-bg, #111);
  --ps-error: var(--error, #e8a090);
  --ps-sans: var(--sans, inherit);
  --ps-mono: var(--mono, ui-monospace, monospace);
  color: var(--ps-text);
  font-family: var(--ps-sans);
  margin: 0 0 10px;
}
.pslib .pslib-label {
  margin: 0 0 8px;
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.pslib .pslib-status {
  margin: 0;
  padding: 14px 16px;
  background: var(--ps-bg);
  border: 1px solid var(--ps-line);
  border-radius: 8px;
  color: var(--ps-muted);
}
.pslib .pslib-status.is-error { color: var(--ps-error); }
.pslib .pslib-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pslib .pslib-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--ps-bg);
  border: 1px solid var(--ps-line);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.pslib .pslib-row:hover,
.pslib .pslib-row.is-playing {
  border-color: var(--ps-accent);
}
.pslib .pslib-cover {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  flex: 0 0 36px;
  background: var(--ps-input);
}
.pslib .pslib-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}
.pslib .pslib-heading {
  margin: 0;
  min-width: 0;
  flex: 1 1 8em;
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  overflow: hidden;
  line-height: 1.25;
}
.pslib .pslib-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pslib .pslib-dot { color: var(--ps-muted); flex: 0 0 auto; }
.pslib .pslib-artist {
  color: var(--ps-muted);
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pslib .pslib-url {
  color: var(--ps-muted);
  font-family: var(--ps-mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pslib .pslib-tags {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.pslib .pslib-tags li {
  border: 1px solid var(--ps-line);
  border-radius: 999px;
  padding: 2px 8px;
  color: var(--ps-muted);
  font-size: 11px;
  white-space: nowrap;
}
.pslib .pslib-play {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  background: var(--ps-accent);
  color: var(--ps-btn-text);
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}
.pslib .pslib-play svg {
  width: 14px;
  height: 14px;
  margin-left: 2px;
  fill: currentColor;
}
.pslib .pslib-play:disabled { opacity: 0.45; cursor: default; }
`;

  function ensureCss() {
    if (document.getElementById('procsong-library-css')) return;
    const style = document.createElement('style');
    style.id = 'procsong-library-css';
    style.textContent = LIBRARY_CSS;
    document.head.appendChild(style);
  }

  function pick(obj, ...keys) {
    if (!obj) return '';
    for (const key of keys) {
      if (obj[key] != null && String(obj[key]).trim() !== '') return obj[key];
    }
    return '';
  }

  function normalizeUrl(url) {
    if (!url) return '';
    let value = String(url).trim();
    if (/^ttps:\/\//i.test(value)) value = `h${value}`;
    return value;
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

  function resolveElement(target) {
    if (!target) throw new Error('ProcsongLibrary requires a target element or id');
    if (target instanceof Element) return target;
    const selector = String(target);
    const byId = document.getElementById(selector.replace(/^#/, ''));
    if (byId) return byId;
    const found = document.querySelector(selector);
    if (!found) throw new Error(`ProcsongLibrary target not found: ${target}`);
    return found;
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

  function normalizeEntry(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      const procSongUrl = normalizeUrl(raw);
      return procSongUrl ? { title: '', artist: '', description: '', tags: [], procSongUrl, imageUrl: '' } : null;
    }
    if (typeof raw !== 'object') return null;
    const procSongUrl = normalizeUrl(pick(raw, 'procSongUrl', 'proc_song_url', 'procsong_url', 'url'));
    if (!procSongUrl) return null;
    return {
      title: String(pick(raw, 'title', 'songName', 'name') || ''),
      artist: String(pick(raw, 'artist') || ''),
      description: String(pick(raw, 'description') || ''),
      tags: parseTags(raw.tags),
      procSongUrl,
      imageUrl: normalizeUrl(pick(raw, 'imageUrl', 'image_url')),
    };
  }

  function entriesFromJson(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.songs)) return data.songs;
      if (Array.isArray(data.library)) return data.library;
      if (Array.isArray(data.entries)) return data.entries;
      if (pick(data, 'procSongUrl', 'proc_song_url', 'procsong_url', 'url')) return [data];
    }
    throw new Error('JSON library did not contain a song list');
  }

  function parseCsv(text) {
    const input = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (inQuotes) {
        if (ch === '"') {
          if (input[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }

    const nonempty = rows.filter((item) => item.some((value) => String(value).trim() !== ''));
    if (!nonempty.length) return [];
    const header = nonempty[0].map((name) => String(name).trim().toLowerCase());
    return nonempty.slice(1).map((values) => {
      const obj = {};
      header.forEach((name, i) => {
        if (name) obj[name] = values[i] != null ? String(values[i]).trim() : '';
      });
      return obj;
    });
  }

  function pathnameOf(url) {
    try {
      return new URL(url, typeof window !== 'undefined' ? window.location.href : undefined).pathname.toLowerCase();
    } catch (_) {
      return String(url).toLowerCase();
    }
  }

  function inferFormat(url, contentType, text) {
    const path = pathnameOf(url);
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.csv')) return 'csv';
    const type = (contentType || '').toLowerCase();
    if (type.includes('json')) return 'json';
    if (type.includes('csv')) return 'csv';
    const start = String(text).trim()[0];
    if (start === '[' || start === '{') return 'json';
    return 'csv';
  }

  async function fetchLibrary(url) {
    const response = await fetch(dropboxDirectUrl(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const format = inferFormat(url, response.headers.get('content-type'), text);
    const raw = format === 'json' ? entriesFromJson(JSON.parse(text.replace(/^\uFEFF/, ''))) : parseCsv(text);
    return raw.map(normalizeEntry).filter(Boolean);
  }

  class ProcsongLibrary {
    /**
     * @param {object} options See file header for the public API.
     */
    constructor(options = {}) {
      this.target = options.target;
      this.playerTarget = options.player;
      this.librarySource = options.library;
      this.heading = headingText(options.heading, 'Library');
      this.el = null;
      this.items = [];
      this.activeUrl = '';
      this.boundPlayer = null;
    }

    /**
     * Fetch the library if needed and render it into `options.target`.
     * @returns {Promise<ProcsongLibrary>}
     */
    async initialise() {
      ensureCss();
      this.el = resolveElement(this.target);
      this.showStatus('Loading library…');
      this.watchPlayer();
      try {
        this.items = await this.resolveLibrary(this.librarySource);
        this.render();
      } catch (err) {
        this.showStatus(`Failed to load library: ${err.message || err}`, true);
        throw err;
      }
      return this;
    }

    /**
     * Replace the library source and re-render.
     * @param {string|object|object[]} library
     * @returns {Promise<ProcsongLibrary>}
     */
    load(library) {
      this.librarySource = library;
      return this.initialise();
    }

    async resolveLibrary(library) {
      if (library == null || library === '') throw new Error('No library provided');
      if (typeof library === 'string') return fetchLibrary(library.trim());
      return entriesFromJson(library).map(normalizeEntry).filter(Boolean);
    }

    watchPlayer() {
      const player = this.findPlayer();
      if (!player || !player.el || this.boundPlayer === player) return;
      this.boundPlayer = player;
      player.el.addEventListener('procsong:play', (event) => {
        this.activeUrl = (event.detail && event.detail.procSongUrl) || '';
        this.markActive();
      });
      player.el.addEventListener('procsong:stop', () => {
        this.activeUrl = '';
        this.markActive();
      });
    }

    findPlayer() {
      if (!this.playerTarget) return null;
      const Player = global.ProcsongPlayer;
      if (Player && typeof Player.get === 'function') {
        const found = Player.get(this.playerTarget);
        if (found) return found;
      }
      if (typeof this.playerTarget.play === 'function') return this.playerTarget;
      return null;
    }

    headingEl() {
      if (!this.heading) return null;
      const label = document.createElement('p');
      label.className = 'pslib-label';
      label.textContent = this.heading;
      return label;
    }

    setContent(node) {
      const wrap = document.createElement('div');
      wrap.className = 'pslib';
      const label = this.headingEl();
      if (label) wrap.appendChild(label);
      wrap.appendChild(node);
      this.el.replaceChildren(wrap);
    }

    showStatus(message, isError) {
      const status = document.createElement('p');
      status.className = isError ? 'pslib-status is-error' : 'pslib-status';
      status.textContent = message;
      this.setContent(status);
    }

    render() {
      if (!this.items.length) {
        const status = document.createElement('p');
        status.className = 'pslib-status';
        status.textContent = 'No songs in this library.';
        this.setContent(status);
        return;
      }

      const list = document.createElement('ul');
      list.className = 'pslib-list';
      this.items.forEach((item) => list.appendChild(this.rowEl(item)));
      this.setContent(list);
      this.markActive();
    }

    rowEl(item) {
      const row = document.createElement('li');
      row.className = 'pslib-row';
      row.dataset.procSongUrl = item.procSongUrl;
      if (item.description) row.title = item.description;

      if (item.imageUrl) {
        const img = document.createElement('img');
        img.className = 'pslib-cover';
        img.alt = item.title || item.artist || 'Cover art';
        img.loading = 'lazy';
        img.src = dropboxDirectUrl(item.imageUrl);
        img.addEventListener('error', () => img.remove());
        row.appendChild(img);
      }

      const main = document.createElement('div');
      main.className = 'pslib-main';

      const heading = document.createElement('p');
      heading.className = 'pslib-heading';
      if (item.title) {
        const title = document.createElement('span');
        title.className = 'pslib-title';
        title.textContent = item.title;
        heading.appendChild(title);
      }
      if (item.title && item.artist) {
        const dot = document.createElement('span');
        dot.className = 'pslib-dot';
        dot.textContent = '•';
        heading.appendChild(dot);
        const artist = document.createElement('span');
        artist.className = 'pslib-artist';
        artist.textContent = item.artist;
        heading.appendChild(artist);
      } else if (!item.title && item.artist) {
        const artist = document.createElement('span');
        artist.className = 'pslib-title';
        artist.textContent = item.artist;
        heading.appendChild(artist);
      } else if (!item.title && !item.artist) {
        const url = document.createElement('span');
        url.className = 'pslib-url';
        url.textContent = item.procSongUrl;
        heading.appendChild(url);
      }
      main.appendChild(heading);

      if (item.tags.length) {
        const tags = document.createElement('ul');
        tags.className = 'pslib-tags';
        item.tags.forEach((tag) => {
          const li = document.createElement('li');
          li.textContent = tag;
          tags.appendChild(li);
        });
        main.appendChild(tags);
      }

      row.appendChild(main);

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'pslib-play';
      play.setAttribute('aria-hidden', 'true');
      play.tabIndex = -1;
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5-9-5.5z"/></svg>';
      const start = () => {
        this.playItem(item, play).catch(() => {});
      };
      row.addEventListener('click', start);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          start();
        }
      });
      row.tabIndex = 0;
      row.setAttribute('aria-label', item.title ? `Play ${item.title}` : 'Play procsong');
      row.appendChild(play);
      return row;
    }

    markActive() {
      if (!this.el) return;
      this.el.querySelectorAll('.pslib-row').forEach((row) => {
        row.classList.toggle('is-playing', Boolean(this.activeUrl) && row.dataset.procSongUrl === this.activeUrl);
      });
    }

    async playItem(item, button) {
      const player = this.findPlayer();
      if (!player || typeof player.play !== 'function') {
        throw new Error('No procsong player found. Pass the player target id as `player`.');
      }
      this.watchPlayer();
      button.disabled = true;
      try {
        await player.play({
          title: item.title,
          artist: item.artist,
          imageUrl: item.imageUrl,
          description: item.description,
          tags: item.tags,
          procSongUrl: item.procSongUrl,
        });
        this.activeUrl = item.procSongUrl;
        this.markActive();
      } finally {
        button.disabled = false;
      }
    }
  }

  global.ProcsongLibrary = ProcsongLibrary;
})(typeof window !== 'undefined' ? window : this);
