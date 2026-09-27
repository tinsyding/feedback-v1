# Feedback-V1 API 接口文档

> 版本：v1（当前全量接口）。版本含义见文末《版本与契约》。
> 本文档由代码逆向整理，与实现不一致时以 `api/*.php` 为准，麻烦同步改文档。

## 通用约定

- 基地址：与前端同域，如 `https://feedback.wxjifang.cn/api/`。
- 统一返回包：`{ "success": true|false, "data": {...}|null, "error": "中文原因"|null }`。
- 常用 HTTP 状态：200 成功；400 参数错误；401 未登录；403 无权限；404 找不到；405 方法错误；413 过大；429 限频；500 服务异常。
- 鉴权三档：
  - `公开`：无需登录（家长核验类接口自带 Token/验证码）。
  - `教师`：需前台登录（`users` 表，`api/auth.php` 登录）。
  - `管理员`：需后台登录（`admin_users` 表，`api/admin.php` 登录）。
- 所有 POST JSON 接口的 `Content-Type: application/json`。

---

## 1. `auth.php` — 前台教师认证（教师）

| action | 方法 | 鉴权 | 入参 | 说明 |
|--------|------|------|------|------|
| `captcha` | GET | 公开 | 无 | 返回 PNG 图形验证码（4 位，防混淆字符集）。输错一次登录后强制要求 |
| `check` | GET | 公开 | 无 | 返回 `{ loggedIn, require_captcha, user? }`，user 含 id/username/real_name/role/created_by |
| `login` | POST | 公开 | `{ username, password, captcha? }` | 成功写 session 并 `session_regenerate_id`；测试账号 `0` 已下线（403）。失败计数触发验证码 |
| `logout` | GET/POST | 教师 | 无 | 清 session |
| `reset_password` | POST | 公开 | `{ username, old_password, new_password, confirm_password?, captcha? }` | 需原密码；新密码 ≥6 位且与原不同；10 分钟 5 次失败限频；测试账号禁改 |
| `assistant_list` | GET | 教师 | 无 | 当前教师名下的助教列表 |
| `assistant_create` | POST | 教师 | `{ username, real_name, password }` | username 只填后缀，前缀强制为 `教师账号_`；密码 ≥6 位 |
| `assistant_update` | POST | 教师 | `{ id, real_name?, status?, password? }` | password 留空=不改 |
| `assistant_delete` | POST | 教师 | `{ id }` | 彻底删除 |

## 2. `admin.php` — 后台管理（管理员）

`action` 经 `?action=` 传递，按模块分发。POST 写操作要求 Origin/Referer 同源。

- **认证**：`login` / `logout` / `check` / `change_password`
  - `login` POST `{ username, password }`：优先 `admin_users` 表（bcrypt，兼容老 SHA256 并自动升级）；10 分钟 5 次失败锁定；DB 离线时回退常量账号。
  - `change_password` POST `{ old_password, new_password }`（≥6 位）。
- **系统配置**：`config` GET 读 / POST 写。字段：`defaultSeason`（spring/summer/autumn/winter）、`semesterYear`、`semesterWeeks`、`forceIntegerScores`、`retestQuestionSpacing`（10~260）、`retestQrCodeEnabled`。敏感密钥不在此文件。
- **元数据**：`db_tables`（表清单+精确行数）、`db_schema?table=`（字段结构+主键）、`db_batches_options`（班级下拉）、`dimensions` / `db_filter_options`（年级/班层/学科/教师等维度）、`student_records_stats`（总数/有错题/零错题/批次/学生数）。
- **通用 CRUD**：`db_list` / `db_get` / `db_create` / `db_update` / `db_delete`，`table` 参数经 `SHOW TABLES` 白名单校验。
  - `db_list` 通用参数：`table`、`page`、`page_size`（≤100）、`search`（字符列 LIKE）、`sort`（须为真实列名）、`order`（asc/desc）；按表附加过滤：`student_records`（batch_id/batch_code/week_num/has_errors/created_by/grade/tier/subject）、`qbank_weeks|qbank_questions`（year/season/grade/tier/subject/week）、`system_logs`（level/module）、`retest_access_logs`（log_action）、`users|admin_users`（status/role）。
  - `db_update` 写 `student_records` 会先归档旧版本到 `student_record_history`（operation_type=admin_edit）。
  - `db_reset_teacher_password` POST `{ id|username, password }`（≥6 位，测试账号禁改）。
- **Token 反查**：`get_retest_admin_url?token=`（签发 24h 有效的 `admin_sig/admin_ts` 免密链接）、`search_by_token`（DB → 映射表 → AES 解密三策略，附家长访问日志）。
- **版本历史**：`record_history?record_id|batch_id+student_name(+week_num)`（查）、`record_rollback` POST `{ history_id }`（回滚，先归档当前为 before_rollback）。

## 3. `retest.php` — 专属错题本（公开 + 家长核验）

| action | 方法 | 入参 | 说明 |
|--------|------|------|------|
| `captcha` | GET | 无 | SVG 图形验证码（一次性，验证即作废） |
| `check_existing_batch` | POST（教师） | `{ subject, grade, tier, week, year?, season?, students? [{name,id,key,score,errors}] }` | 生成前检查该班本周是否已有存档；传名单时逐人 diff（分数/错题变动预警），返回 `{ exists, hasDiff, modifiedStudents, data }` |
| `encrypt_batch` | POST（教师） | `{ subject, grade, tier, week, year?, season?, source_files?, teacher_username?, students: [{name,id?,key?,errors?,homeworkScore?,previewScore?,totalScore?,comment?}] }` | 建班级批次→覆盖前归档历史→upsert 学情→记批次→双写文件档案→返回 `{ batch_code, tokens }`。Token 为 HMAC 确定性 10 位短码 |
| `decrypt` | GET/POST | GET：`token`（+`w` 切周 +`admin_sig/admin_ts` 免密）；POST：`{ token, studentName, captcha }` | 三级解析 Token（短映射→旧 AES→DB）；未核验需姓名+验证码；返回 `{ data, currentWeek, availableWeeks, weeksData{week,errors,pdfs,homeworkScore,avgScore…}, retestQuestionSpacing, retestQrCodeEnabled }`。**均分口径：剔除 0 分、逐分取整后平均**（与家长文案一致） |
| `create_temp_download` | POST（已核验 Token 会话或已登录） | `file`（前端合成的 PDF，≤25MB，校验 %PDF 魔数）+`filename/token/studentName` | 微信优化：服务端暂存并返回 2 小时有效直链。每会话每小时限 30 个 |
| `download_file` | GET | `key`（32 位 hex）+`fn` | 下发暂存 PDF；过期（2h）返回 410 |
| `log_download` | 任意 | `token/filename/studentName` | 记录下载行为 |
| `revoke_token` / `unrevoke_token` | POST（教师） | `{ token, reason? }` | Token 黑名单（持久有效，重生成同一 Token 仍不可用） |

## 4. `qbank.php` — 题库（教师；助教禁写）

| action | 方法 | 说明 |
|--------|------|------|
| `list` | GET | `year/season/subject/grade/search` 过滤，优先 DB（`qbank_weeks`），异常回退本地 JSON（带 `fallback` 标记） |
| `get` | GET | `subject/grade/tier/week(+year/season)` 取专题明细；DB 优先，JSON 兜底 |
| 保存 | POST | `{ year, season, subject, grade, tier, week, questions[] }`；逐题强校验（知识点必填、题目 PDF 必传）；事务写双表 + 同步 JSON 灾备 |
| 删除 | DELETE | 同上参数；级联删明细 + 删 JSON 镜像 |

## 5. `logs.php` — 日志（写入公开限频，查询/导出/删除需管理员）

- `POST ?action=log`：单条或 `entries[]`（≤20 条/次，载荷 ≤64KB）；未登录每 session 每分钟 30 条 + 每 IP 每分钟 60 条；双写 `system_logs` 表 + 当天 `.jsonl`。
- `GET list`：`page/perPage/level/module/event/date/search/ip/fingerprint` + 分级统计。
- `GET filters` / `GET stats`（近 7 天）/ `GET export`（CSV，≤5000 条）/ `DELETE`（按 `id` 或按日期 `clear`）。
- 保留期 30 天（`recordServerLog` 内 2% 概率触发清理）。

## 6. `changelog.php` — 更新日志

- 公开：`getAll`（全部）、`getActive`（当前生效一条）。
- 管理员：`save { log }`（设 active 会互斥）、`delete { id }`、`setActive { id }`。文件型存储（`data/changelog.json`）。

## 7. 文件上传类（教师）

- `upload_pdf.php`：POST `file`（仅 PDF，≤20MB）→ `{ success, url: data/pdfs/xxx.pdf, originalName }`，供题库切片。
- `upload_capture.php`：POST `file`（csv/xlsx/xls/json，≤10MB）+`fingerprint/type` → 按指纹归档到 `data/uploads/`（30 天清理），用于问题排查。
- `public_config.php`：公开脱敏配置（semesterYear/defaultSeason/semesterWeeks/forceIntegerScores/retestQuestionSpacing/retestQrCodeEnabled），扁平输出；`config.json` 禁止直读，密钥永不外泄。

## 版本与契约

- **当前版本：v1**（即本文档全部内容）。版本号只在破坏性变更时递增。
- **契约承诺**：
  1. 只做加法：新增字段/新增 action 不需客户端同步上线；
  2. 不改名、不删字段、不改枚举含义；真要改 → 开 `api/v2/` 冻结版，原 v1 保持可运行，新旧客户端按各自版本接入；
  3. 错误一律走 `{ success:false, error:中文原因 }` + 对应 HTTP 状态码，不抛裸 HTML（`download_file` 等文件流接口除外）。
- 前端硬编码 endpoint 较多（历史包袱）；新增调用请集中到 `js/` 内已有常量处，未来收敛为 `js/api.js` 统一客户端。
