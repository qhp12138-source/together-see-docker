import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const serverRoot = process.cwd();
const dockerignore = fs.readFileSync(path.join(serverRoot, '.dockerignore'), 'utf8');
const dockerfile = fs.readFileSync(path.join(serverRoot, 'Dockerfile'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package-lock.json'), 'utf8'));
const rootEnvExample = fs.readFileSync(path.join(serverRoot, '..', '.env.example'), 'utf8');
const serverEnvExample = fs.readFileSync(path.join(serverRoot, '.env.example'), 'utf8');
const composeFile = fs.readFileSync(path.join(serverRoot, '..', 'docker-compose.yml'), 'utf8');
const webDockerfile = fs.readFileSync(path.join(serverRoot, '..', 'Dockerfile'), 'utf8');
const nginxConfig = fs.readFileSync(path.join(serverRoot, '..', 'nginx', 'default.conf'), 'utf8');
const outerNginxConfig = fs.readFileSync(path.join(serverRoot, '..', 'nginx', 'baota-site.conf'), 'utf8');
const deploymentGuide = fs.readFileSync(path.join(serverRoot, '..', '部署文档.md'), 'utf8');
const troubleshootingGuide = fs.readFileSync(path.join(serverRoot, '..', 'DEPLOYMENT_AND_TROUBLESHOOTING.md'), 'utf8');
const ignoredEntries = dockerignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

assert.equal(
  ignoredEntries.includes('package-lock.json'),
  false,
  'server/package-lock.json must remain in the Docker build context because Dockerfile uses npm ci',
);
assert.match(
  dockerfile,
  /COPY package\.json package-lock\.json \.\//,
  'Dockerfile should copy the locked dependency manifest before npm ci',
);
assert.match(dockerfile, /npm ci --include=dev/, 'the Docker build stage should install the locked development tree');
assert.match(dockerfile, /npm ci --omit=dev/, 'the Docker runtime stage should install the locked production tree');
assert.equal(
  (dockerfile.match(/^FROM node:24\.18\.0-bookworm-slim@sha256:[a-f0-9]{64}(?: AS \w+)?$/gm) || []).length,
  2,
  'both Node build and runtime stages must use the reviewed immutable image digest',
);
assert.match(
  webDockerfile,
  /^FROM nginx:1\.28\.3-alpine@sha256:[a-f0-9]{64}$/m,
  'the web image must use the reviewed immutable Nginx digest',
);
assert.equal(packageLock.version, packageJson.version, 'package-lock version should match package.json');
assert.equal(packageLock.packages?.['']?.version, packageJson.version, 'root package-lock entry should match package.json');
assert.match(rootEnvExample, /^ROOM_RECONNECT_GRACE_MS=120000$/m, 'root environment example should delay full management takeover for 2 minutes');
assert.match(serverEnvExample, /^ROOM_RECONNECT_GRACE_MS=120000$/m, 'server environment example should delay full management takeover for 2 minutes');
assert.match(composeFile, /ROOM_RECONNECT_GRACE_MS: "\$\{ROOM_RECONNECT_GRACE_MS:-120000\}"/, 'Compose should default full management takeover to 2 minutes');
assert.match(rootEnvExample, /^ROOM_HOST_RECONNECT_GRACE_MS=60000$/m, 'root environment example should protect the host role for 60 seconds');
assert.match(serverEnvExample, /^ROOM_HOST_RECONNECT_GRACE_MS=60000$/m, 'server environment example should protect the host role for 60 seconds');
assert.match(composeFile, /ROOM_HOST_RECONNECT_GRACE_MS: "\$\{ROOM_HOST_RECONNECT_GRACE_MS:-60000\}"/, 'Compose should default the host reconnect grace to 60 seconds');
assert.doesNotMatch(webDockerfile, /COPY[^\n]*(?:README\.md|PROJECT_PROGRESS\.md|部署文档\.md|DEPLOYMENT_AND_TROUBLESHOOTING\.md)/, 'the public web image must not publish internal project or deployment documents');
assert.match(composeFile, /stop_grace_period:\s*70s/, 'Compose should outlast the maximum 60 second room-store shutdown timeout');
assert.match(
  nginxConfig,
  /log_format together_see_proxy[^;]*\$request_method \$uri \$server_protocol[^;]*;/s,
  'media proxy access logging must use URI-only request identity',
);
assert.match(
  nginxConfig,
  /location ~\* \^\/api\/proxy\(\?:\/\|\$\) \{[\s\S]*?access_log [^;]+ together_see_proxy;/,
  'canonical, case-variant, and bare-parent media proxy paths must use the query-redacting access log format',
);
assert.match(
  nginxConfig,
  /location ~\* \^\/api\/proxy\(\?:\/\|\$\) \{[\s\S]*?error_log \/dev\/null emerg;/,
  'media proxy errors must not persist bearer query strings in the container error log',
);
const proxyLogFormat = nginxConfig.match(/log_format together_see_proxy([\s\S]*?);/)?.[1] || '';
assert.doesNotMatch(proxyLogFormat, /\$(?:request|args|query_string|request_uri)\b/, 'media proxy logs must not persist bearer query tokens');

function extractLocationBlock(config, locationPattern, label) {
  const match = config.match(locationPattern);
  assert.ok(match?.index !== undefined, `${label} location must exist`);
  const openingBrace = config.indexOf('{', match.index);
  assert.notEqual(openingBrace, -1, `${label} location must have an opening brace`);
  let depth = 0;
  for (let index = openingBrace; index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}') depth -= 1;
    if (depth === 0) return config.slice(openingBrace + 1, index);
  }
  assert.fail(`${label} location must have a closing brace`);
}

const mediaProxyLocationPattern = /location\s+~\*\s+\^\/api\/proxy\(\?:\/\|\$\)\s*\{/;
for (const [name, config] of [['container Nginx', nginxConfig], ['BaoTa outer Nginx', outerNginxConfig]]) {
  const proxyBlock = extractLocationBlock(config, mediaProxyLocationPattern, `${name} media proxy`);
  assert.match(proxyBlock, /proxy_set_header\s+Range\s+\$http_range\s*;/, `${name} must forward byte Range requests`);
  assert.match(proxyBlock, /proxy_set_header\s+If-Range\s+\$http_if_range\s*;/, `${name} must forward conditional Range requests`);
  assert.match(proxyBlock, /proxy_cache\s+off\s*;/, `${name} must not cache authenticated media proxy responses`);
  assert.match(proxyBlock, /proxy_buffering\s+off\s*;/, `${name} must stream media proxy responses without buffering`);
  assert.match(proxyBlock, /proxy_request_buffering\s+off\s*;/, `${name} must not buffer media proxy requests`);
}

const outerProxyBlock = extractLocationBlock(outerNginxConfig, mediaProxyLocationPattern, 'BaoTa outer Nginx media proxy');
assert.match(outerProxyBlock, /access_log\s+off\s*;/, 'BaoTa media proxy access logging must be disabled');
assert.match(outerProxyBlock, /error_log\s+\/dev\/null\s+emerg\s*;/, 'BaoTa media proxy errors must not persist bearer query strings');
assert.match(outerProxyBlock, /proxy_pass\s+http:\/\/127\.0\.0\.1:8080\s*;/, 'BaoTa media proxy must preserve the original URI');
assert.match(outerNginxConfig, /location\s+\^~\s+\/socket\.io\/\s*\{[\s\S]*?proxy_set_header\s+Upgrade\s+\$http_upgrade\s*;/, 'BaoTa template must preserve WebSocket upgrades');
assert.match(outerNginxConfig, /location\s+\^~\s+\/assets\/\s*\{/, 'BaoTa template must protect assets from generic cache locations');
assert.doesNotMatch(outerNginxConfig, /location\s+\^~\s+\/api\//, 'BaoTa template must not let a generic ^~ /api/ prefix bypass the media proxy rule');
for (const [name, guide] of [['deployment guide', deploymentGuide], ['troubleshooting guide', troubleshootingGuide]]) {
  const guideProxyBlock = extractLocationBlock(guide, mediaProxyLocationPattern, `${name} media proxy`);
  assert.match(guideProxyBlock, /access_log\s+off\s*;/, `${name} must disable outer media proxy access logging`);
  assert.match(guideProxyBlock, /error_log\s+\/dev\/null\s+emerg\s*;/, `${name} must disable query-bearing media proxy error logs`);
  assert.match(guideProxyBlock, /proxy_pass\s+http:\/\/127\.0\.0\.1:8080\s*;/, `${name} must preserve the original media proxy URI`);
  assert.match(guideProxyBlock, /proxy_set_header\s+Range\s+\$http_range\s*;/, `${name} must document outer Range forwarding`);
  assert.match(guideProxyBlock, /proxy_set_header\s+If-Range\s+\$http_if_range\s*;/, `${name} must document outer If-Range forwarding`);
  assert.match(guideProxyBlock, /proxy_cache\s+off\s*;/, `${name} must disable media proxy caching`);
  assert.match(guideProxyBlock, /proxy_buffering\s+off\s*;/, `${name} must disable media response buffering`);
  assert.match(guideProxyBlock, /proxy_request_buffering\s+off\s*;/, `${name} must disable media request buffering`);
  assert.match(guide, /nginx\/baota-site\.conf/, `${name} must identify the tracked BaoTa proxy template`);
  assert.doesNotMatch(
    guide,
    /location \^~ \/api\//,
    `${name} must not let a generic ^~ /api/ prefix bypass the case-insensitive proxy token rule`,
  );
}
assert.match(composeFile, /^x-logging: &default-logging$/m, 'Compose should define one bounded logging policy');
assert.equal(
  (composeFile.match(/^\s+logging: \*default-logging$/gm) || []).length,
  2,
  'both production containers must use bounded log rotation',
);

const persistenceEnvironmentDefaults = {
  ROOM_STORE_SHUTDOWN_TIMEOUT_MS: '20000',
  ROOM_STORE_MAX_BYTES: '67108864',
  ROOM_STORE_MAX_ROOM_BYTES: '3145728',
  ROOM_STORE_MAX_ROOMS: '500',
  ROOM_MAX_ACTIVE: '20',
  ROOM_MAX_RECONNECT_ENTRIES: '100',
  ROOM_MAX_KICKED_ENTRIES: '400',
};
for (const [name, defaultValue] of Object.entries(persistenceEnvironmentDefaults)) {
  assert.match(rootEnvExample, new RegExp(`^${name}=${defaultValue}$`, 'm'), `root .env.example should document ${name}`);
  assert.match(serverEnvExample, new RegExp(`^${name}=${defaultValue}$`, 'm'), `server .env.example should document ${name}`);
  assert.match(composeFile, new RegExp(`${name}: "\\$\\{${name}:-${defaultValue}\\}"`), `Compose should pass ${name} to the server`);
}

const bilibiliEnvironmentVariables = [
  'BILIBILI_ENABLED',
  'BILIBILI_TIMEOUT_MS',
  'BILIBILI_RATE_LIMIT_PER_MINUTE',
  'BILIBILI_DANMAKU_MAX_ITEMS',
  'BILIBILI_DANMAKU_MAX_RESPONSE_BYTES',
  'BILIBILI_CACHE_TTL_MS',
];
for (const name of bilibiliEnvironmentVariables) {
  assert.match(rootEnvExample, new RegExp(`^${name}=`, 'm'), `root .env.example should document ${name}`);
  assert.match(serverEnvExample, new RegExp(`^${name}=`, 'm'), `server .env.example should document ${name}`);
  assert.match(composeFile, new RegExp(`\\b${name}:`), `Compose should pass ${name} to the server`);
}

console.log('release contract verification passed');
