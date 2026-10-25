let tick = 1;
const err = (name) => Object.assign(Error(name), { name });
export class MemoryDirectory {
  constructor(name = 'root', parent = null) {
    this.kind = 'directory';
    this.name = name;
    this.parent = parent;
    this.children = new Map();
    this.writes = [];
    this.fault = null;
  }
  get root() {
    return this.parent ? this.parent.root : this;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    let h = this.children.get(name);
    if (h && h.kind !== 'directory') throw err('TypeMismatchError');
    if (!h) {
      if (!create) throw err('NotFoundError');
      h = new MemoryDirectory(name, this);
      this.children.set(name, h);
    }
    return h;
  }
  async getFileHandle(name, { create = false } = {}) {
    let h = this.children.get(name);
    if (h && h.kind !== 'file') throw err('TypeMismatchError');
    if (!h) {
      if (!create) throw err('NotFoundError');
      h = new MemoryFile(name, this);
      this.children.set(name, h);
    }
    return h;
  }
  async *entries() {
    if (this.listError) throw this.listError;
    yield* this.children.entries();
  }
  async isSameEntry(other) {
    return this === other;
  }
  async resolve(other) {
    const names = [];
    for (let p = other; p; p = p.parent) {
      if (p === this) return names.reverse();
      names.push(p.name);
    }
    return null;
  }
  async removeEntry(name) {
    if (this.root.removeFault?.(name))
      throw new DOMException(
        'The file could not be modified.',
        'InvalidModificationError',
      );
    if (!this.children.has(name)) throw err('NotFoundError');
    const h = this.children.get(name);
    if (h.kind === 'directory' && h.children.size)
      throw err('InvalidModificationError');
    this.children.delete(name);
  }
}
class MemoryFile {
  constructor(name, parent) {
    this.kind = 'file';
    this.name = name;
    this.parent = parent;
    this.data = new Uint8Array();
    this.modified = tick++;
  }
  get path() {
    const parts = [this.name];
    for (let p = this.parent; p.parent; p = p.parent) parts.unshift(p.name);
    return parts.join('/');
  }
  async getFile() {
    const f = new Blob([this.data]);
    Object.defineProperties(f, {
      lastModified: { value: this.modified },
      name: { value: this.name },
    });
    return f;
  }
  async createWritable() {
    const chunks = [];
    const file = this;
    return {
      async write(value) {
        const fault = file.parent.root.fault?.(file.path);
        if (fault)
          throw fault instanceof Error ? fault : Error('Injected write failure');
        chunks.push(
          typeof value === 'string'
            ? new TextEncoder().encode(value)
            : new Uint8Array(value),
        );
      },
      async close() {
        const size = chunks.reduce((n, x) => n + x.length, 0),
          data = new Uint8Array(size);
        let i = 0;
        for (const b of chunks) {
          data.set(b, i);
          i += b.length;
        }
        file.data = data;
        file.modified = tick++;
        file.parent.root.writes.push(file.path);
      },
      async abort() {},
    };
  }
}
export async function put(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1))
    dir = await dir.getDirectoryHandle(part, { create: true });
  const f = await dir.getFileHandle(parts.at(-1), { create: true });
  const w = await f.createWritable();
  await w.write(data);
  await w.close();
}
export async function fixture() {
  const reader = new MemoryDirectory('KOBO'),
    backup = new MemoryDirectory('Backups');
  await put(
    reader,
    '.kobo/version',
    'N428-SYNTHETIC,4.9.77,4.46.23836,other,other,00000000-0000-0000-0000-000000000390',
  );
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    '[OneStoreServices]\r\napi_endpoint=http://192.168.0.10:8083/kobo/0123456789abcdef0123456789abcdef\r\n[Other]\r\nkeep=yes\r\n',
  );
  await put(reader, '.kobo/KoboReader.sqlite', new Uint8Array([1, 2, 3]));
  await put(reader, 'Books/keep.epub', new Uint8Array([9, 8, 7]));
  reader.writes = [];
  return { reader, backup };
}
export async function systemSnapshot(reader, backup) {
  const { hashBytes } = await import('../web/lib/sha256.js');
  const data = new TextEncoder().encode('synthetic system settings'),
    hash = hashBytes(data);
  await put(reader, '.adds/kobold/system-backup.tar.gz', data);
  await put(reader, '.adds/kobold/backup-ack.txt', hash + '\n');
  await put(backup.directory, 'privileged/.adds/kobold/system-backup.tar.gz', data);
  return hash;
}
