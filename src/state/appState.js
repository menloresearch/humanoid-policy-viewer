import { reactive } from 'vue';
import { COMMAND_LIMITS } from '@/simulation/commandSequencer.js';

export function defaultLimits() {
  return {
    vx: [...COMMAND_LIMITS.vx],
    vy: [...COMMAND_LIMITS.vy],
    wz: [...COMMAND_LIMITS.wz]
  };
}

export const MAX_DURATION = 600;
export const NEW_DEFAULT_DURATION = 15;
export const DEFAULT_MASS = 30; // kg, fallback when the model mass is unavailable

// Shared app-level state: which page is showing and the sequence handed to the
// trajectory editor. A plain reactive() singleton (no vue-router in this app).
export const appState = reactive({
  page: 'viewer', // 'viewer' | 'editor' | 'results'
  editorSequence: null, // working copy the editor mutates
  editorFile: null, // filename on disk being edited (null = unsaved/new)
  mass: DEFAULT_MASS, // robot mass for derived-quantity charts
  bodyNames: [], // loaded model's real body names, for the push-event target-body picker
  benchmarkSelection: [], // relative test-file paths checked to run in the benchmark
  benchmarkResults: null, // the run currently loaded in memory (see benchmarkRunner)
  benchmarkResultsFile: null, // which saved run that is, if it came from disk
  benchmarkRuns: [] // metadata for the runs saved under benchmarks/, newest first
});

/** Adopt a run as the one on show, remembering which file it came from. */
export function setBenchmarkResults(results, file = null) {
  appState.benchmarkResults = results;
  appState.benchmarkResultsFile = file;
}

function blankSequence() {
  return {
    name: 'untitled',
    duration: NEW_DEFAULT_DURATION,
    limits: defaultLimits(),
    commands: [{ t: 0, vx: 0, vy: 0, wz: 0 }]
  };
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Switch to the editor. If a sequence is provided it is deep-copied so edits
 * don't touch the live sequencer; otherwise the previous working copy (or a
 * fresh 15s-of-zeros default) is kept.
 */
export function openEditor(sequence = null, file = null, mass = null, bodyNames = null) {
  if (sequence) {
    appState.editorSequence = deepCopy(sequence);
    appState.editorFile = file;
  } else if (!appState.editorSequence) {
    appState.editorSequence = blankSequence();
    appState.editorFile = null;
  }
  if (Number.isFinite(mass) && mass > 0) appState.mass = mass;
  // A real array replaces the list; anything else (undefined from
  // `this.demo?.listBodyNames?.()` when the demo isn't ready yet) must clear
  // it rather than leave a previous robot's names in place for the picker.
  appState.bodyNames = Array.isArray(bodyNames) ? bodyNames : [];
  appState.page = 'editor';
}

export function newBlankSequence() {
  appState.editorSequence = blankSequence();
  appState.editorFile = null;
}

export function closeEditor() {
  appState.page = 'viewer';
}

// Benchmark results page.
export function openResults(results = null) {
  if (results) appState.benchmarkResults = results;
  appState.page = 'results';
}

export function closeResults() {
  appState.page = 'viewer';
}
