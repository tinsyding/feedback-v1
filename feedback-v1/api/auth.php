<?php
/**
 * 前台用户认证接口 (api/auth.php)
 * 
 * 提供教师/用户账号登录、状态校验与注销
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/logs.php';

function sendAuthResponse(bool $success, $data = null, ?string $error = null, int $code = 200): void {
    sendResponse($success, $data, $error, $code);
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

switch ($action) {
    case 'captcha':
        // 生成 4 位安全防混淆字符
        $chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
        $code = '';
        for ($i = 0; $i < 4; $i++) {
            $code .= $chars[random_int(0, strlen($chars) - 1)];
        }
        $_SESSION['front_captcha_code'] = strtolower($code);
        $_SESSION['front_captcha_time'] = time();

        $width = 130;
        $height = 42;
        $image = imagecreatetruecolor($width, $height);

        // 深色现代底色
        $bgColor = imagecolorallocate($image, 24, 24, 27);
        imagefilledrectangle($image, 0, 0, $width, $height, $bgColor);

        // 绘制随机干扰噪点
        for ($i = 0; $i < 60; $i++) {
            $dotColor = imagecolorallocate($image, random_int(45, 95), random_int(45, 95), random_int(70, 130));
            imagesetpixel($image, random_int(0, $width), random_int(0, $height), $dotColor);
        }

        // 绘制干扰平滑曲线
        for ($i = 0; $i < 3; $i++) {
            $lineColor = imagecolorallocate($image, random_int(70, 140), random_int(90, 170), random_int(130, 230));
            imageline($image, random_int(0, 20), random_int(5, $height - 5), random_int($width - 20, $width), random_int(5, $height - 5), $lineColor);
        }

        // 字符调色板
        $letterColors = [
            imagecolorallocate($image, 56, 189, 248),  // Sky
            imagecolorallocate($image, 129, 140, 248), // Indigo
            imagecolorallocate($image, 168, 85, 247),  // Purple
            imagecolorallocate($image, 52, 211, 153),  // Emerald
            imagecolorallocate($image, 251, 191, 36)   // Amber
        ];

        $font = 5; // 内置大字体
        $charHeight = imagefontheight($font);
        $spacing = ($width - 24) / 4;

        for ($i = 0; $i < 4; $i++) {
            $char = $code[$i];
            $cColor = $letterColors[$i % count($letterColors)];
            $x = 14 + $i * $spacing + random_int(-2, 3);
            $y = ($height - $charHeight) / 2 + random_int(-3, 3);
            imagestring($image, $font, (int)$x, (int)$y, $char, $cColor);
        }

        if (ob_get_length()) ob_clean();
        header('Content-Type: image/png');
        header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('Expires: 0');
        imagepng($image);
        imagedestroy($image);
        exit;

    case 'check':
        $requireCaptcha = !empty($_SESSION['front_login_fail_count']) && $_SESSION['front_login_fail_count'] > 0;
        $hasAdminSession = function_exists('isAdminLoggedIn') ? isAdminLoggedIn() : !empty($_SESSION['admin_logged_in']);
        if (!empty($_SESSION['user_logged_in']) && $_SESSION['user_logged_in'] === true) {
            $uRole = $_SESSION['user_role'] ?? 'teacher';
            sendAuthResponse(true, [
                'loggedIn'        => true,
                'require_captcha' => $requireCaptcha,
                'user'            => [
                    'id'         => $_SESSION['user_id'] ?? null,
                    'username'   => $_SESSION['username'] ?? '',
                    'real_name'  => $_SESSION['real_name'] ?? '',
                    'role'       => $uRole,
                    'is_admin'   => $hasAdminSession || in_array($uRole, ['admin', 'super_admin'], true),
                    'created_by' => $_SESSION['user_created_by'] ?? ''
                ]
            ]);
        } elseif ($hasAdminSession) {
            sendAuthResponse(true, [
                'loggedIn'        => true,
                'require_captcha' => $requireCaptcha,
                'user'            => [
                    'id'         => null,
                    'username'   => $_SESSION['admin_username'] ?? 'admin',
                    'real_name'  => $_SESSION['admin_realname'] ?? '超级管理员',
                    'role'       => $_SESSION['admin_role'] ?? 'super_admin',
                    'is_admin'   => true,
                    'created_by' => ''
                ]
            ]);
        } else {
            sendAuthResponse(true, [
                'loggedIn'        => false,
                'require_captcha' => $requireCaptcha
            ]);
        }
        break;

    case 'login':
        if ($method !== 'POST') {
            sendAuthResponse(false, null, '只支持 POST 请求', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $username = trim($input['username'] ?? '');
        $password = trim((string)($input['password'] ?? ''));

        $requireCaptcha = !empty($_SESSION['front_login_fail_count']) && $_SESSION['front_login_fail_count'] > 0;

        // 如果之前输错一次，必须校验图形验证码
        if ($requireCaptcha) {
            $captchaInput = strtolower(trim((string)($input['captcha'] ?? '')));
            $sessionCaptcha = $_SESSION['front_captcha_code'] ?? '';

            if ($captchaInput === '') {
                sendAuthResponse(false, ['require_captcha' => true], '请输入图形验证码', 400);
            }
            if ($sessionCaptcha === '' || $captchaInput !== $sessionCaptcha) {
                unset($_SESSION['front_captcha_code']);
                $_SESSION['front_login_fail_count'] = ($_SESSION['front_login_fail_count'] ?? 0) + 1;
                sendAuthResponse(false, ['require_captcha' => true], '验证码错误，请重新输入', 400);
            }
        }

        if ($username === '' || $password === '') {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '请输入账号和密码', 400);
        }

        // 测试账号已下线
        if ($username === '0') {
            $_SESSION['front_login_fail_count'] = ($_SESSION['front_login_fail_count'] ?? 0) + 1;
            unset($_SESSION['front_captcha_code']);
            sendAuthResponse(false, ['require_captcha' => true], '测试账号已退出历史舞台，请使用已分配的教师专属账号登录', 403);
        }

        $user = null;
        $adminUser = null;
        try {
            $user = DB::fetchOne("SELECT * FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
        } catch (Throwable $e) {
            error_log("Auth DB query error: " . $e->getMessage());
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '数据库连接异常，请稍后重试', 500);
        }

        // 同步核验 admin_users：允许管理员直接从前台首页登录，或在同名教师账号密码一致时自动联动管理员会话
        try {
            $adminUser = DB::fetchOne("SELECT * FROM `admin_users` WHERE `username` = ? LIMIT 1", [$username]);
        } catch (Throwable $ignore) {
            $adminUser = null;
        }

        if (!$user && !$adminUser) {
            $_SESSION['front_login_fail_count'] = ($_SESSION['front_login_fail_count'] ?? 0) + 1;
            unset($_SESSION['front_captcha_code']);
            recordServerLog('warn', 'user_auth', 'login_failed_not_found', [
                'username' => $username,
                'ip'       => getClientIp(),
                'message'  => "账号不存在: {$username}"
            ]);
            sendAuthResponse(false, ['require_captcha' => true], '账号或密码错误', 401);
        }

        $userActive = $user && intval($user['status']) === 1;
        $adminActive = $adminUser && intval($adminUser['status']) === 1;
        if (!$userActive && !$adminActive) {
            $_SESSION['front_login_fail_count'] = ($_SESSION['front_login_fail_count'] ?? 0) + 1;
            unset($_SESSION['front_captcha_code']);
            recordServerLog('warn', 'user_auth', 'login_failed_disabled', [
                'username' => $username,
                'ip'       => getClientIp(),
                'message'  => "账号已停用: {$username}"
            ]);
            sendAuthResponse(false, ['require_captcha' => true], '该账号已被停用，请联系管理员', 403);
        }

        $userValid = $userActive && !empty($user['password_hash']) && password_verify($password, $user['password_hash']);

        $adminValid = false;
        if ($adminActive && !empty($adminUser['password_hash'])) {
            $storedAdminHash = (string)$adminUser['password_hash'];
            if (password_verify($password, $storedAdminHash)) {
                $adminValid = true;
            } elseif (hash_equals($storedAdminHash, hash('sha256', $password))) {
                $adminValid = true;
                try {
                    $newHash = password_hash($password, PASSWORD_BCRYPT);
                    DB::execute("UPDATE `admin_users` SET `password_hash` = ? WHERE `id` = ?", [$newHash, $adminUser['id']]);
                } catch (Throwable $ignore) {}
            }
        }

        if (!$userValid && !$adminValid) {
            $_SESSION['front_login_fail_count'] = ($_SESSION['front_login_fail_count'] ?? 0) + 1;
            unset($_SESSION['front_captcha_code']);
            recordServerLog('warn', 'user_auth', 'login_failed_wrong_password', [
                'username' => $username,
                'ip'       => getClientIp(),
                'message'  => "密码错误: {$username}"
            ]);
            sendAuthResponse(false, ['require_captcha' => true], '账号或密码错误', 401);
        }

        // 登录成功：重置失败计数与验证码
        unset($_SESSION['front_login_fail_count'], $_SESSION['front_captcha_code']);

        session_regenerate_id(true);
        $clientIp = getClientIp();

        if ($userValid) {
            $_SESSION['user_logged_in'] = true;
            $_SESSION['user_id'] = $user['id'];
            $_SESSION['username'] = $user['username'];
            $_SESSION['real_name'] = $user['real_name'];
            $_SESSION['user_role'] = $user['role'] ?: 'teacher';
            $_SESSION['user_teacher_id'] = (int)($user['teacher_id'] ?? 0);
            $_SESSION['user_created_by'] = $user['created_by'] ?? '';
            $_SESSION['user_login_time'] = time();

            try {
                DB::execute("UPDATE `users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `id` = ?", [$clientIp, $user['id']]);
            } catch (Throwable $ignore) {}
        } else {
            unset(
                $_SESSION['user_logged_in'],
                $_SESSION['user_id'],
                $_SESSION['username'],
                $_SESSION['real_name'],
                $_SESSION['user_role'],
                $_SESSION['user_teacher_id'],
                $_SESSION['user_created_by'],
                $_SESSION['user_login_time']
            );
        }

        if ($adminValid) {
            $_SESSION['admin_logged_in'] = true;
            $_SESSION['admin_username'] = $adminUser['username'];
            $_SESSION['admin_realname'] = $adminUser['real_name'] ?? '管理员';
            $_SESSION['admin_role'] = $adminUser['role'] ?: 'super_admin';
            $_SESSION['login_time'] = time();

            try {
                DB::execute("UPDATE `admin_users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `id` = ?", [$clientIp, $adminUser['id']]);
            } catch (Throwable $ignore) {}
        }

        $logUsername = $userValid ? $user['username'] : $adminUser['username'];
        $logRealName = $userValid ? $user['real_name'] : ($adminUser['real_name'] ?? '管理员');
        recordServerLog('action', 'user_auth', 'login_success', [
            'username'  => $logUsername,
            'real_name' => $logRealName,
            'ip'        => $clientIp,
            'message'   => $adminValid && !$userValid
                ? "管理员从前台登录成功: {$logUsername}"
                : "用户登录成功: {$logUsername}"
        ]);

        if ($userValid) {
            $uRole = $user['role'] ?: 'teacher';
            $hasAdminSession = $adminValid || (function_exists('isAdminLoggedIn') ? isAdminLoggedIn() : !empty($_SESSION['admin_logged_in']));
            sendAuthResponse(true, [
                'username'   => $user['username'],
                'real_name'  => $user['real_name'],
                'role'       => $uRole,
                'is_admin'   => $hasAdminSession || in_array($uRole, ['admin', 'super_admin'], true),
                'created_by' => $user['created_by'] ?? '',
                'message'    => '登录成功'
            ]);
        }

        $aRole = $adminUser['role'] ?: 'super_admin';
        sendAuthResponse(true, [
            'username'   => $adminUser['username'],
            'real_name'  => $adminUser['real_name'] ?? '管理员',
            'role'       => $aRole,
            'is_admin'   => true,
            'created_by' => '',
            'message'    => '登录成功'
        ]);
        break;

    case 'logout':
        $uname = $_SESSION['username'] ?? 'unknown';
        $_SESSION['user_logged_in'] = false;
        unset($_SESSION['user_logged_in'], $_SESSION['user_id'], $_SESSION['username'], $_SESSION['real_name'], $_SESSION['user_role'], $_SESSION['user_login_time']);

        recordServerLog('action', 'user_auth', 'logout', [
            'username' => $uname,
            'ip'       => getClientIp(),
            'message'  => "用户退出登录: {$uname}"
        ]);

        sendAuthResponse(true, ['message' => '已成功退出登录']);
        break;

    case 'reset_password':
        if ($method !== 'POST') {
            sendAuthResponse(false, null, '只支持 POST 请求', 405);
        }

        $clientIp = getClientIp();

        // 1. IP / 会话层面的频率限制 (10分钟内最多允许失败尝试 5 次)
        $rateKey = 'reset_pwd_rate_' . md5($clientIp);
        $rateInfo = $_SESSION[$rateKey] ?? ['count' => 0, 'first_attempt' => time()];
        if (time() - $rateInfo['first_attempt'] > 600) {
            $rateInfo = ['count' => 0, 'first_attempt' => time()];
        }
        if ($rateInfo['count'] >= 5) {
            recordServerLog('warn', 'user_auth', 'reset_pwd_rate_limit_exceeded', [
                'ip'      => $clientIp,
                'message' => '密码重置尝试过于频繁，已触发限频锁定'
            ]);
            sendAuthResponse(false, ['require_captcha' => true], '密码重置尝试过于频繁，请10分钟后再试', 429);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $username = trim((string)($input['username'] ?? ''));
        $oldPassword = trim((string)($input['old_password'] ?? ''));
        $newPassword = trim((string)($input['new_password'] ?? ''));
        $confirmPassword = trim((string)($input['confirm_password'] ?? ''));

        // 2. 输错后强制校验图形验证码
        $requireCaptcha = !empty($_SESSION['reset_pwd_fail_count']) && $_SESSION['reset_pwd_fail_count'] > 0;
        if ($requireCaptcha) {
            $captchaInput = strtolower(trim((string)($input['captcha'] ?? '')));
            $sessionCaptcha = $_SESSION['front_captcha_code'] ?? '';

            if ($captchaInput === '' || $sessionCaptcha === '' || $captchaInput !== $sessionCaptcha) {
                unset($_SESSION['front_captcha_code']);
                $_SESSION['reset_pwd_fail_count'] = ($_SESSION['reset_pwd_fail_count'] ?? 0) + 1;
                $rateInfo['count']++;
                $_SESSION[$rateKey] = $rateInfo;
                sendAuthResponse(false, ['require_captcha' => true], '验证码错误，请重新输入', 400);
            }
        }

        if ($username === '') {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '请输入教师账号', 400);
        }

        // 严格禁止测试账号重置密码
        if ($username === '0') {
            recordServerLog('warn', 'user_auth', 'reset_pwd_blocked_test_account', [
                'username' => '0',
                'ip'       => $clientIp,
                'message'  => '测试账号不支持重置密码功能'
            ]);
            sendAuthResponse(false, ['require_captcha' => true], '测试账号为公共过渡体验账号，不支持重置密码', 403);
        }

        if ($oldPassword === '') {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '请输入原密码以验证身份', 400);
        }
        if ($newPassword === '') {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '请输入新密码', 400);
        }
        if (strlen($newPassword) < 6) {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '新密码长度不能少于 6 位', 400);
        }
        if (isset($input['confirm_password']) && $newPassword !== $confirmPassword) {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '两次输入的新密码不一致', 400);
        }
        if ($newPassword === $oldPassword) {
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '新密码不能与原密码相同', 400);
        }

        $user = null;
        try {
            $user = DB::fetchOne("SELECT * FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
        } catch (Throwable $e) {
            error_log("Auth DB query error: " . $e->getMessage());
            sendAuthResponse(false, ['require_captcha' => $requireCaptcha], '数据库连接异常，请稍后重试', 500);
        }

        // 3. 统一失败响应（防账号枚举与撞库爆破）
        // 无论账号不存在、被停用还是密码错误，统一报错并增加失败计数
        $isAuthFailed = false;
        if (!$user || intval($user['status']) !== 1 || $user['username'] === '0') {
            $isAuthFailed = true;
        } else {
            $validOld = !empty($user['password_hash']) && password_verify($oldPassword, $user['password_hash']);
            if (!$validOld) {
                $isAuthFailed = true;
            }
        }

        if ($isAuthFailed) {
            $_SESSION['reset_pwd_fail_count'] = ($_SESSION['reset_pwd_fail_count'] ?? 0) + 1;
            $rateInfo['count']++;
            $_SESSION[$rateKey] = $rateInfo;
            unset($_SESSION['front_captcha_code']);

            recordServerLog('warn', 'user_auth', 'reset_pwd_failed_auth', [
                'username' => $username,
                'ip'       => $clientIp,
                'message'  => "重置密码身份核验未通过: {$username}"
            ]);

            sendAuthResponse(false, ['require_captcha' => true], '账号或原密码错误，请核对后重试', 400);
        }

        // 4. 执行密码重置
        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        try {
            DB::execute("UPDATE `users` SET `password_hash` = ?, `initial_password` = '', `updated_at` = NOW() WHERE `id` = ?", [$newHash, $user['id']]);
        } catch (Throwable $e) {
            error_log("Update password error: " . $e->getMessage());
            sendAuthResponse(false, ['require_captcha' => true], '密码更新失败，请稍后重试', 500);
        }

        // 改密成功：清除失败计数与频率锁
        unset($_SESSION['reset_pwd_fail_count'], $_SESSION['front_captcha_code'], $_SESSION[$rateKey]);

        recordServerLog('action', 'user_auth', 'password_reset_success', [
            'username'  => $user['username'],
            'real_name' => $user['real_name'],
            'operator'  => $user['username'],
            'ip'        => $clientIp,
            'message'   => "教师 {$user['username']} ({$user['real_name']}) 成功重置密码"
        ]);

        sendAuthResponse(true, [
            'username' => $user['username'],
            'message'  => '密码重置成功，请使用新密码登录'
        ]);
        break;

    case 'assistant_list':
        if (empty($_SESSION['user_logged_in']) || ($_SESSION['user_role'] ?? '') !== 'teacher') {
            sendAuthResponse(false, null, '需要教师登录后才可管理助教账号', 401);
        }
        $teacherUsername = $_SESSION['username'] ?? '';
        $teacherId = (int)($_SESSION['user_id'] ?? 0);

        if ($teacherUsername === '0') {
            sendAuthResponse(false, null, '测试账号为公共体验账号，不支持助教账号管理', 403);
        }

        try {
            $assistants = DB::fetchAll(
                "SELECT id, username, real_name, role, teacher_id, created_by, status, 
                        last_login_at, created_at, updated_at 
                 FROM `users` 
                 WHERE `role` = 'assistant' AND (`teacher_id` = ? OR `created_by` = ?) 
                 ORDER BY `id` DESC",
                [$teacherId, $teacherUsername]
            );
            sendAuthResponse(true, ['assistants' => $assistants]);
        } catch (Throwable $e) {
            error_log("assistant_list query error: " . $e->getMessage());
            sendAuthResponse(false, null, '查询助教列表失败', 500);
        }
        break;

    case 'assistant_create':
        if ($method !== 'POST') sendAuthResponse(false, null, '只支持 POST 请求', 405);
        if (empty($_SESSION['user_logged_in']) || ($_SESSION['user_role'] ?? '') !== 'teacher') {
            sendAuthResponse(false, null, '需要教师登录后才可添加助教账号', 401);
        }
        $teacherUsername = $_SESSION['username'] ?? '';
        $teacherId = (int)($_SESSION['user_id'] ?? 0);

        if ($teacherUsername === '0') {
            sendAuthResponse(false, null, '测试账号为公共体验账号，不支持创建助教账号', 403);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $rawUsername = trim((string)($input['username'] ?? ''));
        $realName = trim((string)($input['real_name'] ?? ''));
        $password = trim((string)($input['password'] ?? ''));

        if ($rawUsername === '' || $realName === '' || $password === '') {
            sendAuthResponse(false, null, '请完整填写助教账号、姓名和初始密码', 400);
        }

        // 助教账号的前缀固定为该老师的账号序号
        $cleanSuffix = preg_replace('/^' . preg_quote($teacherUsername, '/') . '(_)?/i', '', $rawUsername);
        $cleanSuffix = ltrim($cleanSuffix, '_');
        if ($cleanSuffix === '') {
            sendAuthResponse(false, null, "助教账号请在教师前缀 [{$teacherUsername}_] 后输入后缀编号，如 01 或 ta1", 400);
        }
        $username = $teacherUsername . '_' . $cleanSuffix;

        if (!preg_match('/^[a-zA-Z0-9_\-\.]{2,30}$/u', $username)) {
            sendAuthResponse(false, null, '助教账号只能包含字母、数字、下划线、减号或点，长度2-30位', 400);
        }

        if (strlen($password) < 6) {
            sendAuthResponse(false, null, '密码长度不能少于 6 位', 400);
        }

        try {
            $exist = DB::fetchOne("SELECT id FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
            if ($exist) {
                sendAuthResponse(false, null, "账号 [{$username}] 已被注册，请更换其它账号名称", 400);
            }

            $pwdHash = password_hash($password, PASSWORD_DEFAULT);
            DB::execute("
                INSERT INTO `users` (
                    `username`, `password_hash`, `initial_password`, `real_name`, 
                    `role`, `teacher_id`, `created_by`, `status`, `created_at`, `updated_at`
                ) VALUES (
                    ?, ?, '', ?, 
                    'assistant', ?, ?, 1, NOW(), NOW()
                )
            ", [$username, $pwdHash, $realName, $teacherId, $teacherUsername]);

            $newId = (int)DB::lastInsertId();

            recordServerLog('action', 'user_auth', 'assistant_created', [
                'teacher'          => $teacherUsername,
                'assistant_id'     => $newId,
                'assistant_user'   => $username,
                'assistant_name'   => $realName,
                'ip'               => getClientIp(),
                'message'          => "教师 {$teacherUsername} 创建了助教账号 {$username} ({$realName})"
            ]);

            sendAuthResponse(true, [
                'id'        => $newId,
                'username'  => $username,
                'real_name' => $realName,
                'message'   => "助教账号 [{$username}] 创建成功"
            ]);
        } catch (Throwable $e) {
            error_log("assistant_create error: " . $e->getMessage() . "\n" . $e->getTraceAsString());
            sendAuthResponse(false, null, '创建助教账号失败，数据库服务异常', 500);
        }
        break;

    case 'assistant_update':
        if ($method !== 'POST') sendAuthResponse(false, null, '只支持 POST 请求', 405);
        if (empty($_SESSION['user_logged_in']) || ($_SESSION['user_role'] ?? '') !== 'teacher') {
            sendAuthResponse(false, null, '需要教师登录后才可修改助教账号', 401);
        }
        $teacherUsername = $_SESSION['username'] ?? '';
        $teacherId = (int)($_SESSION['user_id'] ?? 0);

        if ($teacherUsername === '0') {
            sendAuthResponse(false, null, '测试账号为公共体验账号，不支持修改助教账号', 403);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $targetId = (int)($input['id'] ?? 0);
        if ($targetId <= 0) {
            sendAuthResponse(false, null, '缺少助教ID参数', 400);
        }

        $target = DB::fetchOne(
            "SELECT * FROM `users` WHERE `id` = ? AND `role` = 'assistant' AND (`teacher_id` = ? OR `created_by` = ?) LIMIT 1",
            [$targetId, $teacherId, $teacherUsername]
        );
        if (!$target) {
            sendAuthResponse(false, null, '未找到指定助教账号，或您无权修改此账号', 404);
        }

        $updates = [];
        $params = [];

        if (isset($input['real_name'])) {
            $rName = trim((string)$input['real_name']);
            if ($rName !== '') {
                $updates[] = "`real_name` = ?";
                $params[] = $rName;
            }
        }

        if (isset($input['status'])) {
            $st = intval($input['status']) === 1 ? 1 : 0;
            $updates[] = "`status` = ?";
            $params[] = $st;
        }

        if (isset($input['password'])) {
            $pwd = trim((string)$input['password']);
            if ($pwd !== '') {
                if (strlen($pwd) < 6) {
                    sendAuthResponse(false, null, '新密码长度至少为 6 位', 400);
                }
                $updates[] = "`password_hash` = ?";
                $params[] = password_hash($pwd, PASSWORD_DEFAULT);
                $updates[] = "`initial_password` = ''";
            }
        }

        if (empty($updates)) {
            sendAuthResponse(false, null, '未提供任何需修改的参数', 400);
        }

        $updates[] = "`updated_at` = NOW()";
        $params[] = $targetId;

        try {
            DB::execute("UPDATE `users` SET " . implode(', ', $updates) . " WHERE `id` = ?", $params);

            recordServerLog('action', 'user_auth', 'assistant_updated', [
                'teacher'        => $teacherUsername,
                'assistant_id'   => $targetId,
                'assistant_user' => $target['username'],
                'ip'             => getClientIp(),
                'message'        => "教师 {$teacherUsername} 更新了助教账号 {$target['username']}"
            ]);

            sendAuthResponse(true, ['message' => "助教账号 [{$target['username']}] 更新成功"]);
        } catch (Throwable $e) {
            error_log("assistant_update error: " . $e->getMessage());
            sendAuthResponse(false, null, '更新助教账号失败', 500);
        }
        break;

    case 'assistant_delete':
        if ($method !== 'POST') sendAuthResponse(false, null, '只支持 POST 请求', 405);
        if (empty($_SESSION['user_logged_in']) || ($_SESSION['user_role'] ?? '') !== 'teacher') {
            sendAuthResponse(false, null, '需要教师登录后才可删除助教账号', 401);
        }
        $teacherUsername = $_SESSION['username'] ?? '';
        $teacherId = (int)($_SESSION['user_id'] ?? 0);

        if ($teacherUsername === '0') {
            sendAuthResponse(false, null, '测试账号为公共体验账号，不支持删除助教账号', 403);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $targetId = (int)($input['id'] ?? 0);
        if ($targetId <= 0) {
            sendAuthResponse(false, null, '缺少助教ID参数', 400);
        }

        $target = DB::fetchOne(
            "SELECT * FROM `users` WHERE `id` = ? AND `role` = 'assistant' AND (`teacher_id` = ? OR `created_by` = ?) LIMIT 1",
            [$targetId, $teacherId, $teacherUsername]
        );
        if (!$target) {
            sendAuthResponse(false, null, '未找到指定助教账号，或您无权删除此账号', 404);
        }

        try {
            DB::execute("DELETE FROM `users` WHERE `id` = ?", [$targetId]);

            recordServerLog('warn', 'user_auth', 'assistant_deleted', [
                'teacher'        => $teacherUsername,
                'assistant_id'   => $targetId,
                'assistant_user' => $target['username'],
                'ip'             => getClientIp(),
                'message'        => "教师 {$teacherUsername} 删除了助教账号 {$target['username']}"
            ]);

            sendAuthResponse(true, ['message' => "已成功删除助教账号 [{$target['username']}]"]);
        } catch (Throwable $e) {
            error_log("assistant_delete error: " . $e->getMessage());
            sendAuthResponse(false, null, '删除助教账号失败', 500);
        }
        break;

    default:
        sendAuthResponse(false, null, '无效的操作指令', 400);
        break;
}
