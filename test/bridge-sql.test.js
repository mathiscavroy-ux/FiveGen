// SQL run by the FiveM bridge at deployment: splitting and the safety filter.
import { test } from "node:test";
import assert from "node:assert/strict";
// The file is a plain FiveM script: it publishes its helpers on globalThis, as the bridge reads them.
await import("../bridge/fivegen_bridge/sql.js");
const { splitSql, checkStatement, ALREADY_DONE } = globalThis.FiveGenSql;

test("statements are split on semicolons outside strings and comments", () => {
  const sql = `-- tables du job
CREATE TABLE IF NOT EXISTS tow_jobs (id INT, note VARCHAR(50) DEFAULT 'a;b');
/* items ; */
INSERT IGNORE INTO items (name, label) VALUES ('rope', "Corde; solide"), ('hook', 'L\\'accroche');
# fin
`;
  const parts = splitSql(sql);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^CREATE TABLE IF NOT EXISTS tow_jobs .*'a;b'\)$/);
  assert.match(parts[1], /Corde; solide/);
  assert.match(parts[1], /L\\'accroche/);
  assert.deepEqual(splitSql("  ;; \n"), []);
});

test("statements that can lose data or change rights are refused", () => {
  for (const ok of [
    "CREATE TABLE IF NOT EXISTS t (id INT)",
    "INSERT INTO items (name) VALUES ('x')",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tow INT",
    "UPDATE users SET job = 'tow' WHERE job = 'unemployed'",
  ]) {
    assert.equal(checkStatement(ok), null, ok);
  }
  for (const bad of [
    "DROP TABLE users",
    "drop table if exists tow_jobs",
    "TRUNCATE items",
    "DELETE FROM users",
    "ALTER TABLE users DROP COLUMN money",
    "UPDATE users SET money = 0",
    "GRANT ALL ON *.* TO x",
    "USE es_extended",
    "CREATE DATABASE test",
    "DELIMITER $$",
  ]) {
    assert.ok(checkStatement(bad), bad);
  }
});

test("errors from a resource deployed twice are recognised", () => {
  assert.match("Table 'tow_jobs' already exists", ALREADY_DONE);
  assert.match("Duplicate column name 'tow'", ALREADY_DONE);
  assert.match("Duplicate entry 'rope' for key 'PRIMARY'", ALREADY_DONE);
  assert.doesNotMatch("You have an error in your SQL syntax", ALREADY_DONE);
});
