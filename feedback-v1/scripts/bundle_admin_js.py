#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Admin 前端脚本自动打包构建工具 (Bundle Admin JS)

功能：
将 js/admin/ 下的 12 个独立业务模块，按严格依赖顺序合并为单文件 js/admin.js。
既保证日常开发的模块化与低耦合，又确保线上运行的单请求极速加载与零时序风险。

使用方式：
python scripts/bundle_admin_js.py
"""

import os
import sys
import datetime

# 模块加载与拼接顺序（严格依赖拓扑）
MODULE_ORDER = [
    ("ui.js", "UI 核心组件与交互 (Toast, Modal, Dock, Theme, TableZoom)"),
    ("auth.js", "管理员认证与授权 (checkAuth, logout, changePassword)"),
    ("config.js", "Tab 1: 系统与学期配置 (loadConfig, saveConfig)"),
    ("logs.js", "Tab 2: 审计日志管理 (loadLogs, filter)"),
    ("teachers.js", "教师账号管理 (loadTeachers, render, resetPassword)"),
    ("records.js", "学生学情记录 (loadRecords, filter, aggregate)"),
    ("batches.js", "生成批次记录独立视图 (generation_batches 列表/筛选/删除/跳转学情)"),
    ("database.js", "Tab 3: 底层数据库通用 CRUD 与版本回滚"),
    ("changelog.js", "Tab 4: 更新日志管理"),
    ("token-search.js", "错题本 Token 快捷反查学情"),
    ("main.js", "路由调度、事件监听与系统启动 (Bootstrap)")
]

def bundle(check_only=False):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.abspath(os.path.join(script_dir, ".."))
    admin_module_dir = os.path.join(root_dir, "js", "admin")
    output_bundle_file = os.path.join(root_dir, "js", "admin.js")

    if not os.path.exists(admin_module_dir):
        print(f"Error: Module directory not found: {admin_module_dir}")
        sys.exit(1)

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    header = f"""/**
 * ============================================================================
 * 极方管理后台 (Admin Console) 前端运行脚本 - 生产环境合并包
 * 自动生成时间: {now_str}
 * 源码模块目录: js/admin/
 * 请勿直接手动修改此文件，开发时请修改 js/admin/ 中的子模块并执行本打包脚本。
 * ============================================================================
 */
"""
    bundled_parts = [header]
    total_lines = 0

    for filename, desc in MODULE_ORDER:
        file_path = os.path.join(admin_module_dir, filename)
        if not os.path.exists(file_path):
            print(f"Error: Missing module file: {file_path}")
            sys.exit(1)

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read().strip()

        part_banner = f"""
/* ============================================================================
 * [MODULE] {filename} - {desc}
 * ============================================================================ */
"""
        bundled_parts.append(part_banner)
        bundled_parts.append(content)
        lines = len(content.splitlines())
        total_lines += lines
        print(f"  + Merged {filename:16s} ({lines:4d} lines) - {desc}")

    full_bundle = "\n\n".join(bundled_parts) + "\n"

    if check_only:
        if not os.path.exists(output_bundle_file):
            print(f"DRIFT: bundle file missing: {output_bundle_file}")
            sys.exit(1)
        with open(output_bundle_file, "r", encoding="utf-8") as f:
            current = f.read()
        # 头部含生成时间戳，比较时剥离首段注释
        def strip_header(text):
            end = text.find("*/")
            return text[end + 2:] if end != -1 else text
        if strip_header(current).strip() != strip_header(full_bundle).strip():
            print("DRIFT: js/admin.js 与 js/admin/ 源码不一致，请执行 python scripts/bundle_admin_js.py 重新打包")
            sys.exit(1)
        print("OK: bundle 与源码一致")
        return

    with open(output_bundle_file, "w", encoding="utf-8") as f:
        f.write(full_bundle)

    output_lines = len(full_bundle.splitlines())
    output_size_kb = len(full_bundle.encode("utf-8")) / 1024
    print(f"\nSuccessfully bundled {len(MODULE_ORDER)} modules into {output_bundle_file}")
    print(f"Total: {output_lines} lines ({output_size_kb:.1f} KB)")

if __name__ == "__main__":
    bundle(check_only="--check" in sys.argv[1:])
