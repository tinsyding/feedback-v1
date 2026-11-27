-- ============================================================
-- 013_user_subject.sql
-- 为前台教师账号表 users 增加所属学科字段 subject，并回填存量教师学科归属
-- 约定：
--   - 单学科直接存学科名（如 数学 / 物理 / 英语 / 化学 / 语文）
--   - 多学科支持逗号分隔（如 数学,物理）
--   - '*' 表示所有学科（全科权限）
--   - 助教（role='assistant'）默认留空，运行时自动继承所属主教师的学科权限
-- ============================================================

ALTER TABLE `users`
  ADD COLUMN `subject` VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '所属学科（数学/物理/英语/化学/语文，多科逗号分隔，*表示所有学科）' AFTER `role`;

ALTER TABLE `users`
  ADD KEY `idx_subject` (`subject`);

-- 1. 全学科账号（含系统管理员联动/测试账号）
UPDATE `users`
SET `subject` = '*'
WHERE `username` IN ('JF001', 'JF060', '9999', '0')
  AND (`subject` = '' OR `subject` IS NULL);

-- 2. 数学教师（25人）
UPDATE `users`
SET `subject` = '数学'
WHERE `username` IN (
  'JF006', 'JF008', 'JF010', 'JF014', 'JF015', 'JF018', 'JF021', 'JF023', 'JF025',
  'JF032', 'JF036', 'JF050', 'JF056', 'JF058', 'JF059', 'JF061', 'JF062', 'JF063',
  'JF065', 'JF066', 'JF067', 'JF068', 'JF075', 'JF076', 'JF079'
)
  AND (`subject` = '' OR `subject` IS NULL);

-- 3. 物理教师（14个账号，含 JF002 奇点王）
UPDATE `users`
SET `subject` = '物理'
WHERE `username` IN (
  'JF002', 'JF011', 'JF016', 'JF022', 'JF026', 'JF029', 'JF031',
  'JF033', 'JF044', 'JF047', 'JF055', 'JF070', 'JF077', 'JF078'
)
  AND (`subject` = '' OR `subject` IS NULL);

-- 4. 英语教师（10人）
UPDATE `users`
SET `subject` = '英语'
WHERE `username` IN (
  'JF003', 'JF007', 'JF019', 'JF024', 'JF037', 'JF038', 'JF048', 'JF049', 'JF071', 'JF072'
)
  AND (`subject` = '' OR `subject` IS NULL);

-- 5. 化学教师（5人）
UPDATE `users`
SET `subject` = '化学'
WHERE `username` IN (
  'JF004', 'JF034', 'JF053', 'JF073', 'JF074'
)
  AND (`subject` = '' OR `subject` IS NULL);
