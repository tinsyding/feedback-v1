"""极方每周反馈程序 · 核验现场诊断与截图存盘工具 (Debug Snapshots)。

功能：
1. 在每次候选人会话核验时，自动将「整窗截图」、「标题栏裁切图」和「带 ROI 框标注的整图」存入 ~/.sender_py/debug_snapshots/；
2. 记录当前核验的详细诊断信息（原图坐标、本地 OCR 原始字串、云端大模型判定与理由）；
3. 自动滚动淘汰旧截图（默认保留最新 60 个文件），防止磁盘空间无限增长；
4. 提供 Web 端 API 与前端查看器，支持在浏览器中一键查看现场截图与用系统文件管理器打开目录。
"""

import glob
import json
import os
import time


def get_debug_dir() -> str:
    """获取调试截图存储目录：~/.sender_py/debug_snapshots。"""
    try:
        try:
            from sender_py.store import default_storage_base_dir
        except ModuleNotFoundError:
            from store import default_storage_base_dir
        base = default_storage_base_dir()
    except Exception:
        base = os.path.join(os.path.expanduser("~"), ".sender_py")
    d = os.path.join(base, "debug_snapshots")
    os.makedirs(d, exist_ok=True)
    return d


def _cleanup_old_snapshots(debug_dir: str, max_files: int = 120):
    """自动清理过旧的调试截图，避免磁盘堆积（默认保留约 120 个文件，折合约 30 次核验现场）。"""
    try:
        all_files = glob.glob(os.path.join(debug_dir, "*.*"))
        # 排除 latest_* 快捷入口文件
        dated_files = [f for f in all_files if not os.path.basename(f).startswith("latest_")]
        if len(dated_files) > max_files:
            dated_files.sort(key=lambda p: os.path.getmtime(p))
            to_remove = dated_files[:len(dated_files) - max_files]
            for f in to_remove:
                try:
                    os.remove(f)
                except Exception:
                    pass
    except Exception:
        pass


def save_candidate_snapshot(full_img, roi: dict, title_img, target_id: str,
                            target_name: str, cand: int = 1, diag_info: dict = None) -> dict:
    """保存当前候选人的核验现场截图及元数据。"""
    debug_dir = get_debug_dir()
    ts = time.strftime("%Y%m%d_%H%M%S")
    clean_id = (target_id or "noid").replace("/", "_").replace("\\", "_")
    clean_name = (target_name or "noname").replace("/", "_").replace("\\", "_")
    prefix = f"{ts}_{clean_id}_{clean_name}_cand{cand}"

    saved_info = {
        "debug_dir": debug_dir,
        "timestamp": ts,
        "target_id": target_id,
        "target_name": target_name,
        "cand": cand,
        "title_path": None,
        "full_path": None,
        "annotated_path": None,
        "title_filename": None,
        "annotated_filename": None,
    }

    try:
        # 1. 保存标题栏裁切图
        if title_img is not None and hasattr(title_img, "save"):
            title_name = f"{prefix}_title.png"
            title_p = os.path.join(debug_dir, title_name)
            title_img.save(title_p, format="PNG")
            title_img.save(os.path.join(debug_dir, "latest_title.png"), format="PNG")
            saved_info["title_path"] = title_p
            saved_info["title_filename"] = title_name

        # 2. 保存整窗图与 ROI 标注图
        if full_img is not None and hasattr(full_img, "save"):
            full_name = f"{prefix}_full.png"
            full_p = os.path.join(debug_dir, full_name)
            full_img.save(full_p, format="PNG")
            full_img.save(os.path.join(debug_dir, "latest_full.png"), format="PNG")
            saved_info["full_path"] = full_p

            # 绘制带标注的 ROI 矩形图
            try:
                from PIL import ImageDraw
                annotated = full_img.copy()
                draw = ImageDraw.Draw(annotated)
                W, H = full_img.size

                try:
                    from sender_py.roi_manager import to_abs
                except ModuleNotFoundError:
                    from roi_manager import to_abs

                # 标题栏矩形 (蓝色)
                if roi and "title" in roi and roi["title"]:
                    tx, ty, tw, th = to_abs(roi["title"], (W, H))
                    draw.rectangle([tx, ty, tx + tw, ty + th], outline="#2563eb", width=3)
                    draw.text((tx + 4, max(0, ty - 14)), "Title Bar (ROI)", fill="#2563eb")

                # 输入框矩形 (红色)
                if roi and "input" in roi and roi["input"]:
                    ix, iy, iw, ih = to_abs(roi["input"], (W, H))
                    draw.rectangle([ix, iy, ix + iw, iy + ih], outline="#dc2626", width=3)
                    draw.text((ix + 4, max(0, iy - 14)), "Input Box (ROI)", fill="#dc2626")

                # 聊天区矩形 (绿色虚线/细线)
                if roi and "chat" in roi and roi["chat"]:
                    cx, cy, cw, ch = to_abs(roi["chat"], (W, H))
                    draw.rectangle([cx, cy, cx + cw, cy + ch], outline="#16a34a", width=2)
                    draw.text((cx + 4, cy + 4), "Chat Area", fill="#16a34a")

                annotated_name = f"{prefix}_annotated.png"
                annotated_p = os.path.join(debug_dir, annotated_name)
                annotated.save(annotated_p, format="PNG")
                annotated.save(os.path.join(debug_dir, "latest_annotated.png"), format="PNG")
                saved_info["annotated_path"] = annotated_p
                saved_info["annotated_filename"] = annotated_name
            except Exception:
                pass

        # 3. 保存元数据 JSON
        meta = {
            "timestamp": ts,
            "target_id": target_id,
            "target_name": target_name,
            "candidate": cand,
            "diag_info": diag_info or {},
        }
        meta_p = os.path.join(debug_dir, f"{prefix}_meta.json")
        with open(meta_p, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        with open(os.path.join(debug_dir, "latest_meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        _cleanup_old_snapshots(debug_dir)

        # 4. 当核验未通过（matched != True）或触发群聊拦截（is_group == True）时，异步同步现场快照至服务端
        try:
            judgment = (diag_info or {}).get("judgment") if isinstance(diag_info, dict) else None
            is_failed_or_blocked = False
            if isinstance(judgment, dict):
                if judgment.get("matched") is not True or judgment.get("is_group") is True:
                    is_failed_or_blocked = True
            if is_failed_or_blocked:
                _trigger_async_snapshot_upload(
                    prefix=prefix,
                    meta=meta,
                    title_path=saved_info.get("title_path"),
                    annotated_path=saved_info.get("annotated_path"),
                )
        except Exception:
            pass
    except Exception as exc:
        saved_info["error"] = str(exc)

    return saved_info


def upload_snapshot_to_server(
    prefix: str,
    meta: dict,
    title_path: str = None,
    annotated_path: str = None,
    server: str = None,
    token: str = None,
) -> bool:
    """将核验失败/拦截现场快照（meta JSON + title.png + annotated.png）同步至服务端。"""
    try:
        try:
            from sender_py.file_logger import _SYNCER, SYNC_SNAPSHOT_PATH, get_client_identity, _resolve_token
        except ModuleNotFoundError:
            from file_logger import _SYNCER, SYNC_SNAPSHOT_PATH, get_client_identity, _resolve_token
        import requests
    except Exception:
        return False

    eff_server = (server or _SYNCER.server or "").strip().rstrip("/")
    if not eff_server.startswith(("http://", "https://")):
        return False
    eff_token = _resolve_token(token or _SYNCER.token)
    ident = get_client_identity(_SYNCER.base_dir)

    files = {}
    opened_files = []
    try:
        if title_path and os.path.isfile(title_path):
            f_title = open(title_path, "rb")
            opened_files.append(f_title)
            files["image_title"] = ("title.png", f_title, "image/png")
        if annotated_path and os.path.isfile(annotated_path):
            f_ann = open(annotated_path, "rb")
            opened_files.append(f_ann)
            files["image_annotated"] = ("annotated.png", f_ann, "image/png")

        data = {
            "token": eff_token,
            "prefix": prefix,
            "client_json": json.dumps(ident, ensure_ascii=False),
            "meta_json": json.dumps(meta or {}, ensure_ascii=False),
        }
        resp = requests.post(
            eff_server + SYNC_SNAPSHOT_PATH,
            data=data,
            files=files if files else None,
            timeout=12,
        )
        if resp.status_code == 200:
            res_json = resp.json()
            return bool(isinstance(res_json, dict) and res_json.get("success"))
    except Exception:
        return False
    finally:
        for fh in opened_files:
            try:
                fh.close()
            except Exception:
                pass
    return False


def _trigger_async_snapshot_upload(prefix: str, meta: dict, title_path: str = None, annotated_path: str = None):
    try:
        try:
            from sender_py.file_logger import _SYNCER
        except ModuleNotFoundError:
            from file_logger import _SYNCER
        if not _SYNCER.enabled:
            return
        import threading
        t = threading.Thread(
            target=upload_snapshot_to_server,
            kwargs={
                "prefix": prefix,
                "meta": meta,
                "title_path": title_path,
                "annotated_path": annotated_path,
            },
            daemon=True,
        )
        t.start()
    except Exception:
        pass


def list_debug_snapshots(limit: int = 50) -> list:
    """获取所有已保存的历史核验现场记录列表，按时间倒序排列。"""
    debug_dir = get_debug_dir()
    meta_files = glob.glob(os.path.join(debug_dir, "*_meta.json"))
    # 排除 latest_meta.json
    dated_meta_files = [f for f in meta_files if not os.path.basename(f).startswith("latest_")]
    dated_meta_files.sort(key=lambda p: os.path.getmtime(p), reverse=True)

    items = []
    for meta_path in dated_meta_files[:limit]:
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            base_name = os.path.basename(meta_path)
            prefix = base_name[:-10] if base_name.endswith("_meta.json") else base_name

            ts = meta.get("timestamp", "")
            target_id = meta.get("target_id", "")
            target_name = meta.get("target_name", "")
            cand = meta.get("candidate", 1)
            diag = meta.get("diag_info", {})
            judgment = diag.get("judgment", {}) if isinstance(diag, dict) else {}

            has_title = os.path.isfile(os.path.join(debug_dir, f"{prefix}_title.png"))
            has_annotated = os.path.isfile(os.path.join(debug_dir, f"{prefix}_annotated.png"))

            # 格式化时间显示 (e.g. 20261028_204332 -> 10-28 20:43:32)
            formatted_time = ts
            if len(ts) == 15 and "_" in ts:
                formatted_time = f"{ts[4:6]}-{ts[6:8]} {ts[9:11]}:{ts[11:13]}:{ts[13:15]}"

            verdict_reason = ""
            if isinstance(judgment, dict) and judgment.get("reason"):
                verdict_reason = str(judgment["reason"])
            elif isinstance(diag, dict) and diag.get("reason"):
                verdict_reason = str(diag["reason"])

            items.append({
                "prefix": prefix,
                "timestamp": ts,
                "formatted_time": formatted_time,
                "target_id": target_id,
                "target_name": target_name,
                "candidate": cand,
                "matched": judgment.get("matched") if isinstance(judgment, dict) else None,
                "verdict_reason": verdict_reason,
                "has_title": has_title,
                "has_annotated": has_annotated,
                "title_url": f"/api/debug/image?name={prefix}_title.png" if has_title else None,
                "annotated_url": f"/api/debug/image?name={prefix}_annotated.png" if has_annotated else None,
            })
        except Exception:
            continue
    return items


def get_debug_info(prefix: str = None) -> dict:
    """获取指定 prefix 或最新一次核验的调试信息与图片相对链接。"""
    debug_dir = get_debug_dir()

    # 若指定了特定 prefix
    if prefix and prefix != "latest":
        clean_prefix = os.path.basename(prefix).replace("..", "").replace("/", "").replace("\\", "")
        meta_path = os.path.join(debug_dir, f"{clean_prefix}_meta.json")
        title_file = f"{clean_prefix}_title.png"
        annotated_file = f"{clean_prefix}_annotated.png"
    else:
        clean_prefix = "latest"
        meta_path = os.path.join(debug_dir, "latest_meta.json")
        title_file = "latest_title.png"
        annotated_file = "latest_annotated.png"

    has_meta = os.path.isfile(meta_path)
    has_title = os.path.isfile(os.path.join(debug_dir, title_file))
    has_annotated = os.path.isfile(os.path.join(debug_dir, annotated_file))

    # 若未指定 prefix 且 latest_meta.json 不存在，则回退尝试读取最新的历史记录
    if not (has_meta or has_title or has_annotated) and (prefix is None or prefix == "latest"):
        hist = list_debug_snapshots(limit=1)
        if hist:
            first_prefix = hist[0]["prefix"]
            return get_debug_info(first_prefix)

    meta_data = {}
    if has_meta:
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_data = json.load(f)
        except Exception:
            pass

    return {
        "available": has_title or has_annotated or has_meta,
        "prefix": clean_prefix,
        "debug_dir": debug_dir,
        "title_url": f"/api/debug/image?name={title_file}" if has_title else None,
        "annotated_url": f"/api/debug/image?name={annotated_file}" if has_annotated else None,
        "meta": meta_data,
    }


def get_latest_debug_info(prefix: str = None) -> dict:
    """获取最新或指定一次核验的调试信息（兼容旧调用签名）。"""
    return get_debug_info(prefix)
