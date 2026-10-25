import { backupProgress } from './backup-ui.js';
export function operationUI(anchor, id) {
  const panel = document.createElement('div');
  panel.className = 'operation-status';
  panel.hidden = true;
  panel.innerHTML =
    '<strong role="status" aria-live="polite"></strong><progress max="1" aria-label="Operation progress"></progress><span class="operation-detail"></span>';
  panel.id = id + '-feedback';
  (id === 'prepare-collection'
    ? (anchor.closest('.collection-actions') ?? anchor)
    : anchor
  ).after(panel);
  const label = panel.querySelector('strong'),
    bar = panel.querySelector('progress'),
    detail = panel.querySelector('span');
  let lastPaint = 0;
  function start(text) {
    panel.hidden = false;
    panel.dataset.state = 'running';
    panel.setAttribute('aria-busy', 'true');
    label.textContent = text;
    detail.textContent = '';
    bar.hidden = false;
    bar.removeAttribute('value');
  }
  async function progress(event) {
    panel.hidden = false;
    bar.hidden = false;
    if (typeof event === 'string') {
      label.textContent = event;
      bar.removeAttribute('value');
      detail.textContent = '';
    } else {
      if (
        event.fraction === undefined &&
        Number.isFinite(event.size) &&
        Number.isFinite(event.bytes)
      )
        event = {
          ...event,
          fraction: event.size ? Math.min(0.99, event.bytes / event.size) : null,
          fileBytes: event.bytes,
          fileSize: event.size,
          path: event.path ?? 'System settings archive',
        };
      const p = backupProgress(event);
      label.textContent = p.phase;
      detail.textContent = [p.path, p.files, p.bytes, p.fileProgress]
        .filter(Boolean)
        .join(' · ');
      if (p.fraction === null) bar.removeAttribute('value');
      else bar.value = p.fraction;
    }
    if (performance.now() - lastPaint > 50) {
      lastPaint = performance.now();
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  function finish(text, failed = false) {
    panel.hidden = false;
    panel.dataset.state = failed ? 'failed' : 'complete';
    panel.setAttribute('aria-busy', 'false');
    label.textContent = text;
    bar.hidden = true;
    if (!failed) detail.textContent = '';
  }
  return {
    start,
    progress,
    finish,
    fail: (e) => finish('Failed: ' + e.message, true),
    panel,
  };
}
