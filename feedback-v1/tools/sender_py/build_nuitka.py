#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极方每周反馈程序 (Web版) - Nuitka 原生机器码编译构建脚本
以 Web 版为主线，编译原生 C++ 机器码，彻底免疫杀软误报。
支持：
  1. 全量打包 (Web 单文件版 + Web 文件夹版 + 对应 ZIP)
  2. 仅 Web 单文件版 (--onefile)
  3. 仅 Web 文件夹版 (--standalone + ZIP)
"""

import os
import sys
import shutil
import subprocess

APP_VERSION = "1.8.22.0"

def get_paths():
    cur_dir = os.path.dirname(os.path.abspath(__file__))
    tools_dir = os.path.dirname(cur_dir)
    repo_root = os.path.dirname(tools_dir)

    favicon = os.path.join(repo_root, "favicon.ico")
    example = os.path.join(tools_dir, "example.png")
    sender_py = os.path.join(cur_dir, "sender.py")
    web_main_py = os.path.join(cur_dir, "web_main.py")
    web_ui = os.path.join(cur_dir, "web_ui.html")
    requirements = os.path.join(cur_dir, "requirements.txt")

    dist_nuitka = os.path.join(cur_dir, "dist_nuitka")
    dist_nuitka_web = os.path.join(cur_dir, "dist_nuitka_web")
    dist_nuitka_onefile = os.path.join(cur_dir, "dist_nuitka_onefile")
    dist_zip = os.path.join(cur_dir, "dist_zip")

    return {
        "cur_dir": cur_dir,
        "tools_dir": tools_dir,
        "repo_root": repo_root,
        "favicon": favicon,
        "example": example,
        "sender_py": sender_py,
        "web_main_py": web_main_py,
        "web_ui": web_ui,
        "requirements": requirements,
        "dist_nuitka": dist_nuitka,
        "dist_nuitka_web": dist_nuitka_web,
        "dist_nuitka_onefile": dist_nuitka_onefile,
        "dist_zip": dist_zip,
    }


def ensure_dependencies(paths):
    print("=" * 60)
    print("       极方每周反馈程序(Web版) - Nuitka 原生机器码编译中心")
    print("=" * 60)
    print(f"\n[1/3] 检查环境与依赖 (Python {sys.version.split()[0]})...")

    subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "pip"], check=True)
    if os.path.isfile(paths["requirements"]):
        subprocess.run([sys.executable, "-m", "pip", "install", "-r", paths["requirements"]], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "nuitka", "zstandard"], check=True)
    print("依赖安装与检查完成！\n")


def build_standalone(paths):
    print("\n" + "=" * 60)
    print("正在编译【极方每周反馈程序 Web版】绿色文件夹模式 (--standalone)...")
    print("=" * 60)

    cmd_web = [
        sys.executable, "-m", "nuitka",
        "--standalone",
        "--assume-yes-for-downloads",
        "--windows-console-mode=disable",
        f"--windows-icon-from-ico={paths['favicon']}",
        "--windows-company-name=JiFang",
        "--windows-product-name=JiFangFeedbackWeb",
        f"--windows-file-version={APP_VERSION}",
        f"--windows-product-version={APP_VERSION}",
        "--enable-plugin=tk-inter",
        "--include-package=sender_py",
        "--include-package-data=rapidocr_onnxruntime",
        f"--include-data-files={paths['favicon']}=favicon.ico",
        f"--include-data-files={paths['example']}=example.png",
        f"--include-data-files={paths['web_ui']}=sender_py/web_ui.html",
        f"--output-dir={paths['dist_nuitka_web']}",
        "--output-filename=JiFangFeedbackWeb.exe",
        paths["web_main_py"],
    ]
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{paths['tools_dir']};{paths['cur_dir']};{env.get('PYTHONPATH', '')}"
    subprocess.run(cmd_web, check=True, env=env)

    web_dist_orig = os.path.join(paths["dist_nuitka_web"], "web_main.dist")
    web_exe_orig = os.path.join(web_dist_orig, "JiFangFeedbackWeb.exe")
    web_exe_target = os.path.join(web_dist_orig, "极方每周反馈程序-Web版.exe")
    if os.path.isfile(web_exe_orig):
        shutil.move(web_exe_orig, web_exe_target)

    web_dist_target = os.path.join(paths["dist_nuitka_web"], "极方每周反馈程序-Web版-Nuitka原生版")
    if os.path.exists(web_dist_target):
        shutil.rmtree(web_dist_target, ignore_errors=True)
    if os.path.exists(web_dist_orig):
        shutil.move(web_dist_orig, web_dist_target)

    # 压缩为 ZIP
    os.makedirs(paths["dist_zip"], exist_ok=True)
    print("\n正在生成 ZIP 压缩分发包...")
    shutil.make_archive(
        os.path.join(paths["dist_zip"], "极方每周反馈程序-Web版-Nuitka原生版"),
        "zip",
        paths["dist_nuitka_web"],
        "极方每周反馈程序-Web版-Nuitka原生版"
    )
    print("ZIP 打包完成！")


def build_onefile(paths):
    print("\n" + "=" * 60)
    print("正在编译【极方每周反馈程序 Web版】单文件模式 (--onefile)...")
    print("=" * 60)

    os.makedirs(paths["dist_nuitka_onefile"], exist_ok=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{paths['tools_dir']};{paths['cur_dir']};{env.get('PYTHONPATH', '')}"

    cmd_web = [
        sys.executable, "-m", "nuitka",
        "--onefile",
        "--assume-yes-for-downloads",
        "--windows-console-mode=disable",
        f"--windows-icon-from-ico={paths['favicon']}",
        "--windows-company-name=JiFang",
        "--windows-product-name=JiFangFeedbackWeb",
        f"--windows-file-version={APP_VERSION}",
        f"--windows-product-version={APP_VERSION}",
        "--enable-plugin=tk-inter",
        "--include-package=sender_py",
        "--include-package-data=rapidocr_onnxruntime",
        f"--include-data-files={paths['favicon']}=favicon.ico",
        f"--include-data-files={paths['example']}=example.png",
        f"--include-data-files={paths['web_ui']}=sender_py/web_ui.html",
        f"--output-dir={paths['dist_nuitka_onefile']}",
        "--output-filename=JiFangFeedbackWeb.exe",
        paths["web_main_py"],
    ]
    subprocess.run(cmd_web, check=True, env=env)

    web_exe_orig = os.path.join(paths["dist_nuitka_onefile"], "JiFangFeedbackWeb.exe")
    web_exe_target = os.path.join(paths["dist_nuitka_onefile"], "极方每周反馈程序-Web版.exe")
    if os.path.isfile(web_exe_orig):
        if os.path.exists(web_exe_target):
            os.remove(web_exe_target)
        shutil.move(web_exe_orig, web_exe_target)


def main():
    paths = get_paths()

    # 检查命令行参数
    arg = sys.argv[1].lower() if len(sys.argv) > 1 else ""
    if arg in ("all", "1"):
        choice = "1"
    elif arg in ("onefile", "2"):
        choice = "2"
    elif arg in ("standalone", "folder", "3"):
        choice = "3"
    else:
        print("=" * 60)
        print("       极方每周反馈程序(Web版) - Nuitka 原生机器码编译中心")
        print("          (注：Tkinter桌面版已停更，以Web版为主)")
        print("=" * 60)
        print("\n请选择编译模式：")
        print("  [1] 全量打包：Web 单文件版 + Web 文件夹版 (含 ZIP) 【推荐】")
        print("  [2] 仅打包 Web 单文件版本 (--onefile 独立 exe)")
        print("  [3] 仅打包 Web 文件夹版本 (--standalone 绿色目录 + ZIP)")
        print("  [0] 退出")
        print("-" * 60)
        try:
            choice = input("请输入选项编号 (0-3，直接回车默认 1): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n已取消。")
            return
        if not choice:
            choice = "1"

    if choice == "0":
        print("已退出。")
        return
    elif choice not in ("1", "2", "3"):
        print(f"无效选项: {choice}")
        return

    ensure_dependencies(paths)

    do_standalone = choice in ("1", "3")
    do_onefile = choice in ("1", "2")

    if do_standalone:
        build_standalone(paths)

    if do_onefile:
        build_onefile(paths)

    print("\n" + "=" * 60)
    print("            ★ Nuitka 原生机器码编译完成！ ★")
    print("=" * 60 + "\n")

    if do_onefile:
        print("【单文件独立 EXE 版本】：")
        print(f"  - {os.path.join(paths['dist_nuitka_onefile'], '极方每周反馈程序-Web版.exe')}\n")

    if do_standalone:
        print("【绿色解压文件夹版本】：")
        print(f"  - {os.path.join(paths['dist_nuitka_web'], '极方每周反馈程序-Web版-Nuitka原生版')}\n")
        print("【对应 ZIP 压缩包】：")
        print(f"  - {os.path.join(paths['dist_zip'], '极方每周反馈程序-Web版-Nuitka原生版.zip')}\n")

    print("该版本为原生 C++ 编译机器码，彻底免疫杀软误报！")


if __name__ == "__main__":
    main()
