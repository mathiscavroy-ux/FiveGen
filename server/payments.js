// Card payments with Stripe Checkout: the buyer pays on Stripe's hosted page and a
// signed webhook credits the account. Credits are never granted from the browser.
import Stripe from "stripe";
import { config } from "./config.js";
import { recordPayment } from "./db.js";

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

export function paymentsEnabled() {
  return Boolean(stripe && config.stripe.webhookSecret);
}

export function publicPacks() {
  return {
    enabled: paymentsEnabled(),
    currency: config.stripe.currency,
    packs: config.packs.map(({ id, name, credits, price, featured }) => ({ id, name, credits, price, featured: Boolean(featured) })),
  };
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
          product_data: { name: `FiveGen — Pack ${pack.name} (${pack.credits} crédits)` },
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
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return `ignoré (${event.type})`;
  }
  const session = event.data.object;
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
