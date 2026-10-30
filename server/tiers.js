// Which engine profile an account runs on (config.tiers): its subscription plan while it
// is paid, Pro for the owner (admin), otherwise the free profile.
import { config } from "./config.js";

// past_due: Stripe is still retrying the payment, the perks stay until it gives up.
const PAID = new Set(["active", "trialing", "past_due"]);

export function tierOf(user) {
  if (user?.is_admin) return config.tiers.pro;
  if (user && PAID.has(user.sub_status)) return config.tiers[user.sub_plan] ?? config.tiers.premium;
  return config.tiers.free;
}
