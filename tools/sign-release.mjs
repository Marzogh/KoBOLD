// Offline signing only. Private keys must live outside this repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
const [keyFile, input, output, trustFile] = process.argv.slice(2);
if (!keyFile || !input || !output || !trustFile)
  throw Error('Usage: sign-release.mjs PRIVATE_PEM INPUT OUTPUT TRUST_JSON');
const key = createPrivateKey({
  key: readFileSync(keyFile),
  passphrase: process.env.KOBOLD_SIGNING_PASSPHRASE,
});
if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
const pub = createPublicKey(key)
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64');
const keys = JSON.parse(readFileSync(trustFile));
const id = Object.keys(keys).find((id) => keys[id] === pub);
if (!id) throw Error('Signing key is not independently trusted');
const payload = readFileSync(input);
writeFileSync(
  output,
  JSON.stringify({
    keyId: id,
    payload: payload.toString('base64'),
    signature: sign(null, payload, key).toString('base64'),
  }) + '\n',
  { flag: 'wx' },
);
