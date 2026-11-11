// Which engine profile an account runs on (config.tiers): its subscription plan while it
// is paid, Pro for the owner (admin), otherwise the free profile.
import { config, planFor } from "./config.js";

// past_due: Stripe is still retrying the payment, the perks stay until it gives up.
const PAID = new Set(["active", "trialing", "past_due"]);

export function tierOf(user) {
  if (user?.is_admin) return config.tiers.pro;
  if (user && PAID.has(user.sub_status)) return config.tiers[user.sub_plan] ?? config.tiers.premium;
  return config.tiers.free;
}

const PLAN_NAMES = { premium: "Premium", pro: "Pro" };

/** Whether the account's plan unlocks a feature of config.tiers[*].features. */
export const hasFeature = (user, feature) => Boolean(tierOf(user).features?.[feature]);

/** The refusal sent when a plan does not include a feature: the studio offers the upgrade. */
export function featureLocked(feature, label) {
  const plan = planFor(feature);
  return { error: `${label} : disponible avec l'offre ${PLAN_NAMES[plan] ?? plan}.`, upgrade: plan, feature };
}

/** Express middleware: 403 with featureLocked() when the account's plan lacks the feature. */
export const requireFeature = (feature, label) => (req, res, next) =>
  hasFeature(req.user, feature) ? next() : res.status(403).json(featureLocked(feature, label));
