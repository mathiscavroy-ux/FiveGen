import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";

const SECRET = "whsec_test_fivegen";
let payments;
let db;
let userId;

before(async () => {
  // Isolated database and fake keys, set before the modules read their config.
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-pay-"));
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  payments = await import("../server/payments.js");
  db = await import("../server/db.js");
  userId = db.createUser("buyer@test.local", "x", 0, false).id;
});

const signer = new Stripe("sk_test_dummy");

function signedEvent(session, type = "checkout.session.completed") {
  const payload = JSON.stringify({ id: `evt_${session.id}`, object: "event", type, data: { object: session } });
  return { payload, header: signer.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
}

const session = (over = {}) => ({
  id: "cs_test_1",
  object: "checkout.session",
  payment_status: "paid",
  amount_total: 1299,
  currency: "eur",
  metadata: { userId: String(userId), packId: "pro" },
  ...over,
});

test("payments are enabled once both Stripe keys are set", () => {
  const info = payments.publicPacks();
  assert.equal(info.enabled, true);
  assert.deepEqual(info.packs.map((p) => p.id), ["starter", "pro", "studio"]);
});

test("a paid session credits the buyer exactly once", () => {
  const { payload, header } = signedEvent(session());
  assert.match(payments.handleWebhook(payload, header), /\+30 crédits/);
  assert.equal(db.getUser(userId).credits, 30);
  // Stripe retries: the same session must not be credited twice.
  assert.equal(payments.handleWebhook(payload, header), "déjà traité");
  assert.equal(db.getUser(userId).credits, 30);
  assert.equal(db.listPayments()[0].amount, 1299);
});

test("credits come from the server pack, not from session metadata", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_2", metadata: { userId: String(userId), packId: "starter", credits: "9999" } }));
  payments.handleWebhook(payload, header);
  assert.equal(db.getUser(userId).credits, 40);
});

test("an unpaid session adds nothing", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_3", payment_status: "unpaid" }));
  assert.equal(payments.handleWebhook(payload, header), "en attente de paiement");
  assert.equal(db.getUser(userId).credits, 40);
});

test("a forged signature is rejected", () => {
  const { payload } = signedEvent(session({ id: "cs_test_4" }));
  const forged = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
  assert.throws(() => payments.handleWebhook(payload, forged));
  assert.equal(db.getUser(userId).credits, 40);
});

test("an unknown pack is refused", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_5", metadata: { userId: String(userId), packId: "mega" } }));
  assert.throws(() => payments.handleWebhook(payload, header), /métadonnées/);
});
