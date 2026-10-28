import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export const db = new DatabaseSync(path.join(config.dataDir, "fivegen.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    credits INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    cost INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    output_tokens INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, created_at);
  CREATE TABLE IF NOT EXISTS payments (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pack_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

// ---------- users ----------

export function createUser(email, passHash, credits, isAdmin) {
  const r = db
    .prepare("INSERT INTO users (email, pass_hash, credits, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(email, passHash, credits, isAdmin ? 1 : 0, now());
  return getUser(Number(r.lastInsertRowid));
}

export const getUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
export const getUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
export const setAdmin = (id) => db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(id);
export const setPassword = (id, hash) => db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hash, id);

// Atomic: never lets credits go negative. Returns true when charged.
export function chargeCredits(userId, amount) {
  if (amount <= 0) return true;
  const r = db.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?").run(amount, userId, amount);
  return r.changes === 1;
}

export function addCredits(userId, amount) {
  db.prepare("UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ?").run(amount, userId);
  return getUser(userId)?.credits ?? 0;
}

export function listUsers() {
  return db
    .prepare(
      `SELECT u.id, u.email, u.credits, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id AND g.status = 'ok') AS generations
       FROM users u ORDER BY u.created_at DESC`,
    )
    .all();
}

// ---------- sessions ----------

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, expires);
  return { token, expires };
}

export function userFromSession(token) {
  if (!token) return null;
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .get(hashToken(token), now());
  return row ?? null;
}

export const deleteSession = (token) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
export const purgeSessions = () => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());

// ---------- activation codes ----------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function randomCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `FG-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function createCodes(count, credits, note) {
  const insert = db.prepare("INSERT INTO codes (code, credits, note, created_at) VALUES (?, ?, ?, ?)");
  const codes = [];
  db.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const code = randomCode();
      insert.run(code, credits, note || null, now());
      codes.push(code);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return codes;
}

export function listCodes(limit = 500) {
  return db
    .prepare(
      `SELECT c.code, c.credits, c.note, c.created_at, c.redeemed_at, u.email AS redeemed_by
       FROM codes c LEFT JOIN users u ON u.id = c.redeemed_by ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function deleteUnusedCode(code) {
  return db.prepare("DELETE FROM codes WHERE code = ? AND redeemed_at IS NULL").run(code).changes === 1;
}

// Returns credits added, or 0 when the code is unknown / already used.
export function redeemCode(code, userId) {
  const normalized = String(code ?? "").trim().toUpperCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM codes WHERE code = ? AND redeemed_at IS NULL").get(normalized);
    if (!row) {
      db.exec("ROLLBACK");
      return 0;
    }
    db.prepare("UPDATE codes SET redeemed_by = ?, redeemed_at = ? WHERE code = ?").run(userId, now(), normalized);
    db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(row.credits, userId);
    db.exec("COMMIT");
    return row.credits;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- card payments ----------

// Idempotent: Stripe may deliver the same event several times. Returns true only
// the first time a session is recorded, which is when credits are added.
export function recordPayment({ sessionId, userId, packId, credits, amount, currency }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO payments (session_id, user_id, pack_id, credits, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, userId, packId, credits, amount, currency, now()).changes === 1;
    if (inserted) db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(credits, userId);
    db.exec("COMMIT");
    return inserted;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listPayments(limit = 200) {
  return db
    .prepare(
      `SELECT p.created_at, p.pack_id, p.credits, p.amount, p.currency, p.session_id, u.email
       FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(limit);
}

// ---------- generation log ----------

export function logGeneration({ userId, projectId, kind, cost, status, error, outputTokens }) {
  db.prepare(
    "INSERT INTO generations (user_id, project_id, kind, cost, status, error, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(userId, projectId, kind, cost, status, error ?? null, outputTokens ?? null, now());
}

export function stats() {
  const day = new Date(Date.now() - 86400000).toISOString();
  const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0] ?? 0;
  return {
    users: one("SELECT COUNT(*) FROM users"),
    usersToday: one("SELECT COUNT(*) FROM users WHERE created_at > ?", day),
    generationsToday: one("SELECT COUNT(*) FROM generations WHERE status = 'ok' AND created_at > ?", day),
    generationsTotal: one("SELECT COUNT(*) FROM generations WHERE status = 'ok'"),
    failuresToday: one("SELECT COUNT(*) FROM generations WHERE status = 'error' AND created_at > ?", day),
    creditsSpent: one("SELECT COALESCE(SUM(cost), 0) FROM generations WHERE status = 'ok'"),
    outputTokensToday: one("SELECT COALESCE(SUM(output_tokens), 0) FROM generations WHERE created_at > ?", day),
    codesUnused: one("SELECT COUNT(*) FROM codes WHERE redeemed_at IS NULL"),
    codesRedeemed: one("SELECT COUNT(*) FROM codes WHERE redeemed_at IS NOT NULL"),
    paymentsCount: one("SELECT COUNT(*) FROM payments"),
    revenueTotal: one("SELECT COALESCE(SUM(amount), 0) FROM payments"),
    revenue30d: one("SELECT COALESCE(SUM(amount), 0) FROM payments WHERE created_at > ?", new Date(Date.now() - 30 * 86400000).toISOString()),
    recentErrors: db
      .prepare("SELECT g.created_at, u.email, g.kind, g.error FROM generations g JOIN users u ON u.id = g.user_id WHERE g.status = 'error' ORDER BY g.id DESC LIMIT 10")
      .all(),
  };
}
