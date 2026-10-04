#!/usr/bin/env tsx
import { PhoenixError } from '@phoenix/shared';
import { CHARACTERIZE_USAGE, characterizeCommand } from './characterize.js';
import { DISCOVER_USAGE, discoverCommand } from './discover.js';
import { MODERNIZE_USAGE, modernizeCommand } from './modernize.js';
import { SPECIFY_USAGE, specifyCommand } from './specify.js';

/**
 * The Phoenix command line.
 *
 * Commands are added as their stages start working end to end; a stage that is not wired yet says so
 * and exits non-zero rather than reporting a run it did not perform.
 */

const USAGE = [
  'usage: phoenix <command> [options]',
  '',
  'commands:',
  '  discover     run the DISCOVER stage and write its artifacts',
  '  specify      derive candidate business rules and invariants from a run\'s discovery findings',
  '  characterize propose and capture behavioral scenarios against the live legacy system',
  '  modernize    generate the modern implementation and repair it until differential verification passes',
  '',
  DISCOVER_USAGE,
  '',
  SPECIFY_USAGE,
  '',
  CHARACTERIZE_USAGE,
  '',
  MODERNIZE_USAGE,
].join('\n');

const COMMANDS: Record<string, (argv: readonly string[]) => Promise<number>> = {
  discover: discoverCommand,
  specify: specifyCommand,
  characterize: characterizeCommand,
  modernize: modernizeCommand,
};

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 2 : 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    throw new PhoenixError('CONFIG_INVALID', `unknown command "${command}"`, { usage: USAGE });
  }
  return handler(rest);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const described =
      error instanceof PhoenixError
        ? error.toJSON()
        : {
            code: 'UNEXPECTED',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          };
    process.stderr.write(`${JSON.stringify({ level: 'error', ...described })}\n`);
    process.exitCode = 2;
  });
