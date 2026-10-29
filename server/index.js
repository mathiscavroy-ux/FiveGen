import path from "node:path";
import express from "express";
import { ZipArchive } from "archiver";
import { config, ROOT } from "./config.js";
import { CATALOG, buildGenerateMessage, buildRefineMessage, buildFixMessage, buildRewriteMessage, buildReviewMessage } from "./prompts.js";
import { applyEdits } from "./patch.js";
import { runEngine, runBrief, engineStatus, EngineError, onEngineUsage } from "./engine.js";
import { providerUsage, modelPricing } from "./provider.js";
import { sanitizeAnswers } from "./brief.js";
import { paymentsEnabled, publicPacks, createCheckout, handleWebhook } from "./payments.js";
import { validateProjectFull } from "./validator.js";
import { mountDeploy, listRuntimeErrors, locateRuntimeError, clearRuntimeErrors } from "./deploy.js";
import { mountSeo } from "./seo.js";
import * as db from "./db.js";
import {
  hashPassword,
  verifyPassword,
  validEmail,
  startSession,
  endSession,
  sessionMiddleware,
  requireUser,
  requireAdmin,
  csrfGuard,
  rateLimit,
  publicUser,
} from "./auth.js";
import {
  createProject,
  listProjects,
  getProject,
  getFiles,
  writeFiles,
  updateMeta,
  addHistory,
  deleteProject,
  filesRoot,
  snapshot,
  listVersions,
  getVersionFiles,
  restoreVersion,
  deleteUserData,
} from "./projects.js";
import { mailEnabled, sendPasswordReset, sendVerification } from "./mailer.js";

const LIMITS = { description: 4000, instruction: 2000, fileBytes: 512 * 1024 };

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});
// Stripe signs the raw body, so this route must run before JSON parsing and the
// CSRF guard (Stripe cannot send our custom header).
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  if (!paymentsEnabled()) return res.status(503).send("payments disabled");
  try {
    const result = handleWebhook(req.body, req.get("stripe-signature"));
    console.log(`[fivegen] webhook Stripe : ${result}`);
    res.json({ received: true });
  } catch (err) {
    console.error("[fivegen] webhook Stripe refusé :", err.message);
    res.status(400).send("invalid webhook");
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);
app.use("/api", csrfGuard);
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
mountSeo(app);

// ---------- SSE helpers ----------

function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const controller = new AbortController();
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(ping);
    if (!res.writableEnded) controller.abort();
  });
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const close = () => {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  return { send, close, signal: controller.signal };
}

function mergeNotes(previous, notes, title) {
  if (!notes) return previous;
  if (!previous) return notes;
  return `${previous}\n\n### ${title}\n\n${notes}`;
}

const LABELS = { generate: "Génération", refine: "Modification", fix: "Correction" };

// Whole files and SEARCH/REPLACE edits from one engine run. Edits whose SEARCH text
// is not found are redone once as whole files, so a stale anchor never loses a change.
async function saveResult({ userId, projectId, result, spec, send, signal, state }) {
  writeFiles(userId, projectId, result.files, result.deletes);
  const { files: patched, failures } = applyEdits(getFiles(userId, projectId), result.edits ?? []);
  if (patched.length) writeFiles(userId, projectId, patched, []);
  for (const f of patched) send("file", f);
  const touched = [...result.files, ...patched].map((f) => f.path);
  if (failures.length) {
    const paths = [...new Set(failures.map((f) => f.path))];
    send("status", `${failures.length} remplacement(s) sans emplacement trouvé : réécriture de ${paths.join(", ")}.`);
    try {
      const redo = await runEngine({ userContent: buildRewriteMessage(spec, getFiles(userId, projectId), failures), onEvent: send, signal, meta: { userId, projectId, purpose: "rewrite" } });
      writeFiles(userId, projectId, redo.files, []);
      state.outputTokens += redo.outputTokens ?? 0;
      touched.push(...redo.files.map((f) => f.path));
    } catch (err) {
      if (signal.aborted) throw err;
      console.error("[fivegen] réécriture après remplacements ratés :", err.detail ?? err);
      send("status", "Une partie de la modification n'a pas pu être appliquée : relance-la si besoin.");
    }
  }
  return [...new Set(touched)];
}

// Static checks plus the dry run of the resource in a fake FiveM.
function checkProject(userId, projectId) {
  const project = getProject(userId, projectId);
  return validateProjectFull(getFiles(userId, projectId), project.spec, { resource: project.name });
}

// Generation → save → check → review pass (new resources) → automatic fix rounds
// (free) while errors remain.
async function runPipeline({ userId, projectId, userContent, kind, instruction, send, signal, state }) {
  const project = getProject(userId, projectId);
  send("phase", { phase: kind, label: LABELS[kind] });
  const result = await runEngine({ userContent, onEvent: send, signal, meta: { userId, projectId, purpose: kind } });
  if (!result.files.length && !result.deletes.length && !result.edits.length) {
    throw new EngineError("Aucun fichier n'a été produit. Précise ta demande et réessaie, tes crédits ont été rendus.", "empty output");
  }
  state.outputTokens += result.outputTokens ?? 0;
  state.produced = true;
  const touched = await saveResult({ userId, projectId, result, spec: project.spec, send, signal, state });
  snapshot(userId, projectId, { type: kind, label: instruction ?? null });
  updateMeta(userId, projectId, {
    notes: kind === "generate" ? result.notes : mergeNotes(project.notes, result.notes, `${LABELS[kind]} : ${instruction ?? ""}`),
  });
  addHistory(userId, projectId, { type: kind, instruction: instruction ?? null, files: touched, outputTokens: result.outputTokens });
  if (result.stopReason === "max_tokens") send("status", "Ressource très volumineuse : certains fichiers ont pu être coupés, la vérification va le signaler.");

  // "checking" lets the studio show the static checks and the dry run while they run.
  const recheck = async () => {
    send("checking", {});
    const result = await checkProject(userId, projectId);
    updateMeta(userId, projectId, { validation: result });
    send("validation", result);
    return result;
  };
  let validation = await recheck();

  if (kind === "generate" && config.reviewPass) {
    send("phase", { phase: "review", label: "Relecture" });
    try {
      const review = await runEngine({
        userContent: buildReviewMessage(project.spec, getFiles(userId, projectId), validation.warnings),
        onEvent: send,
        signal,
        meta: { userId, projectId, purpose: "review" },
      });
      state.outputTokens += review.outputTokens ?? 0;
      if (review.files.length || review.edits.length || review.deletes.length) {
        const reviewed = await saveResult({ userId, projectId, result: review, spec: project.spec, send, signal, state });
        snapshot(userId, projectId, { type: "review", label: "Relecture" });
        updateMeta(userId, projectId, { notes: mergeNotes(getProject(userId, projectId).notes, review.notes, "Relecture") });
        addHistory(userId, projectId, { type: "review", instruction: "Relecture", files: reviewed, outputTokens: review.outputTokens });
        validation = await recheck();
      }
    } catch (err) {
      // Same as the fix rounds: the generated script is saved, the review is a bonus.
      if (signal.aborted) throw err;
      console.error("[fivegen] relecture interrompue :", err.detail ?? err);
      send("status", "Relecture interrompue : le script est livré après la vérification automatique.");
    }
  }

  for (let round = 1; round <= config.autoFixRounds && !validation.ok; round++) {
    send("phase", { phase: "fix", label: `Correction automatique ${round}/${config.autoFixRounds}` });
    let fix;
    try {
      fix = await runEngine({
        userContent: buildFixMessage(project.spec, getFiles(userId, projectId), validation.errors),
        onEvent: send,
        signal,
        meta: { userId, projectId, purpose: "autofix" },
      });
    } catch (err) {
      // The script is already saved: an engine hiccup here must not turn it into a failure.
      if (signal.aborted) throw err;
      console.error(`[fivegen] correction automatique ${round} interrompue :`, err.detail ?? err);
      send("status", `Correction automatique interrompue : le script est livré tel quel. Clique sur « Corriger » pour relancer${config.cost.fix === 0 ? " (gratuit)" : ""}.`);
      break;
    }
    state.outputTokens += fix.outputTokens ?? 0;
    const fixed = await saveResult({ userId, projectId, result: fix, spec: project.spec, send, signal, state });
    snapshot(userId, projectId, { type: "autofix", label: `Correction automatique ${round} · ${validation.errors.length} erreur(s)` });
    const current = getProject(userId, projectId);
    updateMeta(userId, projectId, { notes: mergeNotes(current.notes, fix.notes, `Correction automatique ${round}`) });
    addHistory(userId, projectId, { type: "autofix", instruction: `${validation.errors.length} erreur(s)`, files: fixed, outputTokens: fix.outputTokens });
    validation = await recheck();
  }
  send("done", getProject(userId, projectId));
}

const running = new Set(); // one generation at a time per account

onEngineUsage((call) => db.logEngineCall(call));

function safeProject(userId, id) {
  try {
    return getProject(userId, id);
  } catch {
    return null;
  }
}

// Credits are already charged by the caller; refunded when nothing was produced.
async function streamPipeline(res, { userId, projectId, kind, instruction, userContent, cost }) {
  running.add(userId);
  const { send, close, signal } = openStream(res);
  const state = { produced: false, outputTokens: 0 };
  send("project", { id: projectId });
  send("credits", { credits: db.getUser(userId).credits });
  try {
    await runPipeline({ userId, projectId, userContent, kind, instruction, send, signal, state });
    db.logGeneration({ userId, projectId, kind, cost, status: "ok", outputTokens: state.outputTokens });
  } catch (err) {
    const detail = err instanceof EngineError ? err.detail : err?.stack ?? String(err);
    if (detail !== "aborted") console.error(`[fivegen] ${kind} failed for user ${userId}:`, detail);
    if (!state.produced) db.addCredits(userId, cost);
    if (!state.produced && kind === "generate") deleteProject(userId, projectId);
    db.logGeneration({
      userId,
      projectId,
      kind,
      cost: state.produced ? cost : 0,
      status: detail === "aborted" ? "cancelled" : "error",
      error: String(detail).slice(0, 500),
      outputTokens: state.outputTokens,
    });
    const message = err instanceof EngineError ? err.message : "Erreur interne. Tes crédits ont été rendus.";
    send("failure", { message: state.produced ? message.replace(/,? ?tes crédits ont été rendus\.?/i, ".") : message, project: safeProject(userId, projectId) });
  } finally {
    running.delete(userId);
    send("credits", { credits: db.getUser(userId)?.credits ?? 0 });
    close();
  }
}

// Shared preflight for paid actions: concurrency + credits.
function charge(req, res, cost) {
  if (running.has(req.user.id)) {
    res.status(409).json({ error: "Une génération est déjà en cours sur ton compte." });
    return false;
  }
  if (!db.chargeCredits(req.user.id, cost)) {
    res.status(402).json({ error: `Crédits insuffisants : cette action coûte ${cost} crédit(s).`, code: "NO_CREDITS" });
    return false;
  }
  return true;
}

// ---------- auth ----------

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: "Trop de tentatives. Réessaie dans 10 minutes." });

// Throwaway inboxes: accounts made with them only exist to farm free credits.
const DISPOSABLE = new Set([
  "yopmail.com", "yopmail.fr", "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "10minutemail.com",
  "10minutemail.net", "temp-mail.org", "tempmail.com", "tempmail.net", "trashmail.com", "trashmail.fr", "jetable.org", "getnada.com",
  "dispostable.com", "maildrop.cc", "mohmal.com", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "emailondeck.com", "spamgourmet.com",
  "mintemail.com", "tempr.email", "discard.email", "moakt.com", "mail.tm", "tmail.ws", "tempail.com", "minuteinbox.com", "crazymailing.com",
]);
const disposable = (email) => DISPOSABLE.has(email.split("@")[1]);

const siteUrl = (req) => config.publicUrl || `${req.protocol}://${req.get("host")}`;

async function sendVerificationMail(req, user) {
  const token = db.createEmailToken(user.id, "verify", 48 * 60);
  await sendVerification(user.email, `${siteUrl(req)}/api/auth/verify?token=${token}`, user.free_granted ? 0 : config.freeCredits);
}

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!validEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  if (disposable(email)) return res.status(400).json({ error: "Les adresses e-mail jetables ne sont pas acceptées." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  if (!req.body?.acceptTerms) return res.status(400).json({ error: "Tu dois accepter les conditions générales." });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse." });
  const isAdmin = config.adminEmails.includes(email);
  // With e-mail available, the free credits wait for the address to be confirmed.
  const verified = isAdmin || !mailEnabled;
  let user = db.createUser(email, await hashPassword(password), 0, isAdmin, { verified, ip: req.ip });
  if (verified) db.grantFreeCredits(user.id, config.freeCredits, isAdmin ? Infinity : config.freeCreditsPerIp);
  else await sendVerificationMail(req, user).catch((err) => console.error("[fivegen] e-mail de confirmation non envoyé :", err.message));
  user = db.getUser(user.id);
  startSession(res, user.id);
  res.json(publicUser(user));
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const user = db.getUserByEmail(email);
  const ok = user && (await verifyPassword(String(req.body?.password ?? ""), user.pass_hash));
  if (!ok) return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
  if (user.blocked) return res.status(403).json({ error: "Ce compte est suspendu. Contacte le support FiveGen." });
  if (config.adminEmails.includes(email) && !user.is_admin) db.setAdmin(user.id);
  startSession(res, user.id);
  res.json(publicUser(db.getUser(user.id)));
});

// Same answer whether or not the address exists, so the form cannot list accounts.
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: "Trop de demandes. Réessaie dans une heure." });

app.post("/api/auth/forgot", forgotLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const user = validEmail(email) ? db.getUserByEmail(email) : null;
  if (user && !user.blocked) {
    const token = db.createEmailToken(user.id, "reset", 60);
    await sendPasswordReset(user.email, `${siteUrl(req)}/reset?token=${token}`).catch((err) => console.error("[fivegen] e-mail de réinitialisation non envoyé :", err.message));
  }
  res.json({ ok: true });
});

app.post("/api/auth/reset", authLimiter, async (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  const userId = db.consumeEmailToken(req.body?.token, "reset");
  const user = userId && db.getUser(userId);
  if (!user) return res.status(400).json({ error: "Lien expiré ou déjà utilisé. Refais une demande de mot de passe oublié." });
  db.setPassword(user.id, await hashPassword(password));
  // Receiving the link proves the address, and old sessions must not survive a reset.
  db.setVerified(user.id);
  db.deleteUserSessions(user.id);
  startSession(res, user.id);
  res.json(publicUser(db.getUser(user.id)));
});

// Opened from the e-mail: confirms the address, gives the free credits, back to the studio.
app.get("/api/auth/verify", (req, res) => {
  const userId = db.consumeEmailToken(req.query.token, "verify");
  const user = userId && db.getUser(userId);
  if (!user) return res.redirect("/app?verified=expired");
  db.setVerified(user.id);
  const given = db.grantFreeCredits(user.id, config.freeCredits, config.freeCreditsPerIp);
  res.redirect(`/app?verified=${given ? `credits-${given}` : "ok"}`);
});

app.post("/api/me/resend-verification", requireUser, forgotLimiter, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true });
  try {
    await sendVerificationMail(req, req.user);
    res.json({ ok: true });
  } catch (err) {
    console.error("[fivegen] e-mail de confirmation non envoyé :", err.message);
    res.status(502).json({ error: "Envoi impossible pour le moment. Réessaie plus tard." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => res.json(publicUser(req.user)));

app.post("/api/me/password", requireUser, authLimiter, async (req, res) => {
  const { current, next } = req.body ?? {};
  if (!(await verifyPassword(String(current ?? ""), req.user.pass_hash))) return res.status(400).json({ error: "Mot de passe actuel incorrect." });
  if (String(next ?? "").length < 8) return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 8 caractères." });
  db.setPassword(req.user.id, await hashPassword(String(next)));
  res.json({ ok: true });
});

app.post("/api/me/email", requireUser, authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!(await verifyPassword(String(req.body?.password ?? ""), req.user.pass_hash))) return res.status(400).json({ error: "Mot de passe incorrect." });
  if (!validEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  if (disposable(email)) return res.status(400).json({ error: "Les adresses e-mail jetables ne sont pas acceptées." });
  if (email === req.user.email) return res.json(publicUser(req.user));
  if (db.getUserByEmail(email)) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse." });
  db.setEmail(req.user.id, email);
  if (mailEnabled) await sendVerificationMail(req, db.getUser(req.user.id)).catch((err) => console.error("[fivegen] e-mail de confirmation non envoyé :", err.message));
  else db.setVerified(req.user.id);
  res.json(publicUser(db.getUser(req.user.id)));
});

// Purchases and credit use, for the account page.
app.get("/api/me/activity", requireUser, (req, res) => {
  res.json({ payments: db.listUserPayments(req.user.id), generations: db.listUserGenerations(req.user.id) });
});

// GDPR erasure: account, sessions, servers and every project file. Payment records stay
// (accounting obligation) but lose the link to the account.
app.delete("/api/me", requireUser, authLimiter, async (req, res) => {
  if (!(await verifyPassword(String(req.body?.password ?? ""), req.user.pass_hash))) return res.status(400).json({ error: "Mot de passe incorrect." });
  if (running.has(req.user.id)) return res.status(409).json({ error: "Une génération est en cours : attends qu'elle se termine." });
  deleteUserData(req.user.id);
  db.deleteUser(req.user.id);
  endSession(req, res);
  res.json({ ok: true });
});

const redeemLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: (req) => `r${req.user?.id ?? req.ip}`, message: "Trop d'essais de code. Réessaie dans 10 minutes." });

app.post("/api/redeem", requireUser, redeemLimiter, (req, res) => {
  const added = db.redeemCode(req.body?.code, req.user.id);
  if (!added) return res.status(400).json({ error: "Code invalide ou déjà utilisé." });
  res.json({ added, credits: db.getUser(req.user.id).credits });
});

// ---------- catalogue & projects ----------

app.get("/api/options", (_req, res) => res.json({ ...CATALOG, demo: config.mock }));

app.get("/api/public", (_req, res) =>
  res.json({ freeCredits: config.freeCredits, costs: config.cost, freeRefines: config.freeRefines, shopUrl: config.shopUrl, supportUrl: config.supportUrl }),
);

app.get("/api/packs", (_req, res) => res.json(publicPacks()));

const checkoutLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: (req) => `c${req.user?.id ?? req.ip}` });

app.post("/api/checkout", requireUser, checkoutLimiter, async (req, res) => {
  if (!paymentsEnabled()) return res.status(503).json({ error: "Le paiement par carte n'est pas encore disponible." });
  if (req.body?.consent !== true) {
    return res.status(400).json({ error: "Coche la case : tu demandes l'utilisation immédiate des crédits et renonces au délai de rétractation." });
  }
  const baseUrl = config.publicUrl || `${req.protocol}://${req.get("host")}`;
  try {
    res.json({ url: await createCheckout({ user: req.user, packId: String(req.body?.packId ?? ""), baseUrl }) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("[fivegen] création du paiement impossible :", err.message);
    res.status(502).json({ error: "Le paiement est momentanément indisponible. Réessaie dans un instant." });
  }
});

app.get("/api/projects", requireUser, (req, res) => res.json(listProjects(req.user.id)));

app.get("/api/projects/:id", requireUser, (req, res) => res.json(getProject(req.user.id, req.params.id)));

app.delete("/api/projects/:id", requireUser, (req, res) => {
  deleteProject(req.user.id, req.params.id);
  res.json({ ok: true });
});

// Free questions step; needs enough credits for the generation it prepares, so it
// cannot be used as a free chat.
const briefLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: (req) => `b${req.user?.id ?? req.ip}`, message: "Trop de demandes d'analyse. Réessaie dans quelques minutes." });

app.post("/api/brief", requireUser, briefLimiter, async (req, res) => {
  const description = String(req.body?.description ?? "").trim();
  if (description.length < 8) return res.status(400).json({ error: "Décris un peu plus le script que tu veux." });
  if (description.length > LIMITS.description) return res.status(400).json({ error: `Description trop longue (${LIMITS.description} caractères max).` });
  if (req.user.credits < config.cost.generate) return res.status(402).json({ error: "Crédits insuffisants pour lancer une génération.", code: "NO_CREDITS" });
  const server = req.body?.server ?? {};
  try {
    const brief = await runBrief({
      description,
      server: {
        framework: CATALOG.frameworks.some((x) => x.id === server.framework) ? server.framework : null,
        dependencies: (Array.isArray(server.dependencies) ? server.dependencies : []).filter((d) => CATALOG.dependencies.some((x) => x.id === d)),
      },
      meta: { userId: req.user.id, purpose: "brief" },
    });
    res.json(brief);
  } catch (err) {
    console.error("[fivegen] questions impossibles :", err.detail ?? err);
    const message = err instanceof EngineError ? err.message.replace(/,? ?tes crédits ont été rendus\.?/i, ".") : "Analyse impossible pour le moment.";
    res.status(502).json({ error: message });
  }
});

app.post("/api/generate", requireUser, async (req, res) => {
  const spec = req.body ?? {};
  const description = String(spec.description ?? "").trim();
  if (!description) return res.status(400).json({ error: "Décris le script à générer." });
  if (description.length > LIMITS.description) return res.status(400).json({ error: `Description trop longue (${LIMITS.description} caractères max).` });
  if (!String(spec.name ?? "").trim()) return res.status(400).json({ error: "Donne un nom à la ressource." });
  const pick = (list, v, d) => (list.some((x) => x.id === v) ? v : d);
  const cost = config.cost.generate;
  if (!charge(req, res, cost)) return;
  const project = createProject(req.user.id, {
    name: spec.name,
    framework: pick(CATALOG.frameworks, spec.framework, "qbcore"),
    type: pick(CATALOG.types, spec.type, "other"),
    ui: pick(CATALOG.ui, spec.ui, "auto"),
    dependencies: (Array.isArray(spec.dependencies) ? spec.dependencies : []).filter((d) => CATALOG.dependencies.some((x) => x.id === d)),
    language: pick(CATALOG.languages, spec.language, "fr"),
    description,
    understood: String(spec.understood ?? "").slice(0, 600),
    answers: sanitizeAnswers(spec.answers),
  });
  await streamPipeline(res, {
    userId: req.user.id,
    projectId: project.id,
    kind: "generate",
    instruction: null,
    userContent: buildGenerateMessage(project.spec),
    cost,
  });
});

app.post("/api/projects/:id/refine", requireUser, async (req, res) => {
  const instruction = String(req.body?.instruction ?? "").trim();
  if (!instruction) return res.status(400).json({ error: "Décris la modification." });
  if (instruction.length > LIMITS.instruction) return res.status(400).json({ error: `Demande trop longue (${LIMITS.instruction} caractères max).` });
  const project = getProject(req.user.id, req.params.id);
  // The first FREE_REFINES modifications of each script are included.
  const cost = project.refinesUsed < config.freeRefines ? 0 : config.cost.refine;
  if (!charge(req, res, cost)) return;
  await streamPipeline(res, {
    userId: req.user.id,
    projectId: project.id,
    kind: "refine",
    instruction,
    userContent: buildRefineMessage(project.spec, project.files, instruction),
    cost,
  });
});

app.post("/api/projects/:id/fix", requireUser, async (req, res) => {
  const project = getProject(req.user.id, req.params.id);
  const validation = await checkProject(req.user.id, project.id);
  const problems = [...validation.errors, ...(req.body?.includeWarnings ? validation.warnings : [])];
  // Errors printed by the resource in the FiveM server console (reported by the bridge).
  const runtime = req.body?.runtime ? listRuntimeErrors(req.user.id, project.id) : [];
  for (const e of runtime) {
    problems.push({ ...locateRuntimeError(e.message, project.name), message: `Erreur en jeu (console du serveur, ${e.count}×) : ${e.message}`, level: "error" });
  }
  if (!problems.length) return res.status(400).json({ error: "Aucun problème à corriger." });
  if (runtime.length) clearRuntimeErrors(req.user.id, project.id);
  const cost = config.cost.fix;
  if (!charge(req, res, cost)) return;
  await streamPipeline(res, {
    userId: req.user.id,
    projectId: project.id,
    kind: "fix",
    instruction: `${problems.length} problème(s)`,
    userContent: buildFixMessage(project.spec, project.files, problems),
    cost,
  });
});

app.put("/api/projects/:id/files", requireUser, async (req, res) => {
  const { path: filePath, content } = req.body ?? {};
  if (typeof filePath !== "string" || typeof content !== "string") return res.status(400).json({ error: "path et content requis" });
  if (Buffer.byteLength(content) > LIMITS.fileBytes) return res.status(400).json({ error: "Fichier trop volumineux." });
  writeFiles(req.user.id, req.params.id, [{ path: filePath, content }]);
  snapshot(req.user.id, req.params.id, { type: "edit", label: filePath });
  addHistory(req.user.id, req.params.id, { type: "edit", instruction: filePath });
  updateMeta(req.user.id, req.params.id, { validation: await checkProject(req.user.id, req.params.id) });
  res.json(getProject(req.user.id, req.params.id));
});

app.get("/api/projects/:id/versions", requireUser, (req, res) => {
  getProject(req.user.id, req.params.id); // 404 for someone else's project
  res.json(listVersions(req.user.id, req.params.id));
});

app.get("/api/projects/:id/versions/:n", requireUser, (req, res) => {
  res.json(getVersionFiles(req.user.id, req.params.id, req.params.n));
});

app.post("/api/projects/:id/versions/:n/restore", requireUser, async (req, res) => {
  if (running.has(req.user.id)) return res.status(409).json({ error: "Une génération est en cours sur ton compte." });
  getProject(req.user.id, req.params.id);
  restoreVersion(req.user.id, req.params.id, req.params.n);
  addHistory(req.user.id, req.params.id, { type: "restore", instruction: `version ${req.params.n}`, files: [] });
  updateMeta(req.user.id, req.params.id, { validation: await checkProject(req.user.id, req.params.id) });
  res.json(getProject(req.user.id, req.params.id));
});

app.post("/api/projects/:id/validate", requireUser, async (req, res) => {
  const validation = await checkProject(req.user.id, req.params.id);
  updateMeta(req.user.id, req.params.id, { validation });
  res.json(validation);
});

app.get("/api/projects/:id/zip", requireUser, (req, res) => {
  const project = getProject(req.user.id, req.params.id);
  res.attachment(`${project.name}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => res.destroy(err));
  archive.pipe(res);
  archive.directory(filesRoot(req.user.id, project.id), project.name);
  archive.finalize();
});

mountDeploy(app);

// ---------- admin ----------

app.get("/api/admin/overview", requireUser, requireAdmin, async (_req, res) => {
  res.json({ stats: db.stats(), engine: await engineStatus(), costs: config.cost, freeCredits: config.freeCredits });
});

// Engine account quota (polled by the panel) and what FiveGen spent, with the margin.
app.get("/api/admin/usage", requireUser, requireAdmin, async (req, res) => {
  const [provider, pricing] = await Promise.all([providerUsage({ force: req.query.refresh === "1" }), modelPricing()]);
  const price = pricing.get(config.mock ? "mock" : config.engine.model) ?? null;
  res.json({
    provider,
    summary: db.usageSummary(),
    engine: {
      model: config.mock ? "démo" : config.engine.model,
      fallbackModels: config.engine.fallbackModels,
      price,
      reviewPass: config.reviewPass,
      autoFixRounds: config.autoFixRounds,
      smokeTest: process.env.SMOKE_TEST !== "0",
      maxTokens: config.engine.maxTokens,
    },
    revenue30d: db.stats().revenue30d,
  });
});

app.get("/api/admin/generations", requireUser, requireAdmin, (req, res) => {
  const status = ["ok", "error", "cancelled"].includes(req.query.status) ? req.query.status : undefined;
  res.json(db.listGenerations({ status, limit: 200 }));
});

app.get("/api/admin/users", requireUser, requireAdmin, (_req, res) => res.json(db.listUsers()));

app.get("/api/admin/payments", requireUser, requireAdmin, (_req, res) =>
  res.json({ enabled: paymentsEnabled(), payments: db.listPayments() }),
);

app.post("/api/admin/users/:id/credits", requireUser, requireAdmin, (req, res) => {
  const delta = Math.trunc(Number(req.body?.delta));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: "Montant invalide." });
  const user = db.getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  res.json({ credits: db.addCredits(user.id, delta) });
});

function adminTarget(req, res) {
  const user = db.getUser(Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: "Utilisateur introuvable." });
    return null;
  }
  if (user.id === req.user.id) {
    res.status(400).json({ error: "Impossible sur ton propre compte." });
    return null;
  }
  return user;
}

app.get("/api/admin/users/:id", requireUser, requireAdmin, (req, res) => {
  const user = db.getUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  res.json({
    user: { id: user.id, email: user.email, credits: user.credits, blocked: Boolean(user.blocked), emailVerified: Boolean(user.email_verified), signupIp: user.signup_ip, createdAt: user.created_at },
    projects: listProjects(user.id),
    generations: db.listUserGenerations(user.id, 50),
    payments: db.listUserPayments(user.id),
  });
});

// Suspended accounts keep their data but cannot log in or use the API.
app.post("/api/admin/users/:id/block", requireUser, requireAdmin, (req, res) => {
  const user = adminTarget(req, res);
  if (!user) return;
  const blocked = req.body?.blocked !== false;
  db.setBlocked(user.id, blocked);
  if (blocked) db.deleteUserSessions(user.id);
  res.json({ blocked });
});

app.delete("/api/admin/users/:id", requireUser, requireAdmin, (req, res) => {
  const user = adminTarget(req, res);
  if (!user) return;
  if (running.has(user.id)) return res.status(409).json({ error: "Une génération est en cours sur ce compte." });
  deleteUserData(user.id);
  db.deleteUser(user.id);
  res.json({ ok: true });
});

app.get("/api/admin/codes", requireUser, requireAdmin, (_req, res) => res.json(db.listCodes()));

app.post("/api/admin/codes", requireUser, requireAdmin, (req, res) => {
  const count = Math.trunc(Number(req.body?.count));
  const credits = Math.trunc(Number(req.body?.credits));
  if (!(count >= 1 && count <= 500)) return res.status(400).json({ error: "Nombre de codes entre 1 et 500." });
  if (!(credits >= 1 && credits <= 100000)) return res.status(400).json({ error: "Crédits par code invalides." });
  res.json({ codes: db.createCodes(count, credits, String(req.body?.note ?? "").slice(0, 120)) });
});

app.delete("/api/admin/codes/:code", requireUser, requireAdmin, (req, res) => {
  if (!db.deleteUnusedCode(req.params.code)) return res.status(400).json({ error: "Code introuvable ou déjà utilisé." });
  res.json({ ok: true });
});

// ---------- errors ----------

app.use("/api", (_req, res) => res.status(404).json({ error: "Route inconnue." }));

app.use((err, _req, res, _next) => {
  if (err.code === "ENOENT") return res.status(404).json({ error: "Projet introuvable." });
  console.error("[fivegen]", err);
  res.status(500).json({ error: "Erreur interne." });
});

db.purgeSessions();
setInterval(() => db.purgeSessions(), 6 * 3600 * 1000).unref();

app.listen(config.port, config.host, async () => {
  console.log(`\n  FiveGen en ligne : ${config.publicUrl || `http://localhost:${config.port}`}${config.mock ? "  (mode démo)" : ""}`);
  if (!config.adminEmails.length) console.log("  ⚠ ADMIN_EMAIL non défini : aucun compte administrateur.");
  const status = await engineStatus();
  console.log(status.ok ? `  Moteur : OK (${status.mode})\n` : `  ⚠ Moteur : ${status.error}\n`);
});
