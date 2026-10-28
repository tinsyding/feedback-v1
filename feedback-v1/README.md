# Feedback-V1 目录说明

作业反馈与错题本系统 Web 端源码（PHP + 原生前端）。

## 目录结构

```text
feedback-v1/
├── api/                    # 后端 PHP 接口 (auth, retest, upload, qbank 等)
├── assets/                 # 静态媒体资源
│   ├── images/             # 图片
│   └── icons/              # 图标
├── css/                    # 样式表 (common, upload, viewer, question-bank, admin, auth)
├── js/                     # 前端脚本
│   ├── libs/               # 第三方依赖 (pdf-lib, qrcode, vconsole, pdfjs)
│   ├── common.js           # 通用工具函数、深浅色模式切换
│   ├── auth.js             # 教师登录态管理
│   ├── upload.js           # 上传解析逻辑
│   ├── viewer.js           # 评语展示、复制、未交提醒弹窗
│   ├── question-bank.js    # 错题管理逻辑
│   └── ...
├── data/                   # 本地数据与缓存
│   ├── history/            # 历史评语 JSON 归档
│   ├── logs/               # 运行与操作日志
│   ├── seeds/              # 初始数据与账号备份
│   └── temp/               # 临时生成文件与缓存
├── scripts/                # 构建与维护脚本
│   └── bundle_admin_js.py  # 管理后台 JS 打包脚本
├── tools/                  # 辅助工具与桌面端程序
│   └── sender_py/          # 企业微信反馈发送器（见 tools/sender_py/README.md）
├── index.html              # 登录页
├── upload.html             # 教师作业反馈上传页
├── viewer.html             # 教师评语查看与未交提醒页
├── question-bank.html      # 错题本管理页
├── retest.html             # 学生错题巩固练习页
├── retest-beta.html        # 旧版兼容跳转页（重定向至 retest.html）
├── admin.html              # 管理后台
├── admin-login.html        # 管理员登录页
├── 403.html ~ 50x.html     # 错误状态页
├── config.json             # 数据库连接凭据与配置 (不入库)
├── config.example.json     # 配置模板
├── nginx.conf              # Nginx 站点配置存档
├── favicon.ico             # 站点图标
└── .user.ini               # PHP 目录限制
```

## 线上地址

- 教师上传反馈：`https://feedback.wxjifang.cn/upload.html`
- 教师评语查看：`https://feedback.wxjifang.cn/viewer.html`
- 错题本管理：`https://feedback.wxjifang.cn/question-bank.html`
- 学生错题重练：`https://vip.wxjifang.cn/`
- 管理后台：`https://feedback.wxjifang.cn/admin.html`
