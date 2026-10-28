// Line diff between two versions of a resource (LCS on the changed middle part).
// Pure functions, shared by the studio and the tests.

const MAX_CELLS = 6_000_000; // beyond this, show the block as replaced instead of freezing the tab

export function diffLines(oldText, newText) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", a: i + 1, b: i + 1, text: a[i] });

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) ops.push({ type: "del", a: i + 1, text: a[i] });
    for (let j = start; j < endB; j++) ops.push({ type: "add", b: j + 1, text: b[j] });
  } else {
    // lcs[i][j] = longest common subsequence of a[start+i..endA) and b[start+j..endB)
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        ops.push({ type: "same", a: start + i + 1, b: start + j + 1, text: a[start + i] });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
        ops.push({ type: "add", b: start + j + 1, text: b[start + j] });
        j++;
      } else {
        ops.push({ type: "del", a: start + i + 1, text: a[start + i] });
        i++;
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) ops.push({ type: "same", a: endA + k + 1, b: endB + k + 1, text: a[endA + k] });
  return ops;
}

// Changed lines with `context` unchanged lines around them; gaps become { type: "gap", count }.
export function hunks(ops, context = 3) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, i) => {
    if (op.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: "gap", count: skipped });
      skipped = 0;
      out.push(op);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ type: "gap", count: skipped });
  return out;
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}

// Per-file summary between two versions: added, removed or modified, with line counts.
export function diffFiles(before = [], after = []) {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const now = new Map(after.map((f) => [f.path, f.content]));
  const out = [];
  for (const path of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(path);
    const b = now.get(path);
    if (a === b) continue;
    const ops = diffLines(a ?? "", b ?? "");
    out.push({ path, status: a === undefined ? "added" : b === undefined ? "removed" : "modified", ...diffStats(ops) });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}
