# Guideline setup dự án mới với Pi

Tài liệu này là quy trình **stack-neutral** để bootstrap một software project mới và làm việc
với cấu hình Pi trong repository này. Phần cuối có một baseline cụ thể cho Go service.

- **Đối tượng:** dự án mới hoặc repository hiện có chưa có onboarding/quality contract rõ ràng.
- **Môi trường Pi hiện tại:** macOS, Pi được quản lý bởi `pi-setup`.
- **Phạm vi:** từ quyết định ban đầu, tạo repository, project context, local loop, CI, secrets,
  testing, release đến workflow hằng ngày với Pi.
- **Không phải:** generator áp một cấu trúc cứng cho mọi stack, cơ chế deploy tự động, hay sandbox
  cho source code không tin cậy.
- **Lần đối chiếu nguồn gần nhất:** 2026-08-26. Các source snapshot ở cuối tài liệu.

> Nguyên tắc xuyên suốt: scaffold ít nhất có thể nhưng phải tạo ra một **đường chạy chuẩn có thể
> kiểm chứng**. Chỉ thêm tài liệu, automation và abstraction khi dự án đã có nhu cầu thật.

## 1. Đường đi nhanh

Baseline **bắt buộc cho mọi project**, kể cả CLI/library nhỏ:

1. Chốt outcome, scope/non-goals, owner, lifecycle status, licensing posture và tiêu chí thành công.
2. Tạo project root hẹp, chạy `git init -b main`, rồi mở Pi từ root nếu dùng Pi để scaffold.
3. Trước khi chọn Trust, audit các project resources mà Pi hoặc command có thể load/chạy.
4. Chọn execution/validation stack; pin runtime/toolchain và commit lockfile khi ecosystem có
   các artifact đó.
5. Tạo một vertical slice hoặc artifact đầu tiên kiểm chứng được, `README.md` có
   quickstart/expected result, và project-level `AGENTS.md` ngắn.
6. Cung cấp **một command verification chuẩn** bao gồm các check project hiện có, tối thiểu là
   lint, validate, test hoặc smoke phù hợp với loại repository.
7. Chạy verification và inspect `git status --short`; formatter/linter phải bao phủ cả scaffold
   chưa tracked. Dùng `git diff --check` cho tracked diff hoặc `git diff --cached --check` sau khi
   initial files đã được stage. Ghi check chưa chạy; chỉ commit/push khi người dùng cho phép.

Sau core baseline, chỉ thêm hạng mục khi trigger xuất hiện:

| Hạng mục | Khi nào cần |
|---|---|
| Dependency lockfile | Package manager tạo lockfile hoặc dependency graph cần reproducibility |
| `LICENSE` file | Owner chọn named license hoặc muốn cấp explicit reuse/distribution terms |
| `CONTEXT.md` | Domain term đầu tiên được thống nhất |
| Integration test + dependency thật | Contract phụ thuộc database, broker, filesystem, network service, ... |
| `smoke`/`up`/`down` | Project có runtime path hoặc local service stack |
| CI | Trước khi nhận PR, publish package hoặc dựa vào remote checks |
| Branch protection/`CONTRIBUTING.md` | Có collaboration trên remote repository |
| ADR/architecture docs | Quyết định đạt tiêu chí ADR hoặc README không còn đủ |
| Release/deploy/operations | Có artifact được publish hoặc environment được vận hành |
| Durable tracker/handoff | Công việc kéo qua nhiều session/workstream |

`/grill` và Plan mode hữu ích khi design chưa rõ. `/review <base-ref>` dùng cho committed diff trước
merge; trục Spec chỉ chạy khi có spec. Tree-rewind hỗ trợ recovery nhưng không thay Git hoặc backup.
Các mục sau là reference chi tiết, không phải checklist bắt mọi project tạo toàn bộ artifact.

## 2. Tách hai lớp setup

### 2.1. Machine setup — làm một lần trên mỗi Mac

`pi-setup` quản lý Pi runtime và global behavior. Không copy các file runtime/private vào project.
Làm theo [runbook vận hành Pi](./pi-setup-tieng-viet.md); đường cài chuẩn là:

```bash
brew install gh mise neovim
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
git clone https://github.com/duy-tung/pi-setup.git ~/repos/pi-setup
cd ~/repos/pi-setup
./install.sh
./doctor.sh
```

Public clone không cần GitHub login; chạy `gh auth login` trước khi tạo/sửa remote. Sau full install,
đóng/mở lại Pi để process nhận global environment rồi dùng `/login` cho provider
cần thiết. Không copy `auth.json`, sessions, trust state, caches hoặc subagent artifacts giữa máy.

Machine setup chỉ hỗ trợ macOS vì Bash confinement hiện dựa vào Seatbelt. Đây là lớp giảm tai nạn
trong workflow có người giám sát, không phải isolation cho hostile repository.

### 2.2. Project setup — làm riêng cho từng repository

Project giữ source code, project-specific context, commands, tests, CI và docs. Nó **không** nên
vendor/copy toàn bộ `~/.pi/agent`, global extensions, skills hay prompt templates.

Project có thể thêm:

- `AGENTS.md` cho architecture, commands, constraints và Definition of Done riêng;
- `CONTEXT.md` khi domain vocabulary đầu tiên thật sự được thống nhất;
- `docs/adr/` khi quyết định đầu tiên đạt đủ tiêu chí ADR;
- local scripts/config mà cả người và CI đều chạy được.

Global policy vẫn đến từ `~/.pi/agent/AGENTS.md`. Project policy bổ sung fact cụ thể, không lặp lại
các nguyên tắc chung về scope, evidence, secrets hoặc user authority.

## 3. Chốt đầu vào trước khi scaffold

Nếu một câu trả lời có thể đổi architecture, scope, rủi ro hoặc cách verify thì phải chốt trước.
Dùng `/grill <topic>` khi các quyết định còn mơ hồ; đừng bắt đầu bằng một scaffold lớn rồi mới tìm
lý do giữ nó.

| Quyết định | Câu hỏi tối thiểu | Output cần có |
|---|---|---|
| Problem | Ai có vấn đề gì, outcome quan sát được là gì? | 1–3 câu trong README/spec |
| Scope | Phiên bản đầu làm gì và cố ý không làm gì? | In-scope + non-goals |
| Lifecycle | Active, experimental, historical hay archived? | Status + owner + ngày review |
| Repository | Public/private, owner/org, default branch? | Visibility được xác minh |
| Execution/validation | Language/tool/runtime nào thực sự cần? | Verification entrypoint; manifest/version policy khi có |
| Interfaces | CLI, HTTP, event, library hay contract nào? | Source of truth được chỉ rõ |
| Data | Có database/migration/retention không? | Ownership + migration path |
| Dependencies | Dịch vụ thật nào cần cho test/dev? | Local bring-up + readiness |
| Quality | Rủi ro nào cần unit/integration/e2e/race/security test? | Test matrix ban đầu |
| Delivery | Chỉ local, package, container hay deployment? | Build/release target |
| Licensing | All-rights-reserved, proprietary hay open source? | Posture luôn rõ; `LICENSE` khi cấp explicit terms |
| Success | Command hoặc hành vi nào chứng minh setup xong? | Acceptance checklist |

Không cần tạo PDR dài nếu một README ngắn đã đủ. Ngược lại, một system có nhiều boundary hoặc
nhiều repository cần spec/contract riêng thay vì nhét mọi thứ vào `AGENTS.md`.

## 4. Tạo repository an toàn và có fixed point

### 4.1. Chọn project root hẹp

Không khởi động Pi từ `/`, `~`, `~/Documents` hoặc một thư mục chứa nhiều project. Ví dụ:

```bash
mkdir -p ~/repos/my-project
cd ~/repos/my-project
pwd
```

Tạo Git/runtime marker trước khi làm việc để tree-rewind có thể nhận diện toàn worktree:

```bash
git init -b main
```

Các marker được nhận diện gồm `.git`, `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`,
`Makefile` và một số manifest phổ biến khác. Không có marker, Pi vẫn chạy nhưng rewind chỉ có
coverage giới hạn theo từng file đã edit.

Nếu dùng Pi để scaffold, đây là thời điểm chạy `pi` từ root vừa tạo. Với repository đã có nội dung,
đọc phần [audit trước khi Trust](#141-audit-trước-khi-trust) trước khi cho phép project resources.
Với setup thủ công, hoàn tất file core rồi mới mở Pi cũng được; boundary quan trọng là không Trust
một repository có sẵn trước khi audit.

Không đặt `PI_REWIND_FORCE=1` trong shell profile hoặc project config. Biến này bỏ qua toàn bộ
eligibility guard, kể cả home directory và sensitive trees; nó không thuộc normal workflow.

### 4.2. Chọn visibility trước khi tạo remote

Ghi quyết định public/private vào checklist. Sau khi người có thẩm quyền xác nhận, có thể tạo remote:

```bash
# Chọn đúng MỘT flag: --private hoặc --public.
gh repo create OWNER/REPO --private --source=. --remote=origin

gh repo view OWNER/REPO \
  --json nameWithOwner,visibility,isArchived,defaultBranchRef,url
```

Tạo remote, push, đổi visibility, branch protection hoặc GitHub settings đều là external effects;
agent chỉ được thực hiện khi người dùng cho phép rõ ràng.

### 4.3. Tạo baseline commit

Trước feature đầu tiên, hoàn tất skeleton tối thiểu và chạy verification. Khi người dùng cho phép,
tạo initial commit rồi phát triển trên commit/branch tiếp theo; baseline đó là fixed point rõ cho
`/review <baseline-ref>` và Git rollback. `/review` hiện so committed `<base>...HEAD`, không bao gồm
uncommitted worktree. Không tạo commit rỗng chỉ để đủ quy trình.

## 5. Skeleton khuyến nghị

Không phải project nào cũng cần toàn bộ cây sau ngay ngày đầu:

```text
my-project/
├── README.md                    # mục tiêu, quickstart, commands, limitations
├── AGENTS.md                    # project-specific context cho coding agents
├── CONTRIBUTING.md              # optional khi có nhiều contributor
├── LICENSE                      # khi owner cấp named/explicit license terms
├── .gitignore
├── .env.example                 # chỉ khi app dùng env config; không có secret thật
├── mise.toml                    # optional: pin toolchain project
├── Makefile                     # hoặc Taskfile/package scripts khi cần task runner
├── <runtime/build manifest>     # khi ecosystem dùng manifest
├── <dependency lockfile>        # khi ecosystem tạo file này
├── cmd/, src/, internal/, pkg/  # theo convention của stack, không ép dùng tất cả
├── tests/                       # khi không colocate tests với source
├── scripts/                     # khi command không còn gọn trong task runner
├── docs/
│   ├── architecture.md          # khi README không còn đủ
│   └── adr/                     # tạo lazy khi ADR đầu tiên cần thiết
└── .github/workflows/           # trước collaboration/publish dựa vào remote checks
    └── ci.yml
```

Core nhỏ nhất là `README.md`, `AGENTS.md`, `.gitignore`, một artifact/vertical slice kiểm chứng được
và một command verification. Thêm runtime/build manifest khi ecosystem dùng nó. Các file còn lại
tuân theo trigger matrix ở phần 1; đừng tạo directory rỗng hoặc boilerplate chưa có consumer.

## 6. README contract

README là entrypoint cho cả người và agent. Quickstart phải ngắn, copy được và mô tả expected result.
Một baseline tốt:

```md
# Project name

One sentence: what this project does and for whom.

- Status: active | experimental | historical | archived
- Owner: team/person
- License posture: all-rights-reserved | proprietary | <named license>
- Last verified: YYYY-MM-DD
- Successor: URL or `none`

## Scope and trust boundaries

What is production-safe, what is dev-only, and explicit non-goals.

## Prerequisites

Supported runtime/tool ranges with probe commands, or state that no extra prerequisite exists.

## Quickstart

Commands from clean clone to one visible success, plus expected output.

## Repository layout

Only important directories and their ownership/source-of-truth rules.

## Development commands

List only applicable commands; keep one canonical verification entrypoint.

## Configuration and secrets

Precedence, required values, `.env.example`, dev-only credentials.

## Testing and CI

What each test level proves; include CI commands only when the project has CI.

## Operations or release

Only when the project deploys/publishes: health, migration, rollback, release policy.

## Known limitations

Measured or accepted gaps; do not hide them in issue history.
```

README không nên tuyên bố “production-ready”, “secure”, “exactly once”, “fast” hoặc “≤N phút” nếu
không có threat model, test/evidence hoặc measurement tái tạo được.

## 7. Project-level `AGENTS.md`

### 7.1. Mục tiêu

`AGENTS.md` phải giúp một agent mới trả lời nhanh:

1. Project làm gì và source of truth nằm ở đâu?
2. Command chuẩn để bootstrap và verify là gì?
3. Boundary nào không được phá?
4. File nào generated hoặc cần sửa qua generator?
5. Definition of Done của repository là gì?

Không copy nguyên [global `AGENTS.md`](../AGENTS.md). Không copy `AGENTS.override.md` của
`pi-setup`: file đó chỉ giải quyết duplicate-loading đặc thù của source repo này.

### 7.2. Template tối thiểu

Template trong code block dùng tiếng Anh để phù hợp source/docs convention của project. Xóa mọi
row/section không áp dụng thay vì giữ placeholder hoặc command giả:

```md
# Project instructions

## Purpose and sources of truth

- Purpose: <one sentence>.
- Product/spec authority: `<path or issue system>`.
- Architecture authority: `<path>`.
- Public/runtime contract authority: `<path>`.

## Startup

1. Confirm the repository root with `pwd`.
2. Read `README.md` and the directly relevant spec/code/tests.
3. Run `<bootstrap or health command>` when environment health matters.
4. Inspect `git status --short` and preserve existing user work.

## Commands

- Bootstrap: `<command>`
- Format check: `<command>`
- Lint/typecheck: `<command>`
- Unit tests: `<command>`
- Integration tests: `<command and prerequisites>`
- Build: `<command>`
- Full verification: `<single canonical command>`

## Architecture and boundaries

- `<component>` owns `<responsibility/data>`.
- `<dependency direction or forbidden coupling>`.
- `<trust/security boundary>`.

## Generated files

- `<path>` is generated by `<command>`; edit its source at `<path>`.

## Definition of Done

- Requested behavior and acceptance criteria are implemented.
- Relevant local checks actually passed.
- Required integration dependencies were exercised rather than silently skipped.
- Generated artifacts and durable docs are synchronized when affected.
- Remaining risks and unverified checks are reported explicitly.

## Repository-specific safety

- Never read or commit `<project-specific sensitive paths>`.
- Do not commit, push, publish, deploy, mutate remote state, or delete user data
  without explicit user authorization.
```

Giữ file ngắn. Standards dài nên ở `CONTRIBUTING.md` hoặc docs rồi link từ `AGENTS.md`. Subdirectory
chỉ cần `AGENTS.md`/override riêng khi rules thật sự khác theo scope; tránh nhiều layer lặp lại cùng
một policy.

## 8. Domain context, specs và ADR

### 8.1. `CONTEXT.md` là glossary, không phải spec

Với project một bounded context, tạo root `CONTEXT.md` khi term đầu tiên được chốt. Với nhiều
context, dùng `CONTEXT-MAP.md` trỏ tới từng context. Theo
[`CONTEXT-FORMAT.md`](../skills/domain-modeling/CONTEXT-FORMAT.md):

```md
# Ordering

Receives and tracks customer orders.

## Language

**Order**:
A confirmed request by a Customer for fulfillment.
_Avoid_: Purchase, transaction
```

Chỉ ghi domain-specific terms; không ghi implementation detail, todo hay architecture decision.

### 8.2. Spec phải chứa acceptance criteria

Một feature có scope đáng kể nên có issue/spec chỉ rõ:

- observed problem và desired behavior;
- in-scope/non-goals;
- interface hoặc compatibility constraints;
- failure modes quan trọng;
- acceptance checks có thể chạy/quan sát;
- rollout/migration/rollback nếu thay đổi state hoặc contract.

Spec là nguồn cho trục **Spec** của `/review`; `CONTRIBUTING.md`/standards là nguồn cho trục
**Standards**.

### 8.3. ADR tạo sparingly

Chỉ tạo ADR khi cả ba điều kiện cùng đúng:

1. Khó đảo ngược.
2. Một người mới sẽ thấy lựa chọn này bất ngờ nếu không biết context.
3. Có alternative và trade-off thật.

Dùng format ngắn trong [`ADR-FORMAT.md`](../skills/domain-modeling/ADR-FORMAT.md). Với shared
contract hoặc architecture lâu dài, thêm status/date và **supersede bằng ADR mới** thay vì rewrite
một accepted decision khiến lịch sử biến mất.

## 9. Toolchain và dependency policy

### 9.1. Pin các lớp quan trọng

Chỉ áp dụng những layer project thực sự có:

- Runtime/toolchain: `mise.toml`, `go.mod` toolchain, `.python-version`, `rust-toolchain.toml`, ...
- Direct dependencies: manifest có version policy rõ.
- Transitive dependencies: commit lockfile khi ecosystem hỗ trợ.
- Dev/codegen tools: project-local `./bin`, tools module hoặc exact version trong script.
- CI actions/tools: có version policy; không dùng `master`, `HEAD` hoặc `latest` trong reproducible
  path. Với high-assurance repo, pin action bằng full commit SHA và dùng bot để update.
- Container/base images: pin ít nhất major/minor; release/deploy quan trọng nên pin digest.

Không dùng install pattern kiểu `curl .../main | sh` làm canonical bootstrap. Nếu bắt buộc tải binary,
phải pin version, dùng HTTPS, verify checksum/signature và ghi rõ update path.

### 9.2. Một nguồn version cho local và CI

CI nên đọc runtime version từ cùng manifest local, ví dụ `go-version-file: go.mod`. Tránh version
khác nhau trong README, local script và workflow.

### 9.3. Bootstrap fail-fast

`make bootstrap`, `./scripts/bootstrap.sh` hoặc command tương đương nên:

- kiểm tra prerequisite trước khi mutation lớn;
- idempotent khi thực tế cho phép;
- pin version và không ghi secret;
- cài tool vào project-local cache/bin thay vì yêu cầu global tool mơ hồ;
- dừng non-zero nếu partial setup làm kết quả không đáng tin;
- in exact recovery/cleanup step cho artifact đã tạo.

Không xây transactional installer phức tạp cho project nhỏ nếu một package-manager command đã đủ.

## 10. Command contract và local development loop

Dùng Makefile, Taskfile hoặc package scripts đều được. Điều quan trọng là người, agent và CI gọi
cùng interface. Bảng dưới là menu để chọn theo trigger, không phải danh sách target bắt buộc.

| Command logic | Ý nghĩa |
|---|---|
| `help` | Liệt kê command và prerequisite |
| `bootstrap` / `dev-tools` | Cài pinned local tools/dependencies |
| `fmt` / `fmt-check` | Format hoặc kiểm tra drift |
| `lint` / `typecheck` | Static checks |
| `test-unit` | Fast deterministic tests, không cần external service |
| `test-integration` | Test dependency thật, fail nếu prerequisite bắt buộc thiếu |
| `test` | Test floor cho thay đổi thông thường |
| `build` | Tạo/compile artifact |
| `up` / `down` | Bring up/down local dependencies |
| `smoke` / `demo` | Một đường user-visible với expected result |
| `verify` | Canonical required local/CI gate |
| `clean` | Chỉ xóa generated artifact được khai báo rõ |

`verify` không nhất thiết chạy mọi benchmark/e2e đắt đỏ. Chia gate:

- PR-blocking: deterministic, có signal trực tiếp cho correctness.
- Nightly/manual: full deployment smoke, chaos, benchmark hoặc external system dễ flaky.
- Release-only: reproducibility, migration rehearsal, package/signature checks.

Mỗi non-blocking gate vẫn phải lưu/report failure; “không block PR” không có nghĩa là nuốt lỗi.

## 11. Configuration và secrets

### 11.1. Config precedence

Chọn một thứ tự rõ và document, ví dụ:

1. safe built-in defaults;
2. optional config file;
3. environment variables/secret manager;
4. explicit CLI flags.

Configured-but-unreadable file và invalid required value phải fail loudly. Có thể aggregate validation
errors để người dùng sửa một lần thay vì restart nhiều vòng.

### 11.2. Repository rules

- Commit `.env.example` với placeholder, không commit `.env` hoặc credential thật.
- `.gitignore` phải chặn secret-shaped files, local state, build output và tool caches.
- Dev credentials chỉ được phép khi được label rõ, có scope local và app fail-closed ngoài dev mode.
- Không log DSN, bearer token, cookie, private key hoặc raw request chứa secret.
- CI dùng secret/identity mechanism của platform; ưu tiên short-lived identity hơn static key.
- Không yêu cầu agent đọc `.env`, `~/.ssh`, `~/.aws`, `~/.config/gcloud` hoặc `~/.kube` để “debug”
  nếu task không được người dùng cho phép rõ ràng.

Secret scanning/redaction chỉ là defense-in-depth, không thay access boundary hoặc rotation.

## 12. Testing và evidence

### 12.1. Test theo rủi ro

| Rủi ro | Evidence phù hợp |
|---|---|
| Pure logic | Unit/property tests |
| Database/query/migration | Integration test với engine/version thật |
| Concurrency | Race detector, barrier-synchronized cases, repeated stability run |
| Protocol/contract | Positive + negative fixtures, compatibility checks |
| Generated code | Regenerate rồi `git diff --exit-code` |
| Retry/idempotency | Fault injection trước/sau commit/response boundary |
| Startup/config | Missing/invalid config tests, readiness smoke |
| Performance claim | Reproducible benchmark + machine/cache/methodology |
| Deployment | Smoke trên target gần thật; rollback/readiness evidence |

Đừng chỉ test happy path. Validator phải có negative fixture chứng minh nó thực sự fail; required
integration test không được silently skip khi CI thiếu dependency.

### 12.2. Evidence record tối thiểu

Khi claim quan trọng cần sống lâu hơn transcript, ghi:

- command/scenario exact;
- commit/version pins;
- OS/runtime/dependency versions;
- timestamp và cache/precondition state;
- pass/fail/invalid;
- output hoặc artifact path;
- limitation/deviation còn mở.

Invalid run được giữ với lý do invalid nếu có giá trị điều tra; không retry cho đến khi xanh rồi xóa
mọi dấu vết. Phân biệt rõ **measured**, **source-reported** và **assumed**.

### 12.3. Definition of Done mặc định

Một change chỉ done khi:

1. Desired behavior và acceptance criteria đã được implement.
2. Relevant checks thực sự chạy và pass.
3. Required dependency path không bị skip.
4. Generated files, public docs, config example và migrations được sync nếu bị ảnh hưởng.
5. Formatter/whitespace check bao phủ cả file mới; tracked/staged diff check sạch và
   `git status --short` được inspect.
6. Unverified checks, limitations và remaining risk được report.
7. Không có external effect nào được thực hiện ngoài authority người dùng đã cấp.

Coverage percentage có thể hữu ích nhưng không thay scenario/risk coverage.

## 13. CI, GitHub và release baseline

Phần này chỉ áp dụng khi project có trigger collaboration, publish hoặc deploy trong phần 1.

### 13.1. CI tối thiểu

- Trigger trên pull request và default branch.
- Top-level `permissions: contents: read`; chỉ nâng permission ở job thực sự cần.
- Runtime đọc từ project manifest.
- CI gọi cùng local `verify`/Make targets, không viết một logic khác.
- External services pin version và có health check.
- Generated artifacts có drift check.
- Required tests không có `|| true`, `continue-on-error` hoặc implicit skip.
- Dùng concurrency cancellation cho superseded PR runs khi phù hợp.
- Expensive/environment-sensitive smoke tách nightly/manual nếu signal PR kém.
- Failure diagnostics không được in secret.

### 13.2. Branch/repository settings

Trước collaboration hoặc production release:

- verify lại visibility và default branch;
- bảo vệ default branch;
- require các deterministic checks;
- require review theo mức rủi ro/team policy;
- tắt force-push/delete nếu không có lý do;
- cấu hình Dependabot/Renovate hoặc update cadence;
- đặt lifecycle status, owner, last-validated date và successor trong README/repository metadata.

GitHub “not archived” không chứng minh project active. Một repo chỉ có initial commit, default branch
`claude/*`, README-only hoặc đã được bundle/supersede phải được label trung thực.

### 13.3. Release/versioning

- Library/module/contract được consumer dùng phải pin tag/release, không pin moving branch.
- Dùng SemVer khi compatibility surface có nghĩa rõ.
- Breaking change cần migration note và compatibility test.
- Release workflow validate artifact trước khi publish/tag release.
- Container deploy nên dùng immutable tag/digest; GitOps deploy artifact đã build, không build lại.
- Publish/deploy/tag/push là external effect và cần explicit user authority.

## 14. Workflow hằng ngày với Pi

### 14.1. Audit trước khi Trust

Từ project root, kiểm tra ít nhất:

```bash
pwd
git status --short
```

Đọc các resource có thể ảnh hưởng agent/tool execution:

- `AGENTS.md`, `AGENTS.override.md`, `.pi/`, `.agents/`, `.claude/`;
- package install scripts, Makefile/Taskfile và executable scripts;
- `.git/hooks`, submodules và symlink bất thường;
- Docker bind mounts, privileged mode và host paths;
- workflow permissions/deploy steps;
- tool/plugin/extension config cục bộ.

Chỉ chọn Trust khi repository và local resources được hiểu đủ. Với code không tin cậy, dùng
container/VM/process isolation; permission mode và Seatbelt hiện tại không phải hostile-code sandbox.

### 14.2. Chọn permission mode có chủ ý

```text
/mode plan          không Bash/edit/write; block work child và unknown side effects
/mode manual        hỏi mỗi Bash/edit/write và mỗi mutation-capable work child
/mode accept-edits  auto edit thường, vẫn hỏi Bash/boundary/work child
/mode auto          default low-friction, hỏi các pattern external/destructive đã biết
/mode bypass        chỉ bỏ gate prompt tạm thời; guard vẫn còn
```

Bypass **không** phải quyền commit, push, deploy, publish hoặc xóa user work. Auto pattern cũng
không exhaustive; global authority rules vẫn áp dụng.

### 14.3. Một feature loop

1. **Frame:** nêu outcome, constraints, source spec và success checks.
2. **Clarify:** `/grill` nếu material decisions chưa settled.
3. **Inspect:** đọc governing docs/code/tests; Plan mode hữu ích cho domain mới hoặc repo lạ.
4. **Plan proportionally:** task nhỏ làm inline; task nhiều bước dùng todo; long-running objective
   mới dùng goal.
5. **Implement:** smallest complete vertical slice; giữ repository usable sau từng increment.
6. **Delegate only when it pays:**
   - `explore` cho local read-only high-volume;
   - `web` cho current docs/research không đọc project;
   - một `work` child cho scoped implementation trong trusted workspace.
7. **Verify child claims:** report của subagent là claim, không phải fact. Parent kiểm primary
   evidence trước khi sửa code hoặc báo Critical/Important finding.
8. **Run project checks:** targeted trước, canonical `verify` khi scope/risk yêu cầu.
9. **Review:** `/review <fixed-point>` cho Standards và thêm Spec khi có spec; review finding
   cũng cần verify.
10. **Close:** inspect diff/status, update affected docs, report risk. Xin quyền riêng trước
    commit/push/deploy/publish/delete.
11. **Continue later:** `/handoff` cho unfinished multi-session work.

Khi mục tiêu là học hoặc domain còn lạ, nói rõ với Pi và ưu tiên prediction/attempt, hints, review và
explain-back thay vì giao toàn bộ judgment cho work subagent. `/teach` phù hợp với learning workspace
dài hạn; production work quen thuộc không cần biến thành lesson.

### 14.4. Tree-rewind không phải backup

Tree-rewind tạo shadow checkpoint trước prompt nhưng có coverage gap, caps và protected paths.
Luôn xem status/preview trước `/rewind`. Normal restore hỏi riêng trước outside-project paths và hỏi
thêm cho type change khi cần; Undo dùng preview chung và có thể bao gồm outside paths đã restore, nên
phải đọc preview kỹ. Git commit, remote và backup vẫn là recovery layers độc lập.

## 15. Baseline cụ thể cho Go service

Đây là reference để **adapt**, không phải generator. Core baseline bên dưới chạy được khi module đã có
ít nhất một package/source file; database, Compose, codegen và deployment chỉ thêm khi project cần.

### 15.1. Layout

```text
my-service/
├── README.md
├── AGENTS.md
├── Makefile
├── go.mod
├── go.sum                   # chỉ xuất hiện khi dependency/tool tạo ra
├── cmd/api/                 # hoặc entrypoint phù hợp
├── internal/
└── .github/workflows/ci.yml # khi project dùng remote CI

# Conditional: CONTRIBUTING.md, migrations/, scripts/, tests/integration/,
# compose.yaml, docs/, deployments/
```

Rule ownership nên rõ: domain/usecase không phụ thuộc transport/database adapter; schema/proto là
source of truth; generated code không sửa tay.

### 15.2. Toolchain

Một ví dụ hợp lệ theo snapshot đã audit:

```go
module github.com/OWNER/my-service

go 1.26

toolchain go1.26.5
```

Chọn version project thực sự support và CI có thể cài; có thể bỏ `toolchain` nếu chỉ cần minimum Go
version. Directive `toolchain` phải là tên exact như `go1.26.5`, không dùng `x` hoặc `latest`. Commit
`go.sum` khi Go tạo file đó. Pin codegen/linter qua `tools/go.mod`, exact install version hoặc
project-local `./bin`.

### 15.3. Core Makefile

```make
SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: fmt-check lint test build verify help

fmt-check: ## Fail when Go files need formatting
	@out="$$(gofmt -l .)" || exit $$?; \
	if [ -n "$$out" ]; then echo "gofmt needed on:"; echo "$$out"; exit 1; fi

lint: fmt-check ## Run static checks
	go vet ./...

test: ## Run the project test floor
	go test -race -shuffle=on ./...

build: ## Compile all packages
	go build ./...

verify: lint test build ## Canonical local/CI gate

help: ## Show commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ \
	{printf "  \\033[36m%-20s\\033[0m %s\\n", $$1, $$2}' $(MAKEFILE_LIST)
```

Chỉ mở rộng contract khi có trigger:

- `dev-tools`: cài pinned external tools vào `./bin`; không tạo target no-op.
- `test-integration`: chạy dependency thật. Nếu local cho phép skip, CI phải set
  `TEST_REQUIRE_DB=1` hoặc cơ chế tương đương để missing dependency thành failure.
- `up`/`down`: dùng khi có Compose/local stack và phải wait health trước test.
- `smoke`: dùng khi có user-visible runtime path; script và expected result phải tồn tại.
- `generate`: chạy generator rồi CI kiểm `git diff --exit-code` trên generated paths.

### 15.4. Go CI checklist

- `actions/setup-go` đọc `go.mod`; CI gọi `make verify` thay vì copy logic.
- PostgreSQL/NATS/Redis thật dùng pinned service image + health check khi contract phụ thuộc nó.
- Concurrency/idempotency cần deterministic fault/barrier test; critical flaky path có repeated run.
- Full kind/Helm smoke có thể nightly/manual nếu failure chủ yếu do environment.
- Helm/Terraform validate trước release/apply; apply vẫn cần protected environment/authority.

## 16. Anti-patterns cần tránh

- Copy toàn bộ global Pi/Claude setup vào từng project.
- Tạo nhiều policy layer lặp lại và biến skill activation thành nghi lễ.
- Bắt đầu Pi ở home hoặc một parent directory quá rộng.
- Dùng `PI_REWIND_FORCE=1` như setting mặc định.
- Cài tool từ moving branch (`main`, `HEAD`, `latest`) trong reproducible path.
- Dùng symlink vào live global config làm canonical portable installer.
- Viết local command và CI logic khác nhau.
- `go test ... || true`, required test skip, hoặc retry đến khi xanh mà không ghi flaky evidence.
- Tuyên bố integration/benchmark/quickstart pass mà không lưu command, environment và result.
- Edit generated code thay vì source/generator.
- Commit real `.env`, token hoặc cloud credentials; coi redaction là DLP.
- Tạo ADR/architecture docs cho mọi quyết định nhỏ.
- Coi GitHub “not archived” là bằng chứng project active.
- Để default branch là temporary agent branch mà không ghi lifecycle status.
- Cho agent tự commit/push/deploy vì permission mode kỹ thuật cho phép command chạy.

## 17. Nguồn pattern đã đối chiếu

Guideline tổng hợp facts và engineering patterns, không copy source text. Public visibility không
đồng nghĩa với permissive license; private/proprietary repositories không được dùng làm reusable
text/template source. Chính `pi-setup` hiện cũng chưa cấp root license.

| Repository snapshot | Pattern được dùng |
|---|---|
| [`pi-setup@832fb38`](https://github.com/duy-tung/pi-setup/tree/832fb38db9ab00faaf53055deefb3ac8eb1531a7) | Global/project boundary, transactional setup, doctor, permission/trust, Pi workflow |
| [`pi-anthropic-oauth-plus@1996fbb`](https://github.com/duy-tung/pi-anthropic-oauth-plus/tree/1996fbbc3f0a8a3d3e36fc4ac4f4d1bb871d5d49) | Direct Pi dependency boundary, package checks and explicit operational caveats |
| [`go-service-template@f4203f7`](https://github.com/duy-tung/go-service-template/tree/f4203f7d797c19f372f6d3cc027b68e4798264d7) | Trust model, real-DB CI, migrations, config validation, Go service baseline |
| [`fleetstream@ed69c21`](https://github.com/duy-tung/fleetstream/tree/ed69c218ff5048a005071d485ebbffb170554594) | Makefile UX, CI parity, generated drift, nightly smoke and honest limitations; its `HEAD` installer is negative evidence, not a pinning model |
| [`serving-contracts@507208b`](https://github.com/duy-tung/serving-contracts/tree/507208b25737470b9eb2f9553a5c55f8f535f1d5) | Released contract pins, positive/negative fixtures, SemVer, immutable accepted ADRs |
| [`inference-lab@bb0c253`](https://github.com/duy-tung/inference-lab/tree/bb0c2537295bb77b5659518c544db9167abb1b06) | Pin ledger, measured quickstart, evidence provenance, explicit deviations/status |
| [`infergate@f362ceb`](https://github.com/duy-tung/infergate/tree/f362ceb7835c91182f19645a705de66af3017c82) | Race/concurrency/fault/contract test discipline |
| [`terraform-modules@158f07a`](https://github.com/duy-tung/terraform-modules/tree/158f07ab7f7c0de9bd596a0653a39d5168f2dd15) | Tagged module consumption and validate-before-release |
| [`platform-engineering@bbb34f6`](https://github.com/duy-tung/platform-engineering/tree/bbb34f651a58ce9c0ada16beb4bb613c16b1689a) | Environment/GitOps layout; also evidence for avoiding `latest` and masked test failures |
| [`pi-todos@c25c970`](https://github.com/duy-tung/pi-todos/tree/c25c9705ef85741ed65291ef7fb73716efd86d6e) | Historical precursor; negative evidence for install URLs that follow `main` |

Hai related repositories cũng được phân loại nhưng không dùng làm reusable template:

- [`dsh-anthropic-oauth@7e1c854`](https://github.com/duy-tung/dsh-anthropic-oauth/tree/7e1c85409bd8a428b35f87c6e2ddfc00323802e9)
  là adjacent DSH adapter, không phải Pi project authority.
- `claude-code-setup@4024e57` có proprietary/confidential license; audit chỉ dùng để phân loại và
  không lấy text/template/pattern từ repository đó.

Các standalone `pi-tree-rewind` và `pi-todos` cũ là historical sources; canonical implementations
hiện nằm trong `pi-setup`. Không dùng historical symlink/curl installation làm mẫu cho project mới.

## 18. Checklist duy nhất để copy vào issue

`Core` áp dụng cho mọi project. Chỉ giữ một dòng `Conditional` khi trigger trong ngoặc thực sự có.

```md
# Bootstrap <project>

## Core
- [ ] Outcome, in-scope/non-goals, owner, lifecycle status và licensing posture đã chốt.
- [ ] Project root hẹp; Git khởi tạo trên `main`.
- [ ] Execution/validation path rõ; manifest/runtime pin tồn tại khi ecosystem dùng; `.gitignore` tồn tại.
- [ ] README có quickstart, expected result và known limitations.
- [ ] Project `AGENTS.md` nêu source of truth, commands, boundaries và Definition of Done.
- [ ] Artifact/vertical slice đầu tiên kiểm chứng được.
- [ ] Một canonical lint/validate/test/smoke command phù hợp chạy pass.
- [ ] Formatter/whitespace check bao phủ file mới; diff check và `git status --short` đã inspect.
- [ ] Unverified checks/remaining risks được ghi rõ.

## Conditional — xóa dòng không áp dụng
- [ ] Dependency lockfile được commit (package manager tạo lockfile).
- [ ] `LICENSE` file tồn tại (owner chọn named license hoặc cấp explicit reuse/distribution terms).
- [ ] `.env.example` chỉ có placeholder; config precedence rõ (project dùng runtime config).
- [ ] Integration test dùng dependency thật và không silently skip trong CI (external contract).
- [ ] `up`/`down`/`smoke` có expected result và cleanup (service/local stack).
- [ ] CI gọi local verification, dùng minimal permissions và version policy (PR/publish).
- [ ] Visibility/default branch/branch protection được xác minh (remote collaboration).
- [ ] Generated artifact drift được kiểm (codegen).
- [ ] Migration/health/readiness/rollback được test (stateful deploy).
- [ ] Versioning, immutable artifact và release validation rõ (publish/deploy).
- [ ] Baseline commit/push được thực hiện với explicit authorization (agent thực hiện Git action).
```
