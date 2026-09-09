import fs from 'node:fs';
import { releaseSbomPath, serializeReleaseSbom } from './sbom.mjs';

fs.writeFileSync(releaseSbomPath, serializeReleaseSbom(), 'utf8');
console.log(`release SBOM generated: ${releaseSbomPath}`);
