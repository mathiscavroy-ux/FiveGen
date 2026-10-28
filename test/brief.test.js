import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBrief, extractJson, sanitizeAnswers, buildBriefMessage } from "../server/brief.js";
import { buildGenerateMessage } from "../server/prompts.js";

test("extracts the JSON object even with text or fences around it", () => {
  assert.deepEqual(extractJson('Voici :\n```json\n{"name":"x"}\n```'), { name: "x" });
  assert.throws(() => extractJson("pas de json"));
});

test("sanitizes the engine brief to what the studio can render", () => {
  const b = sanitizeBrief({
    understood: "Un job police",
    name: "Job Police Élite!",
    type: "job",
    framework: "nope",
    ui: "ox_lib",
    dependencies: ["ox_lib", "evil"],
    questions: [
      { id: "f", label: "Fonctionnalités ?", kind: "multi", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: ["a", "zz"] },
      { label: "Grades ?", kind: "single", options: [{ value: "4", label: "4" }, { value: "6", label: "6" }], default: "9" },
      { label: "Choix unique sans options", kind: "single", options: [{ value: "x", label: "X" }] },
      { label: "", kind: "text" },
      ...Array.from({ length: 6 }, (_, i) => ({ label: `Q${i}`, kind: "text" })),
    ],
  });
  assert.equal(b.name, "job_police_elite");
  assert.equal(b.framework, null);
  assert.deepEqual(b.dependencies, ["ox_lib"]);
  assert.deepEqual(b.questions[0].default, ["a"]);
  assert.equal(b.questions[1].id, "q2");
  assert.equal(b.questions[1].default, "4");
  assert.equal(b.questions[2].kind, "text");
  assert.ok(b.questions.length <= 6);
  assert.ok(b.questions.every((q) => q.label));
});

test("the client's answers reach the generation prompt, bounded", () => {
  const answers = sanitizeAnswers([{ question: "Amendes ?", answer: ["esx_billing", "société"] }, { answer: "orphan" }, ...Array(20).fill({ question: "q", answer: "a" })]);
  assert.equal(answers[0].answer, "esx_billing, société");
  assert.ok(answers.length <= 8);
  const msg = buildGenerateMessage({ name: "police_job", framework: "esx", type: "job", ui: "ox_lib", dependencies: [], language: "fr", description: "job police", understood: "Un job police", answers });
  assert.match(msg, /<precisions_du_client>/);
  assert.match(msg, /Amendes \? → esx_billing, société/);
  assert.doesNotMatch(buildGenerateMessage({ name: "x", type: "job", description: "y" }), /precisions_du_client/);
});

test("the server profile is passed to the questions step", () => {
  assert.match(buildBriefMessage("job police", { framework: "esx", dependencies: ["ox_lib"] }), /Framework du serveur : esx[\s\S]*ox_lib/);
});
