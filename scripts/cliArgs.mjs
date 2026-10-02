// Shared comma-separated list parsing for --policies/--tests style CLI flags.
export function splitCsv(value) {
  return value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
}

// Command lines for `npm run benchmark` / `npm run suite` are made of plain
// words, because npm passes those to the script untouched but swallows anything
// starting with "--" unless the user types a bare "--" first:
//
//   npm run benchmark menloresearch/asimov1-loco suite=../my-suite jobs=2 pr
//
//   <word>         positional (a model, a suite, a sub-command...)
//   key=value      option; keys listed in `repeatable` may be given several times
//   flag           a known bare word, e.g. pr, dry-run
//
// `--key=value`, `--key value` and `--flag` are accepted as well, for running
// the script with node directly.

/**
 * @param argv        process.argv.slice(2)
 * @param keys        option names that take a value
 * @param flags       bare-word switches
 * @param repeatable  option names collected into arrays
 */
export function parseWords(argv, { keys = [], flags = [], repeatable = [] } = {}) {
  const result = { positionals: [], options: {}, flags: new Set() };
  const setOption = (key, value) => {
    if (!keys.includes(key)) throw new Error(`Unknown option "${key}=". Known: ${keys.map((k) => `${k}=`).join(' ')}`);
    if (value === undefined || value === '') throw new Error(`Option ${key}= needs a value`);
    if (repeatable.includes(key)) (result.options[key] ??= []).push(value);
    else if (key in result.options) throw new Error(`Option ${key}= was given twice`);
    else result.options[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word.startsWith('--')) {
      const [key, inline] = word.slice(2).split(/=(.*)/s);
      if (flags.includes(key) && inline === undefined) result.flags.add(key);
      else setOption(key, inline ?? argv[++i]);
      continue;
    }
    const eq = /^([a-z][a-z0-9-]*)=(.*)$/s.exec(word);
    // A key=value word, unless it is really a path or URL that contains "=".
    if (eq && keys.includes(eq[1])) setOption(eq[1], eq[2]);
    else if (eq && !word.includes('/')) throw new Error(`Unknown option "${eq[1]}=". Known: ${keys.map((k) => `${k}=`).join(' ')}`);
    else if (flags.includes(word)) result.flags.add(word);
    else result.positionals.push(word);
  }
  return result;
}

/**
 * npm turns an unknown `--name` given to `npm run` into the environment
 * variable npm_config_name and does not pass it on. Report any that look like
 * ours, so `npm run benchmark x --pr` fails instead of silently not opening a PR.
 */
export function swallowedNpmFlags(env, names) {
  return names.filter((name) => env[`npm_config_${name.replace(/-/g, '_')}`] !== undefined);
}
