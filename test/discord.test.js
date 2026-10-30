// Which FiveGen account a Discord login opens (the OAuth exchange itself needs Discord).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let discordAccount;
let db;
const opts = { ip: "10.0.0.1", disposable: (email) => email.endsWith("@yopmail.com") };

before(async () => {
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fivegen-discord-"));
  process.env.FREE_CREDITS = "3";
  ({ discordAccount } = await import("../server/discord.js"));
  db = await import("../server/db.js");
});

test("a new Discord user gets an account without password, with the free credits", () => {
  const { user } = discordAccount({ id: "111", email: "Gamer@Test.fr", verified: true }, opts);
  assert.equal(user.email, "gamer@test.fr");
  assert.equal(user.pass_hash, "");
  assert.equal(user.discord_id, "111");
  assert.equal(user.email_verified, 1);
  assert.equal(user.credits, 3);
  // next time: same account, found by its Discord id even if the e-mail changed on Discord
  assert.equal(discordAccount({ id: "111", email: "other@test.fr", verified: true }, opts).user.id, user.id);
});

test("an existing account with the same e-mail is linked, not duplicated", () => {
  const existing = db.createUser("player@test.fr", "scrypt$aa$bb", 0, false, { verified: false });
  const { user } = discordAccount({ id: "222", email: "player@test.fr", verified: true }, opts);
  assert.equal(user.id, existing.id);
  assert.equal(user.discord_id, "222");
  assert.equal(user.pass_hash, "scrypt$aa$bb");
  assert.equal(user.email_verified, 1);
});

test("unverified, throwaway or suspended accounts are refused", () => {
  assert.equal(discordAccount({ id: "333", email: "x@test.fr", verified: false }, opts).error, "noemail");
  assert.equal(discordAccount({ id: "334" }, opts).error, "noemail");
  assert.equal(discordAccount({ id: "335", email: "x@yopmail.com", verified: true }, opts).error, "disposable");
  const blocked = discordAccount({ id: "336", email: "bad@test.fr", verified: true }, opts).user;
  db.setBlocked(blocked.id, true);
  assert.equal(discordAccount({ id: "336", email: "bad@test.fr", verified: true }, opts).error, "blocked");
});
