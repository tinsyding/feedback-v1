# Feedback-V1 系统说明文档

旧版作业反馈与错题本系统（PHP + 原生前端架构）。

## 目录组织与功能职责

```text
feedback-v1/
├── api/                    # 后端 PHP 接口 (auth, retest, upload, qbank 等)
├── assets/                 # Web 前端静态媒体资源
│   ├── images/             # 图片资源
│   └── icons/              # 图标与矢量资源
├── css/                    # 样式表 (common, upload, viewer, question-bank, admin, auth)
├── js/                     # 前端 JavaScript 业务逻辑
│   ├── libs/               # 外部第三方只读依赖 (pdf-lib, qrcode, vconsole, pdfjs)
│   ├── common.js           # 通用工具函数、深浅色模式切换逻辑
│   ├── auth.js             # 教师登录态管理
│   ├── upload.js           # 上传解析业务逻辑
│   ├── viewer.js           # 评语展示、复制、未交提醒弹窗逻辑
│   ├── question-bank.js    # 错题管理逻辑
│   └── ...
├── data/                   # 本地持久化数据与缓存
│   ├── history/            # 历史评语 JSON 归档
│   ├── logs/               # 系统运行与操作日志
│   ├── seeds/              # 初始种子数据与账号备份 (accounts_list.json 等)
│   └── temp/               # 临时生成文件与缓存
├── scripts/                # 自动化与前端构建工具
│   └── bundle_admin_js.py         # 管理后台 JS 模块一键打包工具
├── tools/                  # 辅助工具与非 Web 桌面端程序
│   └── desktop-sender/     # 教师端企业微信发送自动化程序 (Python/PyInstaller)
├── index.html              # 门户登录页
├── upload.html             # 教师作业反馈上传页面
├── viewer.html             # 教师评语查看与未交提醒页面
├── question-bank.html      # 错题本管理页面
├── retest.html             # 学生错题巩固落地页（官方正式版，支持作答留白、微课二维码与智能拼接）
├── retest-beta.html        # 历史 Beta 兼容跳转页（平滑重定向至 retest.html）
├── admin.html              # 系统管理后台
├── admin-login.html        # 管理员登录页
├── 403.html ~ 50x.html     # HTTP 错误状态页面
├── config.json             # 数据库连接凭据与系统配置 (不公开)
├── config.example.json     # 配置模板文件 (脱敏参考)
├── nginx.conf              # Nginx 站点配置参考
├── favicon.ico             # 站点图标
└── .user.ini               # PHP 安全与目录限制
```

## 核心访问地址 (线上映射)

- 教师上传反馈：`https://feedback.wxjifang.cn/upload.html`
- 教师评语查看：`https://feedback.wxjifang.cn/viewer.html`
- 错题本管理：`https://feedback.wxjifang.cn/question-bank.html`
- 学生错题重练：`https://vip.wxjifang.cn/` (白名单受控访问)
- 后台管理系统：`https://feedback.wxjifang.cn/admin.html`
