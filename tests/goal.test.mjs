import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const fromPi = createRequire(piCli);
const typebox = fromPi.resolve("typebox");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox") {
      return { url: pathToFileURL(typebox).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: goalExtension } = await import("../extensions/goal.ts");

function harness(initialBranch) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const appended = [];
  const sent = [];
  let branch = initialBranch;
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    appendEntry(customType, data) { appended.push({ customType, data }); },
    sendMessage(...args) { sent.push(args); },
  };
  goalExtension(pi);
  const ctx = {
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  };
  return { handlers, tools, commands, appended, sent, ctx, setBranch(next) { branch = next; } };
}

const priorGoal = {
  id: "goal-old",
  revision: 3,
  objective: "abandoned branch objective",
  phase: "active",
  roundsStarted: 1,
  maxRounds: 10,
  updatedAt: 1,
};

test("a package follow-up already pending suppresses a duplicate goal continuation", async () => {
  const h = harness([]);
  h.handlers.get("session_start")({}, h.ctx);
  await h.tools.get("create_goal").execute("goal", { objective: "fixture", max_goal_rounds: 2 }, undefined, undefined, h.ctx);
  h.ctx.hasPendingMessages = () => true;
  h.ctx.isIdle = () => true;
  h.handlers.get("agent_settled")({}, h.ctx);
  assert.equal(h.sent.length, 0);
  h.ctx.hasPendingMessages = () => false;
  h.handlers.get("agent_settled")({}, h.ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true);
});

test("goal cache refolds from the selected branch on session_tree", async () => {
  const h = harness([{ type: "custom", customType: "goal-state", data: priorGoal }]);
  h.handlers.get("session_start")({}, h.ctx);
  let result = await h.tools.get("get_goal").execute("call", {}, undefined, undefined, h.ctx);
  assert.equal(result.details.goal.id, "goal-old");

  h.setBranch([]);
  h.handlers.get("session_tree")({}, h.ctx);
  result = await h.tools.get("get_goal").execute("call", {}, undefined, undefined, h.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no goal exists/);

  result = await h.tools.get("create_goal").execute(
    "call",
    { objective: "current branch objective", max_goal_rounds: 2 },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.details.goal.objective, "current branch objective");
  assert.equal(h.appended.at(-1).customType, "goal-state");
});
