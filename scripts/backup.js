// Nightly backup: a consistent copy of the database plus every project, zipped into
// BACKUP_DIR (default: backups/ next to data/). Keeps the last BACKUP_KEEP archives.
//
//   node scripts/backup.js        (alwaysdata: Tâches planifiées, every night)
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZipArchive } from "archiver";
import { config, ROOT } from "../server/config.js";

const dir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(ROOT, "backups");
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
const dbPath = path.join(config.dataDir, "fivegen.db");
const usersDir = path.join(config.dataDir, "users");

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
fs.mkdirSync(dir, { recursive: true });
const snapshot = path.join(dir, `.fivegen-${stamp}.db`);
const target = path.join(dir, `fivegen-${stamp}.zip`);

// VACUUM INTO gives a coherent copy even while the site is writing (WAL mode).
fs.rmSync(snapshot, { force: true });
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  db.close();
}

await new Promise((resolve, reject) => {
  const out = fs.createWriteStream(target);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  out.on("close", resolve);
  archive.on("error", reject);
  archive.pipe(out);
  if (fs.existsSync(snapshot)) archive.file(snapshot, { name: "fivegen.db" });
  if (fs.existsSync(usersDir)) archive.directory(usersDir, "users");
  archive.finalize();
});
fs.rmSync(snapshot, { force: true });

const archives = fs
  .readdirSync(dir)
  .filter((f) => /^fivegen-\d{8}-\d{4}\.zip$/.test(f))
  .sort();
for (const old of archives.slice(0, Math.max(0, archives.length - keep))) fs.rmSync(path.join(dir, old));

const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[fivegen] sauvegarde ${path.basename(target)} (${size} Mo), ${Math.min(archives.length, keep)} archive(s) conservée(s) dans ${dir}`);
