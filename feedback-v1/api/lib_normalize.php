<?php
/**
 * 极方教学反馈系统 - 公共字段归一化、评语错题提取与短码派生工具库 (api/lib_normalize.php)
 *
 * 统一收敛：
 * 1. 季节/学期双向归一化 (春/暑/秋/寒 <-> spring/summer/autumn/winter)
 * 2. 年级与学科别名归一化
 * 3. 与前端 js/common.js (parseErrorQuestionsFromComment) 完全对齐的评语错题题号解析器
 * 4. 错题本 10 位 HMAC-SHA256 短 Token 统一派生函数
 */

require_once __DIR__ . '/lib_retest_keys.php';

if (!function_exists('normalizeSeason')) {
    /**
     * 归一化季节字段
     *
     * @param string|null $season 原始季节值（如 'autumn', '秋季', '秋', 'fall'）
     * @param string $fallbackOrTarget 当为 'en' 时返回英文 ('spring'|'summer'|'autumn'|'winter')；否则返回单字中文 ('春'|'暑'|'秋'|'寒')，空值时使用该参数作为 fallback（若传 'zh' 则空值返回 ''）
     * @return string
     */
    function normalizeSeason(?string $season, string $fallbackOrTarget = '秋'): string
    {
        $raw = strtolower(trim((string)$season));
        $targetLang = ($fallbackOrTarget === 'en') ? 'en' : 'zh';
        $fallback = in_array($fallbackOrTarget, ['zh', 'en'], true) ? '' : $fallbackOrTarget;

        if ($raw === '') {
            return $fallback;
        }

        $toZh = [
            'spring' => '春', '春' => '春', '春季' => '春', '春学期' => '春',
            'summer' => '暑', '暑' => '暑', '暑假' => '暑', '暑期' => '暑', '夏' => '暑',
            'autumn' => '秋', 'fall' => '秋', '秋' => '秋', '秋季' => '秋', '秋学期' => '秋',
            'winter' => '寒', '寒' => '寒', '寒假' => '寒', '寒期' => '寒', '冬' => '寒',
        ];
        $zhToEn = [
            '春' => 'spring',
            '暑' => 'summer',
            '秋' => 'autumn',
            '寒' => 'winter',
        ];

        $zh = $toZh[$raw] ?? null;
        if ($zh === null) {
            foreach (['春', '暑', '秋', '寒'] as $char) {
                if (strpos($raw, $char) !== false) {
                    $zh = $char;
                    break;
                }
            }
        }
        if ($zh === null) {
            return $fallback !== '' ? $fallback : trim((string)$season);
        }

        return $targetLang === 'en' ? ($zhToEn[$zh] ?? $zh) : $zh;
    }
}

if (!function_exists('getSeasonVariants')) {
    /**
     * 获取季节的中英文等价候选集合（用于兼容历史 SQL 查询）
     *
     * @param string|null $season
     * @return string[]
     */
    function getSeasonVariants(?string $season): array
    {
        $raw = trim((string)$season);
        if ($raw === '') {
            return [];
        }
        $zh = normalizeSeason($raw, 'zh');
        $en = normalizeSeason($raw, 'en');
        return array_values(array_unique(array_filter([$raw, $zh, $en], static fn($v) => $v !== '')));
    }
}

if (!function_exists('normalizeGrade')) {
    /**
     * 归一化年级名称（保持系统标准命名，如 初一 -> 七年级 等可选映射或去空白）
     */
    function normalizeGrade(?string $grade): string
    {
        $g = trim((string)$grade);
        if ($g === '') {
            return '';
        }
        $map = [
            '初一' => '七年级', '初中一年级' => '七年级', '7年级' => '七年级',
            '初二' => '八年级', '初中二年级' => '八年级', '8年级' => '八年级',
            '初三' => '九年级', '初中三年级' => '九年级', '9年级' => '九年级',
            '小一' => '一年级', '1年级' => '一年级',
            '小二' => '二年级', '2年级' => '二年级',
            '小三' => '三年级', '3年级' => '三年级',
            '小四' => '四年级', '4年级' => '四年级',
            '小五' => '五年级', '5年级' => '五年级',
            '小六' => '六年级', '6年级' => '六年级',
        ];
        return $map[$g] ?? $g;
    }
}

if (!function_exists('normalizeSubject')) {
    /**
     * 归一化科目名称
     */
    function normalizeSubject(?string $subject): string
    {
        return trim((string)$subject);
    }
}

if (!function_exists('getRetestSecretKey')) {
    /**
     * 获取服务端错题本 HMAC 密钥
     */
    function getRetestSecretKey(): string
    {
        static $cachedKey = null;
        if ($cachedKey !== null) {
            return $cachedKey;
        }
        $secretFile = __DIR__ . '/secret_key.php';
        $secretConfig = file_exists($secretFile) ? require($secretFile) : [];
        $key = is_array($secretConfig) ? ($secretConfig['retestSecret'] ?? '') : '';
        if ($key === '') {
            $configFile = __DIR__ . '/../config.json';
            $config = file_exists($configFile) ? (json_decode((string)file_get_contents($configFile), true) ?: []) : [];
            $key = (string)($config['retestSecret'] ?? '');
        }
        $cachedKey = $key;
        return $cachedKey;
    }
}

if (!function_exists('deriveRetestToken')) {
    /**
     * 统一派生 10 位防篡改错题本短码（HMAC-SHA256 Base64URL 前 10 位）
     * 与 api/retest.php encrypt_batch 严格保持一致
     */
    function deriveRetestToken(string $subject, string $grade, string $studentKey, ?string $secretKey = null): string
    {
        $secret = ($secretKey !== null && $secretKey !== '') ? $secretKey : getRetestSecretKey();
        if ($secret === '') {
            // 极端情况下未加载到密钥时使用安全随机退化
            return substr(strtoupper(bin2hex(random_bytes(6))), 0, 10);
        }
        $rawHash = hash_hmac('sha256', "{$subject}_{$grade}_{$studentKey}", $secret, true);
        return substr(str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($rawHash)), 0, 10);
    }
}

if (!function_exists('parseErrorQuestionsFromCommentPhp')) {
    /**
     * 从教师评语中提取错题题号数组（与前端 js/common.js parseErrorQuestionsFromComment 规则严格对齐）
     *
     * 支持：
     * 1. 全角数字自动转半角
     * 2. 显式“无错题 / 全对 / 0 / 零失误”立即返回 []
     * 3. 错题前缀（含冒号后跨行题号）提取
     * 4. 首行纯题号列表（如 "1, 2, 5"、"第1题、第3题"）提取
     * 5. 普通评语中的分数/名次数字（如 "98分"、"第1名"）绝不误判为题号
     *
     * @param string|null $rawComment
     * @return int[]
     */
    function parseErrorQuestionsFromCommentPhp(?string $rawComment): array
    {
        $rawComment = trim((string)$rawComment);
        if ($rawComment === '') {
            return [];
        }

        // 全角数字转半角
        $normalized = strtr($rawComment, [
            '０' => '0', '１' => '1', '２' => '2', '３' => '3', '４' => '4',
            '５' => '5', '６' => '6', '７' => '7', '８' => '8', '９' => '9',
        ]);

        $rawLines = explode("\n", str_replace("\r\n", "\n", $normalized));
        $nonEmptyLines = [];
        foreach ($rawLines as $l) {
            $trimmed = trim($l);
            if ($trimmed !== '') {
                $nonEmptyLines[] = $trimmed;
            }
        }
        if (empty($nonEmptyLines)) {
            return [];
        }

        $firstLine = $nonEmptyLines[0];

        $filterValidNums = static function (array $matches): array {
            $res = [];
            foreach ($matches as $m) {
                $n = intval($m);
                if ($n >= 1 && $n <= 100 && !in_array($n, $res, true)) {
                    $res[] = $n;
                }
            }
            return $res;
        };

        // 1. 显式“无错题 / 全对 / 满分”拦截
        $pureNoErrHeaderRegex = '/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错|错误)?(?:题号|序号|编号)?(?:为|是)?\s*[:：]\s*(?:无|没有|0|零|全对|无错题|全部正确|都对|暂无|none)\s*[。!！.]?\s*$/iu';
        if (preg_match($pureNoErrHeaderRegex, $firstLine)) {
            return [];
        }

        $noErrorGeneralKeywords = '/(?:本次|本周|今天)?(?:的)?(?:作业|测验|测试)?(?:全部做对|全部正确|全做对|完全正确|零失误|无错题|没有错题|免除加练|全对)/u';
        if (preg_match($noErrorGeneralKeywords, $firstLine)) {
            return [];
        }

        // 2. 错题前缀模糊容错正则（扫描所有非空行，优先首行）
        $prefixPattern = '/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/iu';
        foreach ($nonEmptyLines as $idx => $line) {
            if (preg_match($prefixPattern, $line, $m)) {
                $after = trim($m[1] ?? '');
                if ($after === '' && isset($nonEmptyLines[$idx + 1])) {
                    $after = $nonEmptyLines[$idx + 1];
                }
                if (preg_match('/^(?:无|没有|0|零|全对|全部正确|无错题|都对|暂无|none)\s*[。!！.]?$/iu', $after)) {
                    return [];
                }
                $numsPart = preg_split('/[。!！;；\n]|(?=[\x{4e00}-\x{9fa5}]{2,})/u', $after)[0] ?? '';
                if (preg_match_all('/\d+/', $numsPart, $numMatches)) {
                    $valid = $filterValidNums($numMatches[0]);
                    if (!empty($valid)) {
                        return $valid;
                    }
                }
                return [];
            }
        }

        // 3. 首行纯题号列表格式（如 "1, 2, 5"、"1 3 4"、"第1题、第3题"）
        $pureNumbersRegex = '/^(?:第?\s*\d+\s*题?[,，、\s\/；;和与及\-]+)*第?\s*\d+\s*题?\s*[。.]?$/u';
        if (preg_match($pureNumbersRegex, $firstLine)) {
            if (preg_match_all('/\d+/', $firstLine, $numMatches)) {
                $valid = $filterValidNums($numMatches[0]);
                if (!empty($valid)) {
                    return $valid;
                }
            }
        }

        return [];
    }
}

if (!function_exists('cleanupUnreferencedPdfs')) {
    /**
     * 清理被替换或删除后不再被任何 qbank_questions 引用的孤儿 PDF 文件
     *
     * @param string[] $candidateUrls 待检查的相对路径列表（如 ['data/pdfs/pdf_123.pdf']）
     * @return int 实际清理的文件数
     */
    function cleanupUnreferencedPdfs(array $candidateUrls): int
    {
        if (empty($candidateUrls) || !class_exists('DB')) {
            return 0;
        }
        $urls = array_values(array_unique(array_filter(array_map('trim', $candidateUrls), static fn($u) => $u !== '')));
        if (empty($urls)) {
            return 0;
        }
        $pdfDir = dirname(__DIR__) . '/data/pdfs';
        $deletedCount = 0;
        foreach ($urls as $relUrl) {
            // 仅允许清理 data/pdfs/ 目录下的合法 PDF 文件，防止越权路径遍历
            if (!preg_match('#^data/pdfs/(pdf_[a-zA-Z0-9_.\-]+\.pdf)$#', $relUrl, $m)) {
                continue;
            }
            $fileName = $m[1];
            $fullPath = $pdfDir . '/' . $fileName;
            if (!is_file($fullPath)) {
                continue;
            }
            try {
                $refCount = (int)DB::fetchValue(
                    "SELECT COUNT(*) FROM `qbank_questions` WHERE `exercise_pdf` = ? OR `answer_pdf` = ?",
                    [$relUrl, $relUrl]
                );
                if (DB::getLastError() === null && $refCount === 0) {
                    if (@unlink($fullPath)) {
                        $deletedCount++;
                    }
                }
            } catch (Throwable $ignore) {
            }
        }
        return $deletedCount;
    }
}

