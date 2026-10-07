"""Read-only image index + atomic annotations; never accepts a client file path."""
from pathlib import Path
import hashlib
import json
import os
import threading
import time
import copy
import struct
import shutil
import uuid


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def image_type(path):
    if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"} or not path.is_file() or path.is_symlink():
        return None
    try:
        with path.open("rb") as handle:
            head = handle.read(32)
            size = path.stat().st_size
            handle.seek(max(0, size - 12))
            tail = handle.read()
        if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR" and len(head) >= 24 and all(struct.unpack(">II", head[16:24])) and tail == b"\x00\x00\x00\x00IEND\xaeB`\x82":
            return "image/png"
        if head.startswith(b"\xff\xd8\xff") and size > 32 and tail.endswith(b"\xff\xd9"):
            return "image/jpeg"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP" and size > 32 and int.from_bytes(head[4:8], "little") + 8 == size:
            return "image/webp"
    except OSError:
        pass
    return None


class AssetLibrary:
    def __init__(self, jobs, batches, receipts, annotations):
        self.jobs = Path(jobs)
        self.batches = Path(batches)
        self.receipts = Path(receipts)
        self.annotations = Path(annotations)
        self.lock = threading.RLock()
        self._cache = None
        self._cache_at = 0

    def _annotations(self):
        if not self.annotations.exists():
            return {}
        # A corrupt file must not be silently replaced by an empty collection.
        value = json.loads(self.annotations.read_text(encoding="utf-8-sig"))
        if not isinstance(value, dict) or any(not isinstance(v, dict) for v in value.values()):
            raise ValueError("图库标注文件损坏，已停止写入，请保留原文件后修复")
        return value

    def index(self):
        with self.lock:
            if self._cache is not None and time.monotonic() - self._cache_at < 2:
                return copy.deepcopy(self._cache)
        receipts = {}
        if self.receipts.exists():
            for line in self.receipts.read_text(encoding="utf-8-sig", errors="replace").splitlines():
                try:
                    row = json.loads(line)
                    for f in row.get("files") or []:
                        if isinstance(f, dict) and f.get("file"):
                            receipts[str(Path(f["file"]).resolve()).casefold()] = (row, f)
                except (ValueError, TypeError, AttributeError):
                    continue
        batch_jobs = {}
        for file in self.batches.glob("*.json"):
            batch = read_json(file)
            for item in batch.get("items", []) if isinstance(batch.get("items"), list) else []:
                if not isinstance(item, dict):
                    continue
                for job_id in [item.get("currentJobId")] + [a.get("jobId") for a in (item.get("attemptHistory") if isinstance(item.get("attemptHistory"), list) else []) if isinstance(a, dict)]:
                    if job_id:
                        batch_jobs[job_id] = (batch, item)
        with self.lock:
            notes = self._annotations()
        assets = []
        for file in self.jobs.glob("*.json"):
            job = read_json(file)
            request = read_json(self.jobs / "requests" / file.name)
            batch, item = batch_jobs.get(file.stem, ({}, {}))
            candidates = list(job.get("images")) if isinstance(job.get("images"), list) else []
            if job.get("file"):
                candidates.append(job["file"])
            seen = set()
            for candidate in candidates:
                if not isinstance(candidate, str) or not Path(candidate).is_absolute():
                    continue
                original = Path(candidate)
                if any(part.is_symlink() or getattr(part, "is_junction", lambda: False)() for part in [original, *original.parents]):
                    continue
                path = original.resolve()
                mime = image_type(path)
                identity = str(path).casefold()
                if not mime or identity in seen:
                    continue
                seen.add(identity)
                try:
                    stat = path.stat()
                except OSError:
                    continue
                asset_id = hashlib.sha256((file.stem + "|" + identity).encode()).hexdigest()[:24]
                receipt, info = receipts.get(identity, ({}, {}))
                assets.append({"id": asset_id, "jobId": file.stem, "name": item.get("name") or request.get("name") or path.stem,
                    "path": str(path), "mime": mime, "bytes": stat.st_size,
                    "width": info.get("w"), "height": info.get("h"), "sha256": info.get("sha256"),
                    "createdAt": stat.st_mtime, "batchId": batch.get("batchId"), "batchName": batch.get("name"),
                    "attempt": next((a.get("attempt") for a in (item.get("attemptHistory") if isinstance(item.get("attemptHistory"), list) else []) if isinstance(a, dict) and a.get("jobId") == file.stem), item.get("attempts")),
                    "prompt": request.get("prompt") or job.get("prompt") or item.get("prompt"),
                    "effectivePrompt": request.get("effectivePrompt") or job.get("effectivePrompt") or receipt.get("effective_prompt"),
                    "params": request.get("params", job.get("params", item.get("params"))),
                    "version": request.get("version") or job.get("version") or item.get("version") or receipt.get("requested_version"),
                    "aspect": job.get("aspect") or receipt.get("aspect"), "requestedAspect": request.get("aspect") or item.get("aspect") or receipt.get("requested_aspect"),
                    "parameterVerification": request.get("parameterVerification") or job.get("parameterVerification") or "missing",
                    "recordId": job.get("recordId") or receipt.get("serial"), "receipt": receipt or None,
                    "status": job.get("status"), "submitted": job.get("submitted"), "billed": job.get("billed"),
                    "favorite": bool(notes.get(asset_id, {}).get("favorite")), "archived": bool(notes.get(asset_id, {}).get("archived")),
                    "tags": notes.get(asset_id, {}).get("tags", [])})
        with self.lock:
            self._cache = sorted(assets, key=lambda row: row["createdAt"], reverse=True)
            self._cache_at = time.monotonic()
            return copy.deepcopy(self._cache)

    def get(self, asset_id):
        result = next((row for row in self.index() if row["id"] == asset_id), None)
        candidate = Path(result["path"]) if result else None
        if not candidate or any(part.is_symlink() or getattr(part, "is_junction", lambda: False)() for part in [candidate, *candidate.parents]) or not image_type(candidate):
            raise KeyError("没有找到此图片或原文件已不可用")
        return result

    def annotate(self, asset_id, patch):
        if not isinstance(patch, dict) or set(patch) - {"favorite", "archived", "tags"}:
            raise ValueError("图库标注字段或类型无效")
        for key in ("favorite", "archived"):
            if key in patch and not isinstance(patch[key], bool):
                raise ValueError("图库标注字段或类型无效")
        if "tags" in patch:
            tags = patch["tags"]
            if not isinstance(tags, list) or len(tags) > 20 or any(not isinstance(t, str) or not t.strip() or len(t) > 40 for t in tags):
                raise ValueError("最多 20 个标签，每个标签须为 1–40 字符")
            patch = {**patch, "tags": list(dict.fromkeys(t.strip() for t in tags))}
        self.get(asset_id)
        with self.lock:
            notes = self._annotations()
            notes[asset_id] = {**notes.get(asset_id, {}), **patch}
            self.annotations.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.annotations.with_suffix(".tmp")
            tmp.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.annotations)
            self._cache = None
        return self.get(asset_id)


    def storage(self, default_output):
        with self.lock:
            file = self.annotations.with_name("library-storage.json")
            value = json.loads(file.read_text(encoding="utf-8-sig")) if file.exists() else {}
            if not isinstance(value, dict) or set(value) - {"outputDir", "materialDir"}:
                raise ValueError("图片位置配置损坏，请保留原文件后修复")
            for key, path in value.items():
                if not isinstance(path, str):
                    raise ValueError("图片位置配置损坏")
                if path:
                    self._destination(path)
            return {"outputDir": value.get("outputDir") or str(default_output), "materialDir": value.get("materialDir") or ""}

    def _destination(self, value):
        if not isinstance(value, str) or not value.strip() or not Path(value.strip()).expanduser().is_absolute():
            raise ValueError("请填写完整的绝对目录，例如 D:\\创作\\图片")
        path = Path(value.strip()).expanduser()
        for part in [path, *path.parents]:
            if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
                raise ValueError("保存位置不能经过符号链接或目录联接")
        path = path.resolve()
        protected = [self.jobs.resolve(), self.batches.resolve(), self.annotations.parent.resolve(),
                     self.receipts.parent.resolve(), Path(__file__).resolve().parent]
        if path == Path(path.anchor) or any(path == p or p in path.parents for p in protected):
            raise ValueError("请使用独立图片目录，不能写入磁盘根目录、程序、任务或回执目录")
        if path.exists() and not path.is_dir():
            raise ValueError("此位置不是目录")
        return path

    def configure_storage(self, patch, default_output):
        if not isinstance(patch, dict) or not patch or set(patch) - {"outputDir", "materialDir"}:
            raise ValueError("只支持原图保存位置和素材目录")
        with self.lock:
            value = self.storage(default_output)
            for key, entry in patch.items():
                if not isinstance(entry, str):
                    raise ValueError("目录必须是文本")
                value[key] = str(self._destination(entry)) if entry.strip() else (str(default_output) if key == "outputDir" else "")
            file = self.annotations.with_name("library-storage.json")
            file.parent.mkdir(parents=True, exist_ok=True)
            tmp = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
            tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, file)
            return value

    @staticmethod
    def _file_digest(file):
        digest = hashlib.sha256()
        with Path(file).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _publish_no_replace(temporary, target):
        # Windows rename is atomic and refuses an existing target. POSIX link has
        # the same no-overwrite behavior. Both files are on the destination volume.
        if os.name == "nt":
            os.rename(temporary, target)
        else:
            os.link(temporary, target)
            temporary.unlink()

    def deliver(self, asset_ids, default_output):
        if not isinstance(asset_ids, list) or not 1 <= len(asset_ids) <= 100 or any(not isinstance(i, str) for i in asset_ids):
            raise ValueError("每次请选择 1–100 张真实图片")
        if len(set(asset_ids)) != len(asset_ids):
            raise ValueError("图片选择不能重复")
        with self.lock:
            configured = self.storage(default_output)["materialDir"]
            if not configured:
                raise ValueError("请先在连接与设置中填写素材目录")
            destination = self._destination(str(self._destination(configured) / "multica-assets"))
            assets = [self.get(i) for i in asset_ids]  # Validate every ID before creating any file.
            destination.mkdir(parents=True, exist_ok=True)
            outcomes = []
            for asset in assets:
                temporary = None
                try:
                    source = Path(asset["path"])
                    temporary = destination / (".delivery-" + uuid.uuid4().hex + ".tmp")
                    with source.open("rb") as src, temporary.open("xb") as dst:
                        shutil.copyfileobj(src, dst)
                        dst.flush()
                        os.fsync(dst.fileno())
                    digest = self._file_digest(temporary)
                    if not image_type(source) or self._file_digest(source) != digest:
                        raise ValueError("复制期间原文件改变，请刷新后重试")
                    receipt_hash = asset.get("sha256")
                    if isinstance(receipt_hash, str) and len(receipt_hash) == 64 and receipt_hash.lower() != digest:
                        raise ValueError("原图与已记录回执哈希不一致，已停止素材交付")
                    target = destination / (asset["id"] + "-" + digest[:16] + source.suffix.lower())
                    sidecar = target.with_suffix(target.suffix + ".json")
                    self._destination(str(destination))
                    for entry in (target, sidecar):
                        if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)():
                            raise ValueError("素材目标文件不能是链接")
                    existed = target.exists()
                    if existed:
                        if self._file_digest(target) != digest:
                            raise ValueError("目标有不同内容，已停止覆盖")
                    else:
                        try:
                            self._publish_no_replace(temporary, target)
                        except FileExistsError:
                            if self._file_digest(target) != digest:
                                raise ValueError("素材文件被其他程序写入不同内容，已停止覆盖")
                            existed = True
                    if self._file_digest(target) != digest:
                        raise ValueError("素材副本哈希校验失败")
                    metadata = {"schema": "multica-asset-v1", "assetId": asset["id"], "sha256": digest,
                                "file": target.name, "sourcePath": asset["path"],
                                **{k: asset.get(k) for k in ("jobId", "batchId", "batchName", "attempt", "recordId", "name", "prompt", "effectivePrompt", "params", "version", "requestedAspect", "aspect", "parameterVerification", "submitted", "billed", "tags")}}
                    if sidecar.exists():
                        previous = json.loads(sidecar.read_text(encoding="utf-8"))
                        if not isinstance(previous, dict) or previous.get("assetId") != asset["id"] or previous.get("sha256") != digest:
                            raise ValueError("目标来源清单冲突，已停止覆盖")
                    else:
                        note_tmp = destination / (".delivery-" + uuid.uuid4().hex + ".tmp")
                        try:
                            with note_tmp.open("x", encoding="utf-8") as handle:
                                json.dump(metadata, handle, ensure_ascii=False, indent=2)
                                handle.flush()
                                os.fsync(handle.fileno())
                            self._publish_no_replace(note_tmp, sidecar)
                        except FileExistsError:
                            previous = json.loads(sidecar.read_text(encoding="utf-8"))
                            if not isinstance(previous, dict) or previous.get("assetId") != asset["id"] or previous.get("sha256") != digest:
                                raise ValueError("来源清单被其他程序修改，已停止覆盖")
                        finally:
                            if note_tmp.exists():
                                note_tmp.unlink()
                    outcomes.append({"id": asset["id"], "ok": True, "status": "already_present" if existed else "copied", "path": str(target), "metadataPath": str(sidecar), "sha256": digest})
                except (ValueError, OSError) as exc:
                    outcomes.append({"id": asset["id"], "ok": False, "error": str(exc)})
                finally:
                    if temporary and temporary.exists():
                        temporary.unlink()
            return {"ok": all(o["ok"] for o in outcomes), "directory": str(destination), "items": outcomes}
