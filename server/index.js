import path from "node:path";
import express from "express";
import { ZipArchive } from "archiver";
import { config, ROOT } from "./config.js";
import { CATALOG, buildGenerateMessage, buildRefineMessage, buildFixMessage } from "./prompts.js";
import { runEngine, engineStatus, EngineError } from "./engine.js";
import { paymentsEnabled, publicPacks, createCheckout, handleWebhook } from "./payments.js";
import { validateProject } from "./validator.js";
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
} from "./projects.js";

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

// Generation → save → check → automatic fix rounds (free) while errors remain.
async function runPipeline({ userId, projectId, userContent, kind, instruction, send, signal, state }) {
  const project = getProject(userId, projectId);
  send("phase", { phase: kind, label: LABELS[kind] });
  const result = await runEngine({ userContent, onEvent: send, signal });
  if (!result.files.length && !result.deletes.length) {
    throw new EngineError("Aucun fichier n'a été produit. Précise ta demande et réessaie, tes crédits ont été rendus.", "empty output");
  }
  writeFiles(userId, projectId, result.files, result.deletes);
  state.produced = true;
  state.outputTokens += result.outputTokens ?? 0;
  updateMeta(userId, projectId, {
    notes: kind === "generate" ? result.notes : mergeNotes(project.notes, result.notes, `${LABELS[kind]} : ${instruction ?? ""}`),
  });
  addHistory(userId, projectId, { type: kind, instruction: instruction ?? null, files: result.files.map((f) => f.path), outputTokens: result.outputTokens });
  if (result.stopReason === "max_tokens") send("status", "Ressource très volumineuse : certains fichiers ont pu être coupés, la vérification va le signaler.");

  let validation = validateProject(getFiles(userId, projectId));
  updateMeta(userId, projectId, { validation });
  send("validation", validation);

  for (let round = 1; round <= config.autoFixRounds && !validation.ok; round++) {
    send("phase", { phase: "fix", label: `Correction automatique ${round}/${config.autoFixRounds}` });
    const fix = await runEngine({
      userContent: buildFixMessage(project.spec, getFiles(userId, projectId), validation.errors),
      onEvent: send,
      signal,
    });
    writeFiles(userId, projectId, fix.files, fix.deletes);
    state.outputTokens += fix.outputTokens ?? 0;
    const current = getProject(userId, projectId);
    updateMeta(userId, projectId, { notes: mergeNotes(current.notes, fix.notes, `Correction automatique ${round}`) });
    addHistory(userId, projectId, { type: "autofix", instruction: `${validation.errors.length} erreur(s)`, files: fix.files.map((f) => f.path), outputTokens: fix.outputTokens });
    validation = validateProject(getFiles(userId, projectId));
    updateMeta(userId, projectId, { validation });
    send("validation", validation);
  }
  send("done", getProject(userId, projectId));
}

const running = new Set(); // one generation at a time per account

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

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!validEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères." });
  if (!req.body?.acceptTerms) return res.status(400).json({ error: "Tu dois accepter les conditions générales." });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse." });
  const isAdmin = Boolean(config.adminEmail) && email === config.adminEmail;
  const user = db.createUser(email, await hashPassword(password), config.freeCredits, isAdmin);
  startSession(res, user.id);
  res.json(publicUser(user));
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const user = db.getUserByEmail(email);
  const ok = user && (await verifyPassword(String(req.body?.password ?? ""), user.pass_hash));
  if (!ok) return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
  if (config.adminEmail && email === config.adminEmail && !user.is_admin) db.setAdmin(user.id);
  startSession(res, user.id);
  res.json(publicUser(db.getUser(user.id)));
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

const redeemLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: (req) => `r${req.user?.id ?? req.ip}`, message: "Trop d'essais de code. Réessaie dans 10 minutes." });

app.post("/api/redeem", requireUser, redeemLimiter, (req, res) => {
  const added = db.redeemCode(req.body?.code, req.user.id);
  if (!added) return res.status(400).json({ error: "Code invalide ou déjà utilisé." });
  res.json({ added, credits: db.getUser(req.user.id).credits });
});

// ---------- catalogue & projects ----------

app.get("/api/options", (_req, res) => res.json({ ...CATALOG, demo: config.mock }));

app.get("/api/public", (_req, res) =>
  res.json({ freeCredits: config.freeCredits, costs: config.cost, shopUrl: config.shopUrl, supportUrl: config.supportUrl }),
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
  const cost = config.cost.refine;
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
  const validation = validateProject(project.files);
  const problems = [...validation.errors, ...(req.body?.includeWarnings ? validation.warnings : [])];
  if (!problems.length) return res.status(400).json({ error: "Aucun problème à corriger." });
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

app.put("/api/projects/:id/files", requireUser, (req, res) => {
  const { path: filePath, content } = req.body ?? {};
  if (typeof filePath !== "string" || typeof content !== "string") return res.status(400).json({ error: "path et content requis" });
  if (Buffer.byteLength(content) > LIMITS.fileBytes) return res.status(400).json({ error: "Fichier trop volumineux." });
  writeFiles(req.user.id, req.params.id, [{ path: filePath, content }]);
  addHistory(req.user.id, req.params.id, { type: "edit", instruction: filePath });
  updateMeta(req.user.id, req.params.id, { validation: validateProject(getFiles(req.user.id, req.params.id)) });
  res.json(getProject(req.user.id, req.params.id));
});

app.post("/api/projects/:id/validate", requireUser, (req, res) => {
  const validation = validateProject(getFiles(req.user.id, req.params.id));
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

// ---------- admin ----------

app.get("/api/admin/overview", requireUser, requireAdmin, async (_req, res) => {
  res.json({ stats: db.stats(), engine: await engineStatus(), costs: config.cost, freeCredits: config.freeCredits });
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
  if (!config.adminEmail) console.log("  ⚠ ADMIN_EMAIL non défini : aucun compte administrateur.");
  const status = await engineStatus();
  console.log(status.ok ? `  Moteur : OK (${status.mode})\n` : `  ⚠ Moteur : ${status.error}\n`);
});
