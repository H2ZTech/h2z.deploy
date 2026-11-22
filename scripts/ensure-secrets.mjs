// `secrets-init` compose service: creates secret files added by a newer release (no credentials printed).
// Usage: node ensure-secrets.mjs <secrets dir>
import { ensureSecrets } from './secrets.mjs';
const dir = process.argv[2] || '/secrets';
const created = ensureSecrets(dir);
console.log(created.length ? 'secrets created: ' + created.join(', ') : 'secrets complete');
