// Card payments with Stripe Checkout: the buyer pays on Stripe's hosted page and a
// signed webhook credits the account. Credits are never granted from the browser.
import Stripe from "stripe";
import { config } from "./config.js";
import { recordPayment, getUser, getUserBySubscription, setSubscription } from "./db.js";

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

export function paymentsEnabled() {
  return Boolean(stripe && config.stripe.webhookSecret);
}

export function publicPacks() {
  return {
    enabled: paymentsEnabled(),
    currency: config.stripe.currency,
    packs: config.packs.map(({ id, name, credits, price, featured }) => ({ id, name, credits, price, featured: Boolean(featured) })),
    plans: config.plans.map(({ id, name, price, featured }) => ({ id, name, price, featured: Boolean(featured), perks: planPerks(id) })),
    free: { engineName: config.tiers.free.engineName, perks: planPerks("free") },
  };
}

// "anthropic/claude-sonnet-5.5" -> "Sonnet 5.5", "qwen/qwen3.8-max:free" -> "Qwen3.8 Max".
const modelLabel = (id) =>
  String(id ?? "")
    .split("/")
    .pop()
    .replace(/:free$/, "")
    .replace(/^claude-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// What a plan brings, shown on the plan cards, from its engine profile (config.tiers).
export function planPerks(id) {
  const t = config.tiers[id] ?? config.tiers.free;
  return [
    id === "free" ? `Moteur ${t.engineName} (gratuit)` : `Moteur ${t.engineName}, le plus puissant`,
    `Relecture par ${modelLabel(t.review) || t.engineName}${id === "pro" ? " et réflexion poussée sur les modifications" : ""}`,
    `${t.autoFixRounds} tours de correction automatique`,
    `${t.freeRefines} modifications offertes par script`,
    `Conversion ${t.cost.convert} crédit${t.cost.convert > 1 ? "s" : ""} · optimisation ${t.cost.optimize} crédit${t.cost.optimize > 1 ? "s" : ""}`,
    `${t.maxServers} serveur${t.maxServers > 1 ? "s" : ""} FiveM connecté${t.maxServers > 1 ? "s" : ""}`,
  ];
}

// A subscription that still bills or gives credits: a second one is refused.
export const ACTIVE_SUB = new Set(["active", "trialing", "past_due", "incomplete"]);

export async function createSubscriptionCheckout({ user, planId, baseUrl }) {
  const plan = config.plans.find((p) => p.id === planId);
  if (!plan) throw Object.assign(new Error("Abonnement inconnu."), { status: 400 });
  if (ACTIVE_SUB.has(user.sub_status)) throw Object.assign(new Error("Tu as déjà un abonnement en cours : gère-le depuis tes paramètres."), { status: 400 });
  const metadata = { userId: String(user.id), planId: plan.id, immediateExecutionConsent: "yes" };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: config.stripe.currency,
          unit_amount: plan.price,
          recurring: { interval: "month" },
          tax_behavior: "inclusive",
          product_data: { name: `FiveGen ${plan.name} (moteur ${config.tiers[plan.id]?.engineName ?? ""}, mensuel)`, tax_code: config.stripe.taxCode },
        },
      },
    ],
    ...(user.stripe_customer ? { customer: user.stripe_customer } : { customer_email: user.email }),
    client_reference_id: String(user.id),
    metadata,
    // copied by Stripe onto every invoice of the subscription (invoice.paid)
    subscription_data: { metadata },
    success_url: `${baseUrl}/app?subscribed=1`,
    cancel_url: `${baseUrl}/app?canceled=1`,
  });
  return session.url;
}

// Stops (or restarts) the renewal; the perks stay until the end of the paid month.
export async function setCancelAtPeriodEnd(user, cancel) {
  if (!user.sub_id || !ACTIVE_SUB.has(user.sub_status)) throw Object.assign(new Error("Aucun abonnement en cours."), { status: 400 });
  const sub = await stripe.subscriptions.update(user.sub_id, { cancel_at_period_end: cancel });
  syncSubscription(sub);
}

// Premium <-> Pro without cancelling. Upgrade: the difference for the rest of the month is
// charged at once, and nothing changes if that payment fails. Downgrade: immediate, the
// unused part of the higher plan is credited on the next invoice.
export async function changePlan(user, planId) {
  const plan = config.plans.find((p) => p.id === planId);
  if (!plan) throw Object.assign(new Error("Abonnement inconnu."), { status: 400 });
  if (!user.sub_id || !["active", "trialing"].includes(user.sub_status)) throw Object.assign(new Error("Aucun abonnement actif à modifier."), { status: 400 });
  if (user.sub_plan === plan.id) throw Object.assign(new Error(`Tu es déjà abonné à ${plan.name}.`), { status: 400 });
  const current = await stripe.subscriptions.retrieve(user.sub_id);
  const item = current.items.data[0];
  const product = typeof item.price.product === "string" ? item.price.product : item.price.product.id;
  const from = config.plans.find((p) => p.id === user.sub_plan);
  const upgrade = !from || plan.price > from.price;
  const changed = await stripe.subscriptions.update(user.sub_id, {
    items: [{ id: item.id, price_data: { currency: config.stripe.currency, product, unit_amount: plan.price, recurring: { interval: "month" }, tax_behavior: "inclusive" } }],
    proration_behavior: upgrade ? "always_invoice" : "create_prorations",
    // an upgrade only applies once its prorated invoice is paid
    ...(upgrade ? { payment_behavior: "pending_if_incomplete" } : {}),
  });
  if (changed.pending_update) throw Object.assign(new Error("Le paiement de la différence a été refusé : ton abonnement n'a pas changé. Vérifie ta carte et réessaie."), { status: 402 });
  // the plan travels in the metadata (invoices and webhooks read it), and the product is
  // the one created for this subscription: renamed so invoices show the new plan
  const sub = await stripe.subscriptions.update(user.sub_id, { metadata: { ...current.metadata, planId: plan.id }, cancel_at_period_end: false });
  await stripe.products.update(product, { name: `FiveGen ${plan.name} (moteur ${config.tiers[plan.id]?.engineName ?? ""}, mensuel)` }).catch(() => {});
  syncSubscription(sub);
  return { upgrade };
}

// Account deletion: nothing may be billed after it.
export async function cancelNow(user) {
  if (stripe && user.sub_id && ACTIVE_SUB.has(user.sub_status)) await stripe.subscriptions.cancel(user.sub_id);
}

const periodEnd = (sub) => {
  // since API 2025-03-31 the period lives on the subscription items
  const end = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return end ? new Date(end * 1000).toISOString() : undefined;
};

function syncSubscription(sub) {
  const user = getUserBySubscription(sub.id) ?? getUser(Number(sub.metadata?.userId));
  if (!user) return "abonnement sans compte";
  setSubscription(user.id, {
    id: sub.id,
    customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    plan: config.plans.some((p) => p.id === sub.metadata?.planId) ? sub.metadata.planId : undefined,
    status: sub.status,
    periodEnd: periodEnd(sub),
    cancelAtEnd: Boolean(sub.cancel_at_period_end),
  });
  return `abonnement ${sub.status} pour l'utilisateur ${user.id}`;
}

// A paid subscription invoice (start and each monthly renewal): recorded once for the
// accounting, and the plan stays active until the end of the new period. No credits.
function recordInvoice(invoice) {
  // subscription_update: the prorated difference of an upgrade (a downgrade bills nothing)
  const update = invoice.billing_reason === "subscription_update";
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason) && !(update && invoice.amount_paid > 0)) return `facture ignorée (${invoice.billing_reason})`;
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details;
  const plan = config.plans.find((p) => p.id === details?.metadata?.planId);
  const userId = Number(details?.metadata?.userId);
  if (!plan || !Number.isInteger(userId)) return "facture hors FiveGen";
  const added = recordPayment({
    sessionId: invoice.id,
    userId,
    packId: update ? "abonnement:changement" : `abonnement:${plan.id}`,
    credits: 0,
    amount: invoice.amount_paid ?? plan.price,
    currency: invoice.currency ?? config.stripe.currency,
  });
  // an upgrade invoice is made before the plan in the metadata changes: only the payment
  // is recorded, the new plan comes from changePlan and customer.subscription.updated
  if (update) return added ? `changement d'abonnement payé par l'utilisateur ${userId}` : "déjà traité";
  const subId = typeof details.subscription === "string" ? details.subscription : details.subscription?.id;
  const end = invoice.lines?.data?.[0]?.period?.end;
  if (getUser(userId)) {
    setSubscription(userId, {
      id: subId,
      customer: typeof invoice.customer === "string" ? invoice.customer : undefined,
      plan: plan.id,
      status: "active",
      periodEnd: end ? new Date(end * 1000).toISOString() : undefined,
    });
  }
  return added ? `abonnement ${plan.name} payé par l'utilisateur ${userId}` : "déjà traité";
}

export async function createCheckout({ user, packId, baseUrl }) {
  const pack = config.packs.find((p) => p.id === packId);
  if (!pack) throw Object.assign(new Error("Pack inconnu."), { status: 400 });
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: config.stripe.currency,
          unit_amount: pack.price,
          // the price shown on the site is what the buyer pays: VAT included, never added on top
          tax_behavior: "inclusive",
          product_data: { name: `FiveGen — Pack ${pack.name} (${pack.credits} crédits)`, tax_code: config.stripe.taxCode },
        },
      },
    ],
    customer_email: user.email,
    client_reference_id: String(user.id),
    metadata: { userId: String(user.id), packId: pack.id, credits: String(pack.credits), immediateExecutionConsent: "yes" },
    success_url: `${baseUrl}/app?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/app?canceled=1`,
  });
  return session.url;
}

// Verifies the signature, then credits the buyer once per paid session.
// Returns a short label for logs; throws when the signature is invalid.
export function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  if (event.type === "invoice.paid") return recordInvoice(event.data.object);
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") return syncSubscription(event.data.object);
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return `ignoré (${event.type})`;
  }
  const session = event.data.object;
  // A subscription checkout: credits come with its invoice (invoice.paid), only remember the link here.
  if (session.mode === "subscription") {
    const userId = Number(session.metadata?.userId);
    if (!getUser(userId)) return "abonnement sans compte";
    setSubscription(userId, {
      id: typeof session.subscription === "string" ? session.subscription : session.subscription?.id,
      customer: typeof session.customer === "string" ? session.customer : session.customer?.id,
      plan: config.plans.some((p) => p.id === session.metadata?.planId) ? session.metadata.planId : undefined,
      status: "active",
    });
    return `abonnement enregistré pour l'utilisateur ${userId}`;
  }
  if (session.payment_status !== "paid") return "en attente de paiement";

  const userId = Number(session.metadata?.userId);
  const pack = config.packs.find((p) => p.id === session.metadata?.packId);
  if (!Number.isInteger(userId) || !pack) throw new Error(`Session ${session.id} sans métadonnées FiveGen valides`);

  // Credits come from server config, never from the client; the amount is what Stripe charged.
  const added = recordPayment({
    sessionId: session.id,
    userId,
    packId: pack.id,
    credits: pack.credits,
    amount: session.amount_total ?? pack.price,
    currency: session.currency ?? config.stripe.currency,
  });
  return added ? `+${pack.credits} crédits pour l'utilisateur ${userId}` : "déjà traité";
}
