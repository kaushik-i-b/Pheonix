import path from 'node:path';
import type { Workspace } from './repo-root.js';

const hostPathPattern = /(?<![\w.-])\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"'`)\]},;]*/g;

const secretPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted api key]'],
  [/\bAQ\.[A-Za-z0-9_.-]{8,}/g, '[redacted api key]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bAuthorization\s*[:=]\s*[^\s"'`]{8,}/gi, 'Authorization: [redacted]'],
];

export function maskHostPaths(text: string): string {
  return text.replace(hostPathPattern, '[host path withheld]');
}

export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of secretPatterns)
    masked = masked.replace(pattern, replacement);
  return masked;
}

export function sanitizeForDisplay(text: string, ws: Workspace, maxLength = 240): string {
  let display = text.split(ws.repoRoot + path.sep).join('');
  display = maskHostPaths(display);
  display = maskSecrets(display);
  display = display.replace(/\s+/g, ' ').trim();
  if (display.length > maxLength) display = display.slice(0, maxLength - 1) + '…';
  return display;
}
