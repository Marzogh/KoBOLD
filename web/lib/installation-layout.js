import { exists } from './storage.js';
/** Recognise the public managed layout without trusting unsigned file markers. */
export async function installationLayout(reader) {
  return (await exists(reader, '.adds/kobold/last-result.txt')) ||
    (await exists(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS'))
    ? 'kobold'
    : 'none';
}
