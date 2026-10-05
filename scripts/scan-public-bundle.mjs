#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PATTERNS = [
  { label: 'api key (sk-)', re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { label: 'api key (AQ.)', re: /\bAQ\.[A-Za-z0-9_.-]{8,}/g },
  { label: 'authorization value', re: /\bAuthorization\s*[:=]\s*[^\s"']{8,}/gi },
  { label: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { label: 'absolute user path', re: /(?<![\w.-])\/(?:Users|home)\/[^\s"'`)\]},;<>]*/g },
];

const BINARYISH_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.gz',
  '.br',
  '.pdf',
  '.wasm',
]);

export function maskMatch(match) {
  return `${match.slice(0, 6)}…${match.slice(-2)}`;
}

export function scanText(text) {
  const findings = [];
  const lines = text.split('\n');
  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(re)) {
        findings.push({ label: pattern.label, line: index + 1, masked: maskMatch(match[0]) });
      }
    }
  }
  findings.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
  return findings;
}

export function scanDir(dir) {
  const findings = [];
  walk(dir, dir, findings);
  return findings;
}

function walk(root, current, findings) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    if (BINARYISH_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const text = readFileSync(full, 'utf8');
    for (const finding of scanText(text)) {
      findings.push({ file: relative(root, full), ...finding });
    }
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const dir = process.argv[2] ?? 'apps/web/out';
  let findings;
  try {
    findings = scanDir(dir);
  } catch (error) {
    console.error(`scan error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.label}] ${finding.masked}`);
  }
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s) in ${dir}; refusing to publish this bundle.`);
    process.exit(1);
  }
  console.log(`clean: no secrets or host paths found in ${dir}`);
}
