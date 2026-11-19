<?php
/**
 * 题库知识点相关的 PDF 上传 API
 */
require_once __DIR__ . '/bootstrap.php';
requireAuth();
requireNonAssistant('上传或修改题库 PDF');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => '不支持的请求方法']);
    exit;
}
if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    http_response_code(400);
    $errorMap = [
        UPLOAD_ERR_INI_SIZE   => '文件大小超过 php.ini 限制',
        UPLOAD_ERR_FORM_SIZE  => '文件大小超过 HTML 表单限制',
        UPLOAD_ERR_PARTIAL    => '文件只有部分被上传',
        UPLOAD_ERR_NO_FILE    => '没有文件被上传',
        UPLOAD_ERR_NO_TMP_DIR => '找不到临时文件夹',
        UPLOAD_ERR_CANT_WRITE => '文件写入失败',
        UPLOAD_ERR_EXTENSION  => '文件上传被扩展拦截'
    ];
    $errMsg = $errorMap[$_FILES['file']['error'] ?? 0] ?? '未知上传错误';
    echo json_encode(['success' => false, 'error' => $errMsg], JSON_UNESCAPED_UNICODE);
    exit;
}

$file = $_FILES['file'];
$originalName = basename($file['name']);
$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));

if ($ext !== 'pdf') {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => '仅支持上传 PDF 文件'], JSON_UNESCAPED_UNICODE);
    exit;
}

// 20MB limit
$maxSize = 20 * 1024 * 1024;
if ($file['size'] > $maxSize) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => '文件大小不能超过 20MB'], JSON_UNESCAPED_UNICODE);
    exit;
}

// 校验 PDF 头部魔数 %PDF
$handle = fopen($file['tmp_name'], 'rb');
$header = $handle ? fread($handle, 4) : '';
if ($handle) fclose($handle);
if ($header !== '%PDF') {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => '文件非合法 PDF 格式'], JSON_UNESCAPED_UNICODE);
    exit;
}

$uploadDir = __DIR__ . '/../data/pdfs';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

$safeName = 'pdf_' . time() . '_' . bin2hex(random_bytes(4)) . '.pdf';
$targetPath = $uploadDir . '/' . $safeName;

if (move_uploaded_file($file['tmp_name'], $targetPath)) {
    // Return relative URL from frontend perspective
    $url = 'data/pdfs/' . $safeName;
    echo json_encode([
        'success' => true,
        'url' => $url,
        'originalName' => $originalName
    ], JSON_UNESCAPED_UNICODE);
} else {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => '保存文件失败，请检查目录权限'], JSON_UNESCAPED_UNICODE);
}
