import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverRoot, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalizeTextForHash(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

function parseImageReference(dockerfile, stage) {
  const match = dockerfile.match(new RegExp(`^FROM\\s+([^\\s]+)${stage ? `\\s+AS\\s+${stage}` : ''}\\s*$`, 'im'));
  if (!match) throw new Error(`Unable to identify ${stage || 'web'} base image`);
  const reference = match[1];
  const [taggedReference, digest, ...extraParts] = reference.split('@');
  if (extraParts.length > 0 || !digest || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`Base image must use an immutable sha256 digest: ${reference}`);
  }
  const separator = taggedReference.lastIndexOf(':');
  if (separator <= taggedReference.lastIndexOf('/')) throw new Error(`Base image must use an explicit version tag: ${reference}`);
  return {
    reference,
    name: taggedReference.slice(0, separator),
    version: taggedReference.slice(separator + 1),
    digest: digest.slice('sha256:'.length).toLowerCase(),
  };
}

function imageComponent(image) {
  const shortName = image.name.split('/').at(-1);
  return {
    'bom-ref': `container:${image.reference}`,
    type: 'container',
    name: shortName,
    version: image.version,
    scope: 'required',
    purl: `pkg:docker/${shortName}@${image.version}`,
    hashes: [{ alg: 'SHA-256', content: image.digest }],
    properties: [{ name: 'together-see:container-reference', value: image.reference }],
  };
}

function normalizeDependencies(dependencies) {
  const merged = new Map();
  for (const entry of dependencies) {
    const dependsOn = merged.get(entry.ref) || new Set();
    for (const dependency of entry.dependsOn || []) dependsOn.add(dependency);
    merged.set(entry.ref, dependsOn);
  }
  return [...merged.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((left, right) => String(left.ref).localeCompare(String(right.ref)));
}

function packageNameFromPath(packagePath) {
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) throw new Error(`Unable to derive package name from lock path: ${packagePath}`);
  return packagePath.slice(index + marker.length);
}

function npmPurl(name, version) {
  const purlName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${purlName}@${version}`;
}

function integrityHash(integrity) {
  const match = String(integrity || '').match(/^(sha(?:256|384|512))-([A-Za-z0-9+/=]+)$/i);
  if (!match) return undefined;
  const algorithm = match[1].toUpperCase().replace(/^SHA(\d+)$/, 'SHA-$1');
  return [{ alg: algorithm, content: Buffer.from(match[2], 'base64').toString('hex') }];
}

function resolveLockedDependencyPath(packages, packagePath, dependencyName) {
  let cursor = packagePath;
  while (true) {
    const candidate = cursor ? `${cursor}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (packages[candidate] && packages[candidate].dev !== true) return candidate;
    const parentMarker = '/node_modules/';
    const parentIndex = cursor.lastIndexOf(parentMarker);
    if (parentIndex < 0) {
      if (!cursor) return null;
      cursor = '';
    } else {
      cursor = cursor.slice(0, parentIndex);
    }
  }
}

function createProductionDependencyGraph(packageJson, packageLock) {
  const packages = packageLock.packages || {};
  const rootPaths = Object.keys(packageJson.dependencies || {})
    .map((name) => resolveLockedDependencyPath(packages, '', name))
    .filter(Boolean);
  const reachablePaths = new Set();
  const queue = [...rootPaths];
  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (!packagePath || reachablePaths.has(packagePath)) continue;
    reachablePaths.add(packagePath);
    const entry = packages[packagePath];
    for (const dependencyName of new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
    ])) {
      const resolvedPath = resolveLockedDependencyPath(packages, packagePath, dependencyName);
      if (resolvedPath && !reachablePaths.has(resolvedPath)) queue.push(resolvedPath);
    }
  }

  const componentByRef = new Map();
  const dependencies = [];
  const packageRefByPath = new Map();
  for (const packagePath of reachablePaths) {
    const entry = packages[packagePath];
    if (!entry.version) continue;
    const name = entry.name || packageNameFromPath(packagePath);
    const ref = `${name}@${entry.version}`;
    packageRefByPath.set(packagePath, ref);
    if (componentByRef.has(ref)) continue;
    componentByRef.set(ref, {
      'bom-ref': ref,
      type: 'library',
      name,
      version: entry.version,
      scope: entry.optional === true ? 'optional' : 'required',
      purl: npmPurl(name, entry.version),
      ...(integrityHash(entry.integrity) ? { hashes: integrityHash(entry.integrity) } : {}),
      ...(entry.license ? { licenses: [{ expression: entry.license }] } : {}),
    });
  }

  for (const [packagePath, ref] of packageRefByPath.entries()) {
    const entry = packages[packagePath];
    const dependencyNames = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
    ]);
    const dependsOn = [...dependencyNames]
      .map((name) => resolveLockedDependencyPath(packages, packagePath, name))
      .filter(Boolean)
      .map((resolvedPath) => packageRefByPath.get(resolvedPath))
      .filter(Boolean);
    dependencies.push({ ref, dependsOn: [...new Set(dependsOn)] });
  }

  const directDependsOn = rootPaths
    .map((resolvedPath) => packageRefByPath.get(resolvedPath))
    .filter(Boolean);
  return {
    components: [...componentByRef.values()],
    dependencies,
    directDependsOn: [...new Set(directDependsOn)],
  };
}

export function createReleaseSbom() {
  const packageJson = readJson(path.join(serverRoot, 'package.json'));
  const packageLock = readJson(path.join(serverRoot, 'package-lock.json'));
  const productionGraph = createProductionDependencyGraph(packageJson, packageLock);

  const hlsSource = fs.readFileSync(path.join(projectRoot, 'assets', 'js', 'hls.js'));
  const hlsVersion = hlsSource.toString('utf8').match(/hls\.js version ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  if (!hlsVersion) throw new Error('Unable to identify the bundled hls.js version');

  const serverDockerfile = fs.readFileSync(path.join(serverRoot, 'Dockerfile'), 'utf8');
  const webDockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
  const nodeImage = parseImageReference(serverDockerfile, 'runtime');
  const nginxImage = parseImageReference(webDockerfile, '');
  const appRef = `together-see@${packageJson.version}`;
  const serverComponent = {
    'bom-ref': `${packageJson.name}@${packageJson.version}`,
    name: packageJson.name,
    version: packageJson.version,
    type: 'application',
    scope: 'required',
    purl: npmPurl(packageJson.name, packageJson.version),
  };
  const hlsRef = `hls.js@${hlsVersion}`;
  const extraComponents = [
    serverComponent,
    {
      'bom-ref': hlsRef,
      type: 'library',
      name: 'hls.js',
      version: hlsVersion,
      scope: 'required',
      purl: `pkg:npm/hls.js@${hlsVersion}`,
      hashes: [{ alg: 'SHA-256', content: sha256(canonicalizeTextForHash(hlsSource.toString('utf8'))) }],
      properties: [{ name: 'together-see:distribution', value: 'vendored-browser-bundle' }],
    },
    imageComponent(nodeImage),
    imageComponent(nginxImage),
  ];
  const components = [...extraComponents, ...productionGraph.components]
    .sort((left, right) => String(left['bom-ref']).localeCompare(String(right['bom-ref'])));
  const rootDependency = {
    ref: appRef,
    dependsOn: extraComponents.map((component) => component['bom-ref']).sort(),
  };

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      lifecycles: [{ phase: 'pre-build' }],
      component: {
        'bom-ref': appRef,
        type: 'application',
        name: 'together-see',
        version: packageJson.version,
        scope: 'required',
        purl: `pkg:generic/together-see@${packageJson.version}`,
        properties: [{ name: 'together-see:release-scope', value: 'single-instance-anonymous-small-public' }],
      },
    },
    components,
    dependencies: normalizeDependencies([
      rootDependency,
      { ref: serverComponent['bom-ref'], dependsOn: productionGraph.directDependsOn },
      { ref: hlsRef, dependsOn: [] },
      ...extraComponents.slice(2).map((component) => ({ ref: component['bom-ref'], dependsOn: [] })),
      ...productionGraph.dependencies,
    ]),
  };
}

export function serializeReleaseSbom() {
  return `${JSON.stringify(createReleaseSbom(), null, 2)}\n`;
}

export const releaseSbomPath = path.join(projectRoot, 'SBOM.cdx.json');
