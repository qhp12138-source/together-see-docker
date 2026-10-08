import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('..');
const generated = new Set(['.git', 'node_modules', 'dist', '.artifacts', 'test-results', 'playwright-report']);
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (generated.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [path.relative(root, target).replaceAll('\\', '/')];
  });
}
let files;
try {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (path.resolve(top).toLowerCase() !== root.toLowerCase()) throw new Error('archive outside its own repository');
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  files = walk(root);
}
files = [...new Set(files)].filter(file => fs.existsSync(path.join(root, file)));
const forbiddenPath = /(?:^|\/)(?:\.agents?|\.codex|node_modules|dist|data|private|\.local|\.artifacts)(?:\/|$)|(?:^|\/)\.env(?!\.example$)(?:\.|$)|\.(?:zip|tgz|pem|key|log)$/i;
const sensitive = [
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{24,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /codex:\/\/threads\//,
  /togethersee\.aihouse\.cyou/i,
  /\/www\/backup\/together-see/i,
  /[CD]:[\\/]Users[\\/]qhp12|D:[\\/]CodexProject/i,
];
for (const file of files) {
  assert.doesNotMatch(file, forbiddenPath, `forbidden public path: ${file}`);
  if (/\.(?:png|webp|wav|webm|ico)$/i.test(file)) continue;
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const pattern of sensitive) assert.equal(pattern.test(text), false, `sensitive public content in ${file}`);
  if (!file.endsWith('.md')) continue;
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1].split('#')[0];
    if (!href || /^(?:https?:|mailto:)/i.test(href)) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), decodeURIComponent(href))), `broken local link in ${file}`);
  }
}
const assetFiles = files.filter(file => file.startsWith('assets/interactions/'));
assert.deepEqual(assetFiles.sort(), [
  'assets/interactions/catalog.json', 'assets/interactions/question/audio.wav',
  'assets/interactions/question/poster.png', 'assets/interactions/question/spritesheet.png',
]);
assert.ok(files.includes('server/package-lock.json'));
assert.ok(files.includes('LICENSE') && files.includes('server/LICENSE'));
assert.equal(files.some(file => /(?:^|\/)RELEASE_0|OPEN_SOURCE_HANDOFF|NEXT_MAJOR_HANDOFF|NEW_SESSION_PROMPT/.test(file)), false);
console.log(`Public export privacy, asset and documentation boundaries passed: ${files.length} files`);
