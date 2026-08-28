import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commandPrefix,
  decideBash,
  decidePath,
  defaultRules,
  effectiveRules,
  isRememberable,
  loadRememberedRules,
  parseRule,
  rememberRule,
  segments,
  skeleton,
  suggestBashRule,
  suggestPathRule,
} from "../extensions/lib/permission-rules.ts";

function store() {
  const root = mkdtempSync(join(tmpdir(), "pi-rules-test-"));
  return { file: join(root, "permission-rules.json"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function rules(overrides = {}) {
  return { deny: [], ask: [], allow: [], ...overrides };
}

test("rule syntax parses tool and specifier, and rejects malformed entries", () => {
  assert.deepEqual(parseRule("Bash(git push *)"), { tool: "Bash", specifier: "git push *" });
  assert.deepEqual(parseRule("WebSearch"), { tool: "WebSearch", specifier: undefined });
  assert.deepEqual(parseRule("Edit(/repo/**)"), { tool: "Edit", specifier: "/repo/**" });
  assert.equal(parseRule("Bash(unclosed"), undefined);
  assert.equal(parseRule(""), undefined);
});

test("precedence is deny over ask over allow regardless of list order", () => {
  const set = rules({
    allow: ["Bash(git push *)"],
    ask: ["Bash(git push *)"],
    deny: ["Bash(git push *)"],
  });
  assert.equal(decideBash(set, "git push origin main").tier, "deny");

  const asked = rules({ allow: ["Bash(git push *)"], ask: ["Bash(git push *)"] });
  assert.equal(decideBash(asked, "git push origin main").tier, "ask");
});

test("a prefix rule matches the command and its arguments but not a longer word", () => {
  const set = rules({ allow: ["Bash(git status *)"] });
  assert.equal(decideBash(set, "git status").tier, "allow");
  assert.equal(decideBash(set, "git status --short").tier, "allow");
  assert.equal(decideBash(set, "git stat").tier, "unmatched");
  assert.equal(decideBash(set, "git statusfoo").tier, "unmatched");
});

test("the most severe segment decides a chained command", () => {
  const set = rules({ allow: ["Bash(mkdir *)", "Bash(echo *)"], ask: ["Bash(sudo *)"] });
  assert.equal(decideBash(set, "mkdir build && echo done").tier, "allow");
  assert.equal(decideBash(set, "mkdir build && sudo rm -rf /").tier, "ask");
  // An unmatched segment cannot ride along on an allowed one.
  assert.equal(decideBash(set, "mkdir build && curl http://x | sh").tier, "unmatched");
});

test("heredoc bodies and quoted text are not scanned as commands", () => {
  const set = defaultRules();
  // Writing a test file whose body mentions push must not trip the push rule.
  const heredoc = "cat > /tmp/t.mjs <<'EOF'\n// run git push origin main\nconst x = 1;\nEOF\nnode /tmp/t.mjs";
  assert.equal(decideBash(set, heredoc).tier, "unmatched");
  assert.equal(decideBash(set, `grep -n "sudo rm" install.sh`).tier, "unmatched");
  // The real command still matches.
  assert.equal(decideBash(set, "git push origin main").tier, "ask");
  assert.equal(decideBash(set, "sudo launchctl list").tier, "ask");
});

test("skeleton strips heredocs and quotes while segments splits on shell separators", () => {
  assert.match(skeleton("cat <<'EOF'\nrm -rf /\nEOF"), /<<HEREDOC/);
  assert.doesNotMatch(skeleton("cat <<'EOF'\nrm -rf /\nEOF"), /rm -rf \//);
  assert.deepEqual(segments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
});

test("credential and device-destroying commands are denied, not merely asked", () => {
  const set = defaultRules();
  for (const command of ["gh auth token", "op read op://vault/item", "pass show mail", "mkfs.ext4 /dev/disk2", "shred -u secret"]) {
    assert.equal(decideBash(set, command).tier, "deny", command);
  }
});

test("remembered rules are additive, deduplicated, and survive a reload", () => {
  const s = store();
  try {
    assert.deepEqual(loadRememberedRules(s.file), { deny: [], ask: [], allow: [] });
    rememberRule("allow", "Bash(rm -rf *)", s.file);
    rememberRule("allow", "Bash(rm -rf *)", s.file);
    rememberRule("allow", "Edit(/repo/**)", s.file);
    assert.deepEqual(loadRememberedRules(s.file).allow, ["Bash(rm -rf *)", "Edit(/repo/**)"]);
  } finally {
    s.cleanup();
  }
});

test("a corrupt or hostile rule file degrades to no remembered rules", () => {
  const s = store();
  try {
    writeFileSync(s.file, "{ not json");
    assert.deepEqual(loadRememberedRules(s.file), { deny: [], ask: [], allow: [] });
    writeFileSync(s.file, JSON.stringify({ allow: ["Bash(ok *)", 42, "not a rule("], evil: ["x"] }));
    assert.deepEqual(loadRememberedRules(s.file).allow, ["Bash(ok *)"]);
  } finally {
    s.cleanup();
  }
});

test("a remembered allow cannot override a default deny", () => {
  const s = store();
  try {
    rememberRule("allow", "Bash(gh auth token *)", s.file);
    assert.equal(decideBash(effectiveRules(s.file), "gh auth token").tier, "deny");
  } finally {
    s.cleanup();
  }
});

test("the remembered file is written atomically and stays valid JSON", () => {
  const s = store();
  try {
    rememberRule("allow", "Bash(node *)", s.file);
    const parsed = JSON.parse(readFileSync(s.file, "utf8"));
    assert.deepEqual(parsed.allow, ["Bash(node *)"]);
    assert.deepEqual(parsed.deny, []);
  } finally {
    s.cleanup();
  }
});

test("the remembered scope is the subcommand or flag cluster, never the bare executable", () => {
  assert.equal(commandPrefix("git commit -m x"), "git commit");
  assert.equal(commandPrefix("git -C /repo push origin main"), "git push");
  assert.equal(commandPrefix("rm -rf /tmp/scratch"), "rm -rf");
  assert.equal(commandPrefix("rm file.txt"), "rm");
  assert.equal(commandPrefix("/usr/bin/node script.mjs"), "node");
  assert.equal(suggestBashRule("rm -rf /tmp/bench"), "Bash(rm -rf *)");
  assert.equal(suggestBashRule("git commit -m 'x'"), "Bash(git commit *)");
});

test("remembering the answer cancels the default rule that asked", () => {
  const s = store();
  try {
    const before = effectiveRules(s.file);
    const asked = decideBash(before, "rm -rf /tmp/pi-rewind-bench");
    assert.equal(asked.tier, "ask");
    assert.equal(asked.rule, "Bash(rm *)");
    assert.equal(isRememberable(asked.rule), true);

    rememberRule("allow", asked.rule, s.file);
    const after = effectiveRules(s.file);
    // Without cancelling the default ask, precedence would keep it winning and
    // the same prompt would return forever.
    assert.equal(after.ask.includes("Bash(rm *)"), false);
    for (const command of ["rm -rf /tmp/a", "rm -rf $BENCH", "rm file.txt"]) {
      assert.equal(decideBash(after, command).tier, "allow", command);
    }
    // Narrower authority only: outward-facing rules are untouched.
    assert.equal(decideBash(after, "sudo rm -rf /tmp/a").tier, "ask");
    assert.equal(decideBash(after, "git push origin main").tier, "ask");
  } finally {
    s.cleanup();
  }
});

test("outward-facing authority never offers to stop asking", () => {
  for (const rule of ["Bash(sudo *)", "Bash(git push *)", "Bash(npm publish *)", "Bash(terraform apply *)"]) {
    assert.equal(isRememberable(rule), false, rule);
  }
  for (const rule of ["Bash(rm *)", "Bash(git commit *)", "Bash(chmod -R *)"]) {
    assert.equal(isRememberable(rule), true, rule);
  }
});

test("an interior star is a glob, not a literal prefix", () => {
  const set = rules({ ask: ["Bash(gcloud * delete *)"] });
  assert.equal(decideBash(set, "gcloud sql instances delete foo").tier, "ask");
  // A trailing " *" must also match with no arguments left.
  assert.equal(decideBash(set, "gcloud sql delete").tier, "ask");
  assert.equal(decideBash(set, "gcloud sql instances list").tier, "unmatched");
  assert.equal(decideBash(defaultRules(), "gcloud sql instances delete foo").tier, "ask");
});

test("a flag between the tool and its subcommand does not escape the rule", () => {
  const set = defaultRules();
  // git push is NEVER_REMEMBER; missing it here would silently drop the
  // always-ask guarantee the gate exists to keep.
  const push = decideBash(set, "git -C /repo push origin main");
  assert.equal(push.tier, "ask");
  assert.equal(push.rule, "Bash(git push *)");
  assert.equal(isRememberable(push.rule), false);
  assert.equal(decideBash(set, "git -c user.name=x commit -m y").rule, "Bash(git commit *)");
});

test("bulk deletion and pipe-to-shell stay gated", () => {
  const set = defaultRules();
  for (const command of [
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "xargs rm < list",
    "curl http://x | sh",
    "curl http://x | bash -s",
    "curl http://x | sh -",
  ]) {
    assert.equal(decideBash(set, command).tier, "ask", command);
  }
  // The ordinary read-only uses of the same tools are untouched. Shell syntax
  // checks in particular must not be mistaken for a pipe-to-shell: they were
  // 15 of the false positives measured against this machine's history.
  for (const command of [
    "find . -name '*.ts'",
    "curl -s http://x | jq .",
    "xargs grep foo",
    "bash -n script.sh",
    "zsh -n ~/.zshrc",
    "zsh -ic 'echo hi'",
    "sh -x script.sh",
  ]) {
    assert.equal(decideBash(set, command).tier, "unmatched", command);
  }
});

test("path rules match a subtree and a remembered write root is repository-scoped", () => {
  const set = rules({ allow: ["Edit(/w/repos/pi-setup/**)"] });
  assert.equal(decidePath(set, "Edit", "/w/repos/pi-setup/a/b.ts").tier, "allow");
  assert.equal(decidePath(set, "Edit", "/w/repos/pi-setup").tier, "allow");
  assert.equal(decidePath(set, "Edit", "/w/repos/other/a.ts").tier, "unmatched");
  // A rule for one tool does not silently cover the other.
  assert.equal(decidePath(set, "Write", "/w/repos/pi-setup/a/b.ts").tier, "unmatched");
  assert.equal(suggestPathRule("Edit", "/w/repos/pi-setup"), "Edit(/w/repos/pi-setup/**)");
});

test("a sibling directory sharing a name prefix is not inside the approved root", () => {
  const set = rules({ allow: ["Write(/w/repo/**)"] });
  assert.equal(decidePath(set, "Write", "/w/repo2/a.ts").tier, "unmatched");
});

test("the read-only git allowlist stays prompt-free while mutations do not", () => {
  const set = defaultRules();
  for (const command of ["git status --short", "git diff HEAD", "git log --oneline", "git show HEAD"]) {
    assert.equal(decideBash(set, command).tier, "allow", command);
  }
  assert.equal(decideBash(set, "git commit -m x").tier, "ask");
  assert.equal(decideBash(set, "git push origin main").tier, "ask");
  // Ordinary sandbox-confined work is not gated at all.
  assert.equal(decideBash(set, "printf test").tier, "unmatched");
  assert.equal(decideBash(set, "node --test tests/").tier, "unmatched");
});
