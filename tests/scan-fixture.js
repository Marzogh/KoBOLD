import { fixture } from './memory-fs.js';
import { backupReader } from '../web/lib/storage.js';
import {
  prepareScanProtection,
  confirmScanRestart,
} from '../web/lib/scan-protection.js';
// Simulates the explicit restart acknowledgement; never claims a real restart.
export async function scanFixture() {
  const f = await fixture();
  const b = await backupReader(f.reader, f.backup);
  await prepareScanProtection(f.reader, b, null);
  await confirmScanRestart(f.reader, b, true);
  f.reader.writes = [];
  f.backup.writes = [];
  return f;
}
