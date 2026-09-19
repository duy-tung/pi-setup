# Pi setup — runbook vận hành và khôi phục

> **Nguồn sự thật:** public repo `duy-tung/pi-setup`.
>
> **License:** chưa cấp root license; public visibility không tự cấp quyền reuse. Bundled component
> giữ license notice riêng.
>
> **Nền tảng được hỗ trợ:** macOS.
>
> **Mục tiêu bảo mật:** giảm tai nạn trong workflow local có người giám sát; không chống
> hostile code hoặc prompt injection.

Bản hiện tại đã chuyển sang package; các pin bổ sung và thay đổi API nằm trong
[runbook migration](./package-migration.md).

Tài liệu này vận hành Pi trên máy. Khi tạo repository phần mềm mới, dùng thêm
[guideline setup dự án mới](./new-project-setup-tieng-viet.md).

## 1. Cài trên máy Mac mới

Prerequisite: Apple Command Line Tools và Homebrew đã cài (`xcode-select -p`,
`brew --version`); nếu thiếu, dùng hướng dẫn chính thức tại `https://brew.sh/`. Sau đó:

```bash
brew install gh mise neovim
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
git clone https://github.com/duy-tung/pi-setup.git ~/repos/pi-setup
cd ~/repos/pi-setup
./install.sh
```

Public clone không cần GitHub login. Chạy `gh auth login` trước thao tác authenticated như tạo repo
hoặc push.

Installer sẽ:

1. pin Node `24.15.0` trong global mise config;
2. set global `PI_CACHE_RETENTION=long`;
3. set global `PI_ANTHROPIC_OAUTH_REWRITE_MODE=technical-safe`;
4. cài exact `@earendil-works/pi-coding-agent@0.85.1`;
5. backup rồi áp dụng tám resource được quản lý;
6. cài/reconcile ba package đã pin;
7. chạy test, tree-rewind backend suite và no-cost offline startup smoke.

Sau đó mở `pi` và dùng `/login` cho Anthropic và Codex. Không copy credentials qua Git.
Trust decision cũng phải tạo lại theo từng project.

`~/.pi` và `~/.pi/agent` phải là directory thật, không phải symlink. Installer từ chối
symlink root trước mọi thay đổi để không ghi nhầm sang một cây khác. Legacy alias
`~/.Claude Code -> ~/.pi` trên máy cũ không được bootstrap lại; OAuth fork tạo narrow
`~/.Claude Code/agent` alias khi cần trên cài đặt mới.

## 2. Thành phần được pin

| Thành phần | Pin |
|---|---|
| Node | `24.15.0` qua mise |
| Pi | `@earendil-works/pi-coding-agent@0.85.1` |
| Anthropic OAuth/cache fork | `git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2` |
| Web search | `npm:pi-web-search@1.4.0` + `patches/pi-web-search-oauth-system.patch` |
| Context7 | `npm:@upstash/context7-pi@0.1.2`; tools, `/c7-docs`, and the on-demand `context7-docs` skill |
| Hỏi người dùng | `npm:@juicesharp/rpiv-ask-user-question@2.9.0` |
| Todo | `npm:@juicesharp/rpiv-todo@2.9.0` |
| Subagents | `npm:@tintinweb/pi-subagents@0.19.0` + patch truy vấn activity cho rewind |
| Background jobs | `npm:pi-background-tasks@2.5.0`; chỉ nạp entrypoint background-tasks ở phiên chính |
| Zentui | `npm:pi-zentui@0.22.3`; ô nhập Accent Rail gọn, messages framed, Footer Native giữ statusline custom |
| Advisor | `npm:@juicesharp/rpiv-advisor@2.9.0`; cấu hình riêng ngoài repo |
| Themes | `npm:@firstpick/pi-themes-bundle@0.1.6`; cung cấp `catppuccin-mocha` |
| tree-rewind | bundled package `extensions/tree-rewind/`, provenance `65fa4fa` |

### Patch cho package đã publish

Package publish nào cần sửa source tại chỗ thì để unified diff trong `patches/`.
`install.sh` apply sau bước reconcile package, `doctor.sh` verify checksum post-image của
file đã patch — cài lại, bump version hay sửa tay làm mất patch đều fail rõ ràng thay vì
âm thầm regress.

Patch OAuth là `patches/pi-web-search-oauth-system.patch` (vẫn cần trên 1.4.0).
Ngoài ra có patch activity của pi-subagents để tích hợp rewind. `pi-web-search` gọi thẳng
`/v1/messages` cho `web_search` native của Anthropic nhưng không gửi field `system`. Token
OAuth Claude Pro/Max chỉ được chấp nhận khi system block đầu tiên là identity Claude Code;
thiếu nó Anthropic trả `429 rate_limit_error` với message `"Error"` chung chung và không có
header `anthropic-ratelimit-*` — nhìn y hệt hết quota nhưng thực chất là bị từ chối. Patch
thêm identity cho OAuth và cập nhật User-Agent tìm kiếm lên Claude Code 2.1.261.
Tool Anthropic dùng `web_search_20260318`, mặc định dynamic filtering và trả đủ response.
Nếu code execution bị giới hạn/unavailable trước khi search chạy, package thử direct search
một lần với cùng version và báo rõ fallback. Không chuyển mode để thử lại lỗi quota search.
`pause_turn` được tiếp tục với nguyên content mã hóa/caller/signature/container, tối đa
bốn request; stream thiếu đoạn kết hoặc hết lượt tiếp tục sẽ báo lỗi. Cách xác thực API key
giữ nguyên, Codex vẫn dùng `web_search`. Chưa báo upstream.

`settings.json` gọi npm qua:

```text
mise --no-config exec node@24.15.0 -- npm
```

`--no-config` tránh phụ thuộc vào mise config/trust của project nhưng vẫn giữ package cwd mà
Pi truyền cho `npm install`; dùng `-C /` ở đây sẽ làm npm chạy nhầm tại `/`. Repo có `mise.toml`
để mô tả pin, nhưng installer không cần trust file đó để bootstrap. Transaction backup tôn
trọng `MISE_GLOBAL_CONFIG_FILE` khi user override global config path.

`defaultTools` pin exact `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Ba dedicated
read-only tools làm Manual/Plan search được mà không cần Bash; PowerShell không active trên
setup macOS này. Tradeoff là thêm ba tool schema vào model context.

Context7 loads without a resource filter: both tools, `/c7-docs`, and the `context7-docs`
skill are enabled. Its description is available in the system prompt; full skill instructions
load on demand for library documentation tasks.

OAuth fork vẫn là dependency GitHub ngoài repo và được fetch theo tag cố định. “Một repo” ở
đây nghĩa là chỉ cần clone một private setup repo; không vendor toàn bộ third-party packages.
Đây là exact top-level pins, không phải hermetic dependency lock: transitive npm versions vẫn
có thể đổi trong range package upstream cho phép. Doctor không hash toàn bộ installed bytes.
OAuth v0.3.2 honors request-body/tool-choice hooks, merge required betas nhưng loại
fine-grained tool streaming, và ghi đúng returned fallback model cùng pricing của nó.
Setup pin `PI_ANTHROPIC_OAUTH_REWRITE_MODE=technical-safe`: standalone identity `Pi` vẫn có
thể thành `Claude Code` theo yêu cầu OAuth, nhưng `.pi`, `pi-setup` và ordinary path được giữ
nguyên. Provider vẫn loại paragraph chứa fixed Pi-identity anchors trước bước regex; mode này
không thay behavior riêng đó. Narrow `~/.Claude Code/agent` alias chỉ còn là fallback. Pi
process đang mở phải đóng/mở lại để nhận global env mới; `/reload` không đủ.

## 3. Phạm vi repo và dữ liệu private

Tám path installer quản lý nằm trong `scripts/managed-paths.txt`:

```text
AGENTS.md
settings.json
zentui.json
scrub-session-secrets.sh
extensions
skills
prompts
agents
```

`agents/` chứa bốn định nghĩa subagent (Explore, Plan, general-purpose, final-reviewer).
Model/effort của final reviewer nằm trong `agents/final-reviewer.md`; cấu hình advisor nằm
ngoài repo ở `~/.config/rpiv-advisor/advisor.json`. Model mặc định của phiên chính là
`openai-codex/gpt-6-astra` thinking `high`, Fable 5.1 `medium`, theme `catppuccin-mocha`;
`/fast` bật thủ công.

Root `AGENTS.override.md` chỉ dành cho source repo và không nằm trong allowlist. Nó ngăn Pi
load cùng policy hai lần từ global `~/.pi/agent/AGENTS.md` và tracked `AGENTS.md`; máy bootstrap
chưa có global copy được chỉ dẫn đọc tracked source đầy đủ. Installer không copy override.

Không bao giờ đưa vào repo hoặc thay thế khi cài:

- `auth.json` và provider credentials;
- `sessions/`, RPC child sessions;
- `trust.json`;
- cache và model catalog;
- spill artifacts, rewind shadow stores và logs.

Hai configured package stores là ngoại lệ runtime duy nhất: full install có thể reconcile chúng,
nhưng move before-image vào transaction và restore nếu reconciliation/doctor lỗi.

`.gitignore` là lớp phòng thủ phụ. `scripts/audit-repo.mjs` còn từ chối symlink, absolute
home path theo máy, credential-shaped content/file và runtime/generated directory lồng bên
trong managed resources.

Backup config bị thay thế nằm ở:

```text
~/.local/state/pi-setup/backups/<UTC timestamp>-<pid>/
```

Backup này chỉ chứa managed config cũ, không chứa auth/session/runtime state. Full install
còn giữ transaction tạm cho global mise config, Pi version và configured package stores.
Normal error/catchable signal restore chúng; prior Pi version khác được reinstall từ npm chứ
không byte-restore. Một Node download chưa được select có thể còn như cache. Install và sync
dùng chung fail-closed operation lock. SIGKILL/power loss có thể để lại lock/transaction; chỉ
xóa exact lock sau khi xác nhận không còn process, rồi dùng before-image để recovery. Nếu
rollback thường không hoàn chỉnh, cảnh báo `CRITICAL` giữ lại mọi artifact cần thiết.

## 4. Dùng Pi hằng ngày

Từ migration tháng 9/2026, Pi dùng Bash/file tools với quyền host thông thường.
Permission gate, các mode Auto/Manual/Plan/Bypass custom và Seatbelt wrapper đã bỏ.
Project trust của Pi vẫn quyết định việc nạp tài nguyên dự án.

- `ask_user_question`: hỏi lựa chọn, preview, câu trả lời tự do.
- `todo`, `/todos`: task có ID và dependency.
- `Agent`, `get_subagent_result`, `steer_subagent`, `/agents`: điều phối agent.
- `bg_run`, `/jobs`, `bg_logs`, `bg_kill`: shell job chạy nền.
- `/goal`, `/rewind`, `/limits`, `/fast`: các tiện ích custom được giữ.
- `/fast on|off|status`: requests `service_tier: "priority"` only on OpenAI/Codex APIs;
  Anthropic and other providers are unchanged. Default off unless `PI_FAST_MODE=1`.
  The badge indicates a request, not confirmed service. Pricing/credit usage and availability
  depend on model/account. `off` restores provider defaults; reload resets the session toggle.
  Switching to an unsupported provider suspends the override; switching back resumes it.
- Statusline và `/limits` tự theo provider/model đang chọn: quota Anthropic hoặc Codex,
  context capacity thực tế (ví dụ Astra 272K), phần trăm đã dùng và thời gian reset.
  Dấu `*` báo số chưa được credential hiện tại xác nhận: hoặc refresh lỗi nên giữ số của
  lần đọc thành công trước, hoặc số được đọc dưới credential khác; API key không có quota
  subscription hiện `n/a`. Cache không chứa token: Codex tách theo tài khoản, Anthropic
  tách theo provider vì token OAuth xoay mỗi giờ và không định danh tài khoản — đổi model
  giữ lại window toàn tài khoản và chỉ bỏ bucket riêng của model cũ. Poll Anthropic gửi
  `user-agent: claude-code/<version>` vì endpoint quota chặn theo tên agent; gặp 429 thì
  chờ cố định 3 phút thay vì leo thang backoff.
- `/model`, `/thinking`, `/review`, `/grill`, `/handoff`, `/teach`, `/wait-what`: tiếp tục dùng.

Pi tự thực hiện các bước thuộc yêu cầu, kể cả ngoài cwd; hỏi khi thiếu quyết định quan trọng
hoặc hành động vượt phạm vi đã giao. Mở ở project giúp rewind có phạm vi checkpoint rõ ràng,
nhưng không còn giới hạn quyền truy cập máy theo workspace.

Xem [chi tiết migration và rollback](./package-migration.md).

## 5. Subagent

Subagent dùng package `@tintinweb/pi-subagents@0.19.0`: background/foreground,
steering/resume, FleetView, workflow, scheduling và worktree. Không còn ba profile OS-confined
cũ hoặc khóa một work child. Khi review, yêu cầu agent chỉ báo cáo; đây là chỉ dẫn công việc,
không phải bảo đảm sandbox. Không tự tạo lịch chạy nếu user chưa yêu cầu.

Chọn `isolation: "worktree"` khi cần tách thay đổi; package có thể tự commit trên branch
của child. Dữ liệu child cũ còn trong lịch sử, không resume bằng ID cũ qua package mới.

Present and its private RPC helpers have been removed. Use `/wait-what` for an on-demand
explanation instead of automatically sending answers to a second model. Historical Present
entries remain untouched; their recorded costs still count in the footer, without a separate
presentation-token segment.

## 6. Anthropic cache

Với `PI_CACHE_RETENTION=long`, fork dùng TTL một giờ. Conversation thành công có prompt từ
10K tokens có thể ping cache ở phút 55, mặc định tối đa sáu lần. Coverage lý tưởng khoảng
390 phút nếu process còn sống, máy không sleep và provider xác nhận cache read.

Keepalive là request ẩn, không nằm trong transcript/footer cost. Qua đêm nên dùng `/compact`,
`/handoff` hoặc session mới. Dòng `Cache miss after … idle` chỉ so visible request timestamps,
không biết hidden ping. Với `showCacheMissNotices: true`, Pi 0.84.3 còn hiển thị usage riêng
của compaction và branch summary; không cần extension notice thứ hai.

Debug tạm:

```bash
PI_CACHE_KEEPALIVE_DEBUG=1 pi
```

Log ở `~/.pi/agent/cache/cache-keepalive.log`; tắt debug sau khi điều tra.

## 7. Giới hạn còn lại

Không còn permission/sandbox custom. Secret redaction chỉ xử lý một số mẫu trong output,
không ngăn truy cập host và không bảo đảm che mọi secret.

Rewind vẫn checkpoint project và file ngoài project được write/edit nêu rõ. Trước restore/undo,
nó kiểm tra agent/workflow/job còn chạy và yêu cầu chờ hoặc dừng chúng qua UI package.
Đây là kiểm tra trong một Pi session, không khóa filesystem toàn máy; checkpoint cha cũng
không tự bao phủ worktree child hay mọi shell write ngoài project.

Goal giữ cơ chế tự tiếp tục và nhường lượt đã có follow-up chờ sẵn. Runtime context giữ
snapshot mới nhất và loại permission snapshot cũ khỏi context gửi model, không sửa transcript.
Các cơ chế kiểm tra blob, type change, undo và lock của rewind được giữ. Rewind chỉ restore
đúng user entry có checkpoint (không lùi về tổ tiên), giữ store khi project tạm biến mất,
đọc preview có giới hạn và không theo symlink, và ghi index công khai theo dạng base/delta
có thể replay. Khi Pi tắt, rewind đóng nhận việc mới, hủy lock đang chờ/cold prime, drain
trọn các job backend đã nhận rồi mới nhả lease; không cài handler signal/exit trong Pi.

Compaction dùng cơ chế chuẩn của Pi; `compaction-prune.ts` đã được gỡ vì Pi 0.85.1 tự cắt
tool result còn 2.000 ký tự khi tóm tắt.

## 8. Áp dụng và capture thay đổi

Sau khi sửa repo:

```bash
cd ~/repos/pi-setup
./install.sh --config-only
# rồi trong Pi đang chạy:
/reload
```

Dùng full `./install.sh` nếu đổi runtime/package pin. Chỉ verify:

```bash
./doctor.sh
```

Nếu sửa live config trước, repo phải clean ở tám managed paths:

```bash
cd ~/repos/pi-setup
./sync-from-live.sh
git diff --check
git status --short
```

Install và capture dùng chung operation lock. Capture dùng exact allowlist, từ chối symlink,
chạy audit và không tự stage/commit/push. Nếu rollback lỗi, before-image được giữ dưới
`~/.local/state/pi-setup/sync-transactions/` và path xuất hiện trong cảnh báo `CRITICAL`.

Không dùng `rsync ~/.pi/agent/` tổng quát.

## 9. Update và restore

Update bình thường:

```bash
cd ~/repos/pi-setup
git pull --ff-only
./install.sh
```

Giữ `install.sh` làm runtime authority. Layout hiện tại là global npm qua mise, không phải Pi
installer-managed (`PI_MANAGED_INSTALL_ROOT` không được set), nên managed atomic self-update
và `pi update --self` không thay thế repo pin, package reconciliation, doctor hoặc rollback.

Trước khi nâng Pi/package, đọc changelog và re-audit private APIs: Bash override,
paste-image editor method và tree events. Sau đó chạy smoke trong disposable trusted project.

Verification thủ công:

```bash
./doctor.sh
node scripts/audit-repo.mjs
npm --prefix extensions/tree-rewind run test:hazards  # design probes; đọc output, không chỉ exit code
```

`doctor.sh` không gọi model hoặc chạm live credential migration. Nó chạy full tests, exact
pin checks, `pi list`, backend tests và offline model-list smoke trong temporary HOME/config
với local package paths.
Một real provider request mới chứng minh auth/provider end-to-end nhưng có usage cost.

Sessions không nằm trong setup repo. Khi thật sự cần chuyển session, dùng JSONL export/import;
HTML export chỉ để xem.

## 10. Troubleshooting

### Cài đặt từ chối `.pi` symlink

Đây là fail-safe có chủ đích. Không tự động đổi alias vì có thể làm mất hoặc redirect private
state. Xác minh layout, backup thủ công, rồi chuyển `~/.pi` và `~/.pi/agent` thành directory
thật trước khi chạy lại.

### Operation lock còn sau crash

Nếu không còn install/sync process nào, xóa đúng
`~/.local/state/pi-setup/operation.lock`, rồi kiểm các before-image trong `transactions/`,
`sync-transactions/` và `backups/` trước khi rerun. Không xóa lock khi process còn sống.

### `mise` không có trên PATH

Activate mise trong shell và mở shell mới:

```bash
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
```

### Package/provider duplicate

`pi list` phải hiện đúng ba exact specs và chỉ một Anthropic OAuth provider package. Không
thêm upstream OAuth package song song với fork vì cả hai register provider `anthropic`.

### Web search trả 429

`429 rate_limit_error` với message `"Error"` mà `anthropic-ratelimit-*` vắng mặt nghĩa là
patch OAuth của `pi-web-search` không còn áp dụng, không phải hết quota. Chạy `./doctor.sh`
để xác nhận checksum, rồi `./install.sh` để apply lại.

### Extension chưa xuất hiện

Chạy `/reload`, đọc startup diagnostics, rồi `./doctor.sh`. Project-local resource còn phụ
thuộc trust; global managed resources không tự sync chỉ vì repo đã thay đổi.

### Cache miss

Kiểm `PI_CACHE_RETENTION=long`, exact OAuth tag, process/sleep gap và cache-read telemetry.
Không tắt notice để giả vờ sửa cache.

### OAuth rewrite làm sai project path

Chạy `./doctor.sh`; nó kiểm global mise env và probe provider thật. Expected mode là
`technical-safe`. Không dựa vào narrow `~/.Claude Code/agent` alias để che project path bị đổi.

## 11. Nguyên tắc cuối

1. Repo là nguồn sự thật cho behavior; live runtime/private state vẫn local.
2. Không commit/push auth, sessions, trust, caches hoặc generated package state.
3. Không force-push setup repo; update bằng fast-forward.
4. Tin test/source evidence hơn memory hoặc UI wording.
5. Không hứa hostile-code hoặc prompt-injection resistance.
