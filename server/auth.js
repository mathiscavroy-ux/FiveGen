import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { createSession, userFromSession, deleteSession, deleteOtherSessions, countOtherSessions, setAdmin } from "./db.js";
import { tierOf } from "./tiers.js";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "fg_session";

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function startSession(res, userId) {
  const { token, expires } = createSession(userId);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    expires: new Date(expires),
    path: "/",
  });
}

export function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) deleteSession(token);
  res.clearCookie(COOKIE, { path: "/" });
}

// "Log out my other devices", and after a password change.
export const endOtherSessions = (req, userId) => deleteOtherSessions(userId, readCookie(req, COOKIE) ?? "");
export const otherSessionCount = (req, userId) => countOtherSessions(userId, readCookie(req, COOKIE) ?? "");

// Attaches req.user when a valid session cookie is present.
export function sessionMiddleware(req, _res, next) {
  const user = userFromSession(readCookie(req, COOKIE));
  if (user && !user.is_admin && config.adminEmails.includes(user.email.toLowerCase())) {
    setAdmin(user.id);
    user.is_admin = 1;
  }
  req.user = user;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Connecte-toi pour continuer." });
  if (req.user.blocked) return res.status(403).json({ error: "Ce compte est suspendu. Contacte le support FiveGen.", code: "BLOCKED" });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Accès réservé à l'administrateur." });
  next();
}

// Mutating API calls must carry a custom header: browsers cannot send it cross-site
// without a CORS preflight we never grant, which blocks CSRF.
export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-fivegen") !== "1") return res.status(403).json({ error: "Requête refusée." });
  next();
}

// Fixed-window limiter, in memory (one server process).
export function rateLimit({ windowMs, max, key = (req) => req.ip, message }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const entry = hits.get(k);
    const t = Date.now();
    if (!entry || t - entry.start > windowMs) {
      hits.set(k, { start: t, count: 1 });
      return next();
    }
    entry.count++;
    if (entry.count > max) return res.status(429).json({ error: message ?? "Trop de tentatives, réessaie plus tard." });
    next();
  };
}

export function userPrefs(user) {
  try {
    const prefs = JSON.parse(user.prefs ?? "{}");
    return prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  } catch {
    return {};
  }
}

export function publicUser(user) {
  const tier = tierOf(user);
  return {
    email: user.email,
    createdAt: user.created_at,
    prefs: userPrefs(user),
    // accounts created with Discord have no password until they choose one
    hasPassword: Boolean(user.pass_hash),
    discord: Boolean(user.discord_id),
    subscription: user.sub_status
      ? {
          plan: config.plans.find((p) => p.id === user.sub_plan) ?? null,
          status: user.sub_status,
          periodEnd: user.sub_period_end,
          cancelAtEnd: Boolean(user.sub_cancel_at_end),
        }
      : null,
    credits: user.credits,
    isAdmin: Boolean(user.is_admin),
    emailVerified: Boolean(user.email_verified),
    // the plan the account runs on, and what it changes
    tier: { id: tier.id, label: tier.label, engineName: tier.engineName, maxServers: tier.maxServers },
    // what a subscription would run on, shown to free accounts
    premiumEngineName: config.tiers.premium.engineName,
    costs: { ...config.cost, ...tier.cost },
    freeRefines: tier.freeRefines,
    shopUrl: config.shopUrl,
    supportUrl: config.supportUrl,
  };
}
