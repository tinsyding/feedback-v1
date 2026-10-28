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


def _cleanup_old_snapshots(debug_dir: str, max_files: int = 60):
    """自动清理过旧的调试截图，避免磁盘堆积。"""
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
    except Exception as exc:
        saved_info["error"] = str(exc)

    return saved_info


def get_latest_debug_info() -> dict:
    """获取最新一次核验的调试信息与图片相对链接。"""
    debug_dir = get_debug_dir()
    meta_path = os.path.join(debug_dir, "latest_meta.json")
    has_meta = os.path.isfile(meta_path)
    has_title = os.path.isfile(os.path.join(debug_dir, "latest_title.png"))
    has_annotated = os.path.isfile(os.path.join(debug_dir, "latest_annotated.png"))

    meta_data = {}
    if has_meta:
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta_data = json.load(f)
        except Exception:
            pass

    return {
        "available": has_title or has_annotated or has_meta,
        "debug_dir": debug_dir,
        "title_url": "/api/debug/image?name=latest_title.png" if has_title else None,
        "annotated_url": "/api/debug/image?name=latest_annotated.png" if has_annotated else None,
        "meta": meta_data,
    }
