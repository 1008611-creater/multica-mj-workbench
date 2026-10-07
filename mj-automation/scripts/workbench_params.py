"""Validate a complete request before persisting or dispatching it."""
import hashlib
import json
import re

ASPECTS = {"1:1", "1:2", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"}
VERSIONS = {"v8.2", "v8.1", "v7", "v6.1", "v6", "niji6", "niji7"}

def normalize_params(params, version="v8.2"):
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ValueError("高级参数必须是对象")
    unknown = set(params) - {"stylize", "chaos", "seed", "quality", "raw"}
    if unknown:
        raise ValueError("不支持的高级参数：" + "、".join(sorted(unknown)))
    result = {}
    for key, value in params.items():
        if key == "raw":
            if not isinstance(value, bool):
                raise ValueError("raw 必须是布尔值")
        else:
            lo, hi = {"stylize": (0, 1000), "chaos": (0, 100), "seed": (0, 4294967295), "quality": (0.5, 4)}[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
                raise ValueError(f"{key} 必须是 {lo}–{hi} 内的数值")
            if key != "quality" and int(value) != value:
                raise ValueError(f"{key} 必须是整数")
            if key == "quality":
                choices = {1, 2, 4} if version == "v7" else {0.5, 1, 2}
                if version not in {"v6", "v6.1", "v7"} or value not in choices:
                    raise ValueError("此版本不支持所选 quality；V8 不支持质量参数，Niji 质量映射未核验")
            else:
                value = int(value)
        result[key] = value
    return dict(sorted(result.items()))

def prepare_request(prompt, aspect, version, params):
    if not isinstance(prompt, str):
        raise ValueError("提示词必须是文本")
    prompt = prompt.strip()
    if not prompt or len(prompt) > 12000:
        raise ValueError("提示词不能为空且最多 12000 字符")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", prompt):
        raise ValueError("提示词含不可见控制字符")
    if re.search(r"(?:^|\s)--[a-z]", prompt, re.I):
        raise ValueError("请将 -- 参数移出正文，填写在高级参数中，避免重复覆盖")
    if aspect not in ASPECTS:
        raise ValueError("不支持的画幅：" + str(aspect))
    if version not in VERSIONS:
        raise ValueError("不支持的模型版本：" + str(version))
    params = normalize_params(params, version)
    suffix = []
    for key, value in params.items():
        if key == "raw":
            if value:
                suffix.append("--raw")
        else:
            suffix.append(f"--{key} {value}")
    return {"prompt": prompt, "aspect": aspect, "version": version, "params": params,
            "effectivePrompt": " ".join([prompt] + suffix), "parameterVerification": "transport_only"}

def request_fingerprint(prepared, profile):
    identity = {k: prepared[k] for k in ("prompt", "aspect", "version", "params")}
    identity["profile"] = str(profile).casefold()
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
