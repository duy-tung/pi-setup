// Exercise the installed package combination with a fake provider, never real credentials.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
if (process.argv[2] !== "--child") {
  const store = resolve(process.argv[2]);
  const extraNpm = process.argv[3] ? resolve(process.argv[3]) : join(store, "npm/node_modules");
  const fixture = mkdtempSync(join(tmpdir(), "pi-packages-smoke-"));
  try {
    const agent = join(fixture, "agent");
    mkdirSync(agent);
    mkdirSync(join(fixture, "home"));
    mkdirSync(join(fixture, "workspace"));
    for (const rel of ["extensions", "skills", "prompts", "AGENTS.md", "zentui.json"]) cpSync(join(root, rel), join(agent, rel), { recursive: true });
    cpSync(join(root, "tests/fixtures/migration-provider.ts"), join(agent, "extensions/migration-provider.ts"));
    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    settings.packages = settings.packages.map(entry => {
      const spec = typeof entry === "string" ? entry : entry.source;
      const name = spec.startsWith("npm:") ? spec.slice(4).replace(/@[^@/]+$/, "") : null;
      const source = name
        ? join(extraNpm, name)
        : join(store, "git/github.com/duy-tung/pi-anthropic-oauth-plus");
      return typeof entry === "string" ? source : { ...entry, source };
    });
    settings.defaultProvider = "migration-mock";
    settings.defaultModel = "fixture";
    settings.enabledModels = ["migration-mock/fixture"];
    writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
    const child = spawnSync(process.execPath, [script, "--child", fixture], {
      cwd: join(fixture, "workspace"),
      env: { ...process.env, HOME: join(fixture, "home"), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
      encoding: "utf8", timeout: 90000,
    });
    process.stdout.write(child.stdout ?? "");
    process.stderr.write(child.stderr ?? "");
    assert.equal(child.status, 0, child.error?.message ?? "Package integration smoke failed");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
} else {
  const fixture = process.argv[3];
  const cwd = join(fixture, "workspace");
  const agentDir = join(fixture, "agent");
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, "fixture.txt"), "initial\n");
  execFileSync("git", ["-C", cwd, "add", "fixture.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  const piRoot = resolve(dirname(cli), "../..");
  const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
  const { validateToolArguments } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  const { packageRestoreBlocker } = await import(pathToFileURL(join(root, "extensions/lib/package-activity.ts")).href);
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const eventBus = sdk.createEventBus();
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  for (const rel of ["extensions/repeat-reminder.ts", "extensions/lib/effects.ts", "extensions/compaction-prune.ts", "extensions/context-snapshots.ts"]) {
    assert.equal(existsSync(join(agentDir, rel)), false, `Retired resource must not load: ${rel}`);
  }
  const { session, extensionsResult } = await sdk.createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  });
  const errors = [];
  try {
    await session.bindExtensions({ mode: "rpc", onError: e => errors.push(e) });
    const runner = session.extensionRunner;
    const themes = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")).href);
    themes.initTheme("dark", false);
    const tuiLib = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
    const theme = themes.loadThemeFromPath(join(piRoot, "dist/modes/interactive/theme/dark.json"), "truecolor");
    const statuses = new Map();
    const footerChanges = [];
    const uiWarnings = [];
    let footer, editorFactory;
    const tui = { requestRender() {}, terminal: { columns: 120, rows: 40 } };
    const ui = {
      ...runner.getUIContext(), theme,
      setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      setFooter(factory) {
        footerChanges.push(factory);
        footer?.dispose?.();
        footer = factory?.(tui, theme, {
          getExtensionStatuses: () => statuses, getGitBranch: () => "main", onBranchChange: () => () => {},
        });
      },
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory) { editorFactory = factory; },
      notify(message, level) { if (level === "warning" || level === "error") uiWarnings.push(message); },
    };
    await session.bindExtensions({ mode: "tui", uiContext: ui });
    assert.equal(footerChanges.length, 1, "Zentui native mode must leave statusline.ts as the sole footer owner");
    assert.equal(typeof editorFactory, "function", "Zentui editor was not installed");
    const editor = editorFactory(tui, themes.getEditorTheme(), tuiLib.getKeybindings());
    editor.setText("Zentui input fixture");
    const singleLine = editor.render(120);
    assert.equal(singleLine.length, 3, "Accent Rail should have one input row and two spacer rows");
    assert.equal(tuiLib.stripTerminalSequences(singleLine[0]).trim(), "");
    assert.equal(tuiLib.stripTerminalSequences(singleLine.at(-1)).trim(), "");
    assert.match(tuiLib.stripTerminalSequences(singleLine.join("\n")), /Zentui input fixture/);
    assert.doesNotMatch(tuiLib.stripTerminalSequences(singleLine.join("\n")), /migration-mock|Migration fixture/);
    editor.setText("First line\nSecond line");
    const multiline = editor.render(120).map(tuiLib.stripTerminalSequences);
    assert.equal(multiline.filter(line => line.trim() !== "").length, 2, "Both input lines must remain visible without metadata");
    editor.setText("");
    assert.equal(editor.render(120).length, 3, "Empty editor should stay compact");
    assert.match(tuiLib.stripTerminalSequences(footer.render(240).join("\n")), /\$0\.00/);
    await runner.emit({ type: "model_select", model: session.model, source: "set" });
    assert.equal(footerChanges.length, 1, "Model selection replaced the custom footer");
    assert.deepEqual(uiWarnings.filter(message => /zentui/i.test(message)), []);
    const ctx = runner.createContext();
    assert.deepEqual(errors, [], "Extension startup errors");
    assert.ok(ctx.modelRegistry.find("migration-mock", "fixture"), "Fixture model was not registered");
    const tools = new Map(extensionsResult.extensions.flatMap(e => [...e.tools].map(([name, t]) => [name, t.definition])));
    const required = ["ask_user_question", "todo", "Agent", "get_subagent_result", "steer_subagent",
      "SubagentWorkflow", "bg_run", "bg_status", "bg_logs", "bg_kill", "bg_delegate", "bg_result",
      "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate", "create_goal"];
    for (const name of required) assert.ok(tools.has(name), "Missing tool: " + name);
    for (const name of ["ask_user", "todowrite", "subagent", "send_message", "list_agents", "interrupt_agent", "bash"]) {
      assert.ok(!tools.has(name), "Retired override still loaded: " + name);
    }
    const commands = extensionsResult.extensions.flatMap(e => [...e.commands.keys()]);
    for (const name of ["todos", "agents", "bg", "rewind", "goal", "zentui"]) {
      assert.equal(commands.filter(n => n === name).length, 1, name + " command ownership");
    }
    assert.ok(!commands.includes("present"), "Retired Present command must not load");
    assert.ok(!commands.includes("claude-cache"), "Package attribution replaced the existing provider");
    assert.equal(loader.getSkills().skills.filter(s => s.name === "context7-docs").length, 1, "Context7 on-demand skill missing or duplicated");
    for (const name of ["resolve-library-id", "query-docs"]) assert.ok(tools.has(name), "Missing Context7 tool: " + name);
    assert.ok(loader.getPrompts().prompts.some(p => p.name === "c7-docs"), "Context7 explicit prompt missing");
    const call = async (name, args, context = ctx) => {
      const tool = tools.get(name);
      const validated = validateToolArguments(tool, { type: "toolCall", id: "smoke-" + name, name, arguments: args });
      return tool.execute("smoke-" + name, validated, new AbortController().signal, () => {}, context);
    };
    const task = await call("todo", { action: "create", subject: "smoke task" });
    assert.ok(!task.isError, JSON.stringify(task));
    const id = task.details.tasks[0].id;
    await call("todo", { action: "update", id, status: "completed" });
    const list = await call("todo", { action: "list" });
    assert.equal(list.details.tasks[0].status, "completed");
    const dependent = await call("todo", { action: "create", subject: "dependent", blockedBy: [id] });
    const rejected = await call("todo", { action: "update", id: dependent.details.tasks.at(-1).id, addBlockedBy: [999999] });
    assert.ok(rejected.details.error, "Dangling dependency must be rejected");
    const question = await call("ask_user_question", {
      questions: [{ question: "Which fixture?", header: "Fixture", options: [
        { label: "First", description: "Use first fixture" }, { label: "Second", description: "Use second fixture" },
      ] }],
    }, { ...ctx, mode: "rpc", hasUI: true, ui: {
      ...ctx.ui, select: async (_title, options) => options[0], input: async () => "fixture",
    } });
    assert.ok(!question.isError && question.details?.cancelled === false, JSON.stringify(question));
    const multi = await call("ask_user_question", { questions: [{
      question: "Which fixtures?", header: "Multi", multiSelect: true,
      options: [{ label: "First", description: "First fixture" }, { label: "Second", description: "Second fixture" }],
    }] }, { ...ctx, mode: "rpc", hasUI: true, ui: { ...ctx.ui, input: async () => "1,2", select: async () => undefined } });
    assert.deepEqual(multi.details.answers[0].selected, ["First", "Second"]);
    const cancelled = await call("ask_user_question", { questions: [{
      question: "Cancel fixture?", header: "Cancel",
      options: [{ label: "First", description: "First fixture" }, { label: "Second", description: "Second fixture" }],
    }] }, { ...ctx, mode: "rpc", hasUI: true, ui: { ...ctx.ui, select: async () => undefined, input: async () => undefined } });
    assert.equal(cancelled.details.cancelled, true);
    const outside = join(fixture, "outside.txt");
    const bash = sdk.createBashTool(cwd);
    const shell = await bash.execute("shell", { command: "printf fixture > " + outside }, undefined);
    assert.ok(!shell.isError, JSON.stringify(shell));
    assert.equal(readFileSync(outside, "utf8"), "fixture");
    const job = await call("bg_run", { name: "fixture shell", command: "printf background-fixture", isAgent: false,
      notifyOnCompletion: false, triggerOnCompletion: false });
    assert.ok(!job.isError, JSON.stringify(job));
    const jobId = job.details.task.id;
    for (let n = 0; n < 100; n++) {
      const status = await call("bg_status", { taskId: jobId });
      if (!JSON.stringify(status).includes('"status":"running"')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const log = await call("bg_logs", { taskId: jobId });
    assert.match(JSON.stringify(log), /background-fixture/);
    assert.equal(await packageRestoreBlocker(eventBus), null);
    const running = await call("bg_run", { name: "fixture long job", command: "sleep 30", isAgent: false,
      notifyOnCompletion: false, triggerOnCompletion: false });
    assert.match(await packageRestoreBlocker(eventBus), /Background jobs/);
    await call("bg_kill", { taskId: running.details.task.id });
    assert.equal(await packageRestoreBlocker(eventBus), null);
    const agent = await call("Agent", { subagent_type: "general-purpose", description: "fixture child",
      prompt: "migration smoke", model: "migration-mock/fixture", run_in_background: false });
    assert.ok(!agent.isError, JSON.stringify(agent));
    assert.match(JSON.stringify(agent), /fixture answer/);
    const bg = await call("Agent", { subagent_type: "general-purpose", description: "background child",
      prompt: "migration background", model: "migration-mock/fixture", run_in_background: true });
    assert.ok(bg.details.agentId, JSON.stringify(bg));
    await call("steer_subagent", { agent_id: bg.details.agentId, message: "migration steering" });
    const result = await call("get_subagent_result", { agent_id: bg.details.agentId, wait: true });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /fixture answer/);
    const resumed = await call("Agent", { description: "resume fixture", prompt: "migration resume",
      subagent_type: "general-purpose", resume: bg.details.agentId, run_in_background: false });
    assert.match(JSON.stringify(resumed), /fixture answer/);
    const isolated = await call("Agent", { subagent_type: "general-purpose", description: "worktree fixture",
      prompt: "migration worktree", model: "migration-mock/fixture", run_in_background: false, isolation: "worktree" });
    assert.match(JSON.stringify(isolated), /fixture answer/);
    const workflow = await call("SubagentWorkflow", {
      script: 'export const meta = { name: "smoke-workflow", description: "fixture" }; return await agent("workflow fixture", {model:"migration-mock/fixture", agentType:"general-purpose"});',
    });
    assert.ok(!workflow.isError, JSON.stringify(workflow));
    for (let n = 0; n < 100; n++) {
      if (await packageRestoreBlocker(eventBus) === null) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(await packageRestoreBlocker(eventBus), null, "Workflow did not settle");
    const shutdownJob = await call("bg_run", { name: "shutdown fixture", command: "sleep 30", isAgent: false,
      notifyOnCompletion: false, triggerOnCompletion: false });
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(footerChanges.length, 1, "Zentui shutdown must not clear another extension's footer");
    footer?.dispose?.();
    const shutdownPid = shutdownJob.details.task.pid;
    assert.equal(typeof shutdownPid, "number");
    assert.throws(() => process.kill(shutdownPid, 0), { code: "ESRCH" }, "Shutdown left the shell process alive");
    assert.deepEqual(errors, []);
    console.log("Package smoke passed: Zentui TUI/editor and custom footer ownership; ask/cancel/multi RPC, todo dependencies, unrestricted Bash, background logs/kill, Agent/steering/resume, workflow and rewind activity.");
  } finally {
    session.dispose();
  }
  process.exit(0);
}
