// Ephemeral test keys only; no key is shipped or accepted by the normal app.
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyReleaseEnvelope } from '../web/lib/provenance.js';
export function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
  return {
    pub,
    keys: { fixture: pub },
    envelope(value, keyId = 'fixture') {
      const payload = Buffer.from(JSON.stringify(value));
      return {
        keyId,
        payload: payload.toString('base64'),
        signature: sign(null, payload, privateKey).toString('base64'),
      };
    },
  };
}
export async function signedFixture(value) {
  const s = signer();
  return verifyReleaseEnvelope(
    s.envelope({
      schema: 1,
      version: '0.1.0',
      installationDescriptorSha256: 'd'.repeat(64),
      ...value,
    }),
    s.keys,
  );
}
