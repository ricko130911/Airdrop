import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', dir = 'logs' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'bot.log');
  const journalFile = path.join(dir, 'decisions.jsonl');
  const buffer = []; // log terbaru untuk dashboard

  function write(lvl, msg, extra) {
    if (LEVELS[lvl] < min) return;
    const ts = new Date().toISOString();
    const line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
    buffer.push({ ts, level: lvl, msg });
    if (buffer.length > 300) buffer.shift();
    fs.appendFile(logFile, line + '\n', () => {});
  }

  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    /** Log terbaru (untuk dashboard). */
    recent(n = 120) {
      return buffer.slice(-n);
    },
    /** Catatan keputusan terstruktur (untuk evaluasi akurasi model). */
    journal(record) {
      fs.appendFile(journalFile, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', () => {});
    },
  };
}
