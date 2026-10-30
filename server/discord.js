// "Continuer avec Discord": OAuth2 authorization code flow. The account is found by its
// Discord id, else by the (Discord-verified) e-mail, else created without a password.
import crypto from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import { startSession } from "./auth.js";

const API = "https://discord.com/api";
const STATE_COOKIE = "fg_oauth";

export const discordEnabled = () => Boolean(config.discord.clientId && config.discord.clientSecret);

// Same site paths only ("//x" and "/\x" leave the site).
const safeNext = (next) => (/^\/(?![/\\])/.test(String(next ?? "")) ? String(next) : "/app");

// The FiveGen account for a Discord profile; { user } or { error: code for /login?discord= }.
export function discordAccount(profile, { ip, disposable }) {
  if (!profile?.id) return { error: "failed" };
  const email = String(profile.email ?? "").trim().toLowerCase();
  let user = db.getUserByDiscord(profile.id);
  if (!user) {
    if (!email || !profile.verified) return { error: "noemail" };
    user = db.getUserByEmail(email);
    if (user) {
      db.setDiscord(user.id, String(profile.id));
      // Discord checked the address: same as clicking our confirmation link
      if (!user.email_verified) {
        db.setVerified(user.id);
        db.grantFreeCredits(user.id, config.freeCredits, config.freeCreditsPerIp);
      }
    } else {
      if (disposable(email)) return { error: "disposable" };
      const isAdmin = config.adminEmails.includes(email);
      user = db.createUser(email, "", 0, isAdmin, { verified: true, ip });
      db.setDiscord(user.id, String(profile.id));
      db.grantFreeCredits(user.id, config.freeCredits, isAdmin ? Infinity : config.freeCreditsPerIp);
    }
    user = db.getUser(user.id);
  }
  if (user.blocked) return { error: "blocked" };
  return { user };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function mountDiscord(app, { siteUrl, disposable }) {
  const redirectUri = (req) => `${siteUrl(req)}/api/auth/discord/callback`;

  app.get("/api/auth/discord", (req, res) => {
    if (!discordEnabled()) return res.redirect("/login");
    const state = crypto.randomBytes(18).toString("base64url");
    // the state ties the callback to this browser (no login CSRF); next comes back with it
    res.cookie(STATE_COOKIE, `${state}|${safeNext(req.query.next)}`, { httpOnly: true, sameSite: "lax", secure: config.secureCookies, maxAge: 10 * 60 * 1000, path: "/api/auth/discord" });
    const params = new URLSearchParams({ client_id: config.discord.clientId, response_type: "code", redirect_uri: redirectUri(req), scope: "identify email", state, prompt: "none" });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get("/api/auth/discord/callback", async (req, res) => {
    const [state, next] = (readCookie(req, STATE_COOKIE) ?? "").split("|");
    res.clearCookie(STATE_COOKIE, { path: "/api/auth/discord" });
    if (req.query.error) return res.redirect("/login?discord=cancel");
    if (!state || req.query.state !== state || !req.query.code) return res.redirect("/login?discord=failed");
    try {
      const token = await fetch(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: redirectUri(req),
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
        }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))));
      const profile = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000) }).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`profile ${r.status}`)),
      );
      const { user, error } = discordAccount(profile, { ip: req.ip, disposable });
      if (error) return res.redirect(`/login?discord=${error}`);
      startSession(res, user.id);
      res.redirect(safeNext(next));
    } catch (err) {
      console.error("[fivegen] connexion Discord impossible :", err.message);
      res.redirect("/login?discord=failed");
    }
  });
}
