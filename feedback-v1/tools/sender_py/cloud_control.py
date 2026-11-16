"""极方每周反馈程序 · 云控策略管理与远程指令接收器 (Two-Tier Cloud Control)。

职责：
1. 维护从服务端同步的有效云控策略（Tier 1 全局策略与 Tier 2 单机覆盖策略已在服务端合并下发）；
2. 提供语义化版本号比较与启停门禁校验（停服锁、最低版本强制升级/提醒）；
3. 去重执行服务端下发的单机远程指令（如 stop_batch 远程急停、refresh_policy、clear_roi、sync_logs），
   并生成幂等执行回执附带在下一次同步请求中上传。

本模块仅使用 Python 标准库，无 GUI/Windows 依赖，可在 Linux 下完整单元测试。
"""

import datetime
import re
import threading
from typing import Any, Callable, Dict, List, Optional

CONTROL_PULL_PATH = "/api/logs.php?action=sender_control_pull"

VALID_VERIFY_MODES = ("auto", "local", "api")
VALID_SNAPSHOT_POLICIES = ("errors_only", "always", "off")
VALID_VERSION_ACTIONS = ("block", "warn")

DEFAULT_CLOUD_POLICY: Dict[str, Any] = {
    "policyVersion": 1,
    "senderServiceEnabled": True,
    "enableAutoCalibration": True,
    "verifyMode": "auto",
    "enableReplyAnalysis": True,
    "enableBenchmarkModel": True,
    "snapshotPolicy": "errors_only",
    "minSenderVersion": "",
    "minVersionAction": "block",
    "updateUrl": "",
    "noticeMessage": "",
    "searchWait": 1.5,
    "enterWait": 1.2,
    "studentGapMin": 0.5,
    "studentGapMax": 1.0,
    "batchBreakEvery": 15,
    "batchBreakMin": 2.0,
    "batchBreakMax": 3.0,
    "updatedAt": "",
}


def parse_semver(version_str: str) -> tuple:
    """将版本号（如 'v2.0.3' / '2.0.2-beta'）解析为可比较的整数元组。"""
    s = str(version_str or "").strip()
    if not s:
        return ()
    s = re.sub(r"^[vV]", "", s)
    core = s.split("-", 1)[0].split("+", 1)[0]
    parts = []
    for seg in core.split("."):
        m = re.match(r"^(\d+)", seg.strip())
        if not m:
            break
        parts.append(int(m.group(1)))
    while len(parts) < 3 and parts:
        parts.append(0)
    return tuple(parts)


def is_version_below(current_version: str, min_version: str) -> bool:
    """判断 current_version 是否严格低于 min_version；任意一方为空或无效时返回 False（fail-open）。"""
    min_ver = str(min_version or "").strip()
    if not min_ver:
        return False
    cur_t = parse_semver(current_version)
    min_t = parse_semver(min_ver)
    if not cur_t or not min_t:
        return False
    width = max(len(cur_t), len(min_t))
    cur_padded = cur_t + (0,) * (width - len(cur_t))
    min_padded = min_t + (0,) * (width - len(min_t))
    return cur_padded < min_padded


def _clamp_float(val: Any, low: float, high: float, default: float) -> float:
    if val is None or val == "" or isinstance(val, bool):
        return default
    try:
        f = round(float(val), 2)
    except (TypeError, ValueError):
        return default
    if f < low:
        return low
    if f > high:
        return high
    return f


def _clamp_int(val: Any, low: int, high: int, default: int) -> int:
    if val is None or val == "" or isinstance(val, bool):
        return default
    try:
        i = int(float(val))
    except (TypeError, ValueError):
        return default
    if i < low:
        return low
    if i > high:
        return high
    return i


def normalize_policy(raw: Optional[dict]) -> Dict[str, Any]:
    """清洗并边界约束服务端下发的云控策略字段。"""
    src = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULT_CLOUD_POLICY)

    out["policyVersion"] = _clamp_int(src.get("policyVersion"), 1, 10**9, 1)
    if "senderServiceEnabled" in src:
        out["senderServiceEnabled"] = bool(src.get("senderServiceEnabled"))
    if "enableAutoCalibration" in src:
        out["enableAutoCalibration"] = bool(src.get("enableAutoCalibration"))

    vm = str(src.get("verifyMode") or out["verifyMode"]).strip().lower()
    out["verifyMode"] = vm if vm in VALID_VERIFY_MODES else "auto"

    if "enableReplyAnalysis" in src:
        out["enableReplyAnalysis"] = bool(src.get("enableReplyAnalysis"))
    if "enableBenchmarkModel" in src:
        out["enableBenchmarkModel"] = bool(src.get("enableBenchmarkModel"))

    sp = str(src.get("snapshotPolicy") or out["snapshotPolicy"]).strip().lower()
    out["snapshotPolicy"] = sp if sp in VALID_SNAPSHOT_POLICIES else "errors_only"

    out["minSenderVersion"] = str(src.get("minSenderVersion") or "").strip()[:32]
    va = str(src.get("minVersionAction") or out["minVersionAction"]).strip().lower()
    out["minVersionAction"] = va if va in VALID_VERSION_ACTIONS else "block"

    url = str(src.get("updateUrl") or "").strip()[:500]
    out["updateUrl"] = url if url.lower().startswith(("http://", "https://")) else ""
    out["noticeMessage"] = str(src.get("noticeMessage") or "").strip()[:500]

    out["searchWait"] = _clamp_float(src.get("searchWait"), 0.4, 8.0, DEFAULT_CLOUD_POLICY["searchWait"])
    out["enterWait"] = _clamp_float(src.get("enterWait"), 0.4, 8.0, DEFAULT_CLOUD_POLICY["enterWait"])

    gap_min = _clamp_float(src.get("studentGapMin"), 0.0, 30.0, DEFAULT_CLOUD_POLICY["studentGapMin"])
    gap_max = _clamp_float(src.get("studentGapMax"), 0.0, 30.0, DEFAULT_CLOUD_POLICY["studentGapMax"])
    if gap_max < gap_min:
        gap_max = gap_min
    out["studentGapMin"] = gap_min
    out["studentGapMax"] = gap_max

    out["batchBreakEvery"] = _clamp_int(src.get("batchBreakEvery"), 1, 200, DEFAULT_CLOUD_POLICY["batchBreakEvery"])
    brk_min = _clamp_float(src.get("batchBreakMin"), 0.0, 60.0, DEFAULT_CLOUD_POLICY["batchBreakMin"])
    brk_max = _clamp_float(src.get("batchBreakMax"), 0.0, 60.0, DEFAULT_CLOUD_POLICY["batchBreakMax"])
    if brk_max < brk_min:
        brk_max = brk_min
    out["batchBreakMin"] = brk_min
    out["batchBreakMax"] = brk_max
    out["updatedAt"] = str(src.get("updatedAt") or "").strip()[:40]
    return out


class CloudControlManager:
    """线程安全的云控策略与远程指令调度器。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._policy: Dict[str, Any] = dict(DEFAULT_CLOUD_POLICY)
        self._synced: bool = False
        self._global_version: int = 1
        self._has_client_override: bool = False
        self._client_overrides: Dict[str, Any] = {}
        self._client_override_note: str = ""
        self._last_sync_at: str = ""
        self._last_error: str = ""
        self._handled_cmd_ids: List[str] = []
        self._pending_acks: Dict[str, dict] = {}
        self._command_handler: Optional[Callable[[dict], Any]] = None
        self._policy_change_handler: Optional[Callable[[dict], Any]] = None

    def set_command_handler(self, handler: Optional[Callable[[dict], Any]]):
        with self._lock:
            self._command_handler = handler

    def set_policy_change_handler(self, handler: Optional[Callable[[dict], Any]]):
        with self._lock:
            self._policy_change_handler = handler

    def get_policy(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._policy)

    def get_snapshot_policy(self) -> str:
        with self._lock:
            return str(self._policy.get("snapshotPolicy") or "errors_only")

    def is_auto_calibration_enabled(self) -> bool:
        with self._lock:
            return bool(self._policy.get("enableAutoCalibration", True))

    def is_benchmark_model_enabled(self) -> bool:
        with self._lock:
            return bool(self._policy.get("enableBenchmarkModel", True))

    def mark_sync_error(self, error_msg: str):
        with self._lock:
            self._last_error = str(error_msg or "")[:200]

    def apply_server_payload(self, cloud_control: Optional[dict]) -> dict:
        """应用服务端下发的 cloud_control 载荷并分发未执行过的新指令。"""
        if not isinstance(cloud_control, dict):
            return {"updated": False, "commands_executed": 0}

        raw_policy = cloud_control.get("effective_policy")
        if raw_policy is None and "verifyMode" in cloud_control:
            raw_policy = cloud_control
        new_policy = normalize_policy(raw_policy) if isinstance(raw_policy, dict) else self.get_policy()

        commands_to_run: List[dict] = []
        policy_changed = False
        cmd_handler = None
        policy_handler = None

        with self._lock:
            old_policy = self._policy
            policy_changed = (not self._synced) or (new_policy != old_policy)
            self._policy = new_policy
            self._synced = True
            self._global_version = _clamp_int(
                cloud_control.get("global_version"),
                1,
                10**9,
                new_policy.get("policyVersion", 1),
            )
            self._has_client_override = bool(cloud_control.get("has_client_override"))
            self._client_overrides = (
                dict(cloud_control["client_overrides"])
                if isinstance(cloud_control.get("client_overrides"), dict)
                else {}
            )
            self._client_override_note = str(cloud_control.get("client_override_note") or "")
            self._last_sync_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self._last_error = ""

            pending = cloud_control.get("pending_commands") or []
            if isinstance(pending, list):
                for cmd in pending:
                    if not isinstance(cmd, dict):
                        continue
                    cid = str(cmd.get("cmd_id") or "").strip()
                    if not cid or cid in self._handled_cmd_ids:
                        continue
                    self._handled_cmd_ids.append(cid)
                    if len(self._handled_cmd_ids) > 300:
                        self._handled_cmd_ids = self._handled_cmd_ids[-200:]
                    commands_to_run.append(dict(cmd))

            cmd_handler = self._command_handler
            policy_handler = self._policy_change_handler

        # 在锁外回调指令与策略变更处理器，防止与控制器锁产生死锁
        executed = 0
        for cmd in commands_to_run:
            cid = str(cmd.get("cmd_id") or "")
            status = "ok"
            ack_msg = "已接收并执行"
            if cmd_handler is not None:
                try:
                    res = cmd_handler(cmd)
                    if isinstance(res, dict):
                        status = "ok" if res.get("success", True) else "error"
                        ack_msg = str(res.get("message") or ack_msg)[:300]
                    elif isinstance(res, tuple) and len(res) >= 2:
                        status = "ok" if res[0] else "error"
                        ack_msg = str(res[1] or ack_msg)[:300]
                    elif res is False:
                        status = "error"
                        ack_msg = "客户端执行返回失败"
                except Exception as exc:
                    status = "error"
                    ack_msg = f"执行异常: {exc}"[:300]
            else:
                status = "ignored"
                ack_msg = "未注册指令处理器"

            with self._lock:
                self._pending_acks[cid] = {
                    "cmd_id": cid,
                    "status": status,
                    "message": ack_msg,
                    "acked_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                }
            executed += 1

        if policy_changed and policy_handler is not None:
            try:
                policy_handler(new_policy)
            except Exception:
                pass

        return {
            "updated": policy_changed,
            "commands_executed": executed,
        }

    def peek_pending_acks(self) -> List[dict]:
        with self._lock:
            return [dict(v) for v in self._pending_acks.values()]

    def confirm_acks_sent(self, acks: List[dict]):
        if not acks:
            return
        ids = {str(a.get("cmd_id") or "") for a in acks if isinstance(a, dict)}
        with self._lock:
            for cid in ids:
                self._pending_acks.pop(cid, None)

    def evaluate_start_gate(self, app_version: str) -> dict:
        """在点击开始发送前评估云控门禁（停服锁 + 最低版本号校验）。"""
        with self._lock:
            pol = dict(self._policy)

        notice = str(pol.get("noticeMessage") or "").strip()
        update_url = str(pol.get("updateUrl") or "").strip()

        if not pol.get("senderServiceEnabled", True):
            reason = "管理员已暂停发送服务（云控维护锁定）。"
            if notice:
                reason += f"\n\n公告说明：{notice}"
            return {
                "allowed": False,
                "block_reason": reason,
                "warning": "",
                "update_url": update_url,
            }

        min_ver = str(pol.get("minSenderVersion") or "").strip()
        if min_ver and is_version_below(app_version, min_ver):
            action = pol.get("minVersionAction", "block")
            ver_hint = f"当前客户端版本 v{app_version} 低于管理员要求的最低版本 v{min_ver}。"
            if update_url:
                ver_hint += f"\n下载地址：{update_url}"
            if action == "block":
                return {
                    "allowed": False,
                    "block_reason": ver_hint + "\n\n请先升级至最新版本后再发送。",
                    "warning": "",
                    "update_url": update_url,
                }
            return {
                "allowed": True,
                "block_reason": "",
                "warning": ver_hint + " 建议尽快更新。",
                "update_url": update_url,
            }

        return {
            "allowed": True,
            "block_reason": "",
            "warning": "",
            "update_url": update_url,
        }

    def get_snapshot_state(self, app_version: str = "") -> dict:
        gate = self.evaluate_start_gate(app_version) if app_version else {"allowed": True, "block_reason": "", "warning": "", "update_url": ""}
        with self._lock:
            return {
                "synced": self._synced,
                "global_version": self._global_version,
                "has_client_override": self._has_client_override,
                "client_overrides": dict(self._client_overrides),
                "client_override_note": self._client_override_note,
                "last_sync_at": self._last_sync_at,
                "last_error": self._last_error,
                "policy": dict(self._policy),
                "start_gate": gate,
            }


_CLOUD_CONTROL = CloudControlManager()


def get_cloud_control_manager() -> CloudControlManager:
    return _CLOUD_CONTROL


def get_effective_policy() -> Dict[str, Any]:
    return _CLOUD_CONTROL.get_policy()
