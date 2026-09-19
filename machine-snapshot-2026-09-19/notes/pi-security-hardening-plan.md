# Kế hoạch hardening Pi tối giản

> **Trạng thái:** đã triển khai và push đầy đủ; baseline tag `pre-security-hardening-20260822`.
> **Lưu ý hiện tại:** các mô tả subagent tmux/role/project-artifact bên dưới là bằng chứng lịch sử của phase hardening đã ship. Runtime hiện dùng native Pi RPC v2, bốn tools `subagent`/`send_message`/`list_agents`/`interrupt_agent`, ba profiles `explore`/`web`/`work`, `--no-approve` cho mọi child, và private sessions dưới `~/.pi/agent/subagents/<parent>/<child>/`.
> **Phạm vi:** Pi 0.84.2 trên macOS, workflow local có người giám sát.
> **Nguyên tắc:** dùng Pi extension API, Node.js và Seatbelt đang có; không dựng platform mới.

## 1. Kết luận thiết kế

Giữ ba trách nhiệm, nhưng làm ranh giới rõ hơn:

```text
permission-gate  → một owner của mọi quyết định pre-execution: deny / ask / allow
secret-guard     → redact known secret shapes ở final tool result
sandbox-bash     → OS enforcement cho Bash file effects
```

`spill` tiếp tục giữ output lớn ngoài context. Project trust, tree-rewind và AGENTS.md giữ
vai trò hiện tại; chúng không được gọi là sandbox.

Chỉ thêm **một helper** `extensions/lib/path-policy.ts` cho canonical path + containment +
sensitive/protected path classification. Không thêm dependency.

## 2. Threat model

### Bảo vệ

- Agent hợp tác nhưng có thể gọi nhầm command/path.
- Repo tương đối tin cậy, user đang theo dõi TUI.
- Chặn deterministic known credential paths.
- Hỏi trước destructive/external action phổ biến.
- Chặn Bash file-write ngoài workspace bằng Seatbelt.
- Giảm rò known secret trong final tool result/spill.
- Giữ session/artifact riêng tư với local account khác.

### Không bảo vệ

- Prompt injection/model ác ý chủ động obfuscate shell.
- Arbitrary read + network exfiltration trong host process.
- Malicious project/global extension hoặc package.
- Hardlink/FUSE/kernel tricks và process cùng UID/root.
- DLP tổng quát, covert channels, image/binary secret.
- User-run `!`/`!!`.
- Unattended work hoặc repo thực sự không tin cậy.

Các trường hợp ngoài phạm vi phải dùng whole-process isolation theo Pi docs:
container, VM, Gondolin hoặc policy sandbox với mount/credential/network tối thiểu.

Nguồn: `pi-coding-agent/docs/security.md:31-53` và `containerization.md:3-17`.

## 3. Nguồn tham khảo và phần được học

### Pi native

Dùng trực tiếp:

- project trust;
- `tool_call` block/mutate (handler error fail-closed);
- `tool_result` transform (best-effort/fail-open);
- `ctx.ui.confirm`;
- `createBashToolDefinition` override;
- `session_start`/`ctx.cwd`;
- CLI strict tool allowlist `--tools` cho run đặc biệt.

Không giả định native Pi có sandbox: docs nói rõ extensions chạy cùng quyền user.

### DSH source

Chỉ mượn invariant nhỏ:

- policy/root resolve theo **từng call**, không cache startup cwd;
- `realpathSync.native` và writable-root derivation dùng chung;
- write/edit trusted fence dùng fresh canonical target;
- runner/sandbox availability failure được tách khỏi command result;
- spill private storage, fail-open nhưng không vi phạm output contract.

Không port Cordis service/plugin/package architecture, Landlock/bwrap/Windows ACL, hook
protocol codec, durable policy events hoặc credential broker.

Nguồn chính:

- `packages/sandbox/sandbox/src/roots.ts`
- `packages/sandbox/sandbox-local/src/profiles.ts`
- `packages/fs/fs-sandbox/src/{containment,index}.ts`
- `packages/hooks/hook-protocol/src/merge.ts`
- `packages/spill/spill-{policy,local}/src/`

### Claude Code official docs

Học hành vi:

- deny > ask > allow;
- approval phải hiện chính xác command/path và phạm vi;
- saved approval chỉ khi phạm vi có thể mô tả chính xác;
- sandbox và permission là hai lớp khác nhau;
- filesystem read/write và network là hai boundary độc lập;
- unsandboxed retry chỉ sau sandbox denial — dùng làm benchmark, nhưng plan tối giản chủ động không copy escape hatch này;
- project trust không giải quyết prompt injection.

Không copy:

- shell AST/compound-command parser;
- network proxy/domain rules;
- credential mask/sentinel/TLS injection;
- enterprise managed settings hoặc model risk explainer.

Official sources:

- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/security

## 4. Những gì chủ động không xây

- Không shell parser/AST.
- Không network proxy/domain allowlist.
- Không credential masking/broker.
- Không DLP/entropy scanner hoặc mở rộng regex vô hạn.
- Không persistent permission rule engine.
- Không daemon/state service.
- Không override toàn bộ filesystem tool implementation.
- Không biến tree-rewind thành security mechanism.
- Không hứa prompt-injection-safe.
- Không tự động cài container/Gondolin cho workflow bình thường.

Network của model-run Bash vẫn unrestricted trong host mode và phải được ghi rõ. Nếu cần
network isolation, đó là một deployment mode khác, không phải patch thêm vào extension này.

## 5. Target architecture

### 5.1 Một pre-execution policy owner

`permission-gate.ts` trở thành owner duy nhất của `tool_call` decision:

```text
canonicalize input
  → hard deny sensitive path/command
  → ask destructive/outside/protected operation
  → allow
```

`secret-guard.ts` bỏ phần `tool_call`; chỉ giữ `tool_result` redaction. Điều này loại thứ tự
handler mơ hồ và tạo precedence cố định `deny > ask > allow` mà không cần permission engine.

### 5.2 Một canonical path helper

`lib/path-policy.ts` chỉ có pure functions:

- expand `~`, resolve absolute;
- existing target: `realpathSync.native`;
- target chưa tồn tại: realpath deepest existing ancestor rồi nối missing suffix;
- `isUnder(target, root)` với path-separator boundary;
- classify sensitive credential paths (hard deny cho read/write/edit) và protected write paths;
- detect unsafe broad workspace root (`/`, HOME, ancestor của HOME).

Helper là policy check trong trusted extension code, không được gọi là kernel sandbox.
Hardlink là residual gap đã ghi nhận; không scan inode toàn máy.

### 5.3 Bash enforcement

`sandbox-bash.ts` vẫn là owner duy nhất của tool `bash`:

- tạo base tool/profile theo `ctx.cwd` cho **mỗi call**;
- explicit workdir nếu sau này support phải resolve dưới same call root;
- `shellCommandPrefix` được đưa vào command bên trong Seatbelt hoặc bị từ chối khi sandbox
  active; không chạy prefix bên ngoài;
- Seatbelt tiếp tục deny `file-write*` ngoài workspace/temp;
- thêm `file-read*` deny cho fixed credential roots/files;
- network/read khác vẫn unrestricted và được mô tả trung thực;
- runner failure và policy denial được phân loại riêng.

### 5.4 Approval model tối giản

Không xây repo/session persistent permission scopes. Chỉ có:

```text
Allow once
Deny
```

Dialog phải hiện:

- exact command hoặc requested path;
- canonical target nếu khác;
- cwd/workspace;
- lý do rule match.

Xóa `permission-gate.json`/`Always allow`. Non-UI và subagent tiếp tục fail-closed.

Bỏ hoàn toàn `sandbox_permissions`/unsandboxed escalation khỏi tool schema và execute path.
Khi Seatbelt chặn, Pi báo exact command + limitation; user tự quyết định có chạy command đó
ngoài agent hay không. Cách này tránh một retry vô tình mở luôn sensitive-read và
protected-write, đồng thời không cần denial ticket/state.

## 6. Kế hoạch triển khai

Mỗi phase là một commit độc lập và phải pass gate trước khi sang phase kế.

### Phase 0 — Baseline, docs và privacy-at-rest

**File/config:**

- One-time `chmod 700 ~/.pi` để descendants không thể bị local user khác traverse.
- One-time chmod mọi project `.pi/agents`/agent dir hiện có về `0700`; trong
  `subagent.ts`, `mkdir` rồi explicit `chmod 0700` cho root và từng agent dir để sửa cả
  directory đã tồn tại.
- Scrub backups nếu còn dùng phải mode `0600`.
- Cập nhật README và `pi-setup-tieng-viet.md` với threat model thật.

Không thêm global `umask`: nó có side effect lên mọi file process/child tạo. Parent dir 0700
đã bảo vệ global sessions/rewind; subagent dirs cần mode explicit vì nằm trong project.

**Acceptance:**

- `~/.pi` và `.pi/agents/<id>` không traverse bởi group/other.
- Session, brief, output, registry và rewind dưới private parent.
- Pi startup/reload/subagent smoke không đổi hành vi.

**Rollback:** permission mode chặt hơn không cần rollback; source change subagent revert được.

### Phase 1 — Canonical path + permission simplification

**New:** `extensions/lib/path-policy.ts`.

**`permission-gate.ts`:**

- nhận toàn bộ pre-execution hard deny/ask từ secret guard;
- canonicalize `read`, `write`, `edit` path;
- hard deny known credential path/command;
- write/edit ngoài canonical workspace → exact confirm;
- protected writes → exact confirm: global/project agent config, shell startup, `.git/config`,
  `.git/hooks`;
- unsafe broad cwd (HOME/root) → mọi non-temp write/edit hỏi;
- dùng `ctx.ui.confirm`, chỉ Allow once/Deny;
- bỏ store và `Always allow`.

**`secret-guard.ts`:**

- chỉ giữ final text redaction;
- sửa claim: known-pattern best effort, không bảo vệ raw streaming/temp/binary.

**Không làm:** shell parser; command regex vẫn chỉ là accident detection.

**Acceptance tests:**

- native `read/write/edit` trực tiếp vào `.env`/credential path bị hard deny;
- symlink alias tới fake credential bị deny; case alias chỉ chạy trên fixture volume được
  detect là case-insensitive, nếu không thì skip có lý do;
- write/edit qua symlink ra sibling hiện exact requested + canonical target và hỏi;
- new path canonicalize qua deepest existing parent;
- sibling-prefix `/work2` không được coi dưới `/work`;
- normal workspace read/write/edit không prompt;
- broad HOME cwd write phải hỏi;
- non-UI/subagent ask trở thành deny;
- không còn `permission-gate.json`/Always option.

**Residual:** hardlink alias và deliberate shell obfuscation không được giải quyết.

### Phase 2 — Bash policy theo từng call

**`sandbox-bash.ts` + `lib/seatbelt.ts`:**

- resolve policy/profile từ `ctx.cwd` mỗi execute, không startup `process.cwd()`;
- create base Bash tool với same call cwd;
- đưa command prefix vào trong confined command hoặc reject config;
- add fixed sensitive-read denies: Pi auth store, SSH/AWS/gcloud/kube/GitHub credential
  files, netrc/npmrc/pgpass, project root `.env*` hiện có;
- protected config write deny ngay cả khi cwd rộng;
- giữ workspace + `/tmp` + OS temp write roots để tương thích;
- chỉ nhận biết `sandbox-unavailable` khi launcher/profile fail rõ ràng; mọi exit khác là
  command result bình thường. Denial marker là diagnostic best-effort, không phải protocol;
- bỏ `sandbox_permissions` và wording nói rõ “Bash file-write + sensitive-read confinement;
  network unrestricted; denial không có automatic unsandboxed retry”.

**Acceptance tests:**

- session/cwd A và B dùng đúng root riêng;
- workspace write pass, sibling write deny;
- fake credential direct, variable và symlink read bị Seatbelt deny;
- network test chứng minh vẫn available và docs nói đúng;
- prefix không tạo file ngoài sandbox;
- sandbox runner/profile failure được báo `sandbox-unavailable`;
- outside/protected side effect thực sự không xảy ra; test không phụ thuộc text classifier;
- tool schema và execute path không còn `sandbox_permissions`/`justification`.

Real Seatbelt e2e phải chạy từ process không nằm trong sandbox khác; nested
`sandbox_apply: Operation not permitted` là runner failure, không phải test policy.

### Phase 3 — Spill và incident utility

**`spill.ts`:**

- vẫn redact trước write;
- nếu core raw file >8 MiB hoặc không đọc/copy được: không expose raw locator;
- preview chỉ lấy từ inline text đã có trong `tool_result`, rồi redact/truncate; nếu không có
  inline text thì chỉ trả notice “full output withheld because it could not be stored safely”;
- sau successful redacted copy, xóa raw core file best-effort nếu ownership/lifecycle cho phép;
- replacement budget tính cả locator/notice; `read` vẫn không spill lại.

**`scrub-session-secrets.sh`:**

- giữ như incident utility, không tính là prevention layer;
- backup mode `0600`, cảnh báo rotate credential;
- document backup cleanup; không gọi script tự động.

**Acceptance tests:**

- normal large output có redacted private file + bounded preview;
- >8 MiB/read failure không lộ raw path;
- storage failure không biến successful tool thành error;
- fake token không xuất hiện trong spill/preview;
- backups luôn 0600.

Không mở rộng thành generic DLP. Pattern additions là maintenance riêng.

### Phase 4 — Subagent truthfulness, không process sandbox mới

**`subagent.ts`:**

- `web-researcher`: luôn `--no-context-files --no-approve`; không claim đây là process
  isolation hoặc rằng brief là context duy nhất;
- giữ tool allowlists, depth cap và non-UI fail-closed;
- docs/comments đổi từ “no filesystem/network access” sang “model không được cấp file/web
  tool”; không gọi đây là process isolation;
- giữ `implementer` nhưng document Bash network vẫn available; user phải chọn mode có giám sát.

Không tắt implementer trong phase tối thiểu: main Pi cũng có cùng host authority; xóa role
không tạo boundary và làm mất workflow. Với untrusted/unattended work, không dùng host
subagent — chạy whole Pi isolated.

**Acceptance tests:**

- web role command có `--no-context-files --no-approve`;
- researcher/reviewer không có write/bash tool;
- web role không có read/write/bash tool; context files bị disable và project resources
  không được approve;
- implementer warning/brief nêu network/host trust;
- regression test xác nhận artifacts vẫn nằm dưới 0700 sau spawn/resume;
- code-review workflow vẫn pass.

### Phase 5 — Documentation, migration và release gate

- Update extension headers: exact protection + known limitations.
- Update `pi-setup` README và tài liệu tiếng Việt.
- Add focused security test command dùng Node built-ins; không thêm test framework.
- Run Pi smoke trên Claude + GPT, `git diff --check`, focused tests và macOS e2e.
- Sync live ↔ `pi-setup`, commit theo phase, push sau mỗi gate pass.

## 7. Test matrix tối thiểu

| Surface | Positive | Negative/bypass | Failure path |
|---|---|---|---|
| Path policy | normal workspace | symlink, conditional case alias, sibling prefix, missing suffix | lstat/realpath permission error fails closed |
| Permission | Allow once exact | deny, non-UI, broad cwd | UI unavailable → deny |
| Secret deny | fake direct credential | alias/variable/conditional case | unknown pattern documented residual |
| Seatbelt write | workspace/temp | sibling/protected config | launcher/profile unavailable |
| Seatbelt read | normal source | fake sensitive direct/symlink | nested sandbox runner error |
| Spill | redacted stored output | >8 MiB/raw fallback | inline preview or notice only; no raw locator |
| Subagent | expected role tools/flags | forbidden tool absent | context files disabled; project not approved |
| Permissions at rest | owner can read | group/other cannot traverse | migration idempotent |

## 8. Migration

1. Backup current `pi-setup` commit/tag.
2. Phase 0 chmod existing roots; record old mode only for audit.
3. Remove/ignore `~/.pi/agent/permission-gate.json` when Phase 1 lands.
4. `/reload` after each extension phase.
5. Run tests in fake fixtures only; never use real credential paths/content.
6. Use two real projects: normal cwd và `/tmp` fixture; never test from HOME.

## 9. Rollback

- Mỗi phase một commit, revert độc lập.
- Nếu canonical policy breaks valid workflow: revert Phase 1; no data migration except obsolete
  permission store.
- Nếu Seatbelt breaks tools: revert Phase 2 only; keep path/permission fixes.
- Nếu spill causes missing diagnostics: revert Phase 3; raw fallback risk returns and must be
  documented.
- Permission chmod không cần nới lại; owner Pi vẫn hoạt động.
- Never disable all guards as a troubleshooting shortcut; identify the failing phase.

## 10. Deferred decisions

### Network deny

Không nằm trong update tối thiểu. Claude Code có proxy/domain approval; copy đúng cần proxy,
parser và lifecycle vượt phạm vi. Seatbelt `deny network*` on/off có thể là một phase riêng
sau này, nhưng dễ phá localhost tests, package managers và git. Khi cần confidentiality với
repo không tin cậy, dùng whole-process isolation.

### Credential masking

Không làm. Claude Code sentinel/proxy/TLS/AWS re-signing là hệ thống lớn. Pi local chỉ deny,
unset và redact best-effort.

### Tree-rewind hardening

Không trộn vào plan này. Tree-rewind là recovery subsystem riêng; private parent mode từ
Phase 0 giúp at-rest. Persisted-index validation/TOCTOU cần plan riêng trong repo đó.

### Presenter privacy

Không đổi default trong plan guard/permission/sandbox vì đây là lựa chọn sản phẩm đã được
user yêu cầu. Tài liệu phải nêu rõ full answer được gửi sang OpenAI thứ hai; `/present off`
dùng cho session nhạy cảm.

## 11. Gate phê duyệt implementation

Plan được xem là đủ đơn giản nếu:

- chỉ thêm một helper;
- không thêm dependency/daemon/service;
- không có shell parser/network proxy/persistent permission engine;
- mỗi phase có test và rollback độc lập;
- docs dùng đúng cụm “accident-resistant local setup”, không “secure against prompt
  injection”.

## 12. Research và review evidence

Plan dựa trên bốn audit độc lập:

- Pi 0.84.2 native APIs/docs/source;
- DSH sandbox/fs/approval/spill source + tests;
- Claude Code official permissions/sandbox/security docs;
- simplification review theo threat model local supervised.

GPT-5.6 Sol gate đầu trả `REVISE` vì escalation unsandboxed phá sensitive-read/protected-
write, denial classifier không đáng tin, subagent/context claims quá mạnh và một số test
không khả thi. Plan đã bỏ escalation, hạ classifier thành diagnostic, sửa scope sensitive
path, mode migration, conditional case test, spill inline-preview và subagent assertions.
Gate cuối trả `APPROVE`.

## 13. Implementation commits

| Phase | Commit |
|---|---|
| P0 private artifacts | `cdee648` |
| P1 canonical path + permission | `635ba4c` |
| P2 per-call Bash confinement | `95c182b` |
| P3 safe spill fallback | `929f64f` |
| P4 subagent trust claims/flags | `3caf8b3` |
| P5 docs, backup classification, final tests | `298328e` |

Tất cả commit đã push lên `duy-tung/pi-setup`.
