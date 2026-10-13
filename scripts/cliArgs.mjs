// Shared comma-separated list parsing for tests=/robots= style options.
export function splitCsv(value) {
  return value?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
}

// Every command line (`npm run dev`, `npm run hf`, `npm run benchmark`) is made
// of plain words, because npm passes those to the script untouched but swallows
// anything starting with "--" unless the user types a bare "--" first:
//
//   npm run benchmark menloresearch/asimov1-loco benchmark=../my-benchmark jobs=2 pr
//
//   <word>         positional (a policy, a benchmark, a sub-command...)
//   key=value      option; keys listed in `repeatable` may be given several times
//   flag           a known bare word, e.g. pr, dry-run
//
// A "--" word is refused with the words form to write instead, so one command
// line works the same through npm and with node directly.

/**
 * @param argv        process.argv.slice(2)
 * @param keys        option names that take a value
 * @param flags       bare-word switches
 * @param repeatable  option names collected into arrays
 * @param hints       name -> how to write a "--name" this command spells differently
 */
export function parseWords(argv, { keys = [], flags = [], repeatable = [], hints = {} } = {}) {
  const result = { positionals: [], options: {}, flags: new Set() };
  const setOption = (key, value) => {
    if (!keys.includes(key)) throw new Error(`Unknown option "${key}=". Known: ${keys.map((k) => `${k}=`).join(' ')}`);
    if (value === undefined || value === '') throw new Error(`Option ${key}= needs a value`);
    if (repeatable.includes(key)) (result.options[key] ??= []).push(value);
    else if (key in result.options) throw new Error(`Option ${key}= was given twice`);
    else result.options[key] = value;
  };
  for (const word of argv) {
    if (word.startsWith('--')) throw new Error(dashedWordError(word, { keys, flags, hints }));
    const eq = /^([a-z][a-z0-9-]*)=(.*)$/s.exec(word);
    // A key=value word, unless it is really a path or URL that contains "=".
    if (eq && keys.includes(eq[1])) setOption(eq[1], eq[2]);
    else if (eq && !word.includes('/')) throw new Error(`Unknown option "${eq[1]}=". Known: ${keys.map((k) => `${k}=`).join(' ')}`);
    else if (flags.includes(word)) result.flags.add(word);
    else result.positionals.push(word);
  }
  return result;
}

function dashedWordError(word, { keys, flags, hints }) {
  const [name, inline] = word.slice(2).split(/=(.*)/s);
  const how = hints[name]
    ?? (keys.includes(name) ? `write ${name}=${inline || '<value>'}`
      : flags.includes(name) ? `write ${name}`
        : `write options as key=value and flags as plain words${keys.length ? ` (options: ${keys.map((k) => `${k}=`).join(' ')})` : ''}${flags.length ? ` (flags: ${flags.join(' ')})` : ''}`);
  return `"${word}": no dashes; ${how}.`;
}

/**
 * npm turns an unknown `--name` given to `npm run` into the environment
 * variable npm_config_name and does not pass it on. Report any that look like
 * ours, so `npm run benchmark x --pr` fails instead of silently not opening a PR.
 */
export function swallowedNpmFlags(env, names) {
  return names.filter((name) => env[`npm_config_${name.replace(/-/g, '_')}`] !== undefined);
}

/** Throws, naming the words form, if npm swallowed any of these keys, flags or hinted names. */
export function rejectSwallowedNpmFlags(env, { keys = [], flags = [], hints = {} }) {
  // npm answers --help itself; every other flag it strips and runs the script anyway.
  const swallowed = swallowedNpmFlags(env, [...new Set([...keys, ...flags.filter((f) => f !== 'help'), ...Object.keys(hints)])]);
  if (swallowed.length) {
    const how = (f) => hints[f] ?? `write ${keys.includes(f) ? `${f}=<value>` : f}`;
    throw new Error(`npm kept ${swallowed.map((f) => `--${f}`).join(', ')} for itself (no dashes): ${swallowed.map(how).join('; ')}.`);
  }
}

/** port=<n> as a number, or undefined when not given. */
export function parsePort(value) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port=${value}: must be 1-65535`);
  return port;
}
