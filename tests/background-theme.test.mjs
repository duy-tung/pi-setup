import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const cli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const root = resolve(dirname(cli), "../..");
const fromPi = createRequire(cli);
const { createJiti } = fromPi("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
    "@earendil-works/pi-tui": join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  },
});
const packageDir = process.env.PI_BACKGROUND_TASKS_DIR ?? join(homedir(), ".pi/agent/npm/node_modules/pi-background-tasks");
const { BackgroundTasksManager, highlightTaskRow } = await jiti.import(join(packageDir, "src/ui/background-tasks-manager.ts"));
const { loadThemeFromPath } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")));
const { stripTerminalSequences, visibleWidth } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")));

for (const name of ["dark", "light"]) {
  for (const scenario of ["output", "empty", "missing"]) {
    test(`background log view renders the ${scenario} case with ${name} theme borders`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-bg-log-test-"));
      const outputPath = join(dir, "output.log");
      if (scenario !== "missing") writeFileSync(outputPath, scenario === "empty" ? "" :
        Array.from({ length: 30 }, (_, i) => `Fixture output ${i + 1}`).join("\n"));
      const theme = loadThemeFromPath(join(root, "dist/modes/interactive/theme", name + ".json"), "truecolor");
      const task = { id: "log-fixture", name: "Log fixture", command: "fixture", status: "completed",
        cwd: dir, outputPath, outputAbsPath: outputPath, startTime: 0, endTime: 5000,
        exitCode: 0, bytesWritten: 500, isAgent: false, notified: false };
      const manager = new BackgroundTasksManager({ requestRender() {} }, theme, () => {}, {
        getTasks: () => [task], isSeen: () => false, markSeen() {}, markFinishedSeen() {},
        stopTask: async () => {}, stopAllRunning: async () => ({ stopped: 0, failures: [] }),
        rerunTask: async () => task, showOutputPath() {},
      });
      try {
        manager.handleInput("\r"); // Exercise the same list -> Enter logs -> render path as the UI.
        // Await the actual tail reader deterministically instead of sleeping for its timer.
        await manager.refreshTail();
        for (const width of [60, 80, 110]) {
          const rows = manager.render(width);
          const plain = rows.map(stripTerminalSequences).join("\n");
          assert.match(plain, /Output tail:/);
          assert.match(plain, scenario === "output" ? /Fixture output 30/ :
            scenario === "empty" ? /No output yet/ : /Output file not found/);
          const borders = rows.filter(row => stripTerminalSequences(row).includes("╭"));
          assert.equal(borders.length, 2, "both outer frame and nested output box render");
          for (const border of borders) assert.ok(border.includes(theme.getFgAnsi("border")));
          for (const row of rows) {
            assert.ok(visibleWidth(row) <= width);
            assert.ok(!row.includes("\x1b[38;2;83;160;215m"), "no hard-coded blue border");
          }
        }
        if (scenario === "output") {
          manager.handleInput("\x1b[A");
          assert.match(manager.render(110).map(stripTerminalSequences).join("\n"), /lines .* of 30/);
        }
        manager.handleInput("\x1b[D");
        assert.match(manager.render(110).map(stripTerminalSequences).join("\n"), /bg tasks focused/);
      } finally {
        manager.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  test("background task selection follows the " + name + " theme without nested low-contrast status colors", () => {
    const theme = loadThemeFromPath(join(root, "dist/modes/interactive/theme", name + ".json"), "truecolor");
    const highlighted = highlightTaskRow(theme, theme.fg("warning", "Selected task"));
    assert.equal(stripTerminalSequences(highlighted), "Selected task");
    assert.ok(highlighted.includes(theme.getBgAnsi("selectedBg")));
    assert.ok(highlighted.includes(theme.getFgAnsi("text")));
    assert.ok(!highlighted.includes(theme.getFgAnsi("warning")));
    assert.ok(!highlighted.includes("\x1b[48;2;183;223;255m"));

    const tasks = ["Fetch advisor sources securely", "Fetch advisor package sources"].map((label, index) => ({
      id: "fixture-" + index, name: label, command: "fixture", status: "completed",
      cwd: "/fixture", outputPath: "/fixture/output", outputAbsPath: "/fixture/output",
      startTime: 0, endTime: 5000, exitCode: 0, bytesWritten: 627,
      isAgent: false, notified: false, notifyOnCompletion: false, triggerOnCompletion: false,
    }));
    const manager = new BackgroundTasksManager({ requestRender() {} }, theme, () => {}, {
      getTasks: () => tasks, isSeen: () => false,
      stopTask: async () => {}, stopAllRunning: async () => ({ stopped: 0, failures: [] }),
      rerunTask: async task => task, showOutputPath() {}, markSeen() {}, markFinishedSeen() {},
    });
    try {
      const rows = manager.render(110);
      const selected = rows.find(row => stripTerminalSequences(row).includes(tasks[0].name));
      assert.ok(selected);
      assert.ok(selected.includes(theme.getBgAnsi("selectedBg")));
      assert.ok(!selected.includes(theme.getFgAnsi("warning")));
      assert.ok(rows[0].includes(theme.getFgAnsi("border")));
      for (const width of [60, 80, 110]) {
        for (const row of manager.render(width)) assert.ok(visibleWidth(row) <= width);
      }
      if (name === "dark" && process.env.PI_BG_RENDER_OUTPUT) {
        writeFileSync(process.env.PI_BG_RENDER_OUTPUT, JSON.stringify({ rows, columns: 110 }));
      }
    } finally { manager.dispose(); }
  });
}
