// These reserved names are not used by the runtime or library search paths.
export function hostMetadata(path, known) {
  const parts = path.split('/'),
    name = parts.pop(),
    parent = parts.length ? parts.join('/') + '/' : '';
  if (
    ['.ds_store', 'desktop.ini', 'thumbs.db', '.directory'].includes(name.toLowerCase())
  )
    return true;
  if (!name.startsWith('._')) return false;
  const companion = parent + name.slice(2);
  return known.has(companion) || [...known].some((p) => p.startsWith(companion + '/'));
}
