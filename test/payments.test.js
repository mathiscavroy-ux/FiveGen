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
  amount_total: 1999,
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
  assert.match(payments.handleWebhook(payload, header), /\+45 crédits/);
  assert.equal(db.getUser(userId).credits, 45);
  // Stripe retries: the same session must not be credited twice.
  assert.equal(payments.handleWebhook(payload, header), "déjà traité");
  assert.equal(db.getUser(userId).credits, 45);
  assert.equal(db.listPayments()[0].amount, 1999);
});

test("credits come from the server pack, not from session metadata", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_2", metadata: { userId: String(userId), packId: "starter", credits: "9999" } }));
  payments.handleWebhook(payload, header);
  assert.equal(db.getUser(userId).credits, 60);
});

test("an unpaid session adds nothing", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_3", payment_status: "unpaid" }));
  assert.equal(payments.handleWebhook(payload, header), "en attente de paiement");
  assert.equal(db.getUser(userId).credits, 60);
});

test("a forged signature is rejected", () => {
  const { payload } = signedEvent(session({ id: "cs_test_4" }));
  const forged = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
  assert.throws(() => payments.handleWebhook(payload, forged));
  assert.equal(db.getUser(userId).credits, 60);
});

test("an unknown pack is refused", () => {
  const { payload, header } = signedEvent(session({ id: "cs_test_5", metadata: { userId: String(userId), packId: "mega" } }));
  assert.throws(() => payments.handleWebhook(payload, header), /métadonnées/);
});

test("a payment for an account deleted meanwhile is still recorded", () => {
  const gone = db.createUser("gone@test.local", "x", 0, false).id;
  db.deleteUser(gone);
  const { payload, header } = signedEvent(session({ id: "cs_test_gone", metadata: { userId: String(gone), packId: "pro" } }));
  assert.match(payments.handleWebhook(payload, header), /\+\d+ crédits/);
  assert.ok(db.listPayments().some((p) => p.session_id === "cs_test_gone" && p.email === null));
});

// ---- monthly subscriptions ----

function signed(type, object) {
  const payload = JSON.stringify({ id: `evt_${object.id}_${type}`, object: "event", type, data: { object } });
  return [payload, signer.webhooks.generateTestHeaderString({ payload, secret: SECRET })];
}

test("a subscription checkout links the subscription without adding credits", () => {
  const subscriber = db.createUser("sub@test.local", "x", 0, false).id;
  const before = db.getUser(subscriber).credits;
  const result = payments.handleWebhook(
    ...signed("checkout.session.completed", {
      id: "cs_sub_1", object: "checkout.session", mode: "subscription", payment_status: "paid",
      customer: "cus_1", subscription: "sub_1", metadata: { userId: String(subscriber), planId: "premium" },
    }),
  );
  assert.match(result, /abonnement enregistré/);
  const u = db.getUser(subscriber);
  assert.equal(u.credits, before);
  assert.equal(u.sub_id, "sub_1");
  assert.equal(u.stripe_customer, "cus_1");
  assert.equal(u.sub_status, "active");
});

const invoice = (over = {}) => ({
  id: "in_1", object: "invoice", billing_reason: "subscription_create", amount_paid: 1499, currency: "eur", customer: "cus_1",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { userId: String(db.getUserByEmail("sub@test.local").id), planId: "premium" } } },
  lines: { data: [{ period: { end: 1800000000 } }] },
  ...over,
});

test("each paid subscription invoice is recorded once with the plan's monthly credits, and keeps the plan active", async () => {
  const { config } = await import("../server/config.js");
  const monthly = config.plans.find((p) => p.id === "premium").credits;
  assert.ok(monthly > 0);
  const id = db.getUserByEmail("sub@test.local").id;
  const start = db.getUser(id).credits;
  assert.match(payments.handleWebhook(...signed("invoice.paid", invoice())), /abonnement Premium payé/);
  assert.equal(payments.handleWebhook(...signed("invoice.paid", invoice())), "déjà traité");
  assert.match(payments.handleWebhook(...signed("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle" }))), /abonnement Premium payé/);
  assert.match(payments.handleWebhook(...signed("invoice.paid", invoice({ id: "in_3", billing_reason: "subscription_update", amount_paid: 0 }))), /ignorée/);
  // two periods paid (start + renewal), the replayed webhook and the upgrade add nothing
  assert.equal(db.getUser(id).credits, start + 2 * monthly);
  assert.equal(db.getUser(id).sub_plan, "premium");
  assert.equal(db.listPayments().filter((p) => p.pack_id === "abonnement:premium").length, 2);
  assert.equal(db.getUser(id).sub_period_end, new Date(1800000000 * 1000).toISOString());
});

test("a period paid 0 (100% coupon, trial) keeps the plan active but gives no credits", () => {
  const id = db.getUserByEmail("sub@test.local").id;
  const start = db.getUser(id).credits;
  assert.match(payments.handleWebhook(...signed("invoice.paid", invoice({ id: "in_free", billing_reason: "subscription_cycle", amount_paid: 0 }))), /abonnement Premium payé/);
  assert.equal(db.getUser(id).credits, start);
  assert.equal(db.getUser(id).sub_status, "active");
});

test("the engine profile follows the subscription: free models without, Opus with", async () => {
  const { tierOf } = await import("../server/tiers.js");
  const { config } = await import("../server/config.js");
  assert.equal(tierOf({ sub_status: null }).id, "free");
  assert.ok(tierOf({}).models.every((m) => !/opus|sonnet/.test(m)), "no paid Claude model for free accounts");
  assert.equal(tierOf({ sub_status: "active", sub_plan: "premium" }).models[0], config.engine.model);
  assert.equal(tierOf({ sub_status: "active", sub_plan: "pro" }).id, "pro");
  assert.equal(tierOf({ sub_status: "past_due", sub_plan: "pro" }).id, "pro"); // Stripe still retrying
  assert.equal(tierOf({ sub_status: "canceled", sub_plan: "pro" }).id, "free");
  assert.equal(tierOf({ sub_status: "incomplete", sub_plan: "pro" }).id, "free"); // never paid
  assert.equal(tierOf({ sub_status: "active", sub_plan: "mensuel" }).id, "premium"); // plan id of the old offer
  assert.equal(tierOf({ is_admin: 1 }).id, "pro");
  assert.ok(tierOf({ sub_status: "active", sub_plan: "pro" }).freeRefines > tierOf({}).freeRefines);
});

test("subscription changes from Stripe are mirrored on the account", () => {
  const id = db.getUserByEmail("sub@test.local").id;
  const sub = { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: true, metadata: { userId: String(id), planId: "premium" }, items: { data: [{ current_period_end: 1800000000 }] } };
  payments.handleWebhook(...signed("customer.subscription.updated", sub));
  assert.equal(db.getUser(id).sub_cancel_at_end, 1);
  payments.handleWebhook(...signed("customer.subscription.deleted", { ...sub, status: "canceled" }));
  assert.equal(db.getUser(id).sub_status, "canceled");
});

test("a plan change is refused without an active subscription, for the same plan or an unknown one", async () => {
  const id = db.getUserByEmail("sub@test.local").id;
  await assert.rejects(payments.changePlan({ ...db.getUser(id), sub_status: "canceled" }, "pro"), /Aucun abonnement actif/);
  await assert.rejects(payments.changePlan({ ...db.getUser(id), sub_status: "active", sub_plan: "pro" }, "pro"), /déjà abonné à Pro/);
  await assert.rejects(payments.changePlan({ ...db.getUser(id), sub_status: "active" }, "gold"), /Abonnement inconnu/);
});

test("the prorated invoice of an upgrade is recorded without touching the plan", () => {
  const id = db.getUserByEmail("sub@test.local").id;
  db.setSubscription(id, { plan: "pro", status: "active" });
  // made before the metadata switch: it still says premium
  const result = payments.handleWebhook(...signed("invoice.paid", invoice({ id: "in_up", billing_reason: "subscription_update", amount_paid: 650 })));
  assert.match(result, /changement d'abonnement payé/);
  assert.equal(db.getUser(id).sub_plan, "pro");
  assert.ok(db.listPayments().some((p) => p.session_id === "in_up" && p.pack_id === "abonnement:changement" && p.amount === 650));
  assert.match(payments.handleWebhook(...signed("invoice.paid", invoice({ id: "in_down", billing_reason: "subscription_update", amount_paid: 0 }))), /ignorée/);
});
