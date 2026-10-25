// Tab-local, allowlisted diagnostics. Visibility never controls recording.
const KEY = 'kobold.diagnostics.v1';
const LIMIT = 1600;
const MAX_BYTES = 1500000;
const word = (value) =>
  typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value) ? value : 'unknown';
export function diagnosticJournal(storage, now = () => Date.now()) {
  let data;
  try {
    data = JSON.parse(storage?.getItem(KEY));
  } catch {}
  if (
    data?.schema !== 1 ||
    !Array.isArray(data.sessions) ||
    !data.sessions.every(
      (s) =>
        /^[a-f0-9]{32}$/.test(s.id) &&
        Number.isFinite(s.started) &&
        Array.isArray(s.events) &&
        Array.isArray(s.evidence),
    )
  )
    data = { schema: 1, current: null, show: false, sessions: [] };
  let warning = '',
    listeners = new Set();
  function save() {
    while (JSON.stringify(data).length > MAX_BYTES) {
      if (data.sessions.length > 1) data.sessions.shift();
      else if (current().evidence.length > 1) current().evidence.shift();
      else if (current().events.length > 1) {
        current().events.shift();
        current().omitted++;
      } else break;
      warning =
        'Older diagnostic records were removed at the storage limit. Export this report.';
    }
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      warning =
        'Diagnostic storage is unavailable or full. Export the current report before refreshing.';
    }
    for (const fn of listeners) fn();
  }
  function current() {
    return data.sessions.find((s) => s.id === data.current);
  }
  function start() {
    const s = {
      id: crypto.randomUUID().replaceAll('-', ''),
      started: now(),
      events: [],
      evidence: [],
      omitted: 0,
    };
    data.sessions.push(s);
    data.current = s.id;
    if (data.sessions.length > 12) {
      data.sessions.shift();
      warning =
        'The oldest diagnostic session was removed. Export reports you want to retain.';
    }
    save();
    return s.id;
  }
  if (!current()) start();
  function record(step, code, values = {}) {
    const e = { time: now(), step: word(step), code: word(code) };
    for (const key of [
      'completedFiles',
      'totalFiles',
      'copiedBytes',
      'totalBytes',
      'fileBytes',
      'fileSize',
      'durationMs',
      'sequence',
    ]) {
      if (Number.isFinite(values[key]) && values[key] >= 0) e[key] = values[key];
    }
    if (typeof values.fraction === 'number')
      e.fraction = Math.max(0, Math.min(1, values.fraction));
    if (values.fileClass)
      e.fileClass = [
        'book',
        'installer',
        'settings',
        'system-archive',
        'other',
      ].includes(values.fileClass)
        ? values.fileClass
        : 'other';
    current().events.push(e);
    if (current().events.length > LIMIT) {
      current().events.shift();
      current().omitted++;
      warning =
        'Older diagnostic events were removed at the storage limit. Export this report.';
    }
    while (JSON.stringify(data).length > MAX_BYTES && current().events.length > 1) {
      current().events.shift();
      current().omitted++;
      warning = 'Diagnostic storage limit reached. Export this report.';
    }
    save();
  }
  // Capture useful native facts without persisting identities, tokens or paths.
  function evidence(capture) {
    const safe = { time: now(), reportCount: capture.reportCount, reports: [] };
    for (const report of Object.values(capture.reports ?? {})) {
      const item = {};
      for (const name of ['status', 'readiness', 'receipt', 'result']) {
        const raw = report[name];
        if (!raw) continue;
        const part = {};
        for (const key of [
          'present',
          'verified',
          'requestMatches',
          'identityMatches',
          'tagMatches',
        ])
          if (typeof raw[key] === 'boolean') part[key] = raw[key];
        for (const key of ['attempts', 'healthCount', 'tagCount', 'sequence', 'bytes'])
          if (Number.isSafeInteger(raw[key])) part[key] = raw[key];
        for (const key of ['state', 'status', 'outcome', 'value'])
          if (typeof raw[key] === 'string' && /^[A-Za-z-]{0,48}$/.test(raw[key]))
            part[key] = raw[key];
        item[name] = part;
      }
      for (const name of [
        'probes-private.txt',
        'runtime-private.txt',
        'login-private.txt',
        'provenance-error.txt',
      ]) {
        if (report[name]?.signals)
          item[name.split('-')[0]] = Object.fromEntries(
            Object.entries(report[name].signals).filter(
              ([, v]) => typeof v === 'boolean',
            ),
          );
      }
      safe.reports.push(item);
    }
    current().evidence.push(safe);
    if (current().evidence.length > 12) current().evidence.shift();
    save();
  }
  return {
    get id() {
      return data.current;
    },
    get warning() {
      return warning;
    },
    get show() {
      return data.show;
    },
    record,
    evidence,
    start,
    setVisible(show) {
      data.show = show === true;
      save();
    },
    list() {
      return data.sessions.map((s) => ({
        id: s.id,
        started: s.started,
        events: s.events.length,
        omitted: s.omitted,
      }));
    },
    export(id = data.current) {
      const s = data.sessions.find((s) => s.id === id);
      return JSON.stringify({ format: 1, session: s ?? null }, null, 2);
    },
    clear() {
      const id = data.current;
      data.sessions = [{ id, started: now(), events: [], evidence: [], omitted: 0 }];
      warning = '';
      save();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
