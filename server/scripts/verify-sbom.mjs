import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalizeTextForHash, createReleaseSbom, releaseSbomPath, serializeReleaseSbom } from './sbom.mjs';

const hashText = (value) => crypto.createHash('sha256').update(canonicalizeTextForHash(value)).digest('hex');
assert.equal(
  hashText('line one\r\nline two\r\n'),
  hashText('line one\nline two\n'),
  'text bundle hashes must be stable across CRLF and LF checkouts',
);

const committed = fs.readFileSync(releaseSbomPath, 'utf8');
const generated = serializeReleaseSbom();
assert.equal(
  committed.replace(/\r\n/g, '\n'),
  generated.replace(/\r\n/g, '\n'),
  'SBOM.cdx.json is stale; run npm run generate:sbom',
);

const sbom = createReleaseSbom();
assert.equal(sbom.bomFormat, 'CycloneDX');
assert.equal(sbom.specVersion, '1.5');
assert.equal(sbom.metadata.component.name, 'together-see');
assert.ok(sbom.components.some((component) => component.name === 'together-see-server'));
assert.ok(sbom.components.some((component) => component.name === 'hls.js' && component.hashes?.[0]?.alg === 'SHA-256'));
for (const imageName of ['node', 'nginx']) {
  const component = sbom.components.find((candidate) => candidate.type === 'container' && candidate.name === imageName);
  assert.ok(component, `${imageName} container must be present in the production SBOM`);
  assert.equal(component.hashes?.[0]?.alg, 'SHA-256', `${imageName} container must include its immutable digest`);
  assert.match(component.hashes?.[0]?.content || '', /^[a-f0-9]{64}$/, `${imageName} container digest must be valid`);
  assert.match(
    component.properties?.find((property) => property.name === 'together-see:container-reference')?.value || '',
    /@sha256:[a-f0-9]{64}$/,
    `${imageName} container reference must be digest-pinned`,
  );
}
for (const devOnlyName of ['@playwright/test', 'typescript', 'tsx']) {
  assert.equal(sbom.components.some((component) => component.name === devOnlyName), false, `${devOnlyName} must not be present in the production SBOM`);
}

console.log(`release SBOM verification passed: ${sbom.components.length} components`);
