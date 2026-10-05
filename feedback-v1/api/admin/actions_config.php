<?php
/**
 * Admin Config 动作处理: config
 */

switch ($action) {
        case 'config':
            requireAdmin();
            if ($method === 'GET') {
                // Get config
                if (!file_exists($configFile)) {
                    sendResponse(false, null, '配置文件不存在', 500);
                }
                
                $config = json_decode(file_get_contents($configFile), true);
                if ($config === null) {
                    sendResponse(false, null, '配置文件格式错误', 500);
                }
                
                sendResponse(true, $config);
                
            } elseif ($method === 'POST') {
                // Update config - require auth
                requireAdmin();
                
                $input = json_decode(file_get_contents('php://input'), true);
                
                // Read current config
                if (!file_exists($configFile)) {
                    sendResponse(false, null, '配置文件不存在', 500);
                }
                
                $config = json_decode(file_get_contents($configFile), true);
                if ($config === null) {
                    $config = [];
                }
                
                // Update fields
                if (isset($input['defaultSeason'])) {
                    $config['defaultSeason'] = is_numeric($input['defaultSeason']) ? (int)$input['defaultSeason'] : (string)$input['defaultSeason'];
                }
                if (isset($input['semesterYear'])) {
                    $config['semesterYear'] = (int)$input['semesterYear'];
                }
                if (isset($input['semesterWeeks'])) {
                    $config['semesterWeeks'] = (int)$input['semesterWeeks'];
                }
                if (isset($input['forceIntegerScores'])) {
                    $config['forceIntegerScores'] = (bool)$input['forceIntegerScores'];
                }
                if (isset($input['retestQuestionSpacing'])) {
                    $config['retestQuestionSpacing'] = max(10, min(260, (int)$input['retestQuestionSpacing']));
                }
                if (isset($input['retestQrCodeEnabled'])) {
                    $config['retestQrCodeEnabled'] = (bool)$input['retestQrCodeEnabled'];
                }
                
                // Keep comment
                $config['_comment'] = "defaultSeason: spring/summer/autumn/winter (春/暑/秋/寒). semesterYear: 当前学年. semesterWeeks: 学期总周/次数. retestQuestionSpacing: 错题本拼页题目间隙(pt). retestQrCodeEnabled: 下载PDF是否包含视频讲解二维码.";
                
                // Save
                $result = file_put_contents($configFile, json_encode($config, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                
                if ($result === false) {
                    sendResponse(false, null, '保存配置失败，请检查服务器权限', 500);
                }

                recordServerLog('action', 'admin', 'config_updated', [
                    'semesterYear' => $config['semesterYear'] ?? 2026,
                    'defaultSeason' => $config['defaultSeason'] ?? 'autumn',
                    'semesterWeeks' => $config['semesterWeeks'] ?? 14,
                    'retestQrCodeEnabled' => $config['retestQrCodeEnabled'] ?? true,
                    'message' => '管理员修改系统配置及错题本PDF二维码开关'
                ]);
                
                sendResponse(true, [
                    'message' => '配置已更新',
                    'config' => $config
                ]);
            } else {
                sendResponse(false, null, '不支持的请求方法', 405);
            }
        // ========== 数据库可视化 CRUD 接口 ==========
}
