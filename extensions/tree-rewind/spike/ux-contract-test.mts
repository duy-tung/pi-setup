/** Public interaction contract: internal history changes must not change menus. */
import assert from "node:assert/strict";
import { handleForkRestore, handleTreeRestore, registerCommands, runRewindFlow } from "../src/commands.js";
import { createInitialState } from "../src/state.js";

const user = {
  id: "user-1", type: "message", timestamp: "2026-01-01T12:00:00Z",
  message: { role: "user", content: "fixture prompt", timestamp: 1767268800000 },
};
const assistant = { id: "assistant-1", parentId: user.id, type: "message", message: { role: "assistant" } };
const checkpoint = { entryId: user.id, parentEntryId: null, prompt: "fixture prompt", timestamp: 1, snapshot: { "": "a".repeat(40) } };
const slashOptions = [
  "Restore code and conversation", "Restore conversation only", "Restore code only",
  "Compact, focusing on this prompt", "Cancel",
];
/** A prompt without a checkpoint offers no code restore, as Claude Code does. */
const slashOptionsNoCheckpoint = ["Restore conversation only", "Compact, focusing on this prompt", "Cancel"];
const treeOptions = ["Restore code and conversation", "Restore code only", "Restore conversation only", "Cancel"];
const undoLabel = "↩ Undo last rewind";

function fixture(withUndo = false, finalChoice = "Cancel", withCheckpoint = true) {
  const state = createInitialState();
  if (withCheckpoint) state.checkpoints.set(user.id, checkpoint);
  if (withUndo) state.undo = { snapshot: checkpoint.snapshot, timestamp: 1, label: "before rewind" };
  const menus: { title: string; options: string[] }[] = [];
  const ctx = {
    hasUI: true, isIdle: () => true,
    sessionManager: {
      getBranch: () => [user, assistant], getEntries: () => [user, assistant],
      getEntry: (id: string) => [user, assistant].find(entry => entry.id === id),
    },
    ui: {
      select: async (title: string, options: string[]) => {
        menus.push({ title, options: [...options] });
        return title === "Rewind to prompt:" ? options.find(label => label.includes("fixture prompt")) : finalChoice;
      },
      confirm: async () => { throw new Error("Cancellation/conversation-only must not touch file restore"); },
      notify: () => {},
    },
  };
  return { state, ctx, menus };
}

const registered: string[] = [];
registerCommands({ registerCommand: (name: string) => registered.push(name) } as never, createInitialState());
assert.deepEqual(registered, ["rewind"], "Do not add or replace public slash commands");

for (const withUndo of [false, true]) {
  const slash = fixture(withUndo);
  await runRewindFlow(slash.state, slash.ctx);
  assert.equal(slash.menus[0]?.title, "Rewind to prompt:");
  assert.equal(slash.menus[0]?.options.length, withUndo ? 3 : 2);
  assert.equal(slash.menus[0]?.options.at(-1), "· coverage report");
  assert.match(slash.menus[0]?.options[withUndo ? 1 : 0] ?? "", /^⏺ .*fixture prompt$/);
  if (withUndo) assert.equal(slash.menus[0]?.options[0], undoLabel);
  assert.deepEqual(slash.menus[1], { title: "Restore Options", options: slashOptions });

  const tree = fixture(withUndo);
  assert.deepEqual(await handleTreeRestore(tree.state, { preparation: { targetId: user.id } }, tree.ctx), { cancel: true });
  assert.deepEqual(tree.menus, [{ title: "Restore Options", options: withUndo ? [undoLabel, ...treeOptions] : treeOptions }]);

  const fork = fixture(withUndo);
  assert.deepEqual(await handleForkRestore(fork.state, { entryId: user.id }, fork.ctx), { cancel: true });
  const forkOptions = treeOptions.map(label => label === "Restore code only" ? "Restore code only (cancel fork)" : label);
  assert.deepEqual(fork.menus[0]?.options, withUndo ? [undoLabel, ...forkOptions] : forkOptions);
}

for (const withUndo of [false, true]) {
  const descendant = fixture(withUndo);
  assert.deepEqual(await handleTreeRestore(descendant.state, { preparation: { targetId: assistant.id } }, descendant.ctx), withUndo ? { cancel: true } : undefined);
  assert.deepEqual(descendant.menus, withUndo ? [{ title: "Restore Options", options: [undoLabel, "Restore conversation only", "Cancel"] }] : []);
}

const bare = fixture(false, "Cancel", false);
await runRewindFlow(bare.state, bare.ctx);
assert.match(bare.menus[0]?.options[0] ?? "", /^  .*fixture prompt$/, "No ⏺ marker without a checkpoint");
assert.deepEqual(bare.menus[1], { title: "Restore Options", options: slashOptionsNoCheckpoint });

const conversation = fixture(false, "Restore conversation only");
assert.equal(await handleTreeRestore(conversation.state, { preparation: { targetId: assistant.id } }, conversation.ctx), undefined);
const suppressed = fixture();
suppressed.state.suppressTreeHook = true;
assert.equal(await handleTreeRestore(suppressed.state, { preparation: { targetId: assistant.id } }, suppressed.ctx), undefined);
assert.equal(suppressed.menus.length, 0, "Slash navigation must not offer the tree menu a second time");
console.log("PASS UX contract: slash/tree/fork option order, prompt/Undo list, cancellation, conversation-only, no duplicate tree menu");
