"""
MJ 生图桥接服务（改造副本）—— 把本机 Midjourney 自动化包装成 OpenAI 兼容接口。

来源: E:\codex\niannianai\zhuanhuiyuangong\infinite-canvas\tools\mj-bridge\server.py
原版从未跑通（.results 为空、无成功记录）。本副本修复点：
  1. RUNNER 指向本目录的 mj_run.js（改造副本），而不是原目录
  2. 默认产物目录改为 MJ_OUTPUT_DIR（默认 ..\output），不再用原目录的 .results
  3. 把 status / rejected / recordId / seconds 透传给调用方，
     让「生成成功但下载不合格」不再被伪装成成功
  4. 失败时把 status 与 rejected 明细带进错误响应，便于 Multica 侧判定重试策略
  5. 新增 GET /v1/receipts 读取回执台账（只读，便于对账）
  6. /health 增加代理、适配器、profile、依赖路径的自检信息

为什么要它：
  mxai_adapter.js 是 Playwright 浏览器自动化，必须跑在已登录 mxai.cn 的桌面机上。
  Codex / Multica / 画布都不能直接调它，所以中间加一层 HTTP。

为什么是 OpenAI 兼容格式：
  画布渠道系统原生支持 OpenAI 协议，填本服务地址 + 模型名 midjourney 即可用。

启动：
  pip install -r requirements.txt
  python server.py            # 默认监听 127.0.0.1:8765

注意：
  - 只监听 127.0.0.1，不对外暴露。
  - 生成是付费动作（约 6 积分/次），调用即消耗账号积分。
  - 服务本身不做登录。未登录时返回 401，需要人工在浏览器窗口登录一次。
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import shutil
import sys
import time
import uuid
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse, RedirectResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from batch_queue import BatchError, BatchManager, JobNotFound
from workbench_params import prepare_request, request_fingerprint
from workbench_assets import AssetLibrary, image_type

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "mj_run.js"
# 【2026-09-14】看护脚本路径。补下载演练（recover-dryrun）会以只演练方式调它。
WATCHDOG = HERE / "watchdog_mj_bridge.ps1"
# 【2026-09-14.4】免管理员自启安装脚本（走登录启动项，不弹 UAC）。
INSTALL_USER_AUTOSTART = HERE / "install_autostart_user.ps1"
RESULTS_DIR = Path(os.environ.get("MJ_OUTPUT_DIR", str(HERE.parent / "output")))
CONTROL_DIR = HERE.parent / "control"
CONTROL_HTML = CONTROL_DIR / "index.html"
CONTROL_BROWSER = HERE / "browser_control.js"
RUN_ROOT = Path(os.environ.get("MJ_RUN_DIR", str(HERE.parent / "run")))
CONTROL_STATE = RUN_ROOT / "control-browser.json"
CONTROL_STOP_FILE = CONTROL_STATE.with_suffix(".stop")
CONTROL_LOG = RUN_ROOT / "logs" / "control-browser.log"
SLOT_LOGIN_ROOT = RUN_ROOT / "slot-login"
CONTROL_PAUSE = RUN_ROOT / "bridge-control-paused"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# 【2026-09-12.3】后台作业目录，必须与 mj_run.js 里的 run/jobs 完全一致，否则查不到结果。
JOBS_DIR = Path(os.environ.get("MJ_JOBS_DIR", str(HERE.parent / "run" / "jobs")))
JOBS_DIR.mkdir(parents=True, exist_ok=True)
BATCHES_DIR = Path(os.environ.get("MJ_BATCHES_DIR", str(HERE.parent / "run" / "batches")))
BATCHES_DIR.mkdir(parents=True, exist_ok=True)
BATCH_SLOT_ROOT = Path(os.environ.get("MJ_BATCH_SLOT_ROOT", str(HERE.parent / "run" / "batch-slots")))
BATCH_SLOT_ROOT.mkdir(parents=True, exist_ok=True)

MODEL_NAME = os.environ.get("MJ_BRIDGE_MODEL", "midjourney")
DEFAULT_VERSION = os.environ.get("MJ_BRIDGE_VERSION", "v8.2")
DEFAULT_TIMEOUT_MS = int(os.environ.get("MJ_BRIDGE_TIMEOUT_MS", "1200000"))
MAX_N = int(os.environ.get("MJ_BRIDGE_MAX_N", "15"))

# 【2026-09-12】构建标记。用途：外部只能通过 /health 判断"跑的是不是改过之后的代码"。
# 上一版的 /health 新旧完全一致，导致无法确认重启是否成功（只能靠猜）。
# 每次改完 server.py 都把这个号 +1，重启后 /health 的 bridge 字段会跟着变。
BRIDGE_BUILD = "2026.10.08.1"
BRIDGE_ID = "multica-local-draw-bridge"
INSTALL_ROOT = Path(os.environ.get("MULTICA_INSTALL_ROOT", str(HERE.parents[1]))).resolve()
BUNDLED_NODE = INSTALL_ROOT / "runtime" / "node" / "node.exe"
NODE_EXE = Path(os.environ.get("MXAI_NODE_EXE", str(BUNDLED_NODE if BUNDLED_NODE.exists() else shutil.which("node") or "node")))
BRIDGE_FEATURES = [
    "timeout_1200s",
    "queued_202_pending",
    "single_file_images_compat",
    "aspect_eight_slots",
    "jobs_api",
    "bg_job_dedupe",
    "readonly_selfcheck",
    "ps1_bom_guard",
    "free_redownload",
    "terminal_failure_split",
    "serial_bound_download",
    "chinese_output_names",
    "recover_dryrun",
    "user_autostart_no_admin",
    "safe_stop_for_selfheal",
    "local_workbench", "validated_params", "durable_dispatch_intent", "asset_library", "explicit_phases",
]

# 上游依赖位置，只用于 /health 自检展示
ADAPTER_PATH = Path(os.environ.get("MXAI_ADAPTER_PATH", str(HERE / "mxai_adapter.js")))
PROFILE_PATH = Path(os.environ.get("MXAI_PROFILE", str(INSTALL_ROOT / "runtime" / "browser-profile")))
NODE_MODULES = Path(os.environ.get("MXAI_NODE_MODULES", str(INSTALL_ROOT / "runtime" / "node_modules")))
PROXY = os.environ.get("MXAI_PROXY", "127.0.0.1:7897")
os.environ.setdefault("MJ_PYTHON", sys.executable)

app = FastAPI(title="MJ Bridge", version="1.1")

# 保留画布 API 跨域契约；工作台私有接口另由 control_origin_guard 限制。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def control_origin_guard(request, call_next):
    # Canvas generation API remains compatible; private workbench APIs are same-origin.
    origin = request.headers.get("origin")
    if request.url.path.startswith("/control/") and origin:
        allowed = {f"http://{request.headers.get('host', '')}"}
        if origin not in allowed:
            return JSONResponse(status_code=403, content={"detail": "工作台接口仅允许本地页面同源访问"})
    return await call_next(request)


class GenerationRequest(BaseModel):
    prompt: str = ""
    model: str | None = None
    n: int = Field(default=1, ge=1, le=MAX_N)
    size: str | None = None
    quality: str | None = None
    aspect: str | None = None
    mode: str | None = None
    output_name: str | None = None


def size_to_aspect(size: str | None, fallback: str = "9:16") -> str:
    """把画布传来的像素尺寸（如 1024x1536）换算成 MJ 的 --ar 比例。

    【2026-09-12 更正】中文版 MXAI 页面实测为八档：1:1 / 1:2 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3。
    旧注释「只有四档、9:16 归到 1:2」是错的，适配器曾按此静默降级，
    导致 9:16 / 1080x1920 的产出规格全错。现在 9:16 直通 9:16，绝不降级。
    仅当页面确实没有该档（如 4:5 / 5:4）才就近兜底，并把降级事实写进回执 aspect_note。
    """
    if not size:
        return fallback
    try:
        width, height = (int(part) for part in size.lower().replace(" ", "").split("x", 1))
    except (ValueError, AttributeError):
        return fallback
    if width <= 0 or height <= 0:
        return fallback
    ratio = width / height
    candidates = {
        "1:1": 1.0,
        "9:16": 9 / 16,
        "16:9": 16 / 9,
        "2:3": 2 / 3,
        "3:2": 3 / 2,
        "3:4": 3 / 4,
        "4:3": 4 / 3,
        "4:5": 4 / 5,
        "5:4": 5 / 4,
    }
    name, _ = min(candidates.items(), key=lambda item: abs(item[1] - ratio))
    return name


def run_mj(prompt: str, aspect: str, timeout_ms: int, mode: str = "normal", output_name: str | None = None) -> dict:
    """调 Node 侧跑一次生图，返回解析后的结果字典。"""
    if not RUNNER.exists():
        raise HTTPException(status_code=500, detail=f"缺少 {RUNNER}")
    task_id = f"mj_{uuid.uuid4().hex[:8]}"
    command = [
        str(NODE_EXE),
        str(RUNNER),
        "--prompt",
        prompt,
        "--aspect",
        aspect,
        "--mode",
        mode,
        "--out-dir",
        str(RESULTS_DIR),
        "--prefix",
        task_id,
        "--output-name",
        output_name or "生成结果",
        "--task-id",
        task_id,
        "--version",
        DEFAULT_VERSION,
        "--timeout",
        str(timeout_ms),
    ]
    started = time.time()
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_ms / 1000 + 120,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail={"status": "timeout", "message": f"MJ 生成超时（>{timeout_ms} ms）", "taskId": task_id},
        )

    stdout = (completed.stdout or "").strip()
    if not stdout:
        tail = (completed.stderr or "").strip().splitlines()[-5:]
        raise HTTPException(
            status_code=502,
            detail={"status": "no_output", "message": "MJ 桥接没有返回结果：" + " | ".join(tail), "taskId": task_id},
        )

    try:
        payload = json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=502,
            detail={"status": "unparsable", "message": "MJ 桥接返回了无法解析的内容：" + stdout[:200], "taskId": task_id},
        )

    payload["seconds"] = round(time.time() - started, 1)
    payload["taskId"] = task_id

    if completed.returncode == 2 or payload.get("needLogin"):
        raise HTTPException(
            status_code=401,
            detail={
                "status": "need_login",
                "message": payload.get("error") or "MXAI 未登录",
                "taskId": task_id,
            },
        )
    return payload


def file_to_b64(path_value: str) -> str:
    data = Path(path_value).read_bytes()
    mime = mimetypes.guess_type(path_value)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


@app.get("/health")
def health():
    node_available = NODE_EXE.is_file() or shutil.which(str(NODE_EXE)) is not None
    playwright_available = (NODE_MODULES / "playwright" / "package.json").is_file()
    runner_available = RUNNER.is_file()
    adapter_available = ADAPTER_PATH.is_file()
    runtime_ready = node_available and adapter_available and playwright_available and runner_available
    return {
        "ok": True,
        "bridgeId": BRIDGE_ID,
        "installRoot": str(INSTALL_ROOT),
        "runtime": {
            "ready": runtime_ready,
            "nodeAvailable": node_available,
            "playwrightAvailable": playwright_available,
            "runnerAvailable": runner_available,
            "adapterAvailable": adapter_available,
        },
        "model": MODEL_NAME,
        "version": DEFAULT_VERSION,
        "runner": str(RUNNER),
        "runnerExists": RUNNER.exists(),
        "adapter": str(ADAPTER_PATH),
        "adapterExists": ADAPTER_PATH.exists(),
        "profile": str(PROFILE_PATH),
        "profileExists": PROFILE_PATH.exists(),
        "nodeModules": str(NODE_MODULES),
        "nodeModulesExists": NODE_MODULES.exists(),
        "outputDir": str(RESULTS_DIR),
        "proxy": PROXY,
        "note": "代理需在线，否则 MXAI 页面会卡在加载。",
        # ↓ 判断"是否已重启到最新代码"只看这两项，不要看 version（那是 MJ 模型版本）。
        "bridge": BRIDGE_BUILD,
        "features": BRIDGE_FEATURES,
        "timeoutMs": DEFAULT_TIMEOUT_MS,
        "maxN": MAX_N,
    }


@app.get("/v1/models")
def list_models():
    """画布的「拉取模型列表」会打这个接口。"""
    return {
        "object": "list",
        "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "mxai"}],
    }


@app.get("/v1/receipts")
def receipts(tail: int = 20):
    """只读回执台账。每条真实出图都会追加一行，用于对账与复盘。"""
    path = Path(os.environ.get("MJ_RECEIPTS_DIR", str(HERE.parent / "receipts"))) / "mxai-tasks.jsonl"
    if not path.exists():
        return {"ok": True, "path": str(path), "count": 0, "items": []}
    lines = [line for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    items = []
    for line in lines[-max(1, min(tail, 500)):]:
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            items.append({"raw": line, "parseError": True})
    return {"ok": True, "path": str(path), "count": len(lines), "items": items}



# =====================================================================
# 【2026-09-12.5】只读自检接口
# =====================================================================
# 为什么要有：改脚本靠肉眼数括号不可靠，一个多余的 } 就能让无人值守重启静默失效。
# 这个入口只跑语法解析，不启动浏览器、不出图、不扣积分，改完随时能验证。
# 【2026-09-12 稳定性】新增 autostart：只读查询开机自启/看护两个计划任务的注册状态。
# 为什么需要：自启装没装、看护有没有动作，不该靠人去翻任务计划程序界面。
ALLOWED_MAINTENANCE_MODES = {"lint", "lint-prompt", "env", "netstat", "autostart", "aspect-check", "dl-serial", "restart-bridge", "recover-dryrun", "autostart-install", "stop-bridge"}
# 【2026-09-14】新增 recover-dryrun：只演练「这一轮会挑中谁去补下载」，
# 不拉浏览器、不调补下载、不写台账。改完筛选规则后用它验证，零成本零风险。
# 【2026-09-13】新增 dl-serial：免费补下载（把已出好、但没取回的图重新取回，不重跑、不扣积分）。
# 新增 restart-bridge：改完脚本后由桥自己安排重启，避免只能靠人工双击。
# 允许内联参数的白名单模式：服务层只透传一个 --mode 值，因此带参数的免费自检
# 只能写成 --mode <模式>:<参数>（例：aspect-check:9:16）。
# 为什么需要 aspect-check：历史上出现过「请求 9:16、页面实际点成 1:2」，图出来才发现，
# 积分已经扣掉。这个模式只点尺寸档位、不出图、不扣积分，可在付费前先验证一次。
INLINE_SPEC_MODES = {"aspect-check", "dl-serial"}
ALLOWED_ASPECTS = {"1:1", "1:2", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"}


class MaintenanceRequest(BaseModel):
    mode: str = "lint"
    file: str | None = None
    # 【2026-09-13】免费补下载专用：mode 写 "dl-serial" 时，这两个字段可与内联写法二选一。
    serial: str | None = None
    prefix: str | None = None
    archive_dir: str | None = None


@app.post("/v1/maintenance")
def maintenance(request: MaintenanceRequest):
    """只读自检通道。白名单限定，绝不触发出图。"""
    mode = (request.mode or "lint").strip()
    base_mode, _, inline_spec = mode.partition(":")
    if base_mode not in ALLOWED_MAINTENANCE_MODES:
        raise HTTPException(
            status_code=400,
            detail={"status": "mode_not_allowed", "mode": mode, "allowed": sorted(ALLOWED_MAINTENANCE_MODES)},
        )
    # 只有白名单内声明的模式才允许携带内联参数，防止把任意串透传给子进程。
    if inline_spec and base_mode not in INLINE_SPEC_MODES:
        raise HTTPException(
            status_code=400,
            detail={"status": "inline_not_allowed", "mode": mode, "allowed": sorted(INLINE_SPEC_MODES)},
        )
    if base_mode == "aspect-check" and inline_spec and inline_spec not in ALLOWED_ASPECTS:
        raise HTTPException(
            status_code=400,
            detail={"status": "bad_aspect", "aspect": inline_spec, "allowed": sorted(ALLOWED_ASPECTS)},
        )
    if base_mode == "autostart-install":
        # 【2026-09-14.4】免管理员装开机自启：写登录启动项 + 立刻拉起看护循环。
        # 为什么要桥来跑：注册「计划任务」需要管理员权限（会弹 UAC），写登录启动项不需要。
        if not INSTALL_USER_AUTOSTART.exists():
            raise HTTPException(status_code=500, detail=f"缺少 {INSTALL_USER_AUTOSTART}")
        command = [
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-Command",
            # 让 PowerShell 用 UTF-8 输出，否则中文在接口返回里是乱码（GBK 被按 UTF-8 解码）。
            "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '" + str(INSTALL_USER_AUTOSTART) + "'",
        ]
    elif base_mode == "stop-bridge":
        # 仅用于验证看护自愈：先返回响应，再让当前进程退出，避免留下半截 HTTP 响应。
        import threading
        def _stop_later():
            time.sleep(0.25)
            os._exit(0)
        threading.Thread(target=_stop_later, daemon=True).start()
        return {"ok": True, "status": "stopping", "mode": mode}
    elif base_mode == "recover-dryrun":
        # 只演练：跑一次看护脚本的 DryRun，它只会记一行「会挑中谁」，绝不发起补下载。
        if not WATCHDOG.exists():
            raise HTTPException(status_code=500, detail=f"缺少 {WATCHDOG}")
        command = [
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(WATCHDOG), "-DryRun", "-Chatty",
        ]
    else:
        if not RUNNER.exists():
            raise HTTPException(status_code=500, detail=f"缺少 {RUNNER}")
        command = [str(NODE_EXE), str(RUNNER), "--mode", mode]
    if request.file:
        command += ["--file", request.file]
    # 【2026-09-13】免费补下载：serial / prefix 也可以走独立字段，不必挤在 mode 里。
    if base_mode == "dl-serial":
        if request.serial:
            command += ["--serial", request.serial]
        if request.prefix:
            command += ["--prefix", request.prefix]
        if request.archive_dir:
            command += ["--archive-dir", request.archive_dir]
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail={"status": "timeout", "mode": mode})
    stdout = (completed.stdout or "").strip()
    if base_mode == "autostart-install":
        # 这个模式不产出 JSON，只回一段人可读的安装结论。
        return {
            "ok": completed.returncode == 0,
            "status": "autostart-install",
            "mode": mode,
            "returncode": completed.returncode,
            "output": stdout[-4000:],
            "stderr": (completed.stderr or "").strip()[-1500:],
        }
    if base_mode == "recover-dryrun":
        # 这个模式不产出 JSON，只回一段人可读的演练结论。
        return {
            "ok": completed.returncode == 0,
            "status": "dryrun",
            "mode": mode,
            "returncode": completed.returncode,
            # 只把「真的会被挑去补下载」的行算进来；
            # 「local hit」是本地已有图、会被跳过，不该混进名单。
            "wouldPick": [line for line in stdout.splitlines() if "would redownload" in line],
            "skippedLocal": [line for line in stdout.splitlines() if "local hit" in line],
            "output": stdout[-4000:],
            "stderr": (completed.stderr or "").strip()[-1000:],
        }
    payload = None
    if stdout:
        try:
            payload = json.loads(stdout.splitlines()[-1])
        except json.JSONDecodeError:
            payload = None
    if payload is None:
        raise HTTPException(
            status_code=502,
            detail={"status": "unparsable", "mode": mode, "raw": stdout[:300], "stderr": (completed.stderr or "").strip()[-300:]},
        )
    payload["returncode"] = completed.returncode
    return payload

# =====================================================================
# 【2026-09-12.3】后台作业接口（jobs）
# =====================================================================
# 为什么要有这一层：
#   本机 MJ 排队实测 11~15 分钟，远超一次 HTTP 请求该等的时长。旧做法是
#   让 HTTP 一直挂着等图，调用方一超时就断开 —— 图还在出、积分已经扣了，
#   结果却没人收，只能看到「失败」。这就是历史上「看起来在跑但从不出图」的根因。
#
#   现在改成两段式：
#     POST /v1/jobs      -> 立刻返回作业号（约 2 秒），真正的出图丢给游离进程
#     GET  /v1/jobs/{id} -> 随时回来查，出好了就把图取走
#   作业结果落盘在 run/jobs/<作业号>.json，进程即使重启也不丢单。
#
# 红线：POST /v1/jobs 是付费动作（每次约 6 积分）。查询接口完全免费，不重复扣费。

JOB_DEAD_AFTER_MS = DEFAULT_TIMEOUT_MS + 180000  # 超过这个时长还无结果，判定作业已死


def prompt_fingerprint(prompt: str) -> str:
    """给提示词取短指纹，用于「同一个提示词不要重复扣费」的去重。"""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:10]


def safe_job_id(value: str) -> str:
    """作业号会变成文件名，必须洗掉 Windows 非法字符，否则落盘会失败。"""
    cleaned = re.sub(r"[\\/:*?\"<>|\s]+", "_", value).strip("_")
    return cleaned[:80]


def job_paths(job_id: str) -> tuple[Path, Path]:
    return JOBS_DIR / (job_id + ".json"), JOBS_DIR / (job_id + ".log")


def read_job(job_id: str) -> dict:
    """只读一个作业的当前状态。不启动浏览器、不出图、不扣积分。"""
    result_file, log_file = job_paths(job_id)
    raw = ""
    if result_file.exists():
        try:
            raw = result_file.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            raw = ""
    payload = None
    if raw:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = None
    log_tail = ""
    log_mtime = None
    if log_file.exists():
        try:
            log_tail = " | ".join(
                line for line in log_file.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()
            )[-800:]
            log_mtime = log_file.stat().st_mtime
        except OSError:
            log_tail = ""

    if isinstance(payload, dict):
        status = "done"
    elif not log_file.exists() and not result_file.exists():
        status = "unknown"
    else:
        age_ms = (time.time() - log_mtime) * 1000 if log_mtime else None
        if age_ms is not None and age_ms > JOB_DEAD_AFTER_MS:
            status = "stale"   # 日志很久没动，基本可以认定进程已死
        else:
            status = "running"

    images: list[str] = []
    if isinstance(payload, dict):
        candidates = list(payload.get("images") or []) if isinstance(payload.get("images"), list) else []
        if payload.get("file"):
            candidates.append(payload["file"])
        images = [str(item) for item in candidates if isinstance(item, str) and image_type(Path(item))]

    result_payload = payload if isinstance(payload, dict) else {}
    request_meta = _read_control_json(JOBS_DIR / "requests" / (job_id + ".json"))
    progress = _read_control_json(JOBS_DIR / "progress" / (job_id + ".json"))
    if status == "unknown" and request_meta:
        status = "stale"
    if progress.get("phase") == "result_pending" and not result_payload:
        status = "stale"
    retry_allowed = result_payload.get("retryAllowed")
    if not isinstance(retry_allowed, bool):
        retry_allowed = result_payload.get("retry_allowed")
    if not isinstance(retry_allowed, bool):
        retry_allowed = None
    submitted = result_payload.get("submitted", progress.get("submitted"))
    if not isinstance(submitted, bool):
        submitted = None
    billed = result_payload.get("billed")
    if not isinstance(billed, bool):
        billed = None
    deduction = result_payload.get("actual_point_deduction")
    charge_known = (
        isinstance(billed, bool)
        or submitted is False
        or (isinstance(deduction, (int, float)) and not isinstance(deduction, bool))
    )

    return {
        "jobId": job_id,
        "status": status,
        "resultStatus": result_payload.get("status"),
        "retryAllowed": retry_allowed,
        "submitted": submitted,
        "billed": billed,
        "chargeKnown": charge_known,
        "actualPointDeduction": deduction if isinstance(deduction, (int, float)) and not isinstance(deduction, bool) else None,
        "ok": bool(result_payload.get("ok")),
        "resultFile": str(result_file),
        "logFile": str(log_file),
        "logTail": log_tail,
        "images": images,
        "aspect": result_payload.get("aspect"),
        "recordId": result_payload.get("recordId"),
        "message": result_payload.get("message") or result_payload.get("error"),
        "result": payload,
        "request": request_meta,
        "phase": ("completed" if result_payload.get("ok") and images else "result_pending") if isinstance(payload, dict) else progress.get("phase"),
        "phaseSource": "receipt" if isinstance(payload, dict) else ("runner" if progress else "missing"),
        "phaseAt": progress.get("at"),
        "startedAt": result_file.stat().st_ctime if result_file.exists() else None,
    }


def find_running_job(fingerprint: str, max_age_ms: int = 6 * 3600 * 1000) -> str | None:
    """Reuse unresolved durable intents, including dispatch timeouts after restart."""
    for candidate in sorted((JOBS_DIR / "requests").glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = _read_control_json(candidate)
        if meta.get("fingerprint") != fingerprint and not candidate.stem.endswith("_" + fingerprint):
            continue
        state = read_job(candidate.stem)
        if state["status"] != "done" or (state.get("submitted") is not False and not state.get("ok")):
            return candidate.stem
    return None


JOB_DISPATCH_LOCK = threading.RLock()


class JobRequest(BaseModel):
    prompt: str = ""
    aspect: str | None = None
    size: str | None = None
    version: str | None = None
    label: str | None = None
    output_name: str | None = None
    output_dir: str | None = None
    profile: str | None = None
    params: dict | None = None
    force: bool = False   # 兼容字段；不能绕过未决提交意图的去重保护


@app.get("/v1/jobs")
def list_jobs(tail: int = 20):
    """列出最近的作业。只读，免费。"""
    rows = []
    files = sorted(JOBS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for item in files[: max(1, min(tail, 200))]:
        rows.append(read_job(item.stem))
    return {"ok": True, "jobsDir": str(JOBS_DIR), "count": len(rows), "items": rows}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str):
    """查一个作业。免费，不重复扣费。图片只给路径，需要 base64 时用 ?b64=1。"""
    state = read_job(safe_job_id(job_id))
    if state["status"] == "unknown":
        raise HTTPException(status_code=404, detail={"status": "not_found", "jobId": state["jobId"], "message": "没有这个作业号"})
    return state


@app.post("/v1/jobs")
def create_job(request: JobRequest):
    with JOB_DISPATCH_LOCK:
        return _create_job_locked(request)


def _create_job_locked(request: JobRequest):
    """提交一次真实出图，立刻返回作业号（付费动作，约 6 积分/张）。"""
    prompt = (request.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不能为空")
    if not RUNNER.exists():
        raise HTTPException(status_code=500, detail=f"缺少 {RUNNER}")

    aspect = request.aspect or size_to_aspect(request.size)
    try:
        prepared = prepare_request(prompt, aspect, request.version or DEFAULT_VERSION, request.params)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    fingerprint = request_fingerprint(prepared, Path(request.profile or PROFILE_PATH).resolve())

    existing = find_running_job(fingerprint)
    if not existing:
        legacy_fingerprint = prompt_fingerprint(prompt)
        for legacy in JOBS_DIR.glob("*_" + legacy_fingerprint + ".json"):
            old = read_job(legacy.stem)
            if old["status"] != "done" or (not old.get("ok") and old.get("submitted") is not False):
                existing = legacy.stem
                break
    if existing:
        return JSONResponse(
            status_code=200,
            content={
                "jobId": existing,
                "status": "already_running",
                "deduped": True,
                "aspect": aspect,
                "message": "已有相同或历史未决作业，复用作业号；本次没有重新提交",
            },
        )

    label = safe_job_id(request.label or "mj")[:30]
    job_id = f"{label}_{uuid.uuid4().hex[:12]}_{fingerprint}"

    output_dir = Path(request.output_dir or RESULTS_DIR).expanduser()
    if not output_dir.is_absolute():
        raise HTTPException(status_code=400, detail="output_dir 必须使用绝对路径")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"输出目录不可用：{exc}")

    profile = PROFILE_PATH.resolve()
    if request.profile:
        candidate = Path(request.profile).expanduser().resolve()
        slot_root = BATCH_SLOT_ROOT.resolve()
        if candidate == PROFILE_PATH.resolve():
            slot_root = candidate
        try:
            candidate.relative_to(slot_root)
        except ValueError:
            raise HTTPException(status_code=400, detail="浏览器档案只能使用批次槽位目录")
        candidate.mkdir(parents=True, exist_ok=True)
        profile = candidate

    result_file, log_file = job_paths(job_id)
    command = [
        str(NODE_EXE),
        str(RUNNER),
        "--mode",
        "bg:" + job_id,
        "--prompt",
        prepared["effectivePrompt"],
        "--source-prompt",
        prompt,
        "--params-json",
        json.dumps(prepared["params"], ensure_ascii=False),
        "--aspect",
        aspect,
        "--out-dir",
        str(output_dir),
        "--prefix",
        job_id,
        "--output-name",
        request.output_name or request.label or "生成结果",
        "--task-id",
        job_id,
        "--version",
        request.version or DEFAULT_VERSION,
        "--timeout",
        str(DEFAULT_TIMEOUT_MS),
    ]
    intent = {**prepared, "jobId": job_id, "fingerprint": fingerprint,
              "outputDir": str(output_dir), "profile": str(profile), "name": request.output_name or request.label or "生成结果",
              "createdAt": time.time(), "dispatchStatus": "intent_persisted"}
    request_path = JOBS_DIR / "requests" / (job_id + ".json")
    request_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = request_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(intent, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, request_path)
    child_env = os.environ.copy()
    child_env["MJ_JOBS_DIR"] = str(JOBS_DIR)
    child_env["MJ_PROGRESS_FILE"] = str(JOBS_DIR / "progress" / (job_id + ".json"))
    if profile is not None:
        child_env["MXAI_PROFILE"] = str(profile)
        child_env["MXAI_LOCK_FILE"] = str(profile.parent / (profile.name + ".bridge.lock"))
    try:
        proc = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, env=child_env,
        )
    except (subprocess.TimeoutExpired, OSError):
        return JSONResponse(status_code=202, content={"status": "dispatch_uncertain", "jobId": job_id, "message": "后台派发状态不明，意图已持久保存；请核对回执，不要重复提交。"})

    dispatch = None
    try:
        dispatch = json.loads((proc.stdout or "").strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        dispatch = None

    if not isinstance(dispatch, dict) or dispatch.get("status") != "bg_started":
        detail = (dispatch if isinstance(dispatch, dict) else {}).get("error") or (proc.stderr or "").strip()[-400:] or "后台作业派发失败"
        return JSONResponse(status_code=202, content={"status": "dispatch_uncertain", "jobId": job_id, "message": "派发结果不明，已保留作业号；请核对回执，禁止重复提交。"})

    return JSONResponse(
        status_code=202,
        content={
            "jobId": job_id,
            "status": "running",
            "deduped": False,
            "aspect": aspect,
            "outputDir": str(output_dir),
            "profile": str(profile) if profile else None,
            "pid": dispatch.get("pid"),
            "resultFile": str(result_file),
            "logFile": str(log_file),
            "pollWith": f"/v1/jobs/{job_id}",
            "message": "已开始出图。MJ 本机排队实测 11~15 分钟，请稍后用上面的地址回来查，不要重复提交。",
        },
    )


def _slot_login_state_path(batch_id: str, slot: int) -> Path:
    SLOT_LOGIN_ROOT.mkdir(parents=True, exist_ok=True)
    return SLOT_LOGIN_ROOT / f"{safe_job_id(batch_id)}-slot-{int(slot)}.json"


def _slot_login_snapshot(batch_id: str, slot: int) -> dict:
    state = _read_control_json(_slot_login_state_path(batch_id, slot))
    pid = state.get("pid")
    running = bool(state.get("running")) and _pid_running(pid)
    return {
        "running": running,
        "loggedIn": bool(state.get("loggedIn")) if running else False,
        "status": state.get("status") if running else "stopped",
        "checkedAt": state.get("updatedAt"),
        "slot": int(slot),
    }


def _shared_login_snapshot() -> dict:
    state = _control_browser_state()
    return {**state, "slot": 1, "profile": str(PROFILE_PATH.resolve())}


def _slot_login_ready(item: dict) -> bool:
    slot = item.get("slot")
    if not slot:
        return False
    if item.get("profile") and Path(str(item["profile"])).resolve() == PROFILE_PATH.resolve():
        snapshot = _shared_login_snapshot()
        # 登录窗口关闭后仍保留已核验的 loginState，不能因为释放锁而把共享登录判成未登录。
        if not snapshot.get("loggedIn") and snapshot.get("loginState") != "logged_in":
            return False
        if not snapshot.get("running"):
            return True
        pid = snapshot.get("pid")
        try:
            CONTROL_STOP_FILE.write_text("stop\n", encoding="utf-8")
        except OSError:
            return False
        deadline = time.time() + 10
        while time.time() < deadline:
            if not _pid_running(pid):
                return True
            time.sleep(0.1)
        return False
    snapshot = _slot_login_snapshot(str(item.get("batchId") or ""), int(slot))
    if not snapshot.get("running") or not snapshot.get("loggedIn"):
        return False
    pid = _read_control_json(_slot_login_state_path(str(item.get("batchId") or ""), int(slot))).get("pid")
    stop_file = _slot_login_state_path(str(item.get("batchId") or ""), int(slot)).with_suffix(".stop")
    try:
        stop_file.write_text("stop\n", encoding="utf-8")
    except OSError:
        return False
    deadline = time.time() + 10
    while time.time() < deadline:
        if not _pid_running(pid):
            return True
        time.sleep(0.1)
    return False


def _batch_submit_job(item: dict) -> dict:
    request = JobRequest(
        prompt=str(item.get("prompt") or ""),
        aspect=str(item.get("aspect") or "16:9"),
        version=str(item.get("version") or DEFAULT_VERSION),
        label=f"batch-{safe_job_id(str(item.get('batchId') or 'batch'))}-{safe_job_id(str(item.get('id') or 'task'))}-a{int(item.get('attempts') or 1)}",
        output_name=str(item.get("name") or item.get("label") or item.get("id") or "生成结果"),
        output_dir=str(item.get("outputDir") or RESULTS_DIR),
        profile=str(item.get("profile") or "") or None,
        params=item.get("params") if isinstance(item.get("params"), dict) else {},
    )
    response = create_job(request)
    if isinstance(response, JSONResponse):
        try:
            return json.loads(response.body.decode("utf-8"))
        except (AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("桥接派发返回不可解析") from exc
    return response


def _batch_get_job(job_id: str) -> dict:
    state = read_job(safe_job_id(job_id))
    if state["status"] == "unknown":
        raise JobNotFound(job_id)
    return state


batch_manager = BatchManager(
    BATCHES_DIR,
    submit_job=_batch_submit_job,
    get_job=_batch_get_job,
    default_output_dir=RESULTS_DIR,
    slot_root=BATCH_SLOT_ROOT,
    slot_login_ready=_slot_login_ready,
    shared_profile=PROFILE_PATH,
)


@app.post("/v1/images/generations")
def generate(request: GenerationRequest):
    prompt = (request.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    # MJ 一次出的是四宫格整图，n>1 只能靠重复调用凑，串行跑避免抢占同一个浏览器。
    aspect = request.aspect or size_to_aspect(request.size)
    mode = request.mode or "normal"
    images: list[dict] = []
    errors: list[str] = []
    statuses: list[str] = []
    records: list[str] = []
    pending: list[dict] = []

    for index in range(request.n):
        payload = run_mj(prompt, aspect, DEFAULT_TIMEOUT_MS, mode, request.output_name)
        statuses.append(str(payload.get("status") or ("ok" if payload.get("ok") else "failed")))
        if payload.get("recordId"):
            records.append(str(payload["recordId"]))
        # 兼容两种成功回传：批量走 images 数组，单文件（如补下载）走 file 字段。
        candidates = list(payload.get("images") or [])
        if payload.get("file"):
            candidates.append(payload["file"])
        files = [item for item in candidates if item and Path(item).exists()]

        # 「排队中」不是失败：任务已受理并扣费，成品稍后可免费补下载取回。
        # 必须单独上报，避免上层把它当成失败去重跑（会重复扣积分）。
        status = str(payload.get("status") or "")
        # 【2026-09-14】page_reported_failed 是**终态**：平台已判定本次生成失败，站点侧
        # 不会再出图，本地也不会有成品。它绝不能进 pending（那会让调用方以为「稍后能补下载」），
        # 而是直接落到下面的失败分支，带着明确状态上报。
        # receipt_pending 保留在 pending 里是有意的：它代表「点了生成但没拿到确定回执」，
        # 既不能断定成功也不能断定失败，202 + retryAllowed=false 是唯一不会重复扣积分的回法。
        if not files and status in ("queued", "receipt_pending", "timeout"):
            pending.append({
                "status": status,
                "serial": payload.get("recordId") or payload.get("serial"),
                "message": payload.get("message") or payload.get("error") or "任务仍在排队/出图中",
                "retryAllowed": False,
            })
            continue

        if not files:
            detail = payload.get("error") or payload.get("message") or f"第 {index + 1} 张没有返回图片"
            rejected = payload.get("rejected") or []
            if rejected:
                detail = f"{detail}（被校验拦下的文件：{len(rejected)} 个）"
            errors.append(detail)
            continue
        images.extend({"b64_json": file_to_b64(file), "url": None} for file in files)

    if not images and pending:
        # 202 = 已受理未完成。调用方应按「稍后补下载」处理，不要重跑。
        return JSONResponse(
            status_code=202,
            content={
                "created": int(time.time()),
                "aspect": aspect,
                "status": "queued",
                "recordIds": records,
                "pending": pending,
                "data": [],
                "message": "任务已提交，仍在排队/出图中；请稍后调用补下载取回成品（不会重复扣积分）",
                "_meta": {"statuses": statuses, "requestedAspect": aspect, "mode": mode},
            },
        )

    if not images:
        raise HTTPException(
            status_code=502,
            detail={
                "status": statuses[-1] if statuses else "no_images",
                "message": "；".join(errors) or "MJ 没有返回任何图片",
                "aspect": aspect,
            },
        )

    return {
        "created": int(time.time()),
        "aspect": aspect,
        "status": "ok",
        "recordIds": records,
        "data": images,
        "pending": pending,
        "_meta": {"statuses": statuses, "requestedAspect": aspect, "mode": mode},
    }


def _read_control_json(path_value: Path) -> dict:
    try:
        value = json.loads(path_value.read_text(encoding="utf-8-sig", errors="replace"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _pid_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        pid_int = int(pid)
    except (ValueError, TypeError):
        return False
    if os.name == "nt":
        # Windows uses tasklist for a read-only PID probe.
        # Never probe Windows processes through termination APIs.
        try:
            probe = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid_int}", "/NH"],
                capture_output=True, text=True, timeout=5,
            )
            return bool(re.search(rf"\b{pid_int}\b", probe.stdout or ""))
        except (OSError, subprocess.SubprocessError):
            return False
    try:
        os.kill(pid_int, 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _control_browser_state() -> dict:
    state = _read_control_json(CONTROL_STATE)
    pid = state.get("pid")
    state["pid"] = pid
    state["running"] = bool(state.get("running")) and _pid_running(pid)
    if not state["running"]:
        state["loggedIn"] = False
        if state.get("status") in {"starting", "logged_in", "not_logged_in", "watching"}:
            state["status"] = "stopped"
    return state


@app.get("/", include_in_schema=False)
def root_page():
    """Open the local workbench when the bridge root URL is visited."""
    return RedirectResponse(url="/control", status_code=307)


@app.get("/control", response_class=HTMLResponse)
def control_page():
    if not CONTROL_HTML.exists():
        raise HTTPException(status_code=404, detail="control console not installed")
    return HTMLResponse(
        CONTROL_HTML.read_text(encoding="utf-8", errors="replace"),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"},
    )


@app.get("/control/batch-template.json")
def control_batch_template():
    template = CONTROL_DIR / "batch-template.json"
    if not template.exists():
        raise HTTPException(status_code=404, detail="批次模板不存在")
    return FileResponse(template, media_type="application/json", headers={"Cache-Control": "no-store"})


@app.get("/control/batch-ui.js")
def control_batch_ui():
    script = CONTROL_DIR / "batch-ui.js"
    if not script.exists():
        raise HTTPException(status_code=404, detail="批次前端脚本不存在")
    return FileResponse(script, media_type="application/javascript", headers={"Cache-Control": "no-store"})


asset_library = AssetLibrary(JOBS_DIR, BATCHES_DIR,
    Path(os.environ.get("MJ_RECEIPTS_DIR", str(HERE.parent / "receipts"))) / "mxai-tasks.jsonl",
    RUN_ROOT / "library-annotations.json")


def _asset_call(call, *args):
    try:
        return call(*args)
    except KeyError as exc:
        raise HTTPException(404, detail=str(exc)) from exc
    except (ValueError, OSError) as exc:
        raise HTTPException(422, detail=str(exc)) from exc


@app.get("/control/storage")
def get_storage():
    return _asset_call(asset_library.storage, RESULTS_DIR)


@app.patch("/control/storage")
def set_storage(payload: dict):
    return _asset_call(asset_library.configure_storage, payload, RESULTS_DIR)


@app.post("/control/assets/deliver")
def deliver_assets(payload: dict):
    if set(payload) != {"ids"}:
        raise HTTPException(422, detail="只接受图库图片编号")
    return _asset_call(asset_library.deliver, payload["ids"], RESULTS_DIR)


@app.get("/control/assets")
def list_assets():
    rows = _asset_call(asset_library.index)
    return {"ok": True, "total": len(rows), "items": rows}


@app.get("/control/assets/{asset_id}/image")
def asset_image(asset_id: str, download: bool = False):
    asset = _asset_call(asset_library.get, asset_id)
    return FileResponse(asset["path"], media_type=asset["mime"],
        filename=Path(asset["path"]).name if download else None,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60"})


@app.patch("/control/assets/{asset_id}")
def annotate_asset(asset_id: str, payload: dict):
    return _asset_call(asset_library.annotate, asset_id, payload)


@app.post("/control/assets/{asset_id}/open")
def open_asset(asset_id: str):
    asset = _asset_call(asset_library.get, asset_id)
    if os.name == "nt":
        subprocess.Popen(["explorer.exe", "/select,", asset["path"]])
    else:
        subprocess.Popen(["xdg-open", str(Path(asset["path"]).parent)])
    return {"ok": True, "path": asset["path"]}


@app.get("/control/gallery-logic.js")
def gallery_script():
    return FileResponse(CONTROL_DIR / "gallery-logic.js", media_type="application/javascript", headers={"Cache-Control": "no-store"})


@app.get("/control/workbench.css")
def control_styles():
    return FileResponse(CONTROL_DIR / "workbench.css", media_type="text/css", headers={"Cache-Control": "no-store"})


def _batch_call(callable_obj, *args, **kwargs):
    try:
        return callable_obj(*args, **kwargs)
    except BatchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail or exc.message) from exc


def _batch_output(payload):
    # A persisted batch keeps its own outputDir; a new blank draft follows the current default.
    if not payload.get("outputDir") and not payload.get("output_dir"):
        payload = {**payload, "outputDir": _asset_call(asset_library.storage, RESULTS_DIR)["outputDir"]}
    return payload


@app.post("/control/batches/validate")
def validate_batch(payload: dict):
    return batch_manager.validate(_batch_output(payload))


@app.post("/control/batches")
def create_batch(payload: dict):
    return _batch_call(batch_manager.create, _batch_output(payload))


@app.get("/control/batches")
def list_batches():
    return {"ok": True, "items": batch_manager.list_summaries(), "health": batch_manager.health()}


@app.get("/control/batches/{batch_id}")
def get_batch(batch_id: str):
    state = _batch_call(batch_manager.get_state, batch_id)
    for item in state.get("items", []):
        if item.get("currentJobId"):
            item["liveJob"] = read_job(safe_job_id(item["currentJobId"]))
    return state


@app.post("/control/batches/{batch_id}/start")
def start_batch(batch_id: str, payload: dict | None = None):
    return _batch_call(batch_manager.start, batch_id, (payload or {}).get("paid_confirmed") is True)


@app.post("/control/batches/{batch_id}/pause")
def pause_batch(batch_id: str, payload: dict | None = None):
    return _batch_call(batch_manager.pause, batch_id, str((payload or {}).get("reason") or "用户已暂停补位"))


@app.post("/control/batches/{batch_id}/resume")
def resume_batch(batch_id: str, payload: dict | None = None):
    return _batch_call(batch_manager.resume, batch_id, (payload or {}).get("paid_confirmed") is True)


@app.get("/control/batches/{batch_id}/items/{item_id}/login")
def batch_item_login_status(batch_id: str, item_id: str):
    state = _batch_call(batch_manager.get_state, batch_id)
    item = next((row for row in state.get("items", []) if row.get("id") == item_id), None)
    if not item or item.get("status") != "login_required" or not item.get("slot"):
        raise HTTPException(status_code=409, detail="\u6b64\u4efb\u52a1\u5f53\u524d\u4e0d\u9700\u8981\u5de5\u4f5c\u4f4d\u767b\u5f55\u6838\u9a8c")
    if item.get("profile") and Path(str(item["profile"])).resolve() == PROFILE_PATH.resolve():
        return _shared_login_snapshot()
    return _slot_login_snapshot(batch_id, int(item["slot"]))


@app.post("/control/batches/{batch_id}/items/{item_id}/login")
def batch_item_login_start(batch_id: str, item_id: str):
    state = _batch_call(batch_manager.get_state, batch_id)
    item = next((row for row in state.get("items", []) if row.get("id") == item_id), None)
    if not item or item.get("status") != "login_required" or not item.get("slot"):
        raise HTTPException(status_code=409, detail="\u6b64\u4efb\u52a1\u5f53\u524d\u4e0d\u9700\u8981\u5de5\u4f5c\u4f4d\u767b\u5f55")
    if item.get("profile") and Path(str(item["profile"])).resolve() == PROFILE_PATH.resolve():
        result = control_browser_start()
        return {**result, "slot": 1, "profile": str(PROFILE_PATH.resolve()), "message": "已打开 Multica 共享登录槽位；登录一次供单路可靠运行。"}
    slot = int(item["slot"])
    if any(row.get("status") == "running" and row.get("slot") == slot for row in state.get("items", [])):
        raise HTTPException(status_code=409, detail="\u8be5\u5de5\u4f5c\u4f4d\u4ecd\u6709\u4efb\u52a1\u8fd0\u884c\uff0c\u6682\u4e0d\u80fd\u6253\u5f00\u767b\u5f55\u7a97\u53e3")
    snapshot = _slot_login_snapshot(batch_id, slot)
    if snapshot.get("running"):
        return {"ok": True, **snapshot, "message": f"\u6279\u6b21\u5de5\u4f5c\u4f4d {slot} \u7684\u6d4f\u89c8\u5668\u5df2\u6253\u5f00\u3002"}
    profile = (BATCH_SLOT_ROOT / f"{batch_id}-slot-{slot}").resolve()
    profile.parent.mkdir(parents=True, exist_ok=True)
    control_state = _slot_login_state_path(batch_id, slot)
    log_path = RUN_ROOT / "logs" / f"login-{safe_job_id(batch_id)}-slot-{slot}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["MXAI_PROFILE"] = str(profile)
    env["MXAI_LOCK_FILE"] = str(profile.parent / (profile.name + ".bridge.lock"))
    env["MXAI_CONTROL_STATE"] = str(control_state)
    env["MXAI_CONTROL_STOP_FILE"] = str(control_state.with_suffix(".stop"))
    try:
        control_state.with_suffix(".stop").unlink(missing_ok=True)
    except OSError:
        pass
    with log_path.open("a", encoding="utf-8") as log_handle:
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        proc = subprocess.Popen([str(NODE_EXE), str(CONTROL_BROWSER)], cwd=str(HERE), env=env, stdin=subprocess.DEVNULL, stdout=log_handle, stderr=subprocess.STDOUT, creationflags=flags)
    return {"ok": True, "status": "started", "slot": slot, "pid": proc.pid, "message": f"\u5df2\u6253\u5f00\u672c\u6279\u6b21\u5de5\u4f5c\u4f4d {slot} \u4f7f\u7528\u7684\u6d4f\u89c8\u5668\u6863\u6848\uff0c\u8bf7\u4f60\u672c\u4eba\u767b\u5f55\u3002\u767b\u5f55\u540e\u70b9\u201c\u68c0\u67e5\u767b\u5f55\u72b6\u6001\u201d\uff0c\u518d\u70b9\u201c\u7ee7\u7eed\u6279\u6b21\u201d\u3002"}


@app.post("/control/batches/{batch_id}/cancel")
def cancel_batch(batch_id: str):
    return _batch_call(batch_manager.cancel, batch_id)


@app.post("/control/batches/{batch_id}/recover")
def recover_batch(batch_id: str):
    return _batch_call(batch_manager.recover, batch_id)


@app.post("/control/batches/{batch_id}/items/{item_id}/skip")
def skip_batch_item(batch_id: str, item_id: str):
    return _batch_call(batch_manager.skip, batch_id, item_id)


@app.post("/control/batches/{batch_id}/items/{item_id}/resubmit")
def resubmit_batch_item(batch_id: str, item_id: str, payload: dict | None = None):
    body = payload or {}
    return _batch_call(batch_manager.resubmit, batch_id, item_id, body.get("paid_confirmed") is True, body.get("confirm_repeat_charge") is True)


@app.post("/control/batches/{batch_id}/items/{item_id}/open-output")
def open_batch_output(batch_id: str, item_id: str):
    state = _batch_call(batch_manager.get_state, batch_id)
    item = next((row for row in state.get("items", []) if row.get("id") == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="找不到任务")
    files = [Path(value) for value in item.get("outputFiles", []) if value]
    existing = next((path for path in files if path.is_file()), None)
    if not existing:
        raise HTTPException(status_code=404, detail="没有可打开的成品文件")
    try:
        if os.name == "nt":
            subprocess.Popen(["explorer.exe", "/select,", str(existing)])
        else:
            subprocess.Popen(["xdg-open", str(existing.parent)])
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"打开成品位置失败：{exc}")
    return {"ok": True, "path": str(existing), "message": "已打开成品所在文件夹"}


@app.get("/control/state")
def control_state():
    state = _control_browser_state()
    watch_process = None  # Not probed on each refresh; unknown is represented as null.
    return {
        "ok": True,
        "health": health(),
        "browser": state,
        "watchdog": {"paused": CONTROL_PAUSE.exists(), "processRunning": watch_process, "pauseFile": str(CONTROL_PAUSE)},
        "jobs": list_jobs(40),
        "receipts": receipts(15),
        "batches": batch_manager.list_summaries(),
        "batchScheduler": batch_manager.health(),
    }


@app.post("/control/browser/start")
def control_browser_start():
    current = _control_browser_state()
    if current.get("running"):
        return {"ok": True, "status": "already_running", "pid": current.get("pid"), "message": "可见登录浏览器已经打开。"}
    if not CONTROL_BROWSER.exists():
        raise HTTPException(status_code=500, detail="缺少浏览器控制脚本")
    CONTROL_LOG.parent.mkdir(parents=True, exist_ok=True)
    log_handle = CONTROL_LOG.open("a", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    env = os.environ.copy()
    env["MXAI_PROFILE"] = str(PROFILE_PATH)
    env["MXAI_CONTROL_STATE"] = str(CONTROL_STATE)
    env["MXAI_CONTROL_STOP_FILE"] = str(CONTROL_STOP_FILE)
    try:
        CONTROL_STOP_FILE.unlink(missing_ok=True)
    except OSError:
        pass
    proc = subprocess.Popen(
        [str(NODE_EXE), str(CONTROL_BROWSER)], cwd=str(HERE), stdin=subprocess.DEVNULL,
        stdout=log_handle, stderr=subprocess.STDOUT, creationflags=flags, env=env,
    )
    log_handle.close()
    time.sleep(0.5)
    return {"ok": True, "status": "started", "pid": proc.pid, "message": "可见 Edge 已打开，请在窗口中手动登录。工作台不会自动提交生成。"}


@app.post("/control/browser/stop")
def control_browser_stop():
    current = _control_browser_state()
    pid = current.get("pid")
    if not pid or not current.get("running"):
        return {"ok": True, "status": "already_stopped", "message": "登录浏览器当前未运行。"}
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"], capture_output=True, timeout=15)
        else:
            os.kill(int(pid), 15)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"关闭浏览器失败：{exc}")
    return {"ok": True, "status": "stopping", "message": "已请求关闭登录浏览器。"}


@app.post("/control/watchdog/pause")
def control_watchdog_pause():
    CONTROL_PAUSE.parent.mkdir(parents=True, exist_ok=True)
    CONTROL_PAUSE.write_text("paused by local control console\n", encoding="utf-8")
    return {"ok": True, "status": "paused", "message": "自动看护已暂停。"}


@app.post("/control/watchdog/resume")
def control_watchdog_resume():
    try:
        CONTROL_PAUSE.unlink()
    except FileNotFoundError:
        pass
    return {"ok": True, "status": "resumed", "message": "自动看护已恢复。"}


if __name__ == "__main__":
    port = int(os.environ.get("MJ_BRIDGE_PORT", "8765"))
    print(f"MJ bridge listening on http://127.0.0.1:{port}  (model={MODEL_NAME})", flush=True)
    print(f"  runner : {RUNNER} (exists={RUNNER.exists()})", flush=True)
    print(f"  output : {RESULTS_DIR}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
