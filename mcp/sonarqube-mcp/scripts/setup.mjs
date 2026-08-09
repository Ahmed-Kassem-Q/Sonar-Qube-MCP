#!/usr/bin/env node
/**
 * Create this package's `.env` from `.env.example`.
 *
 * Run as `npm run setup`, optionally passing credentials so nothing has to be
 * edited by hand:
 *
 *   npm run setup
 *   npm run setup -- --url=https://sonar.example.com --token=squ_xxx
 *
 * Deliberately NOT a postinstall hook: writing files into a working tree as a
 * side effect of `npm ci` surprises people. You run this when you mean to.
 *
 * When a credential is not supplied, its line is written **blank** rather than
 * carrying the placeholder from `.env.example`. A blank value makes the server
 * fail loudly at startup naming the missing variable; a placeholder would look
 * structurally valid and instead fail later as a confusing HTTP 401 against the
 * wrong host.
 *
 * Never commit a real `.env` — it is git-ignored, and this script never writes
 * credentials anywhere else.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(PACKAGE_ROOT, '.env.example');
const ENV_PATH = join(PACKAGE_ROOT, '.env');

/** Variables the user must supply; blanked unless passed on the command line. */
const REQUIRED_KEYS = ['SONARQUBE_URL', 'SONARQUBE_TOKEN'];

/** Parse `--key=value` and `--key value` flags. */
function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        parsed[arg.slice(2)] = next;
        i += 1;
      } else {
        parsed[arg.slice(2)] = 'true';
      }
    }
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`setup: ${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args['help'] === 'true') {
  process.stdout.write(
    'Usage: npm run setup [-- --url=<sonarqube-url>] [--token=<token>] [--force]\n\n' +
      '  --url    SONARQUBE_URL to write into .env\n' +
      '  --token  SONARQUBE_TOKEN to write into .env\n' +
      '  --force  overwrite an existing .env (it is backed up to .env.bak first)\n',
  );
  process.exit(0);
}

if (!existsSync(TEMPLATE_PATH)) {
  fail(`template not found at ${TEMPLATE_PATH}`);
}

const force = args['force'] === 'true';

if (existsSync(ENV_PATH) && !force) {
  // Never clobber a working config — the token in it may be unrecoverable.
  process.stdout.write(
    `setup: ${relative(process.cwd(), ENV_PATH)} already exists — leaving it untouched.\n` +
      '       Re-run with --force to replace it (the current file is backed up first).\n',
  );
  process.exit(0);
}

const supplied = {
  SONARQUBE_URL: args['url'],
  SONARQUBE_TOKEN: args['token'],
};

const lines = readFileSync(TEMPLATE_PATH, 'utf-8').split(/\r?\n/);
const written = [];

const output = lines.map((line) => {
  const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match === null) return line;

  const key = match[1];
  if (supplied[key] !== undefined && supplied[key] !== '') {
    written.push(key);
    return `${key}=${supplied[key]}`;
  }
  // Blank the required keys so a missing value fails loudly at startup.
  if (REQUIRED_KEYS.includes(key)) return `${key}=`;
  return line;
});

if (existsSync(ENV_PATH)) {
  writeFileSync(`${ENV_PATH}.bak`, readFileSync(ENV_PATH));
  process.stdout.write('setup: existing .env backed up to .env.bak\n');
}

writeFileSync(ENV_PATH, output.join('\n'), 'utf-8');

const shortPath = relative(process.cwd(), ENV_PATH) || '.env';
process.stdout.write(`setup: created ${shortPath}\n`);

const missing = REQUIRED_KEYS.filter((key) => !written.includes(key));
if (missing.length > 0) {
  process.stdout.write(
    `\nNext: open ${shortPath} and set ${missing.join(' and ')}.\n` +
      'Generate a token in SonarQube under My Account -> Security -> Generate Tokens\n' +
      '(type "User Token"). Ask a teammate for the server URL.\n',
  );
} else {
  process.stdout.write('\nCredentials written. Next: npm run build, then open the project.\n');
}
