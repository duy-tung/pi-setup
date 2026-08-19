/**
 * pi-todos: TodoWrite tool + pinned checklist widget (dsh-style To-dos panel).
 *
 * - Registers `todowrite` using Claude Code's TodoWrite schema, which Claude
 *   models know by heart (and which passes the Anthropic OAuth tool-name
 *   allowlist as "TodoWrite" via pi-anthropic-oauth's name mapping).
 * - Mirrors the list into a widget pinned above the editor, and a footer
 *   status with the in-progress item.
 * - /todos command toggles the widget.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";
type Todo = { content: string; status: TodoStatus; activeForm?: string };

const ICONS: Record<TodoStatus, string> = {
  pending: "◌",
  in_progress: "◐",
  completed: "✓",
};

export default function (pi: ExtensionAPI) {
  let todos: Todo[] = [];
  let widgetVisible = true;

  const summary = () => {
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    const pending = todos.filter((t) => t.status === "pending").length;
    const done = todos.filter((t) => t.status === "completed").length;
    const parts: string[] = [];
    if (inProgress) parts.push(`${inProgress} in progress`);
    if (pending) parts.push(`${pending} pending`);
    if (done) parts.push(`${done} done`);
    return parts.join(" · ") || "empty";
  };

  const syncUi = (ctx: { hasUI: boolean; ui: any }) => {
    if (!ctx.hasUI) return;
    const active = todos.find((t) => t.status === "in_progress");
    ctx.ui.setStatus("todos", active ? `${active.activeForm ?? active.content}…` : undefined);
    if (!widgetVisible || todos.length === 0 || todos.every((t) => t.status === "completed")) {
      ctx.ui.setWidget("todos", undefined);
      return;
    }
    ctx.ui.setWidget("todos", [
      `To-dos  ${summary()}`,
      ...todos.map((t) => ` ${ICONS[t.status]} ${t.content}`),
    ]);
  };

  pi.registerTool({
    name: "todowrite",
    label: "To-dos",
    description:
      "Create and manage a structured task list for the current session. " +
      "Pass the FULL updated list each call (it replaces the previous list). " +
      "Mark exactly one task in_progress at a time; mark tasks completed immediately when done.",
    promptSnippet: "Track multi-step work as a visible to-do checklist",
    promptGuidelines: [
      "Use todowrite when a task has 3+ steps or the user gives multiple tasks; update it as you go instead of only at the end.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "Imperative task description" }),
          status: StringEnum(["pending", "in_progress", "completed"] as const),
          activeForm: Type.Optional(
            Type.String({ description: "Present-continuous form shown while in progress" }),
          ),
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      todos = params.todos as Todo[];
      syncUi(ctx);
      const lines = todos.map((t) => `${ICONS[t.status]} ${t.content}`);
      return {
        content: [{ type: "text", text: `To-dos (${summary()}):\n${lines.join("\n")}` }],
        details: { todos },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("To-dos ")) + theme.fg("dim", "update"), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const list = ((result.details as { todos?: Todo[] })?.todos ?? []) as Todo[];
      if (!expanded) {
        const active = list.find((t) => t.status === "in_progress");
        let text = theme.fg("success", summary());
        if (active) text += theme.fg("dim", ` — ${active.activeForm ?? active.content}`);
        return new Text(text, 0, 0);
      }
      const color: Record<TodoStatus, string> = {
        pending: "dim",
        in_progress: "warning",
        completed: "success",
      };
      const lines = list.map((t) => theme.fg(color[t.status], `${ICONS[t.status]} ${t.content}`));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Toggle the to-dos widget",
    handler: async (_args, ctx) => {
      widgetVisible = !widgetVisible;
      syncUi(ctx);
      if (ctx.hasUI) ctx.ui.notify(widgetVisible ? "To-dos widget shown" : "To-dos widget hidden", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    todos = [];
    syncUi(ctx);
  });
}
