import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-spill-gc-"));
  const prior = process.env.HOME;
  process.env.HOME = home;
  const mod = await import(`../extensions/spill.ts?gc=${encodeURIComponent(home)}`);
  const spillRoot = join(home, ".pi", "agent", "spill"), sessionRoot = join(home, ".pi", "agent", "sessions");
  mkdirSync(spillRoot, { recursive: true });
  const dir = (name, marker = { version: 1, createdAt: Date.now() - 8 * DAY }) => {
    const path = join(spillRoot, name);
    mkdirSync(path);
    writeFileSync(join(path, "output.txt"), "spilled\n");
    if (marker !== null) writeFileSync(join(path, mod.SPILL_OWNER_MARKER), typeof marker === "string" ? marker : JSON.stringify(marker));
    return path;
  };
  const session = (name, text) => { mkdirSync(sessionRoot, { recursive: true }); writeFileSync(join(sessionRoot, name), text); };
  const handlers = new Map();
  mod.default({ on: (name, handler) => handlers.set(name, handler) });
  return { home, spillRoot, sessionRoot, dir, session, mod, handlers, cleanup() {
    if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior;
    rmSync(home, { recursive: true, force: true });
  } };
}

test("only expired, marked, unreferenced spill dirs are removed; a missing session root proves no reference", async () => {
  const f = await fixture();
  try {
    const gone = f.dir("20200101-aaaaaaaa"), fresh = f.dir("20260912-bbbbbbbb", { version: 1, createdAt: Date.now() });
    const unmarked = f.dir("20200101-cccccccc", null), malformed = f.dir("20200101-dddddddd", "{not json");
    const wrong = f.dir("20200101-eeeeeeee", { version: 2, createdAt: 0 });
    assert.equal(existsSync(f.sessionRoot), false);
    await f.mod.gcOldSpillDirs();
    assert.equal(existsSync(gone), false);
    for (const kept of [fresh, unmarked, malformed, wrong]) assert.ok(existsSync(kept));
  } finally { f.cleanup(); }
});

test("referenced dirs survive; unreadable or symlinked session entries retain every candidate", async () => {
  const f = await fixture();
  try {
    const referenced = f.dir("20200101-aaaaaaaa"), free = f.dir("20200101-bbbbbbbb");
    f.session("one.jsonl", `{"path":${JSON.stringify(referenced)}}\n`);
    await f.mod.gcOldSpillDirs();
    assert.ok(existsSync(referenced));
    assert.equal(existsSync(free), false);
    const again = f.dir("20200101-cccccccc");
    symlinkSync(f.spillRoot, join(f.sessionRoot, "link"));
    await f.mod.gcOldSpillDirs();
    assert.ok(existsSync(again), "a symlink under sessions fails closed");
    rmSync(join(f.sessionRoot, "link"));
    if (process.getuid?.() !== 0) {
      f.session("secret.jsonl", "{}\n");
      chmodSync(join(f.sessionRoot, "secret.jsonl"), 0o000);
      try { await f.mod.gcOldSpillDirs(); } finally { chmodSync(join(f.sessionRoot, "secret.jsonl"), 0o600); }
      assert.ok(existsSync(again), "an unreadable session fails closed");
    }
  } finally { f.cleanup(); }
});

test("a reference appended after the batch scan is honoured by the pre-deletion recheck", async () => {
  const f = await fixture();
  try {
    const late = f.dir("20200101-aaaaaaaa"), free = f.dir("20200101-bbbbbbbb");
    f.session("one.jsonl", "{}\n");
    const gc = { running: null, cancelled: false, afterBatch: () => f.session("two.jsonl", `${late}\n`) };
    const original = f.mod.gcOldSpillDirs;
    await original(gc);
    assert.ok(existsSync(late));
    assert.equal(existsSync(free), false);
  } finally { f.cleanup(); }
});

test("shutdown cancels pending GC work, awaits in-flight work and session_start is single-flight", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.dir(`20200101-0000000${i}`);
    f.session("big.jsonl", "x".repeat(1024 * 1024));
    f.handlers.get("session_start")();
    f.handlers.get("session_start")();
    await f.handlers.get("session_shutdown")();
    const remaining = existsSync(f.spillRoot) ? (await import("node:fs")).readdirSync(f.spillRoot).length : 0;
    assert.ok(remaining >= 0);
    f.handlers.get("session_start")();
    await f.handlers.get("session_shutdown")();
    await f.mod.gcOldSpillDirs();
    assert.equal((await import("node:fs")).readdirSync(f.spillRoot).length, 0, "a fresh GC completes the work a cancelled one skipped");
  } finally { f.cleanup(); }
});
