# Quét sâu Pi → những điểm hay có thể áp dụng vào DeepSeek Harness (DSH)

Nguồn quét (trên máy này):
- Pi cài global: `@earendil-works/pi-coding-agent@0.84.2` (README + ~13k dòng docs, examples, dist/)
- Cấu hình thực chiến: `~/.pi/agent/` (15 extensions, 14 skills, 8 prompt templates) + `~/.pi/agents/` (subagent tự chế)
- Repo liên quan: `~/repos/pi-deepseek-harness` (bridge DSH↔pi)
- DSH checkout: `/Users/user/deepseek-harness/` (v0.1.0-rc.7, ~150 packages, Cordis plugin-everything)

**Lưu ý chiều ý tưởng**: nhiều extension trong `~/.pi` là port *từ DSH sang pi* (spill, repeat-reminder,
compaction-prune, goal, subagent, todos, ask-user, runtime-context, sandbox-bash). Những thứ đó DSH đã có —
báo cáo này chỉ liệt kê chiều ngược lại: cái pi có mà DSH chưa có (hoặc pi làm tốt hơn).

---

## A. Nhóm ưu tiên cao — lấp đúng gap đã xác nhận của DSH

### 1. Session TREE + branch trong một file (pi: session-format v3)
- Pi: mỗi entry có `id`/`parentId` → cả cây branch nằm trong một file JSONL append-only; `/tree` nhảy leaf
  bất kỳ, `/fork` copy nhánh + nạp lại prompt vào editor để sửa, `/clone`, label làm bookmark, không xoá gì.
- DSH: có `ctx.sessions.fork()` với lineage, nhưng **fork không có UI branching** (gap đã flag), log là tuyến tính.
- Áp dụng: thêm `parentId` vào event log (session đã event-sourced nên thuận), UI cây phiên trong Web GUI
  (`packages/session`, `packages/web`), entry-id làm **durable sync cursor** cho `get_entries since` kiểu pi —
  rất hợp với Typert RPC + SSE hiện có.

### 2. Branch summarization khi rời nhánh (pi độc quyền, chưa harness lớn nào có)
- Khi `/tree` chuyển nhánh, pi LLM-summarize nhánh bị bỏ tại common ancestor và tiêm summary vào nhánh mới
  → khám phá thoải mái mà không mất ngữ cảnh.
- Áp dụng: nếu làm mục 1, đây là killer feature đi kèm; DSH đã có compaction seam (`packages/compaction`)
  nên tái dùng được summarizer.

### 3. Workspace checkpoint / rewind (gap DSH: "no workspace checkpoint/undo")
- Nguyên mẫu chạy thật ngay trên máy: `~/.pi/agent/extensions/tree-rewind/` — shadow git repo tách khỏi
  `.git` dự án, checkpoint toàn worktree trước mỗi prompt (đo được 224ms trên linux kernel 95k files),
  DAG shadow phản chiếu cây phiên → worktree là hàm của node đang đứng.
- Áp dụng: port thành plugin DSH (hợp `packages/fs` + session-checkpoint-policy), gắn với mục 1 để
  "rewind hội thoại = rewind file" như Claude Code nhưng branch-aware.

### 4. Cost tracking + cache observability (gap DSH: "no $ cost tracking")
- Pi: mỗi assistant message lưu provider/model/usage/**cost**; footer hiện tokens ↑↓, cache R/W,
  **tỉ lệ cache-hit gần nhất**, cost, context %; `showCacheMissNotices` in cảnh báo khi cache miss lớn;
  pricing model có **tiered pricing** (giá long-context theo `inputTokensAbove`); tool result có field
  `usage` để tool lồng LLM (subagent) roll-up chi phí vào tổng phiên.
- DSH: token-meter chỉ phục vụ compaction pressure.
- Áp dụng: thêm bảng giá vào route/`dsh-llm-pi-ai` (pi-ai đã có catalog giá!), cộng dồn cost per-session,
  hiện trên Web GUI; cho tool `subagent`/`workflow` báo usage lên cha.

### 5. Persistent approval allowlist (gap DSH: "approvals one-shot only")
- Pi (ext `permission-gate.ts`): 3 tầng BLOCK/CONFIRM/ALLOW; "Always allow" lưu **per rule-id** vào
  `permission-gate.json`; phiên non-interactive (subagent) không hỏi được thì **block thẳng kèm lý do**
  bảo agent đưa lệnh cho người dùng — chặt hơn mặc định Claude Code.
- Áp dụng: mở rộng approval seam của DSH thêm outcome "always-for-rule" persist theo `$DSH_HOME`,
  và quy tắc fail-closed có lý do máy-đọc-được cho subagent.

### 6. Secret-guard 2 lớp trước transcript (DSH mới chỉ redact settings)
- Pi ext: (1) chặn read/write path credential; (2) **redact chuỗi dạng secret trong mọi tool result
  TRƯỚC khi ghi transcript và trước khi gửi provider** → secret chưa bao giờ chạm disk/wire.
- Áp dụng: DSH có `tools/post-execute` waterfall — thêm plugin redaction đúng chỗ đó (trước session log);
  dùng chung danh sách redact với spill (pi làm vậy: spill file cũng được scrub).

### 7. `prepareArguments` — shim di trú schema tool (gap DSH: "no session-format migration")
- Pi: hook chạy trước validation để args kiểu cũ trong session resume vẫn qua được schema mới,
  giữ schema public strict. Giải đúng bài toán harness sống lâu.
- Áp dụng: thêm hook tương đương vào tool registry của DSH; đồng thời cân nhắc version+migration
  cho SessionEventMap.

## B. Nhóm nâng cấp subsystem sẵn có

### 8. Compaction: 4 chiêu của pi đáng bổ sung vào `packages/compaction`
- `retainedTail` nhúng thẳng messages được giữ vào entry compaction → compaction = **checkpoint tự chứa**,
  rebuild context không cần walk entries cũ.
- **Overflow-recovery**: gặp lỗi context-overflow thì compact rồi **tự retry turn bị đứt**.
- **Split-turn**: một turn vượt budget thì cắt giữa turn, sinh 2 summary (history + turn-prefix) rồi merge.
- Theo dõi tích luỹ `<read-files>`/`<modified-files>` xuyên các lần compaction; summarizer call
  **tắt prompt-cache write** (prompt one-off không nên chiếm cache).

### 9. Cache-aware deferred tool loading (DSH rất nhiều tools → tốn prompt)
- Pi: `setActiveTools()` additive giữa chừng + map sang protocol native (`tool_reference` Anthropic,
  `tool_search_*` OpenAI) để **giữ nguyên prefix cache**, fallback êm khi model không hỗ trợ.
- Áp dụng: DSH có hàng chục tools (terminal_*, session_*, schedule_*, cordis_*…) — catalog động
  kiểu này giảm mạnh token + cache miss.

### 10. Wire-level hooks cho plugin (`before_provider_headers/request`, `after_provider_response`)
- Case thật trên máy: ext `fast-mode.ts` bật Anthropic fast-mode chỉ bằng chỉnh payload + beta header —
  không sửa core. DSH intercepts ở `agent/request`/`llm/stream` nhưng chưa mở tầng HTTP thô cho plugin.
- Áp dụng: thêm 2-3 event ở adapter layer (`packages/llm`) → mở khoá thử nghiệm provider features
  (fast mode, cache retention, session-affinity headers) bằng plugin thuần.

### 11. models.json "operator tier"
- Đáng lấy: resolve secret bằng **`!command` chạy lúc request** (1Password/Keychain — DSH mới có env-var refs);
  **hot-reload catalog mỗi lần mở /model** (không restart); `thinkingLevelMap` per model; scoped models
  với pattern kèm pinned thinking (`anthropic/*:high`); `modelOverrides` vá model built-in.
- DSH đã dùng `@earendil-works/pi-ai` trong `dsh-llm-pi-ai` nên phần compat matrix hưởng sẵn — phần thiếu
  là UX cấu hình + command-based credentials.

### 12. Model/thinking change là sự kiện theo vị trí nhánh
- Pi ghi `model_change`/`thinking_level_change` như entry trong cây → đổi nhánh là khôi phục đúng model
  của nhánh đó. DSH event-sourced sẵn, chỉ cần định nghĩa event + replay.

### 13. Extension-UI sub-protocol qua RPC
- Pi: dialog của extension (`select/confirm/input/editor`, có timeout tự huỷ) trở thành cặp
  `extension_ui_request/response` → cùng một extension chạy được dưới TUI lẫn frontend RPC bất kỳ.
- Áp dụng: DSH đã có ask_user_question + approval prompts; tổng quát hoá thành API dialog chung cho
  host-plugin (không cần viết ui-* client plugin riêng cho mỗi hỏi-đáp đơn giản).

### 14. Project trust trước khi load config dự án
- Pi: `.pi/settings.json`, extensions/skills/SYSTEM.md của project chỉ load sau quyết định trust
  (lưu `trust.json` theo canonical dir, kế thừa cha; policy tự nó cũng là extension point).
- DSH scan `<project>/.dsh/skills` v.v. — nên có gate tương tự chống supply-chain qua repo clone.

## C. Nhóm ergonomics / UX nhỏ mà chất

15. **Bash mode `!` / `!!`**: lệnh user chạy tay được fold thành message context ở prompt kế tiếp
    ("Ran `ls -la`" + output) — user làm việc trong shell mà model vẫn thấy; `!!` thì ẩn khỏi context.
    Web GUI của DSH có thể thêm ô lệnh tương đương.
16. **Esc khôi phục queue về editor / Alt+Up dequeue**: DSH có steer/followup + inbox rồi; phần "abort
    trả lại message đang xếp hàng vào ô nhập" là chi tiết UX đáng copy.
17. **`AGENTS.override.md`** (thay thế file của đúng thư mục đó, các tầng khác vẫn layer) và
    `APPEND_SYSTEM.md` — quy ước nhỏ, hữu ích cho monorepo.
18. **`withFileMutationQueue(realpath)`**: serialize tool-call song song vào cùng một file — tránh lost
    update khi model gọi edit song song.
19. **/export HTML + /share (gist)**: session thành artifact chia sẻ được; DSH web export tĩnh một phiên.
20. **Truncation contract công khai** cho tool authors (50KB/2000 dòng + helper `truncateHead/Tail`) —
    DSH có output-retention/spill mạnh hơn, nhưng nên export helpers như API công khai cho plugin.
21. **Strict LF-only JSONL framing** trong spec RPC (cảnh báo Node `readline` split U+2028/U+2029) —
    đáng đưa vào spec NDJSON SDK của DSH.
22. **Prompt templates với args bash-style** (`$1`, `${@:2}`, `${1:-default}`) cho slash commands.
23. **Keybindings/themes hot-reload + `keyHint()` tôn trọng remap** — nếu/khi DSH làm TUI.

## D. Điểm triết lý đáng suy ngẫm (không nhất thiết copy)

- Pi đặt cược "core tối giản + extension surface đủ mạnh để mọi feature bị bỏ đều build được ở userland"
  (không MCP, không subagent, không plan-mode built-in — tất cả tồn tại dưới dạng example extension).
  DSH đi hướng ngược (batteries-included nhưng plugin-hoá toàn bộ). Bài học chuyển giao được:
  **mỗi feature core của DSH nên tự hỏi "viết được thành plugin thuần không?"** — pi chứng minh hook
  surface đúng chỗ (tool_call mutable, context rewrite, wire hooks, UI dialogs) là điều kiện đủ.
- "No sandbox by design" của pi thì DSH đã vượt (bwrap/Landlock/Seatbelt thật) — không cần học.
- Pattern **Operations interface** trên từng built-in tool (SSH/micro-VM routing) ≈ capability seam
  của DSH — hai bên hội tụ cùng một ý; DSH đã có E2B provider tương đương Gondolin.

---

## Top 8 khuyến nghị hành động (impact × effort)

| # | Việc | Gap DSH | Effort |
|---|------|---------|--------|
| 1 | Cost tracking + cache-hit observability (mục 4) | ✔ gap flagged | Thấp (pi-ai có sẵn giá) |
| 2 | Persistent approval allowlist per-rule (mục 5) | ✔ gap flagged | Thấp |
| 3 | Secret redaction ở tools/post-execute (mục 6) | mới chỉ redact settings | Thấp |
| 4 | Compaction: overflow-auto-retry + retainedTail (mục 8) | nâng cấp seam sẵn có | Vừa |
| 5 | Wire-level provider hooks (mục 10) | chưa có | Vừa |
| 6 | Session tree + branch UI + entry-id cursor (mục 1) | ✔ fork-no-UI gap | Cao |
| 7 | Tree-rewind shadow-git checkpoint (mục 3) | ✔ gap flagged | Cao (có prototype ~/.pi) |
| 8 | Deferred/cache-aware tool loading (mục 9) | chưa có | Vừa–cao |

Bonus nhanh-gọn: `prepareArguments` shim (7), project trust gate (14), `!` bash-fold trong Web GUI (15),
LF-framing spec cho SDK (21).
