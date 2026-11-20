# pi-hc-subagents — Research & Feasibility Plan

> Mục tiêu: một pi extension dùng **herdr-core (`hc`)** làm backend terminal để tạo
> **subagent pi interactive**, có thể watch/attach/steer, nhận kết quả có cấu trúc,
> và không cần Herdr app.
>
> Trạng thái: research + PoC local. Chưa implement extension.
>
> Implementation spec (English): [`SPEC.md`](./SPEC.md).

---

## 0. TL;DR

| Câu hỏi | Kết luận |
|---|---|
| Có khả thi về kỹ thuật? | **Có, rất khả thi — 9/10.** `hc` có đủ API; pi 1.5+ đã report OSC 7501; session JSONL cho kết quả; parent/child lifecycle có sẵn. |
| Có đáng làm mới? | **Cần cân nhắc — 5/10 về product.** Đã có `pi-pier` (MIT, dùng đúng `hc` core) và nhiều extension subagent khác. |
| Nên làm gì? | Nếu mục tiêu là production/public: **dùng hoặc contribute cho `pi-pier`**, hoặc chọn một niche hẹp (remote-first / minimal / no-child-extension). Nếu mục tiêu là học hoặc công cụ cá nhân: làm **MVP nhỏ, local-first** theo plan này. |
| Kiến trúc khuyến nghị | Parent pi chạy trong `hc` terminal → extension nói **JSON-RPC trực tiếp** với core (`HC_TERMINAL_SOCKET`) → `terminal.run` một pi child interactive → theo dõi status/turn → đọc **session JSONL** của child để lấy kết quả. |
| Không nên làm | Không scrape screen để lấy final result; không dùng PTY `hc send` làm kênh machine-to-machine; không tự viết OSC 7501; không chạy `pi -p` one-shot. |
| Ước lượng | MVP: **5–8 ngày dev** (1–2 tuần lịch). v1 đầy đủ: **3–4 tuần**. Production/Windows/remote: **6–8+ tuần**. |

---

## 1. herdr-core cung cấp gì?

Nguồn: repo `herdr-core` (Apache-2.0), docs + schema + test local.

### 1.1 Terminal API

Các method chính (JSON-RPC 2.0, plain mode một JSON mỗi dòng):

| Method | Dùng để |
|---|---|
| `terminal.run` | Spawn program với `argv`, `cwd`, `env`, `parent`, `labels`, `name`, `no_notify`, `on` (remote machine), `size`, `wait` |
| `terminal.get` | Lấy record: `status`, `turn`, `parent`, `labels`, `state`, `exit_code`, `foreground`, `reported` |
| `terminal.list` | List/filter theo labels |
| `terminal.wait` | Wait một terminal hoặc `children: all/any`; trả `status`, `turn`, `reason` |
| `terminal.read` | Đọc screen + history (text; có `complete: false` khi full-screen app đang working) |
| `terminal.send` | Paste text + Enter (có `--if idle|working`, `--wait`, `--force`) |
| `terminal.keys` / `terminal.interrupt` | Gửi phím / dừng turn hiện tại |
| `terminal.label` | Set/xoá labels |
| `terminal.kill` / `terminal.rm` | Kết thúc / xoá terminal |
| `events.subscribe` | Snapshot + event stream (`created/status/turn/finished/labels/...`), filter theo terminal/children/labels |
| `file.read/write/edit` | File local hoặc remote (`on`) |
| `machine.*` | SSH/custom machines, remote execution |

`terminal.run` trả về ngay khi program chạy (nếu `wait: false`). Với `wait: true`,
nó đợi đến khi terminal không còn `working` và trả output — nhưng **startup `idle`
có thể bị coi là “đã dừng”**, nên không dùng mù quáng cho agent.

### 1.2 Status & turn

- Status **chỉ** đến từ chương trình qua **OSC 7501** (`idle`, `working`, `done`,
  `blocked`, `error`). Core không đoán từ screen.
- `turn` tăng mỗi khi root record rời `working`. Đây là tín hiệu rất hữu ích để
  biết một task/follow-up đã chạy xong.
- `terminal.wait` và `terminal.send --wait` dùng turn để tránh race “gửi xong
  nhưng chưa bắt đầu”.

### 1.3 Parent / children

- Một terminal spawn từ terminal khác sẽ là **child**, trừ khi `--no-parent` /
  `--outlive-parent`.
- Child mặc định **kết thúc khi parent program kết thúc**.
- Parent nhận note qua PTY (`<hc from="t7 name">…</hc>`) khi child blocked/error/exited,
  trừ khi `no_notify: true`.
- `hc wait --children all/any` hỗ trợ local + remote; nhưng có thể trả
  `reason: "message"` khi có người/agent nhắn vào parent, không chỉ khi child xong.

### 1.4 Điểm rất quan trọng cho thiết kế

1. **`hc run` CLI không có `--env`.** API `terminal.run` có `env`, CLI thì không.
   Nếu parent pi có provider key/PATH khác core, child có thể thiếu auth.
   → Dùng **direct API** cho spawn, hoặc chấp nhận core environment.
2. Core chạy nền; nó **không vẽ UI**. Herdr app chỉ là viewer tuỳ chọn.
3. API đang ở protocol generation 1, version 0.x; cam kết “API only grows” và có
   `released.openrpc.json` để chặn breaking change. Vẫn nên **pin version + contract test**.
4. `terminal.send` là **PTY input**, dành cho người. Dùng nó làm kênh điều khiển
   machine-to-machine sẽ đụng draft/người đang gõ, và làm bẩn transcript.

---

## 2. Pi cung cấp gì?

Nguồn: pi 1.5.2 docs/source.

| Tính năng | Ý nghĩa |
|---|---|
| Custom tools (`pi.registerTool`) | Tạo `hc_subagent`, `hc_subagent_control` |
| Events (`agent_settled`, `session_shutdown`, `input`, ...) | Lifecycle, cleanup, async delivery |
| `pi.sendMessage` / `sendUserMessage` | Inject result/notification vào parent |
| `ctx.ui.setWidget/setStatus` | Hiển thị trạng thái subagent |
| `ctx.sessionManager` | Session ID/file, entries |
| Session JSONL | Transcript đầy đủ của child, dùng làm **authoritative result** |
| Program status OSC 7501 | Pi tự report `working/done/blocked/error/idle` cho terminal |
| CLI `--session-id`, `--session-dir`, `@file`, `--append-system-prompt` | Child session deterministic + prompt từ file |
| SDK / RPC / JSON mode | Các alternative (không cần cho plan này) |

### 2.1 Pi ↔ hc status

Pi 1.5+ chỉ report OSC 7501 **sau khi terminal xác nhận hỗ trợ**. `hc` trả lời
query này (test `m3` trong herdr-core). Đã verify local:

```json
// hc 0.1.21, pi 1.5.2
{ "status": { "app": "pi", "state": "idle" }, "reported": true, "turn": 0 }
```

Sau một run lỗi model:

```json
{ "status": { "app": "pi", "state": "error", "msg": "..." }, "turn": 1 }
```

→ Không cần set `PI_PROGRAM_STATUS=1`; `hc` tự confirm. Trong tmux/screen thì
pi sẽ không report (đó là lý do extension này nên chạy trong `hc`).

### 2.2 Child launch contract đã verify

```text
pi
  --session-id <uuid>
  --session-dir <runDir>/sessions
  --name <child-name>
  [--model <provider/model>] [--thinking <level>]
  [--tools read,grep,find,ls] [--exclude-tools ...]
  [--append-system-prompt <runDir>/system.md]
  @<runDir>/task.md
```

- `--session-id` nhận UUID; session file nằm **trực tiếp** trong `--session-dir`
  (không có thư mục `--cwd--` khi custom dir):
  `<runDir>/sessions/<timestamp>_<uuid>.jsonl`.
- `@file` được expand thành user message (có wrapper `<file name=...>`).
- Session file được tạo ngay khi có user message, kể cả khi model lỗi.
- Final assistant message có `stopReason` (`stop`, `length`, `error`, `aborted`,
  `toolUse`, ...) và `errorMessage`/`usage`.

PoC đã chạy child pi trong `hc`, dùng `@task.md`, và đọc được session JSONL với
assistant `stopReason: "error"` + status `error`, turn 1. Chưa test success path
vì account/model local bị chặn quyền/balance; cơ chế file/status giống nhau.

### 2.3 PoC log (local, isolated `HC_SESSION`)

Môi trường: macOS, `hc 0.1.21`, `pi 1.5.2`, core riêng trong `/tmp/pi-hc-poc`
(`HC_SESSION`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` đều là
scratch path; không đụng core/terminal của user).

Đã verify:

1. `hc run --bg ... pi` → `hc get` thấy `status: {app:"pi", state:"idle"}`,
   `reported: true`; không cần `PI_PROGRAM_STATUS=1`.
2. Child pi với `--session-id/--session-dir/@task.md` tạo đúng file
   `<runDir>/sessions/<timestamp>_<uuid>.jsonl`; assistant cuối có
   `stopReason`, `errorMessage`, `usage`.
3. Khi model lỗi, `hc get` báo `status.state: "error"`, `turn: 1`; session
   JSONL chứa assistant `stopReason: "error"` — đủ để parent trả lỗi có cấu trúc.
4. `hc send --json --wait` trả `wait.status`/`wait.turn` đúng; `turn` tăng sau
   mỗi lượt.
5. Parent/child: child tạo từ parent có `parent: "t7"`; `hc send` từ child tới
   parent xuất hiện dạng `<hc from="t8 kid">…</hc>` (khi không `no_notify`).
6. `hc wait --children all` có thể trả `reason: "message"` khi có message tới
   parent — không được coi là “all done”.

Chưa verify / cần làm tiếp:

- Success path với model thật (account local bị permission/balance).
- Windows named pipe + ConPTY.
- Extension UI/tool thực tế; mới là PoC command-line.
- Remote `--on` + `file.read`/session label.

---

## 3. Kiến trúc đề xuất

```text
┌──────────────────────────────┐
│ Parent pi (trong hc terminal)│
│  extension: hc-subagents     │
│                              │
│  tools: spawn/wait/list/...  │
│  session JSONL của parent    │
└──────────────┬───────────────┘
               │ JSON-RPC (plain, JSONL)
               │ HC_TERMINAL_SOCKET
               ▼
┌──────────────────────────────┐
│ herdr-core (hc)              │
│  terminal registry/status    │
│  events/parent-child         │
└──────────────┬───────────────┘
               │ terminal.run(pi, argv, env, parent, no_notify)
               ▼
┌──────────────────────────────┐
│ Child hc terminal            │
│  pi interactive              │
│  OSC 7501 → core status      │
│  session JSONL → result      │
│  human có thể attach/steer   │
└──────────────────────────────┘
```

### 3.1 Vì sao dùng direct JSON-RPC thay vì CLI?

| Tiêu chí | `hc` CLI | Direct JSON-RPC |
|---|---|---|
| Spawn với `env` tuỳ chỉnh | ❌ (CLI không có `--env`) | ✅ |
| Latency mỗi call | Process spawn (~10–30ms) | Socket call (~1ms) |
| Event stream/status realtime | Phải spawn `hc events` | ✅ `events.subscribe` |
| Windows pipe | CLI xử lý | Tự xử lý `\\.\pipe\...` |
| Độ phức tạp | Thấp | ~150–300 LOC cho client tối thiểu |
| Phù hợp MVP | ✅ để PoC | ✅ khuyến nghị production |

**Khuyến nghị:** MVP có thể bắt đầu bằng CLI wrapper để validate UX, nhưng
spawn nên dùng direct API để truyền environment. Nếu làm direct client ngay,
chỉ cần một file `core-client.ts` nhỏ: connect socket, gửi JSON line, đọc reply,
map `error.data.kind`.

### 3.2 Kênh giao tiếp parent ↔ child

| Kênh | Dùng cho | Đánh giá |
|---|---|---|
| `terminal.run` argv + `@task.md` | Initial task | ✅ Nên dùng. Không shell, không race, không PTY. |
| `terminal.send` | Follow-up / steer | ⚠️ Chỉ nên dành cho người; máy gửi có thể đụng draft/người. |
| Private pipe (Unix socket/named pipe) | Prompt/follow-up máy ↔ máy | ✅ Tốt nhất về lâu dài (pier dùng cách này), nhưng thêm ~300–500 LOC. |
| `hc send` note của core | Child báo parent | ❌ Không dùng: PTY input thuộc về người; dễ lẫn với user message. |
| Session JSONL | Final result | ✅ Authoritative, không lossy. |
| Screen `terminal.read` | Progress/blocked/fallback | ⚠️ Lossy, có TUI chrome; chỉ dùng khi không có session/result. |
| `subagent_report` tool (child extension) | Batch/headless result | ✅ Deterministic; cần child extension + report file. |

**Khuyến nghị MVP:** initial task qua argv; result qua session JSONL; follow-up
tạm dùng `terminal.send` (document rõ) hoặc defer. v1 thêm private pipe.

### 3.3 Kết quả từ child session

Parent biết chính xác session file vì tự chọn `--session-id` + `--session-dir`:

```text
<runDir>/sessions/<timestamp>_<uuid>.jsonl
```

Parser tối thiểu:

1. Đọc JSONL (ưu tiên tail vài MB; fallback full).
2. Bỏ qua dòng lỗi/partial.
3. Tìm `message` role `assistant` mới nhất.
4. `stopReason`:
   - `stop` / `length` → final text (length kèm warning).
   - `error` → error message.
   - `aborted` → aborted.
   - `toolUse` / `pending` → chưa xong; nếu status done thì retry/read lại.
5. Sum `usage` các assistant message sau thời điểm spawn.
6. Fallback: status + screen tail + session path.

**Không** dùng screen làm nguồn final result. Screen chỉ để debug/blocked.

---

## 4. Tool surface đề xuất

### 4.1 `hc_subagent`

Spawn một hoặc nhiều child.

```ts
{
  agent: string,                 // tên agent definition
  task?: string,                 // single mode
  cwd?: string,
  model?: string,                // override
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max",
  mode?: "sync" | "async",       // default sync
  tasks?: { agent, task, cwd?, model?, thinking? }[],  // parallel
  chain?: { agent, task, cwd? }[],                     // optional
  agentScope?: "user" | "project" | "both",
  confirmProjectAgents?: boolean
}
```

Trả về:

```text
started hc-reviewer-3f2a (t12)
session: ~/.pi/agent/hc-subagents/runs/<runId>/sessions/....jsonl
attach:  hc attach t12
```

Sync mode đợi đến khi settle rồi trả final text + usage + status.
Async mode trả ngay; khi settle, extension inject custom message
`hc-subagent-result` (không phải user message) và trigger turn.

### 4.2 `hc_subagent_control`

```ts
{
  action: "list" | "wait" | "output" | "result" | "send" |
          "interrupt" | "kill" | "attach",
  id?: string,          // terminal address/name hoặc slug
  message?: string,     // send
  timeoutMs?: number,   // wait
  lines?: number        // output/read
}
```

| Action | Hành vi |
|---|---|
| `list` | Danh sách child của session hiện tại + status/turn/agent/cwd |
| `wait` | Đợi một hoặc tất cả child settle; trả kết quả |
| `output` | Progress gần nhất (session tail hoặc screen), **không** phải final |
| `result` | Đọc lại final text từ session file |
| `send` | Follow-up qua `terminal.send` (có `wait`); không `force` |
| `interrupt` | `terminal.interrupt` (dừng turn, không kill) |
| `kill` | `terminal.kill` + `rm` |
| `attach` | Trả command `hc attach <addr>`; extension không tự attach TUI |

Tên tool nên có prefix `hc_` để tránh conflict với các extension subagent khác.

---

## 5. Agent definitions

Tái sử dụng format quen thuộc:

```md
---
name: reviewer
description: Read-only code review
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-5
thinking: medium
access: read-only
---
You are a focused review agent...
```

Discovery:

- User: `~/.pi/agent/agents/*.md`
- Project: `<nearest>/.pi/agents/*.md` (chỉ khi trusted + confirm)
- Package: `agents/*.md` (fallback)

`access: read-only` → chỉ cho phép `read/grep/find/ls` (và có thể `bash` nếu
agent thật sự cần, nhưng phải document rủi ro write). `access: write` mới cho
`edit/write/bash`.

### 5.1 Prompt cho child

Nên có một preamble cố định:

```text
You are a delegated subagent in a separate pi session.
Complete the task autonomously. Your final assistant message is the result;
make it self-contained and concise.
Do not spawn subagents. Do not ask for confirmation unless truly blocked.
If you need a human decision, stop and state exactly what you need.
Stay within the assigned files/scope.
```

Agent body + preamble → `--append-system-prompt <file>`.
Task + context → `@task.md`.

---

## 6. State machine & lifecycle

### 6.1 Parent-side state

```text
queued
  → starting        (terminal.run OK; chờ pi nhận task)
  → working         (status working, hoặc turn chưa tăng)
  → blocked         (status blocked; cần người)
  → done/error      (status done/error)
  → exited          (terminal finished)
  → collected       (đã đọc session/result)
```

Lưu ý startup:

- Pi report `idle` lúc mới start, **trước khi** task chạy.
- Không được coi `idle + turn 0` là “xong”.
- Đợi đến khi:
  - `turn > 0`, hoặc
  - `status ∈ {working, blocked, error}`, hoặc
  - terminal `finished`, hoặc
  - timeout startup (60s) → trả “not started” + screen.

Sau khi đã started, `done/error/idle + turn > 0` là settled.

### 6.2 Spawn

```ts
terminal.run({
  argv: [piBin, ...piArgs],
  cwd,
  env: childEnv,                 // process.env bỏ HC_*, thêm marker
  caller: parentTerminalId,
  parent: parentTerminalId,
  no_notify: true,               // PTY thuộc về người
  labels: {
    "pi-hc-subagents": "1",
    "pi-hc-run": runId,
    "pi-hc-agent": agentSlug,
    "pi-hc-child": childId,
  },
  name: `hc-${agentSlug}-${shortId}`,
});
```

`childEnv`:

```ts
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k.startsWith("HC_")) continue;        // core tự set identity cho child
  if (k.startsWith("PI_SESSION_")) continue; // tránh stale session metadata
  env[k] = v;
}
env.PI_HC_SUBAGENT = "1";
env.PI_HC_PARENT_SESSION = parentSessionId;
env.PI_HC_RUN_ID = runId;
```

### 6.3 Cleanup

- Child mặc định `die_with_parent` → parent pi chết là child chết.
- `session_shutdown` (quit/new/resume/reload) → kill các child của session.
- Tool abort (Esc) → `terminal.interrupt`; nếu vẫn working sau grace 5s →
  `terminal.kill` (config `killOnAbort`, default true cho sync).
- Nếu parent ngoài hc (không có `HC_TERMINAL_ID`) → không có parent-child;
  extension phải tự kill on shutdown. MVP: **không hỗ trợ**, trả lỗi hướng dẫn.
- Core restart → child vẫn sống; extension reconnect, resnapshot event;
  không kill chỉ vì mất kết nối tạm thời.

---

## 7. Async delivery

Khi child settle ở async mode:

1. Đọc session file → final text/usage/status.
2. `pi.sendMessage({
     customType: "hc-subagent-result",
     content: "<bounded summary + result>",
     display: true,
     details: { ... }
   }, { triggerTurn: true, deliverAs: "steer" })`.
3. Nếu parent đang compacting: queue lại, flush sau `agent_settled`/`compaction_end`.
4. Tránh flood: gộp nhiều result trong một message hoặc giới hạn 3 result/lần.

Không dùng `sendUserMessage` cho result vì sẽ bị coi là user instruction.
Custom message rõ nguồn gốc và có renderer riêng.

---

## 8. UI

MVP:

- `ctx.ui.setStatus("hc-subagents", "1 running")` — footer.
- `ctx.ui.setWidget("hc-subagents", lines)` — một dòng/child:
  `↳ reviewer  working  2m  gpt-6.1-sol  path/to/repo`
- Custom renderer cho tool result và async message.
- `/hc-subagents` command: list / wait / kill / attach instructions.

Không cần Herdr app. Nếu có app, child sẽ hiện dưới parent (hoặc thành pane nếu
set labels `herdr.space`/`herdr.tab` — optional, app-specific).

---

## 9. Prior art — rất quan trọng

Đây là phần thay đổi quyết định “build hay không build”.

| Project | Backend | Result | Điểm mạnh | Bài học |
|---|---|---|---|---|
| **`pi-pier`** (July24, MIT) | **hc core direct** | session JSONL + private pipe + labels | Gần như đúng ý tưởng này; interactive, attach, async, wait, pipe, worktree, todo; ~17.5k LOC | PTY ≠ machine channel; status chỉ từ OSC 7501; child env; parent-child; event watch; session attribution |
| `@maxiaochao/pi-herdr-subagents` | Herdr app | `subagent_report` tool + atomic files | State machine rõ, batch, concurrency, write safety, durable records | Report protocol; atomic rename; one task/process; reminder khi thiếu report |
| `edxeth/pi-subagents` | Herdr app + cmux/tmux/... | JSON/session + result router | Background/interactive, orchestrator mode, timeout, widget | Async delivery; timeout/inactivity; tool surface |
| `pi-herdsman` (Apache-2.0) | Herdr app | agent/lead/manager | Full orchestration, roles, remote/containers | Role/permission boundaries; quá lớn cho MVP |
| `modem-dev/pi-herdr-subagents` | Herdr app plugin | pane/session | Non-blocking, steer | Async steer pattern; dùng package pi cũ |
| Pi bundled `examples/extensions/subagent` (MIT) | subprocess JSON mode | JSON events | Đơn giản, agent discovery, TUI | Baseline; không interactive/attach, block |

### 9.1 Kết luận cạnh tranh

- Nếu chỉ cần “subagent chạy trong terminal, watch/attach, async” → **`pi-pier` đã làm tốt**.
- Nếu cần **remote machine** (hc `--on`) → có thể là niche thật; pier hiện local-only.
- Nếu cần **minimal, không child extension, không pipe, dễ audit** → MVP này có chỗ đứng.
- Nếu cần **deterministic batch/headless** → report protocol của `@maxiaochao` đáng học.
- Đừng cố làm full framework (todo + worktree + roles + remote + app UI) ngay.

### 9.2 Các lỗi thiết kế đã được prior art trả giá

1. **PTY injection cho machine messages** → đụng người đang gõ, bẩn transcript,
   khó phân biệt user với child. Dùng private pipe hoặc argv.
2. **Tự viết OSC 7501** → tranh status ownership với pi; pi 1.5 đã report đủ.
3. **Scrape screen để lấy final text** → mất markdown, wrap, TUI chrome, lossy.
4. **Chạy `pi -p` one-shot** → không watch/steer/resume được; herdr skill cấm.
5. **Quên truyền env cho child** → child thiếu API key/PATH; CLI `hc run` không có `--env`.
6. **Tìm session file theo mtime** → gán nhầm session của agent khác. Dùng
   `--session-id` + `--session-dir` cố định.
7. **Không phân biệt startup idle với settled** → báo xong trước khi task chạy.
8. **Parallel write agents cùng cwd** → race file. Chặn parallel nếu write-capable.
9. **Không cleanup child** → leak terminal/process. Dùng parent-child + session_shutdown.
10. **Tool description quá dài** → tốn token mỗi request; giữ schema gọn, manual
    tách riêng (bài học D127 của pier).
11. **Report/progress tool không ai gọi** → bỏ (D125 của pier).
12. **Không có contract test với `hc schema`** → core update có thể làm client chết.

---

## 10. Scope đề xuất

### MVP (bắt buộc)

- [ ] Detect `HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`; nếu thiếu → không register tool,
      hiện hướng dẫn `hc run --bg --name pi pi`.
- [ ] Direct core client: `terminal.run/get/wait/read/send/interrupt/kill/rm/label`.
- [ ] Agent discovery user-level (chưa cần project).
- [ ] Spawn một child pi interactive với session-id/dir, task file, system prompt file.
- [ ] Sync wait + final result từ session JSONL + usage.
- [ ] Status widget đơn giản.
- [ ] `list`, `output`, `kill`, `attach` command string.
- [ ] Cleanup on `session_shutdown`; abort → interrupt.
- [ ] Error/blocked handling: trả screen tail + attach hint, không tự trả lời dialog.
- [ ] Unit tests cho session parser + argv builder + status state machine.
- [ ] Integration test với isolated `HC_SESSION` (fake child hoặc pi lỗi model).

**Definition of Done MVP:**

- Trong một repo, gọi `hc_subagent({agent:"reviewer", task:"Review X"})` → trả
  final text đúng, có session path, usage.
- `hc ls` thấy child; `hc attach <addr>` xem/steer được.
- Parent quit → child chết, không leak.
- Child bị block quyền → parent trả blocked + screen + hướng dẫn, không tự force.
- Không có screen scraping trong happy path.

### v1

- [ ] Async mode + result message + widget update.
- [ ] Parallel read-only, max concurrency, write-capable parallel rejection.
- [ ] Project agents + trust confirmation.
- [ ] Private pipe cho prompt/follow-up (bỏ PTY machine channel).
- [ ] Persist registry (`pi.appendEntry`) + list after resume.
- [ ] Better output/progress từ session tail (tool name, last text).
- [ ] Timeout/inactivity, stalled warning.
- [ ] Windows path/pipe test; macOS/Linux CI.

### v2 / optional

- [ ] Remote subagents (`terminal.run { on: machine }`) + `file.read` remote.
- [ ] Git worktree isolation cho parallel writers.
- [ ] Resume/fork child session; nested delegation (opt-in).
- [ ] Herdr app pane placement labels.
- [ ] Report protocol cho headless/deterministic batch.
- [ ] Orchestrator mode (parent only delegates).

### 10.1 Cấu trúc repo đề xuất

```text
pi-hc-subagents/
  package.json              # pi-package, pi.extensions: ["./index.ts"]
  index.ts                  # register tools/commands, lifecycle wiring
  src/
    core-client.ts          # JSON-RPC tối thiểu tới HC_TERMINAL_SOCKET
    hc-types.ts             # decode Terminal/Status/Event
    agents.ts               # discovery + frontmatter
    child-spawn.ts          # argv/env/session dir/task/system file
    child-session.ts        # JSONL parser, final text/usage/stopReason
    registry.ts             # in-memory + pi.appendEntry persistence
    status.ts               # startup/settled state machine
    result.ts               # format tool result / async message
    ui.ts                   # widget/status/renderers
    config.ts               # global/project config + defaults
  agents/                   # built-in sample agents (reviewer, scout, worker)
  test/
    fixtures/               # session JSONL fixtures, hc schema snapshot
    *.test.ts
```

Module boundaries quan trọng:

- `core-client.ts` **không** biết gì về pi; test được bằng fake socket server.
- `child-session.ts` là pure parser; test bằng fixtures (stop/error/aborted/toolUse/compaction).
- `status.ts` là pure reducer/state machine; test không cần hc.
- `child-spawn.ts` build argv/env; test snapshot, không chạy pi thật.
- `index.ts` chỉ wiring; hạn chế business logic.

---

## 11. Rủi ro & giảm thiểu

| Rủi ro | Khả năng | Tác động | Giảm thiểu |
|---|---|---|---|
| `hc` API đổi (0.x) | Trung bình | Cao | Pin version; contract test `hc schema`; fallback CLI; feature-detect method |
| Child thiếu auth/PATH | Trung bình | Cao | Direct `terminal.run` + truyền `process.env` (bỏ `HC_*`); test provider key |
| Startup idle bị coi là done | Cao nếu không xử lý | Cao | State machine chờ `turn>0`/working/blocked/error; grace 60s |
| Session final text chưa flush | Trung bình | Trung bình | Retry đọc 5×100ms; chỉ nhận `stopReason` terminal; fallback screen |
| Child bị block dialog | Trung bình | Trung bình | Surface + attach; không auto-answer/force |
| Parallel writes race | Cao nếu cho phép | Cao | Read-only parallel; write → concurrency 1; worktree sau |
| PTY follow-up conflict | Trung bình | Trung bình | v1 private pipe; MVP document + `--if idle` |
| Leak child khi parent crash | Trung bình | Trung bình | parent-child (die_with_parent); session_shutdown; ngoài hc → không hỗ trợ |
| Prompt injection từ child output | Trung bình | Cao | Treat child output as data; prompt guidelines; không auto-follow instructions |
| Cost bùng nổ | Cao | Cao | maxConcurrency, usage/cost, timeout, task scope nhỏ |
| Conflict với extension khác | Cao | Trung bình | Namespace tool `hc_*`; không trùng `subagent`; document |
| Windows named pipe/path | Trung bình | Trung bình | Test sớm hoặc document unsupported MVP |
| Session format đổi | Thấp | Trung bình | Dùng type/schema documented; fixtures; fallback details |

---

## 12. Ước lượng

| Phase | Nội dung | Thời gian |
|---|---|---|
| 0 | Research/PoC (đã làm) | 1 ngày |
| 1 | MVP transport + single agent + result + cleanup | 5–8 ngày |
| 2 | Async + parallel + UI + abort/timeout | 5–8 ngày |
| 3 | Private pipe + project agents + persistence | 5–8 ngày |
| 4 | Hardening: Windows, reconnect, contract tests, docs | 5–10 ngày |
| 5 | Remote/worktree/orchestrator | 2–4+ tuần |

Tổng MVP thực tế: **1.5–2.5 tuần** cho một dev quen TypeScript/pi.
v1 production-ish: **4–6 tuần**. Full feature parity với pier: **không nên** trừ khi
đó là mục tiêu sản phẩm.

---

## 13. Quyết định & câu hỏi mở

Trước khi implement, cần chốt:

1. **Mục tiêu**: công cụ cá nhân / public package / học tập / thay thế pier?
2. **Phạm vi**: local-only hay cần remote machines? Windows?
3. **UX**: blocking (tool chờ) hay async (spawn rồi notify)? Có cần follow-up/steer?
4. **Agent definitions**: dùng chung `~/.pi/agent/agents` hay riêng?
5. **Result protocol**: session JSONL (đơn giản) hay child report tool (deterministic)?
6. **Có chấp nhận child extension** (private pipe/report) hay muốn zero child-side code?
7. **Có cần Herdr app** hay chỉ core + `hc attach`?

### Khuyến nghị cuối

- Nếu câu trả lời là “tôi muốn dùng ngay, không cần tự viết”: cài **`pi-pier`**
  (`pi install npm:pi-pier`) và dùng; nó đã làm đúng core integration.
- Nếu muốn tự làm: làm **MVP local-first** ở trên, direct client, session JSONL,
  không PTY machine channel; giữ scope nhỏ; đừng làm todo/worktree/roles.
- Nếu muốn khác biệt: chọn **remote-first** (`hc machine`) hoặc **minimal/auditable**
  (không child extension, không app, một file client nhỏ).

---

## 14. Nguồn tham khảo

- herdr-core: `README.md`, `docs/commands.md`, `docs/templates.md`, `docs/machines.md`,
  `docs/security.md`, `schema/README.md`, `schema/hc.openrpc.json`, `crates/herdr-core/src/SKILL.md`
- pi: `docs/extensions.md`, `docs/session-format.md`, `docs/message-types.md`,
  `docs/program-status` trong `docs/terminal-setup.md`, `docs/cli.md`,
  `examples/extensions/subagent/`, `docs/cli-integration.md`, `docs/sdk.md`
- Prior art:
  - `github.com/July24/pier` (`pi-pier`, MIT)
  - `github.com/chaochaoxiaochao/pi-toolkit` → `@maxiaochao/pi-herdr-subagents`
  - `github.com/edxeth/pi-subagents` (MIT)
  - `github.com/boadij/pi-herdsman` (Apache-2.0)
  - `github.com/modem-dev/pi-herdr-subagents`
- Local PoC: hc 0.1.21 + pi 1.5.2, isolated `HC_SESSION` (`/tmp/pi-hc-poc`).

---

## 15. Implementation status (phase 15)

Phases 1–15 are implemented. The release candidate adds the M3+ extension points that
were designed in §3 and §10:

- `registerProvider` / `registerResultAdapter` on intertool service v1.
- Built-in `HcLocalProvider` and `PiSessionResultAdapter` (result.json first, else session
  JSONL; never screen scraping).
- `backend`-based provider selection, `unsupported_backend` for unknown backends, and
  failure containment that marks a run failed instead of crashing the parent.
- Provider validation remains host-mediated: agent discovery, project trust/confirmation,
  cwd checks, and scheduler admission all happen before spawn.
- Release hardening: security tests (redaction, file modes, force prevention), a package
  install smoke job in CI, `AGENTS.md`, and refreshed README/SPEC/PLAN documentation.

Windows named pipes/ConPTY, remote `hc` machines, worktree isolation, and nested
orchestration remain Milestone 4 (not part of this release).
