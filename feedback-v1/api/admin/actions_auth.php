<?php
/**
 * Admin Auth 动作处理: login, logout, check, change_password
 */

switch ($action) {
        case 'login':
            if ($method !== 'POST') {
                sendResponse(false, null, '只支持 POST 请求', 405);
            }
            
            $input = json_decode(file_get_contents('php://input'), true);
            $username = trim($input['username'] ?? '');
            $password = $input['password'] ?? '';
            
            if (empty($username) || empty($password)) {
                sendResponse(false, null, '请输入用户名和密码', 400);
            }

            // 登录防爆破频率限制：10分钟内失败超过5次限制登录
            $clientIp = getClientIP();
            $rateKey = 'admin_login_fail_' . md5($clientIp . '_' . $username);
            $failCount = $_SESSION[$rateKey] ?? 0;
            $lastFailTime = $_SESSION[$rateKey . '_time'] ?? 0;
            if ($failCount >= 5 && (time() - $lastFailTime) < 600) {
                $remainSec = 600 - (time() - $lastFailTime);
                sendResponse(false, null, "登录失败次数过多，该账号已被临时锁定，请 {$remainSec} 秒后再试", 429);
            }

            $adminUser = null;
            $authenticated = false;

            // 1. 优先校验数据库 admin_users 表
            try {
                $adminUser = DB::fetchOne("SELECT * FROM `admin_users` WHERE `username` = ? LIMIT 1", [$username]);
                if ($adminUser) {
                    if (intval($adminUser['status']) !== 1) {
                        sendResponse(false, null, '该管理员账号已被禁用，请联系系统管理', 403);
                    }
                    $storedHash = $adminUser['password_hash'];
                    if (password_verify($password, $storedHash)) {
                        $authenticated = true;
                    } elseif (hash_equals((string)$storedHash, hash('sha256', $password))) {
                        // 兼容平滑升级旧 SHA256 哈希为安全 BCrypt
                        $authenticated = true;
                        $newHash = password_hash($password, PASSWORD_BCRYPT);
                        DB::execute("UPDATE `admin_users` SET `password_hash` = ? WHERE `id` = ?", [$newHash, $adminUser['id']]);
                    }
                }
            } catch (Throwable $e) {
                error_log("Admin DB auth query error: " . $e->getMessage());
            }

            // 2. 数据库离线或未初始化时紧急安全回退
            if (!$authenticated && empty($adminUser)) {
                $pwdHash = hash('sha256', $password);
                $isMatch = false;
                if (defined('ADMIN_PASSWORD_HASH') && hash_equals((string)ADMIN_PASSWORD_HASH, $pwdHash)) {
                    $isMatch = true;
                }
                if (!$isMatch && defined('ADMIN_PASSWORD_HASHES') && is_array(ADMIN_PASSWORD_HASHES)) {
                    foreach (ADMIN_PASSWORD_HASHES as $h) {
                        if (hash_equals((string)$h, $pwdHash)) {
                            $isMatch = true;
                            break;
                        }
                    }
                }
                if ($username === ADMIN_USERNAME && $isMatch) {
                    $authenticated = true;
                    // 自动将该常量账号补录到数据库
                    try {
                        $newHash = password_hash($password, PASSWORD_BCRYPT);
                        DB::execute("INSERT INTO `admin_users` (`username`, `password_hash`, `real_name`, `role`, `status`) VALUES (?, ?, '超级管理员', 'super_admin', 1) ON DUPLICATE KEY UPDATE `password_hash` = VALUES(`password_hash`)", [$username, $newHash]);
                    } catch (Throwable $ignore) {}
                }
            }

            if ($authenticated) {
                // 登录成功，清除失败计数
                unset($_SESSION[$rateKey], $_SESSION[$rateKey . '_time']);

                session_regenerate_id(true); // 防御会话固定攻击
                $_SESSION['admin_logged_in'] = true;
                $_SESSION['admin_username'] = $username;
                $_SESSION['admin_realname'] = $adminUser['real_name'] ?? '超级管理员';
                $_SESSION['admin_role'] = $adminUser['role'] ?? 'super_admin';
                $_SESSION['login_time'] = time();

                // 更新管理员最后登录记录
                try {
                    DB::execute("UPDATE `admin_users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `username` = ?", [$clientIp, $username]);
                } catch (Throwable $ignore) {}

                recordServerLog('action', 'admin', 'admin_login_success', [
                    'username' => $username,
                    'ip' => $clientIp,
                    'message' => '管理员登录成功'
                ]);

                sendResponse(true, [
                    'username' => $username,
                    'real_name' => $adminUser['real_name'] ?? '超级管理员',
                    'role' => $adminUser['role'] ?? 'super_admin',
                    'message' => '登录成功'
                ]);
            } else {
                $_SESSION[$rateKey] = $failCount + 1;
                $_SESSION[$rateKey . '_time'] = time();

                recordServerLog('warn', 'admin', 'admin_login_failed', [
                    'username' => $username,
                    'ip' => $clientIp,
                    'message' => '管理员登录失败：用户名或密码错误'
                ]);
                sendResponse(false, null, '用户名或密码错误', 401);
            }
            break;
            
        case 'logout':
            $adminUser = $_SESSION['admin_username'] ?? 'admin';
            recordServerLog('info', 'admin', 'admin_logout', [
                'username' => $adminUser,
                'message' => '管理员安全退出登录'
            ]);
            session_destroy();
            sendResponse(true, ['message' => '已登出']);
            break;
            
        case 'check':
            if (isAdminLoggedIn()) {
                sendResponse(true, [
                    'loggedIn' => true,
                    'username' => $_SESSION['admin_username'] ?? '',
                    'real_name' => $_SESSION['admin_realname'] ?? '超级管理员',
                    'role' => $_SESSION['admin_role'] ?? 'super_admin',
                    'loginTime' => $_SESSION['login_time'] ?? 0
                ]);
            } else {
                sendResponse(true, ['loggedIn' => false]);
            }
            break;

        case 'change_password':
            requireAdmin();
            if ($method !== 'POST') {
                sendResponse(false, null, '只支持 POST 请求', 405);
            }
            $input = json_decode(file_get_contents('php://input'), true);
            $oldPassword = $input['old_password'] ?? '';
            $newPassword = $input['new_password'] ?? '';

            if (empty($oldPassword) || empty($newPassword)) {
                sendResponse(false, null, '原密码和新密码不能为空', 400);
            }
            if (strlen($newPassword) < 6) {
                sendResponse(false, null, '新密码长度至少为 6 位', 400);
            }

            $curUser = $_SESSION['admin_username'] ?? '';
            $user = DB::fetchOne("SELECT * FROM `admin_users` WHERE `username` = ? LIMIT 1", [$curUser]);
            if (!$user) {
                sendResponse(false, null, '未找到当前管理员账号信息', 404);
            }

            $valid = password_verify($oldPassword, $user['password_hash']) 
                  || hash_equals((string)$user['password_hash'], hash('sha256', $oldPassword));
            if (!$valid) {
                sendResponse(false, null, '原密码不正确', 400);
            }

            $newHash = password_hash($newPassword, PASSWORD_BCRYPT);
            DB::execute("UPDATE `admin_users` SET `password_hash` = ? WHERE `id` = ?", [$newHash, $user['id']]);

            recordServerLog('action', 'admin', 'admin_password_changed', [
                'username' => $curUser,
                'message' => '管理员修改了密码'
            ]);

            sendResponse(true, ['message' => '密码已成功修改']);
            break;
            
}
