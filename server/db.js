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

// Columns added after the first release. Accounts created before e-mail checks
// existed are treated as verified and as having had their free credits.
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
if (!userColumns.has("email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE users SET email_verified = 1");
}
if (!userColumns.has("blocked")) db.exec("ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
if (!userColumns.has("signup_ip")) db.exec("ALTER TABLE users ADD COLUMN signup_ip TEXT");
if (!userColumns.has("free_granted")) {
  db.exec("ALTER TABLE users ADD COLUMN free_granted INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE users SET free_granted = 1");
}
// 1 when the free credits were actually given (not refused by the per-address limit).
if (!userColumns.has("credits_from_free")) db.exec("ALTER TABLE users ADD COLUMN credits_from_free INTEGER NOT NULL DEFAULT 0");
// Settings page choices (theme, default framework and language), as JSON.
if (!userColumns.has("prefs")) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT");
db.exec(`
  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// ---------- users ----------

export function createUser(email, passHash, credits, isAdmin, { verified = true, ip = null } = {}) {
  const r = db
    .prepare("INSERT INTO users (email, pass_hash, credits, is_admin, created_at, email_verified, signup_ip, free_granted, credits_from_free) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(email, passHash, credits, isAdmin ? 1 : 0, now(), verified ? 1 : 0, ip, credits > 0 ? 1 : 0, credits > 0 ? 1 : 0);
  return getUser(Number(r.lastInsertRowid));
}

export const setVerified = (id) => db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(id);
export const setBlocked = (id, blocked) => db.prepare("UPDATE users SET blocked = ? WHERE id = ?").run(blocked ? 1 : 0, id).changes === 1;
export const setEmail = (id, email) => db.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?").run(email, id);
export const deleteUser = (id) => db.prepare("DELETE FROM users WHERE id = ?").run(id).changes === 1;

// Free credits are given once per account, and to a limited number of accounts per
// network address, so creating accounts in a loop does not pay.
export function grantFreeCredits(userId, amount, maxPerIp) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const u = getUser(userId);
    if (!u || u.free_granted) {
      db.exec("ROLLBACK");
      return 0;
    }
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const sameIp = u.signup_ip
      ? db.prepare("SELECT COUNT(*) AS n FROM users WHERE signup_ip = ? AND free_granted = 1 AND credits_from_free = 1 AND created_at > ? AND id <> ?").get(u.signup_ip, since, userId).n
      : 0;
    const given = sameIp < maxPerIp ? amount : 0;
    db.prepare("UPDATE users SET free_granted = 1, credits_from_free = ?, credits = credits + ? WHERE id = ?").run(given ? 1 : 0, given, userId);
    db.exec("COMMIT");
    return given;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- one-time e-mail links (password reset, address check) ----------

export function createEmailToken(userId, kind, minutes) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?").run(userId, kind);
  db.prepare("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    kind,
    new Date(Date.now() + minutes * 60000).toISOString(),
  );
  return token;
}

// Single use: the token is deleted when read. Returns the user id or null.
export function consumeEmailToken(token, kind) {
  if (!token) return null;
  const h = hashToken(String(token));
  const row = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?").get(h, kind, now());
  db.prepare("DELETE FROM email_tokens WHERE token_hash = ?").run(h);
  return row?.user_id ?? null;
}

export const deleteUserSessions = (userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);

export function listUserPayments(userId) {
  return db.prepare("SELECT created_at, pack_id, credits, amount, currency FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId);
}

export function listUserGenerations(userId, limit = 100) {
  return db
    .prepare("SELECT created_at, project_id, kind, cost, status, output_tokens FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit);
}

export const getUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
export const getUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
export const setAdmin = (id) => db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(id);
export const setPassword = (id, hash) => db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hash, id);
export const setPrefs = (id, prefs) => db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(prefs), id);

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
      `SELECT u.id, u.email, u.credits, u.is_admin, u.created_at, u.email_verified, u.blocked, u.signup_ip,
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
// Every session of the account except the one with this token. Returns how many closed.
export const deleteOtherSessions = (userId, token) =>
  Number(db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, hashToken(String(token))).changes);
export const countOtherSessions = (userId, token) =>
  db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token_hash != ? AND expires_at > ?").get(userId, hashToken(String(token)), now()).n;
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
    // An account deleted between checkout and webhook: keep the payment (accounting) without
    // the link, instead of a foreign key error that makes Stripe retry for days.
    const owner = getUser(userId) ? userId : null;
    const inserted = db
      .prepare("INSERT OR IGNORE INTO payments (session_id, user_id, pack_id, credits, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, owner, packId, credits, amount, currency, now()).changes === 1;
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

// Every call to the engine with its token counts and cost (USD), for the admin panel.
db.exec(`
  CREATE TABLE IF NOT EXISTS engine_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engine_calls_date ON engine_calls(created_at);
`);

export function logEngineCall({ userId, projectId, purpose, model, inputTokens, cachedTokens, outputTokens, costUsd, durationMs, ok }) {
  db.prepare(
    `INSERT INTO engine_calls (user_id, project_id, purpose, model, input_tokens, cached_tokens, output_tokens, cost_usd, duration_ms, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId ?? null, projectId ?? null, purpose, model ?? null, inputTokens ?? 0, cachedTokens ?? 0, outputTokens ?? 0, costUsd ?? 0, durationMs ?? null, ok ? 1 : 0, now());
}

const ISO = "%Y-%m-%dT%H:%M:%fZ"; // same text format as now(), so dates compare as strings

export function usageSummary() {
  const since = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const totals = (from) =>
    db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cached_tokens), 0) AS cached,
                COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(1 - ok), 0) AS failed
         FROM engine_calls WHERE created_at > ?`,
      )
      .get(from);
  const month = since(30);
  // Cost of one delivered script: its generation plus the review, fixes and rewrites
  // made on the same project in the hour before it was logged as finished.
  const scripts = db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(c.cost_usd), 0) FROM engine_calls c
               WHERE c.project_id = g.project_id AND c.purpose IN ('generate', 'review', 'autofix', 'rewrite')
                 AND c.created_at BETWEEN strftime('${ISO}', g.created_at, '-1 hour') AND strftime('${ISO}', g.created_at, '+1 minute')) AS cost
       FROM generations g WHERE g.kind = 'generate' AND g.status = 'ok' AND g.created_at > ?`,
    )
    .all(month)
    .filter((s) => s.cost > 0);
  const group = (column) =>
    db
      .prepare(
        `SELECT ${column} AS name, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost
         FROM engine_calls WHERE created_at > ? GROUP BY ${column} ORDER BY cost DESC`,
      )
      .all(month);
  return {
    today: totals(since(1)),
    week: totals(since(7)),
    month: totals(month),
    scriptCost: scripts.length ? scripts.reduce((n, s) => n + s.cost, 0) / scripts.length : null,
    byPurpose: group("purpose"),
    byModel: group("model"),
    daily: db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens + output_tokens) AS tokens
         FROM engine_calls WHERE created_at > ? GROUP BY day ORDER BY day`,
      )
      .all(since(14)),
    topUsers: db
      .prepare(
        `SELECT u.id, u.email, COUNT(*) AS calls, SUM(c.cost_usd) AS cost
         FROM engine_calls c JOIN users u ON u.id = c.user_id WHERE c.created_at > ? GROUP BY u.id ORDER BY cost DESC LIMIT 8`,
      )
      .all(month),
    recent: db
      .prepare(
        `SELECT c.created_at, u.email, c.project_id, c.purpose, c.model, c.input_tokens, c.cached_tokens, c.output_tokens, c.cost_usd, c.duration_ms, c.ok
         FROM engine_calls c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 40`,
      )
      .all(),
  };
}

export function listGenerations({ status, limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT g.id, g.created_at, g.user_id, u.email, g.project_id, g.kind, g.cost, g.status, g.error, g.output_tokens
       FROM generations g LEFT JOIN users u ON u.id = g.user_id ${status ? "WHERE g.status = ?" : ""} ORDER BY g.id DESC LIMIT ?`,
    )
    .all(...(status ? [status, limit] : [limit]));
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
