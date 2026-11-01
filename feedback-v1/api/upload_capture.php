<?php
/**
 * 临时文件抓取 API
 * 
 * 将前端选择的文件（带上指纹）静默备份到服务端 data/uploads 文件夹下
 */

require_once __DIR__ . '/bootstrap.php';
requireAuth();

$uploadDir = __DIR__ . '/../data/uploads';

if (!isset($_FILES['file'])) {
    http_response_code(400);
    echo json_encode(['error' => 'No file']);
    exit;
}

$file = $_FILES['file'];

// Max 10MB limit
$maxSize = 10 * 1024 * 1024;
if ($file['size'] > $maxSize) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => '文件大小不能超过 10MB'], JSON_UNESCAPED_UNICODE);
    exit;
}

$fingerprint = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_POST['fingerprint'] ?? 'unknown_fp');
$type = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_POST['type'] ?? 'unknown_type');

$targetDir = $uploadDir . '/' . $fingerprint;
if (!is_dir($targetDir)) {
    mkdir($targetDir, 0755, true);
}

// Prefix with date to maintain chronological order
$filename = date('Ymd_His') . '_' . $type . '_' . preg_replace('/[^a-zA-Z0-9.\-_]/', '', basename($file['name']));

$ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
$allowedExts = ['csv', 'xlsx', 'xls', 'json'];
if (!in_array($ext, $allowedExts)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'File type not allowed']);
    exit;
}

$targetFile = $targetDir . '/' . $filename;

if (move_uploaded_file($file['tmp_name'], $targetFile)) {
    @file_put_contents(
        $uploadDir . '/index.jsonl',
        json_encode([
            'ts' => time(),
            'rel' => $fingerprint . '/' . $filename,
            'orig' => basename($file['name']),
            'type' => $type
        ], JSON_UNESCAPED_UNICODE) . "\n",
        FILE_APPEND | LOCK_EX
    );
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => false, 'error' => 'Failed to move']);
}

// 自动清理超过 30 天以上的上传文件（仅在上传时 10% 概率触发清理）
if (rand(1, 10) === 1) {
    // 30天的截止时间
    $cutoff = time() - (30 * 24 * 3600);
    $fpDirs = glob($uploadDir . '/*', GLOB_ONLYDIR);
    if ($fpDirs) {
        foreach ($fpDirs as $dir) {
            $files = glob($dir . '/*');
            $empty = true;
            if ($files) {
                foreach ($files as $f) {
                    if (is_file($f)) {
                        if (filemtime($f) < $cutoff) {
                            unlink($f);
                        } else {
                            $empty = false;
                        }
                    }
                }
            }
            if ($empty) {
                @rmdir($dir);
            }
        }
    }
}
