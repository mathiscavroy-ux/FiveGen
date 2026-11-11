// What each plan unlocks: the server refuses what the plan lacks and names the plan to take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasFeature, featureLocked, tierOf } from "../server/tiers.js";
import { config, planFor } from "../server/config.js";
import { planPerks } from "../server/payments.js";

const free = {};
const premium = { sub_status: "active", sub_plan: "premium" };
const pro = { sub_status: "active", sub_plan: "pro" };

test("each paid plan unlocks more than the one below it", () => {
  for (const feature of ["import", "convert", "optimize", "editor", "restore", "autoDeploy", "inventory"]) {
    assert.equal(hasFeature(free, feature), false, feature);
    assert.equal(hasFeature(premium, feature), true, feature);
    assert.equal(hasFeature(pro, feature), true, feature);
  }
  assert.equal(hasFeature(premium, "runtimeErrors"), false);
  assert.equal(hasFeature(pro, "runtimeErrors"), true);
  assert.ok(tierOf(free).features.versions < tierOf(premium).features.versions);
  assert.ok(tierOf(free).maxServers < tierOf(premium).maxServers && tierOf(premium).maxServers < tierOf(pro).maxServers);
  assert.ok(tierOf(free).freeRefines < tierOf(premium).freeRefines && tierOf(premium).freeRefines < tierOf(pro).freeRefines);
});

test("a locked feature names the cheapest plan that has it", () => {
  assert.equal(planFor("import"), "premium");
  assert.equal(planFor("runtimeErrors"), "pro");
  const locked = featureLocked("runtimeErrors", "Erreurs du serveur");
  assert.equal(locked.upgrade, "pro");
  assert.match(locked.error, /Pro/);
});

test("subscriptions come with monthly credits, shown first on their card", () => {
  for (const plan of config.plans) {
    assert.ok(plan.credits > 0, plan.id);
    assert.match(planPerks(plan.id)[0], new RegExp(`^${plan.credits} crédits offerts chaque mois`));
  }
  assert.ok(config.plans.find((p) => p.id === "pro").credits > config.plans.find((p) => p.id === "premium").credits);
  // the free card promises nothing it does not do
  const card = planPerks("free").join(" | ");
  assert.doesNotMatch(card, /Relecture|Import|Conversion|crédits offerts/);
  assert.match(card, /lecture seule/);
});
