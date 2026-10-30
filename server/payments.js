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
    plans: config.plans.map(({ id, name, credits, price, featured }) => ({ id, name, credits, price, featured: Boolean(featured) })),
  };
}

// A subscription that still bills or gives credits: a second one is refused.
export const ACTIVE_SUB = new Set(["active", "trialing", "past_due", "incomplete"]);

export async function createSubscriptionCheckout({ user, planId, baseUrl }) {
  const plan = config.plans.find((p) => p.id === planId);
  if (!plan) throw Object.assign(new Error("Abonnement inconnu."), { status: 400 });
  if (ACTIVE_SUB.has(user.sub_status)) throw Object.assign(new Error("Tu as déjà un abonnement en cours : gère-le depuis tes paramètres."), { status: 400 });
  const metadata = { userId: String(user.id), planId: plan.id, credits: String(plan.credits), immediateExecutionConsent: "yes" };
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
          product_data: { name: `FiveGen — Abonnement ${plan.name} (${plan.credits} crédits / mois)`, tax_code: config.stripe.taxCode },
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

// Stops (or restarts) the renewal; the credits of the current month stay.
export async function setCancelAtPeriodEnd(user, cancel) {
  if (!user.sub_id || !ACTIVE_SUB.has(user.sub_status)) throw Object.assign(new Error("Aucun abonnement en cours."), { status: 400 });
  const sub = await stripe.subscriptions.update(user.sub_id, { cancel_at_period_end: cancel });
  syncSubscription(sub);
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

// Credits of a paid subscription invoice: at the start and at each monthly renewal, once.
function creditInvoice(invoice) {
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason)) return `facture ignorée (${invoice.billing_reason})`;
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details;
  const plan = config.plans.find((p) => p.id === details?.metadata?.planId);
  const userId = Number(details?.metadata?.userId);
  if (!plan || !Number.isInteger(userId)) return "facture hors FiveGen";
  const added = recordPayment({
    sessionId: invoice.id,
    userId,
    packId: `abonnement:${plan.id}`,
    credits: plan.credits,
    amount: invoice.amount_paid ?? plan.price,
    currency: invoice.currency ?? config.stripe.currency,
  });
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
  return added ? `+${plan.credits} crédits (abonnement) pour l'utilisateur ${userId}` : "déjà traité";
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
  if (event.type === "invoice.paid") return creditInvoice(event.data.object);
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
