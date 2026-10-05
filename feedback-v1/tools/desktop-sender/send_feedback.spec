# -*- mode: python ; coding: utf-8 -*-
# 经典稳定版打包配置（onefile -> onedir，见 README「八、编译构建与自动化发版」）
import os
from PyInstaller.utils.hooks import collect_all

# 网站根目录的 favicon.ico 作为 exe 图标（spec 目录 -> feedback-v1/）
APP_ICON = os.path.join(SPECPATH, '..', '..', 'favicon.ico')

datas = []
binaries = []
hiddenimports = []

tmp_ret = collect_all('rapidocr_onnxruntime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('onnxruntime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# windows-capture：WGC 抓帧用的 Rust 编译扩展。
#   wheel 名 cp39-abi3-win_amd64（abi3，Python 3.9+ 通用），内容只有
#   __init__.py + windows_capture.pyd（534KB，无随包 DLL）。
#   pyd 的导入表已实证只有 python3.dll / VCRUNTIME140.dll / d3d11.dll /
#   user32.dll / api-ms-win-core-winrt-l1-1-0.dll —— WinRT 由系统自带，
#   不需要 collect_dynamic_libs，collect_all 足够。
#   不加 try/except：构建期缺包必须立刻炸，绝不能产出一个静默没有 WGC 的 exe
#   （那等于让老师以为在用 WGC，实际回退了会截不全的 PyAutoGUI）。
#   注意：它的 METADATA 谎报 requires_dist 含 opencv-python，实测 pyd 内
#   0 处 cv2/opencv 引用，因此 EXCLUDES 里的 'cv2' 保持不变是安全的。
tmp_ret = collect_all('windows_capture')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

# 打包态缺失时静默退回系统默认图标，这里补上，保证属性页与运行期一致
datas.append((APP_ICON, '.'))


# 反误报排除清单：
#   以下均为「已确认全项目零引用」或「仅测试期使用」的重型传递依赖。
#   排除后显著降低产物体积与熵值（91MB -> 约 40MB 量级），
#   同时避免打包出杀毒引擎高度警惕的 numpy/scipy/sklearn 原生扩展矩阵。
EXCLUDES = [
    'cv2',                 # opencv-python：requirements 曾锁定，但代码零引用
    'matplotlib', 'scipy', 'sklearn', 'skimage', 'pandas',  # OCR 传递依赖的非必要分支
    'IPython', 'jupyter', 'notebook', 'pytest', 'setuptools', 'pip',
    'sqlite3', 'test', 'unittest', 'pydoc_data',
]


a = Analysis(
    ['send_feedback.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='JiFang-Feedback-Classic-win-x64',
    icon=APP_ICON,
    version=os.path.join(SPECPATH, 'version_info.txt'),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # 反误报：关闭 UPX 二次加壳。UPX 段头（UPX0/UPX1/UPX2）是杀软教科书式识别特征。
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    # 如需代码签名，在此填入证书名（如 "极方教育"），并配合 build-tools.yml 的签名步骤。
    codesign_identity=None,
    entitlements_file=None,
)