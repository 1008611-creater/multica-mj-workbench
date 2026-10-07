"""Persistent, charge-safe batch scheduler for the local Multica bridge.

The scheduler owns batch state.  The platform adapter is injected through two
small callbacks so this module can be tested without opening a browser or
submitting a paid task.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from workbench_assets import image_type
from typing import Any, Callable
from workbench_params import prepare_request


ITEM_TERMINAL = {"completed", "skipped"}
ITEM_ACTIVE = {"running"}
UNRESOLVED = {"failed", "result_pending", "login_required"}
ALLOWED_ASPECTS = {"1:1", "1:2", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"}
ID_RE = re.compile(r"^[\w\-.\u4e00-\u9fff]{1,80}$", re.UNICODE)
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
PARAM_RE = re.compile(r"(?:--ar|--v|--q|--s|--stylize|--chaos)\b", re.IGNORECASE)
QUALITY_RE = re.compile(r"\b(?:masterpiece|best quality|ultra[- ]?detailed|8k|4k|hd)\b", re.IGNORECASE)
ACRONYM_RE = re.compile(r"\b[A-Z]{3,}\b")


class BatchError(Exception):
    def __init__(self, message: str, status_code: int = 400, detail: Any | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.detail = detail


class JobNotFound(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_id(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text or fallback


def _path_error(value: Any, label: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        return f"{label}必须是路径字符串"
    path = Path(value).expanduser()
    if not path.is_absolute():
        return f"{label}必须使用绝对路径"
    if path.exists() and not path.is_dir():
        return f"{label}不是文件夹"
    parent = path if path.exists() else path.parent
    if not parent.exists():
        return f"{label}所在父目录不存在"
    return None


def validate_prompt(prompt: Any) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(prompt, str) or not prompt.strip():
        return ["prompt 不能为空"], warnings
    text = prompt.strip()
    if len(text) > 12000:
        errors.append("prompt 超过 12000 个字符")
    if CONTROL_RE.search(text):
        errors.append("prompt 含有不可见控制字符")
    if PARAM_RE.search(text):
        errors.append("prompt 不应把平台参数写在正文中，请放入 params")
    if QUALITY_RE.search(text):
        warnings.append("prompt 含有泛化质量词，建议用具体画面描述提高可控性")
    if ACRONYM_RE.search(text):
        warnings.append("prompt 含有连续大写缩写，请确认平台安全规则")
    if re.search(r"(?:密码|token|cookie|api[_ -]?key|secret|私钥)", text, re.IGNORECASE):
        errors.append("prompt 不能包含凭据或敏感认证信息")
    return errors, warnings


def validate_payload(payload: Any, default_output_dir: str | Path) -> dict:
    """Validate and normalize a batch without touching the filesystem."""
    if isinstance(payload, list):
        payload = {"items": payload}
    if not isinstance(payload, dict):
        return {"ok": False, "errors": [{"field": "batch", "message": "批次必须是 JSON 对象"}], "warnings": []}

    errors: list[dict] = []
    warnings: list[dict] = []
    name = str(payload.get("name") or payload.get("batchName") or "未命名批次").strip()
    batch_id = _safe_id(payload.get("batch_id") or payload.get("batchId") or payload.get("id"), "batch-" + uuid.uuid4().hex[:10])
    if not ID_RE.fullmatch(batch_id):
        errors.append({"field": "batch_id", "message": "批次 ID 只能包含中文、字母、数字、下划线、点或短横线"})

    concurrency = payload.get("concurrency", payload.get("maxActive", 3))
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency < 1 or concurrency > 3:
        errors.append({"field": "concurrency", "message": "并发数只能是 1、2 或 3"})
        concurrency = 3

    output_dir = payload.get("output_dir", payload.get("outputDir", str(default_output_dir)))
    path_error = _path_error(output_dir, "输出目录")
    if path_error:
        errors.append({"field": "output_dir", "message": path_error})
    output_dir = str(Path(output_dir).expanduser()) if isinstance(output_dir, str) else str(default_output_dir)

    rows = payload.get("items", payload.get("tasks"))
    if not isinstance(rows, list) or not rows:
        errors.append({"field": "items", "message": "items 必须是非空数组"})
        rows = []

    profile_mode = payload.get("profileMode", "shared")
    if profile_mode not in {"shared", "per_slot"}:
        errors.append({"field": "profileMode", "message": "浏览器档案模式无效"})
    if len(rows) > 500:
        errors.append({"field": "items", "message": "每批最多 500 个任务"})
    seen_requests = set()
    seen: set[str] = set()
    items: list[dict] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append({"item": str(index + 1), "field": "item", "message": "任务必须是 JSON 对象"})
            continue
        item_id = _safe_id(row.get("id") or row.get("item_id") or row.get("itemId"), f"task-{index + 1}")
        if not ID_RE.fullmatch(item_id):
            errors.append({"item": item_id, "field": "id", "message": "任务 ID 含有不支持的字符"})
        if item_id in seen:
            errors.append({"item": item_id, "field": "id", "message": "任务 ID 重复"})
        seen.add(item_id)

        prompt = row.get("prompt", row.get("generation_prompt", ""))
        prompt_errors, prompt_warnings = validate_prompt(prompt)
        for message in prompt_errors:
            errors.append({"item": item_id, "field": "prompt", "message": message})
        for message in prompt_warnings:
            warnings.append({"item": item_id, "field": "prompt", "message": message})

        aspect = str(row.get("aspect") or row.get("aspect_ratio") or "16:9").strip()
        if aspect not in ALLOWED_ASPECTS:
            errors.append({"item": item_id, "field": "aspect", "message": f"不支持的画幅：{aspect}"})
        version = str(row.get("version") or "v8.2").strip()
        if not version or len(version) > 40 or CONTROL_RE.search(version):
            errors.append({"item": item_id, "field": "version", "message": "版本参数无效"})

        item_output = row.get("output_dir", row.get("outputDir", output_dir))
        item_path_error = _path_error(item_output, "任务输出目录")
        if item_path_error:
            errors.append({"item": item_id, "field": "output_dir", "message": item_path_error})
        params = row.get("params") or {}
        if not isinstance(params, dict):
            errors.append({"item": item_id, "field": "params", "message": "params 必须是 JSON 对象"})
            params = {}
        if len(params) > 32:
            errors.append({"item": item_id, "field": "params", "message": "params 最多 32 个字段"})

        try:
            prepared = prepare_request(prompt, aspect, version, params)
            params = prepared["params"]
            identity = json.dumps(prepared, sort_keys=True, ensure_ascii=False)
            if identity in seen_requests:
                warnings.append({"item": item_id, "field": "prompt", "message": "发现相同请求，运行中的请求会复用作业号；独立实验请改变 seed 或其他参数"})
            seen_requests.add(identity)
        except ValueError as exc:
            errors.append({"item": item_id, "field": "params", "message": str(exc)})
        items.append({
            "id": item_id,
            "name": str(row.get("name") or row.get("label") or item_id).strip(),
            "prompt": str(prompt or "").strip(),
            "aspect": aspect,
            "version": version,
            "outputDir": str(Path(item_output).expanduser()) if isinstance(item_output, str) else output_dir,
            "params": params,
        })

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "normalized": {"batchId": batch_id, "name": name, "concurrency": concurrency, "outputDir": output_dir, "profileMode": profile_mode, "items": items},
    }


class BatchManager:
    def __init__(
        self,
        root: str | Path,
        submit_job: Callable[[dict], dict],
        get_job: Callable[[str], dict],
        default_output_dir: str | Path,
        slot_root: str | Path | None = None,
        poll_seconds: float = 0.8,
        slot_login_ready: Callable[[dict], bool] | None = None,
        shared_profile: str | Path | None = None,
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.slot_root = Path(slot_root or self.root / "slots")
        self.slot_root.mkdir(parents=True, exist_ok=True)
        self.shared_profile = str(Path(shared_profile).resolve()) if shared_profile else None
        self.default_output_dir = str(default_output_dir)
        self.submit_job = submit_job
        self.get_job = get_job
        self.slot_login_ready = slot_login_ready or (lambda _item: False)
        self.poll_seconds = poll_seconds
        self._lock = threading.RLock()
        self._workers: dict[str, threading.Thread] = {}
        self._states: dict[str, dict] = {}
        self._load_states()
        self._recover_loaded()

    def _state_path(self, batch_id: str) -> Path:
        return self.root / (batch_id + ".json")

    def _load_states(self) -> None:
        for path in self.root.glob("*.json"):
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(state, dict) and state.get("batchId"):
                    self._states[str(state["batchId"])] = state
            except (OSError, json.JSONDecodeError):
                continue

    def _recover_loaded(self) -> None:
        for batch_id, state in list(self._states.items()):
            if state.get("status") in {"running", "paused"} or (state.get("status") == "cancelled" and any(i.get("status") == "running" for i in state.get("items", []))):
                self._ensure_worker(batch_id)

    def _persist(self, state: dict) -> None:
        state["updatedAt"] = now_iso()
        path = self._state_path(state["batchId"])
        temp = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
        data = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)
        temp.write_text(data, encoding="utf-8")
        os.replace(temp, path)

    def _event(self, state: dict, event: str, item_id: str | None = None, message: str | None = None) -> None:
        state.setdefault("events", []).append({"at": now_iso(), "event": event, "itemId": item_id, "message": message})
        state["events"] = state["events"][-120:]

    def _get(self, batch_id: str) -> dict:
        state = self._states.get(batch_id)
        if not state:
            raise BatchError("找不到批次", 404)
        return state

    def validate(self, payload: Any) -> dict:
        result = validate_payload(payload, self.default_output_dir)
        return {"ok": result["ok"], "errors": result["errors"], "warnings": result["warnings"], "normalized": result["normalized"]}

    def create(self, payload: Any) -> dict:
        result = validate_payload(payload, self.default_output_dir)
        if not result["ok"]:
            raise BatchError("批次检查未通过", 422, result)
        normalized = result["normalized"]
        batch_id = normalized["batchId"]
        with self._lock:
            if batch_id in self._states or self._state_path(batch_id).exists():
                raise BatchError("批次 ID 已存在，请换一个 ID", 409)
            state = {
                "batchId": batch_id,
                "name": normalized["name"],
                "status": "validated",
                "concurrency": normalized["concurrency"],
                "profileMode": normalized.get("profileMode", "shared") if self.shared_profile else "per_slot",
                "sharedProfile": self.shared_profile,
                "outputDir": normalized["outputDir"],
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "authorization": {"paidGeneration": False, "confirmedAt": None},
                "pauseReason": None,
                "items": [],
                "events": [],
                "validation": {"warnings": result["warnings"]},
            }
            for row in normalized["items"]:
                state["items"].append({
                    **row,
                    "status": "pending",
                    "attempts": 0,
                    "slot": None,
                    "currentJobId": None,
                    "submissionId": None,
                    "startedAt": None,
                    "finishedAt": None,
                    "lastResult": None,
                    "failureReason": None,
                    "outputFiles": [],
                    "retryOf": None,
                })
            self._event(state, "batch_created", message="批次已保存，尚未提交")
            self._states[batch_id] = state
            self._persist(state)
            return copy.deepcopy(state)

    def list_summaries(self) -> list[dict]:
        with self._lock:
            rows = []
            for state in self._states.values():
                counts: dict[str, int] = {}
                for item in state.get("items", []):
                    counts[item.get("status", "pending")] = counts.get(item.get("status", "pending"), 0) + 1
                rows.append({"batchId": state["batchId"], "name": state.get("name"), "status": state.get("status"), "concurrency": state.get("concurrency"), "profileMode": state.get("profileMode"), "effectiveConcurrency": 1 if state.get("profileMode") == "shared" else state.get("concurrency"), "createdAt": state.get("createdAt"), "updatedAt": state.get("updatedAt"), "counts": counts, "pauseReason": state.get("pauseReason")})
            return sorted(rows, key=lambda x: x.get("updatedAt") or "", reverse=True)

    def get_state(self, batch_id: str) -> dict:
        with self._lock:
            return copy.deepcopy(self._get(batch_id))

    def health(self) -> dict:
        with self._lock:
            active = []
            manual = []
            for state in self._states.values():
                for item in state.get("items", []):
                    if item.get("status") == "running":
                        active.append({"batchId": state["batchId"], "itemId": item["id"], "slot": item.get("slot"), "jobId": item.get("currentJobId")})
                    if item.get("status") in UNRESOLVED:
                        manual.append({"batchId": state["batchId"], "itemId": item["id"], "status": item.get("status"), "reason": item.get("failureReason")})
            return {"available": True, "active": active, "manualReview": manual, "batchCount": len(self._states)}

    def _require_confirmed(self, paid_confirmed: bool) -> None:
        if paid_confirmed is not True:
            raise BatchError("开始批量提交前必须明确确认可能产生费用", 409)

    def start(self, batch_id: str, paid_confirmed: bool) -> dict:
        self._require_confirmed(paid_confirmed)
        with self._lock:
            state = self._get(batch_id)
            if state.get("status") not in {"validated", "paused"}:
                raise BatchError("当前批次不能启动或继续", 409)
            unresolved = [x["id"] for x in state["items"] if x.get("status") in UNRESOLVED]
            if unresolved:
                raise BatchError("请先跳过或人工核查未决任务", 409, {"items": unresolved})
            state["authorization"] = {"paidGeneration": True, "confirmedAt": now_iso()}
            state["status"] = "running"
            state["pauseReason"] = None
            self._event(state, "batch_started", message="用户已确认可能产生费用，开始派发")
            self._persist(state)
            self._ensure_worker(batch_id)
            return copy.deepcopy(state)

    def pause(self, batch_id: str, reason: str = "用户已暂停补位") -> dict:
        with self._lock:
            state = self._get(batch_id)
            if state.get("status") in {"completed", "cancelled"}:
                return copy.deepcopy(state)
            state["status"] = "paused"
            state["pauseReason"] = reason
            self._event(state, "batch_paused", message=reason)
            self._persist(state)
            return copy.deepcopy(state)

    def resume(self, batch_id: str, paid_confirmed: bool = False) -> dict:
        self._require_confirmed(paid_confirmed)
        with self._lock:
            state = self._get(batch_id)
            login_items = [x for x in state["items"] if x.get("status") == "login_required"]
            other_unresolved = [x["id"] for x in state["items"] if x.get("status") in (UNRESOLVED - {"login_required"})]
            orphaned = [x["id"] for x in state["items"] if x.get("status") == "running" and not x.get("currentJobId")]
            still_running = [x["id"] for x in state["items"] if x.get("status") == "running"]
            if other_unresolved or orphaned:
                raise BatchError("\u6279\u6b21\u4ecd\u6709\u9700\u8981\u4eba\u5de5\u5904\u7406\u7684\u4efb\u52a1", 409, {"items": other_unresolved + orphaned})
            if login_items and still_running:
                raise BatchError("\u5176\u4ed6\u5de5\u4f5c\u4f4d\u4ecd\u6709\u5df2\u63d0\u4ea4\u4efb\u52a1\uff0c\u8bf7\u7b49\u5b83\u4eec\u8fd4\u56de\u7ed3\u679c\u540e\u518d\u7ee7\u7eed", 409, {"items": still_running})
            # 同一共享档案只核验一次；第一次核验会关闭登录窗口释放档案锁。
            verified_profiles: dict[str, bool] = {}
            unverified = []
            for login_item in login_items:
                profile_key = str(login_item.get("profile") or f"slot-{login_item.get('slot')}")
                if profile_key not in verified_profiles:
                    verified_profiles[profile_key] = bool(self.slot_login_ready({"batchId": batch_id, **login_item}))
                if not verified_profiles[profile_key]:
                    unverified.append(login_item["id"])
            if unverified:
                raise BatchError("\u8bf7\u5148\u5728\u5bf9\u5e94\u5de5\u4f5c\u4f4d\u6d4f\u89c8\u5668\u5b8c\u6210\u767b\u5f55\uff1b\u670d\u52a1\u5c1a\u672a\u6838\u9a8c\u5230\u767b\u5f55\u72b6\u6001", 409, {"items": unverified})
            if state.get("status") not in {"paused", "validated"}:
                raise BatchError("\u5f53\u524d\u6279\u6b21\u4e0d\u80fd\u7ee7\u7eed", 409)
            for item in login_items:
                item["loginCheckJobId"] = item.get("currentJobId")
                item.update({"status": "pending", "slot": None, "currentJobId": None, "failureReason": None})
            state["authorization"] = {"paidGeneration": True, "confirmedAt": now_iso()}
            state["status"] = "running"
            state["pauseReason"] = None
            self._event(state, "batch_resumed", message="\u5de5\u4f5c\u4f4d\u767b\u5f55\u5df2\u6838\u9a8c\uff1b\u7528\u6237\u786e\u8ba4\u7ee7\u7eed\u5269\u4f59\u4efb\u52a1")
            self._persist(state)
            self._ensure_worker(batch_id)
            return copy.deepcopy(state)

    def cancel(self, batch_id: str) -> dict:
        with self._lock:
            state = self._get(batch_id)
            state["status"] = "cancelled"
            state["pauseReason"] = "用户已取消后续补位；已提交作业不被强制终止"
            self._event(state, "batch_cancelled", message=state["pauseReason"])
            self._persist(state)
            return copy.deepcopy(state)

    def skip(self, batch_id: str, item_id: str) -> dict:
        with self._lock:
            state = self._get(batch_id)
            item = self._item(state, item_id)
            if item.get("status") not in UNRESOLVED | {"pending"}:
                raise BatchError("当前任务不能跳过", 409)
            item.update({"status": "skipped", "slot": None, "failureReason": "用户选择跳过；原作业关联保留"})
            self._event(state, "item_skipped", item_id, "用户选择跳过")
            self._persist(state)
            return copy.deepcopy(state)

    def resubmit(self, batch_id: str, item_id: str, paid_confirmed: bool, confirm_repeat_charge: bool) -> dict:
        self._require_confirmed(paid_confirmed)
        if confirm_repeat_charge is not True:
            raise BatchError("重新提交前必须明确确认可能重复扣费", 409)
        with self._lock:
            state = self._get(batch_id)
            item = self._item(state, item_id)
            if item.get("status") not in UNRESOLVED:
                raise BatchError("只有失败或结果待核查任务可以重新提交", 409)
            previous = item.get("lastResult") or {}
            if previous.get("submitted") is not False:
                raise BatchError("上次提交状态不明或已提交，禁止重新提交；请先核对原作业回执", 409)
            item.setdefault("attemptHistory", []).append({"jobId": item.get("currentJobId"), "attempt": item.get("attempts"), "result": copy.deepcopy(previous), "at": now_iso()})
            item.update({"status": "pending", "slot": None, "retryOf": item.get("currentJobId"), "currentJobId": None, "submissionId": None, "failureReason": None})
            state["authorization"] = {"paidGeneration": True, "confirmedAt": now_iso()}
            state["status"] = "paused"
            self._event(state, "item_resubmission_armed", item_id, "用户确认人工重新提交；等待继续批次")
            self._persist(state)
            return copy.deepcopy(state)

    def recover(self, batch_id: str) -> dict:
        with self._lock:
            state = self._get(batch_id)
            # 兼容旧 runner 的未登录回执：只读取已有作业，不会重新提交。
            for item in state.get("items", []):
                if item.get("status") == "login_required" and not item.get("slot"):
                    match = re.search(r"-slot-(\d+)$", str(item.get("profile") or ""))
                    if match:
                        item["slot"] = int(match.group(1))
                if item.get("status") != "result_pending" or not item.get("currentJobId"):
                    continue
                try:
                    job = self.get_job(str(item["currentJobId"]))
                except Exception:
                    continue
                if job.get("status") == "done" and job.get("ok") is True:
                    self._finalize_job(state, item, job)
                    continue
                login_status = str(job.get("resultStatus") or job.get("status") or "").lower()
                if login_status == "need_login" and job.get("submitted") is False:
                    slot = item.get("slot")
                    if not slot:
                        match = re.search(r"-slot-(\d+)$", str(item.get("profile") or ""))
                        slot = int(match.group(1)) if match else None
                    item.update({"status": "login_required", "slot": slot, "failureReason": "该工作位尚未登录，未向平台提交生成；请登录此槽位后再继续"})
                    if state.get("status") != "cancelled":
                        state["status"] = "paused"
                        state["pauseReason"] = "检测到批次工作位未登录，已暂停派发"
            self._event(state, "recovery_requested", message="已请求重新核对运行中的作业")
            self._persist(state)
            self._ensure_worker(batch_id)
            return copy.deepcopy(state)

    def _item(self, state: dict, item_id: str) -> dict:
        for item in state.get("items", []):
            if item.get("id") == item_id:
                return item
        raise BatchError("找不到任务", 404)

    def _ensure_worker(self, batch_id: str) -> None:
        worker = self._workers.get(batch_id)
        if worker and worker.is_alive():
            return
        worker = threading.Thread(target=self._worker_loop, args=(batch_id,), name=f"multica-batch-{batch_id}", daemon=True)
        self._workers[batch_id] = worker
        worker.start()

    def _allocate_slot(self, state: dict) -> int | None:
        used = {item.get("slot") for item in state["items"] if item.get("status") == "running" and item.get("slot")}
        limit = 1 if state.get("profileMode") == "shared" else int(state["concurrency"])
        for slot in range(1, limit + 1):
            if slot not in used:
                return slot
        return None

    def _summary(self, job: dict) -> dict:
        allowed = ("jobId", "status", "resultStatus", "retryAllowed", "submitted", "billed", "chargeKnown", "actualPointDeduction", "phase", "phaseSource", "phaseAt", "ok", "images", "aspect", "recordId", "message", "startedAt")
        return {key: job.get(key) for key in allowed if key in job}

    def _pause_item(self, state: dict, item: dict, status: str, reason: str) -> None:
        item.update({"status": status, "slot": None, "failureReason": reason, "lastResult": item.get("lastResult")})
        if state.get("status") != "cancelled":
            state["status"] = "paused"
        state["pauseReason"] = reason
        self._event(state, "batch_paused_for_review", item.get("id"), reason)

    def _finalize_job(self, state: dict, item: dict, job: dict) -> None:
        summary = self._summary(job)
        item["lastResult"] = summary
        # 旧版 runner 的未登录回执只有 status=need_login、没有 resultStatus。
        # 只要明确未登录且尚未提交，就归类为登录待处理，绝不自动重提。
        login_status = str(job.get("resultStatus") or job.get("status") or "").lower()
        if login_status == "need_login" and job.get("submitted") is False:
            item.update({"status": "login_required", "failureReason": "该工作位尚未登录，未向平台提交生成；请登录此槽位后再继续"})
            if state.get("status") != "cancelled":
                state["status"] = "paused"
            state["pauseReason"] = "\u68c0\u6d4b\u5230\u6279\u6b21\u5de5\u4f5c\u4f4d\u672a\u767b\u5f55\uff0c\u5df2\u6682\u505c\u6d3e\u53d1"
            self._event(state, "slot_login_required", item.get("id"), "检测到批次工作位未登录，已暂停派发")
            return
        if job.get("status") == "done" and job.get("ok") is True:
            files = [str(path) for path in (job.get("images") or []) if path]
            valid_files = [path for path in files if image_type(Path(path))]
            if files and len(valid_files) == len(files):
                item.update({"status": "completed", "slot": None, "finishedAt": now_iso(), "outputFiles": valid_files, "failureReason": None})
                self._event(state, "item_completed", item.get("id"), "已收到可信回执且成品文件检查通过")
                return
            self._pause_item(state, item, "result_pending", "平台报告完成，但成品文件缺失或图片格式校验失败，需人工核查")
            return
        status = str(job.get("resultStatus") or job.get("status") or "unknown").lower()
        if status in {"running", "queued"}:
            return
        if status in {"unknown", "stale", "receipt_pending", "download_failed", "timeout"} or job.get("chargeKnown") is not True:
            self._pause_item(state, item, "result_pending", "平台没有返回可确认的成品，本批次已暂停")
        else:
            self._pause_item(state, item, "failed", str(job.get("message") or "平台返回失败，本批次已暂停"))

    def _worker_loop(self, batch_id: str) -> None:
        recovered = False
        while True:
            with self._lock:
                state = self._states.get(batch_id)
                if not state or state.get("status") == "completed" or (state.get("status") == "cancelled" and not any(x.get("status") == "running" for x in state.get("items", []))):
                    return
                active = [x for x in state["items"] if x.get("status") == "running"]

            # Recovery never submits an item whose previous submission intent was persisted.
            if not recovered:
                recovered = True
                with self._lock:
                    for item in self._states[batch_id]["items"]:
                        if item.get("status") == "running" and not item.get("currentJobId"):
                            self._pause_item(self._states[batch_id], item, "result_pending", "服务重启时发现任务已准备提交但没有作业号，禁止自动重提")
                    self._persist(self._states[batch_id])

            for item in list(active):
                job_id = item.get("currentJobId")
                if not job_id:
                    continue
                try:
                    job = self.get_job(str(job_id))
                except JobNotFound:
                    with self._lock:
                        current = self._states.get(batch_id)
                        if current:
                            self._pause_item(current, self._item(current, item["id"]), "result_pending", "已提交但未找到作业记录，禁止自动重提")
                            self._persist(current)
                    continue
                except Exception as exc:
                    with self._lock:
                        current = self._states.get(batch_id)
                        if current:
                            self._pause_item(current, self._item(current, item["id"]), "result_pending", "读取平台作业状态失败，需人工核查")
                            self._persist(current)
                    continue
                if str(job.get("status") or "").lower() in {"running", "queued"}:
                    continue
                with self._lock:
                    current = self._states.get(batch_id)
                    if not current:
                        return
                    self._finalize_job(current, self._item(current, item["id"]), job)
                    self._persist(current)

            with self._lock:
                state = self._states.get(batch_id)
                if not state:
                    return
                if state.get("status") == "running":
                    while True:
                        slot = self._allocate_slot(state)
                        pending = next((x for x in state["items"] if x.get("status") == "pending"), None)
                        if slot is None or pending is None:
                            break
                        profile = self.shared_profile if state.get("profileMode") == "shared" else str(self.slot_root / f"{batch_id}-slot-{slot}")
                        pending.update({"status": "running", "slot": slot, "profile": profile, "attempts": int(pending.get("attempts") or 0) + 1, "submissionId": uuid.uuid4().hex, "startedAt": now_iso(), "failureReason": None})
                        self._persist(state)
                        request = {**pending, "batchId": batch_id, "slot": slot, "profile": profile}
                        try:
                            submitted = self.submit_job(request)
                        except Exception as exc:
                            self._pause_item(state, pending, "failed", "任务派发失败，本批次已暂停")
                            pending["lastResult"] = {"status": "dispatch_failed", "message": str(exc)[:240]}
                            self._persist(state)
                            break
                        pending["currentJobId"] = str(submitted.get("jobId") or "") or None
                        pending["lastResult"] = self._summary(submitted)
                        if not pending["currentJobId"]:
                            self._pause_item(state, pending, "result_pending", "派发结果没有返回作业号，禁止自动重提")
                        else:
                            self._event(state, "item_submitted", pending.get("id"), "已持久化作业号，等待回执")
                        self._persist(state)
                all_done = state["items"] and all(x.get("status") in ITEM_TERMINAL for x in state["items"])
                if all_done and state.get("status") == "running":
                    state["status"] = "completed"
                    state["pauseReason"] = None
                    self._event(state, "batch_completed", message="所有任务均已完成或跳过")
                    self._persist(state)
                    return
                if state.get("status") in {"paused", "cancelled"} and not any(x.get("status") == "running" for x in state["items"]):
                    return
            time.sleep(self.poll_seconds)


__all__ = ["BatchManager", "BatchError", "JobNotFound", "validate_payload"]
