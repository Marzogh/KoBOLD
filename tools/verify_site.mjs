// Validate immutable site assets against repository trust before deployment.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, verify } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(process.argv[2] ?? '');
const production = process.argv.includes('--production');
const hash = (b) => createHash('sha256').update(b).digest('hex');
function safe(name) {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((x) => !x || x === '.' || x === '..')
  )
    throw Error('Unsafe site path');
  return resolve(site, name);
}
const bytes = (name) => readFileSync(safe(name));
const json = (name) => JSON.parse(bytes(name));
function authenticated(folder, role) {
  const keys = JSON.parse(
    readFileSync(resolve(root, 'web/trust/' + role + '-keys.json')),
  );
  const e = json(folder + '/manifest.signed.json');
  const publicKey = Buffer.from(keys[e.keyId] ?? '', 'base64');
  const payload = Buffer.from(e.payload, 'base64');
  if (
    publicKey.length !== 32 ||
    !verify(
      null,
      payload,
      {
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
        type: 'spki',
        format: 'der',
      },
      Buffer.from(e.signature, 'base64'),
    )
  )
    throw Error('Untrusted ' + role + ' manifest');
  if (!payload.equals(bytes(folder + '/manifest.json')))
    throw Error('Manifest bytes differ');
  if (
    !bytes('trust/' + role + '-keys.json').equals(
      readFileSync(resolve(root, 'web/trust/' + role + '-keys.json')),
    )
  )
    throw Error('Site trust differs from repository');
  return JSON.parse(payload);
}
function checked(folder, item) {
  if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid asset checksum');
  const data = bytes(folder + '/' + item.url);
  if (data.length !== item.size || hash(data) !== item.sha256)
    throw Error('Asset checksum failed');
}
const inventory = json('PUBLICATION.json');
const names = new Set(Object.keys(inventory.files));
for (const [name, item] of Object.entries(inventory.files)) {
  const data = bytes(name);
  if (hash(data) !== item.sha256 || data.length !== item.bytes)
    throw Error('Site inventory mismatch');
}
function walk(dir) {
  for (const item of readdirSync(dir)) {
    const path = resolve(dir, item),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Site symlink');
    if (stat.isDirectory()) walk(path);
    else {
      const n = relative(site, path).replaceAll('\\', '/');
      if (n !== 'PUBLICATION.json' && !names.has(n)) throw Error('Unlisted site file');
    }
  }
}
walk(site);
const release = authenticated('releases/0.1.0', 'release');
const collection = authenticated('collection', 'collection');
for (const item of [...release.files, ...Object.values(release.updates)])
  checked('releases/0.1.0', item);
checked('collection', collection.archive);
const sources = json('releases/0.1.0/sources/sources.lock.json');
for (const item of sources.files)
  if (hash(bytes('releases/0.1.0/sources/' + item.filename)) !== item.sha256)
    throw Error('Source checksum failed');
if (
  release.preflight?.collection?.id !== collection.id ||
  release.preflight.collection.descriptorSha256 !== collection.descriptorSha256
)
  throw Error('Collector binding failed');
if (production) {
  const evidence = json('releases/0.1.0/acceptance.json');
  if (
    release.channel !== 'tested' ||
    release.namespace !== 'kobold' ||
    release.profile.bootstrapAccepted !== true ||
    collection.hardwareAccepted !== true ||
    evidence.profileId !== release.profile.id ||
    evidence.archiveSha256 !== release.updates['bootstrap.tgz'].sha256 ||
    evidence.collectionSha256 !== collection.archive.sha256 ||
    release.profile.bootstrapEvidence?.archiveSha256 !== evidence.archiveSha256 ||
    release.profile.bootstrapEvidence?.recordSha256 !==
      hash(bytes('releases/0.1.0/acceptance.json'))
  )
    throw Error('Production acceptance is incomplete');
  for (const k of [
    'usbBackup',
    'systemBackup',
    'libraryExclusion',
    'installation',
    'enrolment',
    'sync',
    'automaticStartup',
    'rebootSync',
    'otherInternetSync',
  ])
    if (evidence.checks?.[k] !== true) throw Error('Hardware check missing');
  if (
    bytes('index.html').toString().includes('name="kobold-site-mode" content="preview"')
  )
    throw Error('Preview cannot be released');
}
console.log(
  JSON.stringify({
    channel: release.channel,
    files: names.size,
    production,
    bootstrap: release.updates['bootstrap.tgz'].sha256,
  }),
);
