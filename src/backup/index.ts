// data/ is the one thing git doesn't keep (family money is personal), so the
// bot mails it to whoever asked: /backup sends a zip now and subscribes you to
// the weekly one. To restore, unzip into data/.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { todayLocal } from "../spending/index.js";

const SUBSCRIBERS_FILE = path.join(config.dataDir, "backup.json");

interface BackupState {
  chatIds: string[];
  lastSentAt?: string;
}

function loadSubs(): BackupState {
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf-8")) as BackupState;
  } catch {
    return { chatIds: [] };
  }
}

function saveSubs(s: BackupState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(s, null, 2), "utf-8");
}

export function subscribe(chatId: string): boolean {
  const s = loadSubs();
  if (s.chatIds.includes(chatId)) return false;
  s.chatIds.push(chatId);
  saveSubs(s);
  return true;
}

export function unsubscribe(chatId: string): boolean {
  const s = loadSubs();
  const before = s.chatIds.length;
  s.chatIds = s.chatIds.filter((id) => id !== chatId);
  saveSubs(s);
  return s.chatIds.length < before;
}

/** Subscribers plus anyone pinned in TELEGRAM_BACKUP_IDS. */
export function backupRecipients(): string[] {
  return [...new Set([...config.telegram.backupIds, ...loadSubs().chatIds])];
}

export function markSent(): void {
  const s = loadSubs();
  s.lastSentAt = new Date().toISOString();
  saveSubs(s);
}

// ── Zip ───────────────────────────────────────────────────────────────────
// A minimal PKZIP writer (deflate, UTF-8 names): enough for a few JSON files,
// and it opens with a double click on Windows and phones — no dependency.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(files: { name: string; data: Buffer; mtime: Date }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf-8");
    const packed = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const { time, date } = dosTime(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 file names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** Every file in data/ (subfolders too), zipped: earninvest-data-YYYY-MM-DD.zip. */
export function buildBackup(): { filename: string; buffer: Buffer; files: number } {
  const files: { name: string; data: Buffer; mtime: Date }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else if (e.isFile()) files.push({ name: `${prefix}${e.name}`, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
    }
  };
  walk(config.dataDir, "data/");
  if (files.length === 0) throw new Error("Папка data пуста — нечего сохранять");
  return { filename: `earninvest-data-${todayLocal()}.zip`, buffer: zip(files), files: files.length };
}

export function backupCaption(b: { files: number; buffer: Buffer }): string {
  const kb = Math.max(1, Math.round(b.buffer.length / 1024));
  return `💾 Резервная копия данных: ${b.files} файлов, ${kb} КБ.\nДолги, платежи, чеки, траты — всё здесь. Восстановить: распаковать в папку проекта (появится data/).`;
}

export function logBackup(to: string, b: { filename: string; buffer: Buffer }): void {
  logger.info(`[Backup] ${b.filename} (${b.buffer.length} B) → ${to}`);
}
