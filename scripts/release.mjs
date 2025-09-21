#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const logger = {
  info: (...args) => console.log('[cw.api.core.queue.local]', ...args),
  error: (...args) => console.error('[cw.api.core.queue.local]', ...args)
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const allowedTypes = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'];
const allowed = new Set(allowedTypes);

const helpText = `Release helper\n\nUsage:\n  npm run release -- <type> [commit message]\n  npm run release --patch\n  npm run release -- patch "custom message"\n  npm run release patch\n  node scripts/release.mjs patch "custom message"\n\nTypes:\n  ${allowedTypes.join(', ')}\n\nNotes:\n  - Defaults to "chore: release v%s" when you omit a message.\n  - If your message omits %s the version number is appended.\n  - Pushes commits and tags automatically after bumping.`;

const defaultMessage = 'chore: release v%s';
const args = process.argv.slice(2);

if (args[0] === '--') {
  args.shift();
}

function normalizeType(value) {
  if (!value) return undefined;
  if (value === '--') return undefined;
  if (value.startsWith('--')) return value.slice(2);
  if (value.startsWith('-')) return value.slice(1);
  return value;
}

function detectTypeFromEnv() {
  for (const type of allowedTypes) {
    const envValue = process.env['npm_config_' + type];
    if (typeof envValue !== 'undefined' && (envValue === '' || envValue === 'true')) {
      return type;
    }
  }
  return undefined;
}

let potentialType = normalizeType(args[0]);

if (potentialType && ['help', 'h', '?'].includes(potentialType)) {
  logger.info(helpText);
  process.exit(0);
}

let messageParts;
if (potentialType && allowed.has(potentialType)) {
  messageParts = args.slice(1);
} else {
  potentialType = detectTypeFromEnv();
  messageParts = args;
}

const typeArg = potentialType;

if (!typeArg || !allowed.has(typeArg)) {
  logger.error(helpText);
  process.exit(1);
}

const rawMessage = messageParts.join(' ').trim();
const commitMessage = rawMessage.length > 0 ? rawMessage : defaultMessage;
const finalMessage = commitMessage.includes('%s') ? commitMessage : commitMessage + ' %s';

try {
  run('npm', ['version', typeArg, '-m', finalMessage]);
  run('git', ['push']);
  run('git', ['push', '--tags']);
} catch (error) {
  logger.error('Release failed:', error.message);
  process.exit(1);
}
