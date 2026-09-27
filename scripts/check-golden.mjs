/**
 * Golden schedule check (SPECIFICATION.md §19).
 *
 * Usage:
 *   node scripts/check-golden.mjs
 *   node scripts/check-golden.mjs --write
 *
 * Loads the web player's engine in Node (no js-yaml). The fixture YAML is the
 * human-authored source of truth; track objects below MUST match it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const fixtureDir = join(root, 'fixtures', 'golden');
const expectedPath = join(fixtureDir, 'expected-t0.json');
const defPath = join(fixtureDir, 'definition.yml');

// Must stay identical to fixtures/golden/definition.yml (engine-ready shape).
const GOLDEN_TRACKS = [
  {
    name: 'Drums',
    declIndex: 0,
    loopSeconds: 10,
    repeats: 2,
    fullRepeats: 2,
    tailFraction: 0,
    silenceProbability: 0,
    clips: [
      { id: 'd1', path: 'Drums/A.wav', weight: 1 },
      { id: 'd2', path: 'Drums/B.wav', weight: 1 },
    ],
    intra: {
      columns: ['d1', 'd2'],
      rows: { d1: [1, 0], d2: [0, 1] },
    },
    inter: null,
  },
  {
    name: 'Bass',
    declIndex: 1,
    loopSeconds: 10,
    repeats: 2.4,
    fullRepeats: 2,
    tailFraction: 0.4,
    silenceProbability: 0.5,
    clips: [
      { id: 'b1', path: 'Bass/A.wav', weight: 1 },
      { id: 'b2', path: 'Bass/B.wav', weight: 1 },
    ],
    intra: null,
    inter: {
      columns: ['d1', 'd2'],
      rows: { b1: [1, 0], b2: [0, 1] },
    },
  },
  {
    name: 'Lead',
    declIndex: 2,
    loopSeconds: 8,
    repeats: 3,
    fullRepeats: 3,
    tailFraction: 0,
    silenceProbability: 0,
    clips: [
      { id: 'l1', path: 'Lead/A.wav', weight: 2 },
      { id: 'l2', path: 'Lead/B.wav', weight: 1 },
    ],
    intra: null,
    inter: null,
  },
];

const engineSrc = readFileSync(join(root, 'players/web/proc_song.js'), 'utf8');
const sandbox = {
  console,
  module: { exports: {} },
  exports: {},
  setTimeout,
  clearTimeout,
  URL,
  Map,
  Set,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Math,
  JSON,
  Error,
  BigInt,
  parseInt,
  parseFloat,
  isNaN,
  Infinity,
  NaN,
  undefined,
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(engineSrc, sandbox, { filename: 'proc_song.js' });

const { ProcsongEngine, parseSeed } = sandbox.module.exports;
if (!ProcsongEngine || !parseSeed) {
  console.error('Failed to load ProcsongEngine from players/web/proc_song.js');
  process.exit(1);
}

// Fixture YAML is the authored source of truth; GOLDEN_TRACKS must match it.
const yamlText = readFileSync(defPath, 'utf8');
for (const name of ['Drums', 'Bass', 'Lead', 'format_version: 2.0.0']) {
  if (!yamlText.includes(name)) {
    console.error(`fixtures/golden/definition.yml missing expected content: ${name}`);
    process.exit(1);
  }
}

const engine = new ProcsongEngine(
  GOLDEN_TRACKS.map((t) => structuredClone(t)),
  parseSeed('12345'),
);
const due = engine.evaluateDue(0);
const actual = due.map((pulse) => ({
  t: 0,
  track: pulse.track.name,
  ChosenClip: pulse.chosen,
  Muted: Boolean(pulse.muted),
  PlaySeconds: pulse.playSeconds,
  CropAudio: Boolean(pulse.cropAudio),
}));

const writeExpected = process.argv.includes('--write');
let expected;
if (writeExpected) {
  writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Wrote ${expectedPath}`);
  expected = actual;
} else {
  expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
}

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('Golden schedule mismatch for fixtures/golden + seed 12345');
  console.error('expected:', JSON.stringify(expected));
  console.error('actual:  ', JSON.stringify(actual));
  process.exit(1);
}

console.log(`OK — fixtures/golden matches seed 12345 t=0 (${actual.length} tracks)`);
