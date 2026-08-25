# Pi setup — runbook vận hành và khôi phục

> **Nguồn sự thật:** private repo `duy-tung/pi-setup`.
>
> **Nền tảng được hỗ trợ:** macOS.
>
> **Mục tiêu bảo mật:** giảm tai nạn trong workflow local có người giám sát; không chống
> hostile code hoặc prompt injection.

## 1. Cài trên máy Mac mới

Prerequisite: Apple Command Line Tools và Homebrew đã cài (`xcode-select -p`,
`brew --version`); nếu thiếu, dùng hướng dẫn chính thức tại `https://brew.sh/`. Sau đó:

```bash
brew install gh mise neovim
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
gh auth login
gh repo clone duy-tung/pi-setup ~/repos/pi-setup
cd ~/repos/pi-setup
./install.sh
```

Installer sẽ:

1. pin Node `24.15.0` trong global mise config;
2. set global `PI_CACHE_RETENTION=long`;
3. cài exact `@earendil-works/pi-coding-agent@0.84.3`;
4. backup rồi áp dụng sáu resource được quản lý;
5. cài/reconcile ba package đã pin;
6. chạy test, tree-rewind backend suite và no-cost offline startup smoke.

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
| Pi | `@earendil-works/pi-coding-agent@0.84.3` |
| Anthropic OAuth/cache fork | `git:github.com/duy-tung/pi-anthropic-oauth-plus@v0.3.2` |
| Web search | `npm:pi-web-search@1.3.1` |
| Context7 | `npm:@upstash/context7-pi@0.1.2` |
| tree-rewind | bundled package `extensions/tree-rewind/`, provenance `65fa4fa` |

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

OAuth fork vẫn là dependency GitHub ngoài repo và được fetch theo tag cố định. “Một repo” ở
đây nghĩa là chỉ cần clone một private setup repo; không vendor toàn bộ third-party packages.
Đây là exact top-level pins, không phải hermetic dependency lock: transitive npm versions vẫn
có thể đổi trong range package upstream cho phép. Doctor không hash toàn bộ installed bytes.
OAuth v0.3.2 honors request-body/tool-choice hooks, merge required betas nhưng loại
fine-grained tool streaming, và ghi đúng returned fallback model cùng pricing của nó.

## 3. Phạm vi repo và dữ liệu private

Sáu path duy nhất installer quản lý nằm trong `scripts/managed-paths.txt`:

```text
AGENTS.md
settings.json
scrub-session-secrets.sh
extensions
skills
prompts
```

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

```bash
cd /path/to/project
pi
```

Nên mở tại project cụ thể, không mở từ `~` hoặc `/`. Workspace rộng làm giảm giá trị của
write policy, rewind và profile `work`.

Workflow ngắn:

1. mô tả task bình thường; dùng `/grill` nếu quyết định chưa rõ;
2. dùng subagent `explore` cho đọc nhiều/report ngắn, `web` cho research không đọc project,
   `work` cho implementation độc lập trong trusted project;
3. dùng `/review` trước merge thay đổi đáng kể;
4. dùng `/wait-what` nếu lời giải thích khó hiểu;
5. dùng `/handoff` trước khi dừng task chưa xong;
6. xem preview/coverage trước `/tree` hoặc `/rewind` restore.

Lệnh setup cần nhớ:

| Lệnh | Vai trò |
|---|---|
| `/reload` | Nạp lại source sau khi áp dụng config |
| `/mode` | Chọn Auto, Manual, Accept edits, Plan hoặc Bypass tạm thời |
| `/model`, `/thinking` | Đổi model/thinking cho session hiện tại; Ctrl+S mới lưu global default |
| `/agents` | Xem/steer/resume/interrupt RPC children |
| `/goal`, `/todos` | Long-running goal và task checklist |
| `/tree`, `/rewind` | Conversation tree và worktree restore |
| `/limits` | Anthropic plan limits |
| `/present on\|off` | Opt-in GPT presentation; mặc định off mỗi session/reload |
| `/fast on\|off` | Anthropic fast mode; OAuth v0.3.2 giữ required betas và loại fine-grained streaming |
| `/review`, `/grill`, `/handoff`, `/teach`, `/wait-what` | Prompt templates |

### Permission mode

`/mode` hoặc `Ctrl+Alt+M` mở selector năm dòng:

- **Auto** (default): giữ workflow hiện tại — workspace edit và Bash thông thường chạy
  dưới policy/sandbox; destructive, protected hoặc outside operation mới hỏi.
- **Manual**: dedicated read/search tools chạy tự do; mỗi `edit`/`write`, mỗi Bash call và
  mỗi work-child activation đều hỏi một lần.
- **Accept edits**: ordinary `edit`/`write` trong workspace tự chạy; Bash, protected/outside
  write, unknown side-effect tool và work-child activation vẫn hỏi.
- **Plan**: gỡ `bash`, `edit`, `write` khỏi active tools; chặn work child và unknown
  side-effect tool. Khi thoát, chỉ ba tool mà Plan đã tắt được restore; tool thêm động không
  bị mất.
- **Bypass permissions**: phải confirm trong attended TUI và chỉ sống trong runtime hiện tại.
  Nó bỏ soft prompt nhưng không bỏ Seatbelt, protected/outside boundary hoặc credential deny.

Auto/Manual/Accept edits/Plan đi theo active session branch. Bypass reset về Auto sau
`/reload`, resume, fork hoặc session mới. Không đổi mode khi parent đang chạy; mode change và
conversation-tree navigation đều bị chặn khi work child đang starting/running. Wait hoặc
interrupt child trước.

Pi 0.84.3 không còn tự ghi `/model` hoặc `/thinking` selection vào global settings. Enter chỉ
đổi session; Ctrl+S mới persist. Vì `settings.json` do repo quản lý, chỉ dùng Ctrl+S khi chủ ý
đổi default rồi capture thay đổi về repo.

## 5. Subagent và presentation

Public API giữ cố định:

- tools: `subagent`, `send_message`, `list_agents`, `interrupt_agent`;
- profiles: `explore`, `web`, `work`.

Subagents dùng native Pi RPC. Child process chỉ sống trong một active turn; durable child
session nằm dưới `~/.pi/agent/subagents/` và không được backup vào repo. Manual/Accept edits
coi mỗi new/resumed `work` activation là một broad approval scope vì unattended child không
forward được từng popup; Plan chặn work activation. Parent permission mode không truyền vào
child. Đây là tool/profile restriction để giảm tai nạn, không phải process isolation; Bash
network vẫn unrestricted.

`present.ts` không phải public subagent. Exact `/present on` mới cho phép gửi future eligible
answers sang private one-shot RPC `openai-codex/gpt-5.6-sol:off`. Original answer luôn là
nguồn authority. Rewrite chỉ để hiển thị, fail-open, không tạo durable child và usage không
được cộng vào parent footer totals. `/reload` reset nó về off.

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

## 7. Safety và giới hạn thật

- `permission-mode` chỉ thay soft approval policy; known credential deny và canonical path
  boundary không thể bị Bypass tắt.
- `permission-gate` là sole pre-execution owner cho model tools; Manual/Accept edits hỏi đúng
  một lần theo matrix, Plan block phòng thủ và Bypass vẫn block protected/outside built-in writes.
- `sandbox-bash` chạy Bash tuần tự qua macOS Seatbelt; Plan không có writable root, reads khác
  và network vẫn mở, không có unsandboxed retry.
- `secret-guard` và spill redaction là best effort, không phải data-loss-proof DLP.
- Global/package extensions chạy với quyền của user.
- Child reports, web, logs và files đều là untrusted task data.
- Không dùng setup này để chạy hostile repository hoặc unattended hostile code; cần
  container/VM/process isolation riêng.

Tree-rewind checkpoint ordinary worktree changes và tối đa 64 outside files mà `write/edit`
nêu rõ. Nó không thay backup hoặc git commit. Luôn xem coverage: ignored Bash paths, deep
nested repos, credential-shaped paths, type changes và outside writes có giới hạn riêng. Old
sessions bị prune, nhưng một current session rất dài không có hard 2 GiB cap.

Failed Git diff/apply không được coi là successful code/conversation rewind. Sau confirmation,
Apply/Undo re-snapshot và re-plan dưới write lock, nên same-type edit trong lúc dialog mở trở
thành exact reverse point. Cả hai revalidate type; Undo type-change cần confirmation riêng và
incomplete undo giữ retry point. Cancel preview không thay prior undo. Persisted outside path/SHA/mode được validate
lại; missing nested repo được report unprotected thay vì vô hiệu hóa root checkpoint.

Chỉ owner mới release lock; không có automatic stale takeover vì race có thể xóa live
successor. Signal handlers chỉ tồn tại khi lock đang held; worktree/outside checkpoint/apply và
projectless outside state cùng dùng store lock. Sau SIGKILL/crash chỉ xóa exact lock path khi đã
xác nhận không còn Pi session dùng project. Với confirmed type change, replacement được
materialize trước khi current directory bị move; missing/corrupt blob để nguyên user data.
Hardlink restore giữ inode, content và mode.

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

Nếu sửa live config trước, repo phải clean ở sáu managed paths:

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
compaction-prune, paste-image editor method, RPC settlement/session state, presentation và
tree events. Sau đó chạy smoke trong disposable trusted project.

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

### Extension chưa xuất hiện

Chạy `/reload`, đọc startup diagnostics, rồi `./doctor.sh`. Project-local resource còn phụ
thuộc trust; global managed resources không tự sync chỉ vì repo đã thay đổi.

### Cache miss

Kiểm `PI_CACHE_RETENTION=long`, exact OAuth tag, process/sleep gap và cache-read telemetry.
Không tắt notice để giả vờ sửa cache.

### Presentation không hiện

Chạy exact `/present on`; source phải là successful long prose answer trong interactive TUI.
New parent turn, tree navigation, toggle-off, model/code mismatch hoặc oversized result đều có
thể cancel/drop rewrite theo thiết kế.

## 11. Nguyên tắc cuối

1. Repo là nguồn sự thật cho behavior; live runtime/private state vẫn local.
2. Không commit/push auth, sessions, trust, caches hoặc generated package state.
3. Không force-push setup repo; update bằng fast-forward.
4. Tin test/source evidence hơn memory hoặc UI wording.
5. Không hứa hostile-code hoặc prompt-injection resistance.
