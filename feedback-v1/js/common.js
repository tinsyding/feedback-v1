/**
 * Polyfill for Array.prototype.at, String.prototype.at, and %TypedArray%.prototype.at (ECMAScript 2022)
 * 兼容 Chrome < 92, Safari < 15.4 等低版本内核环境
 */
(function () {
    'use strict';
    function at(n) {
        if (this == null) {
            throw new TypeError('Cannot call at on ' + this);
        }
        var O = Object(this);
        var len = O.length >>> 0;
        var k = Math.trunc(n) || 0;
        if (k < 0) k += len;
        return (k < 0 || k >= len) ? undefined : O[k];
    }
    var targets = [Array.prototype];
    if (typeof String !== 'undefined' && String.prototype) {
        targets.push(String.prototype);
    }
    if (typeof Uint8Array !== 'undefined') {
        var typedArrayProto = Object.getPrototypeOf(Uint8Array).prototype;
        if (typedArrayProto) {
            targets.push(typedArrayProto);
        }
    }
    for (var i = 0; i < targets.length; i++) {
        var proto = targets[i];
        if (proto && typeof proto.at !== 'function') {
            try {
                Object.defineProperty(proto, 'at', {
                    value: at,
                    writable: true,
                    enumerable: false,
                    configurable: true
                });
            } catch (e) {
                proto.at = at;
            }
        }
    }
})();

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

const storagePrefix = 'jf-autofeedback:';

function getPreferredTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function syncThemeMeta(theme) {
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', theme === 'light' ? '#f6f7f9' : '#151518');
    }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const themeCheckbox = document.getElementById('theme-toggle-input');
    if (themeCheckbox) {
        themeCheckbox.checked = theme === 'light';
    }
    syncThemeMeta(theme);
}

function initTheme() {
    applyTheme(getPreferredTheme());
}

function toggleTheme(checkbox) {
    let newTheme;
    if (checkbox && checkbox.checked !== undefined) {
        newTheme = checkbox.checked ? 'light' : 'dark';
    } else {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        newTheme = currentTheme === 'light' ? 'dark' : 'light';
    }
    applyTheme(newTheme);
    localStorage.setItem('theme', newTheme);
}

function setupPageTransition() {
    requestAnimationFrame(() => {
        document.body.classList.add('page-ready');
    });
}

function shouldForceIntegerScores() {
    return true; // 系统强制开启四舍五入强行取整，统一以整型规范存储与计算
}

/**
 * 自动清理知识点末尾多余标点符号（如逗号、句号、分号、点、顿号等），
 * 避免在与系统自带顿号拼接时产生重复堆叠符号（如“方程，、”、“因式分解。、”）
 */
function cleanTopicTrailingPunctuation(str) {
    if (!str || typeof str !== 'string') return '';
    return str.trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '').trim();
}

function parseScoreValue(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
    const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
    if (isNaN(parsed)) return null;
    if (typeof shouldForceIntegerScores === 'function' && shouldForceIntegerScores()) {
        return Math.round(parsed);
    }
    return Math.round(parsed * 100) / 100;
}

function parsePercentValue(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const cleaned = text.replace('%', '');
    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
}

/**
 * 统一作业状态判定工具（基于线上全量真实 CSV 数据 8 种状态 + 手动录入兼容）
 *
 * 1. 已交·已完结 (graded): 已完成、待订正、已订正、已审阅
 * 2. 已交·未改完 (ungraded): 已提交（且不含“未”）、批改中
 * 3. 未提交 (unsubmitted): 未查阅、已查阅、未提交、缺交、未交、缺勤
 */
const STANDARD_HOMEWORK_STATUSES = ['已完成', '待订正', '已订正', '已审阅', '已提交', '批改中', '未查阅', '已查阅'];

function isStatusGraded(status) {
    const s = String(status || '').trim();
    if (!s) return false;
    return s.includes('已完成') || s.includes('待订正') || s.includes('已订正') || s.includes('已审阅');
}

function isStatusUngraded(status) {
    const s = String(status || '').trim();
    if (!s) return false;
    return s === '已提交' || (s.includes('已提交') && !s.includes('未')) || s.includes('批改中');
}

function isStatusUnsubmitted(status) {
    const s = String(status || '').trim();
    if (!s) return false;
    return s.includes('未查阅') || s.includes('已查阅') || s.includes('未提交') || s.includes('缺交') || s.includes('缺勤') || s === '未交';
}

function isHomeworkSubmitted(status, options = {}) {
    const s = String(status || '').trim();
    if (!s) return !!options.emptyAsSubmitted;
    if (isStatusGraded(s)) return true;
    // 兜底：若处于“批改中”但已有非空分数（如客观题已出分且跳过拦截时），视为已提交以免丢分
    if (s.includes('批改中') && options.score !== undefined && options.score !== null) {
        return true;
    }
    return false;
}

window.STANDARD_HOMEWORK_STATUSES = STANDARD_HOMEWORK_STATUSES;
window.isStatusGraded = isStatusGraded;
window.isStatusUngraded = isStatusUngraded;
window.isStatusUnsubmitted = isStatusUnsubmitted;
window.isHomeworkSubmitted = isHomeworkSubmitted;

/**
 * 通过分数和正确率（或总分列）推算本批次作业的标准满分（一般为 100 分）
 * @param {Array<Array<string>>} data - 表格数据数组 [header, ...rows]
 * @returns {number} 推算出的标准满分（如 100、120、150、50 等）
 */
function estimateHomeworkTotalScore(data) {
    if (!Array.isArray(data) || data.length < 2) return 100;
    const header = data[0];
    if (!Array.isArray(header)) return 100;

    // 1. 如果表格已有明确的“总分”或“满分”列，优先读取非空有效数值
    const totalScoreIdx = header.findIndex(h => typeof h === 'string' && (h.includes('总分') || h.includes('满分')));
    if (totalScoreIdx >= 0) {
        const totalCandidates = [];
        for (let r = 1; r < data.length; r++) {
            const val = parseScoreValue(data[r][totalScoreIdx]);
            if (val !== null && val > 0) totalCandidates.push(val);
        }
        if (totalCandidates.length > 0) {
            totalCandidates.sort((a, b) => a - b);
            const mid = totalCandidates[Math.floor(totalCandidates.length / 2)];
            if (mid > 0) return Math.round(mid);
        }
    }

    // 2. 如果没有总分列，通过“得分”与“正确率”大致计算满分
    const scoreIdx = header.findIndex(h => typeof h === 'string' && (h.includes('得分') || h.includes('成绩') || h === '分数'));
    const accIdx = header.findIndex(h => typeof h === 'string' && (h.includes('正确率') || h.includes('正答率')));

    const estimatedTotals = [];
    let maxObservedScore = 0;

    if (scoreIdx >= 0) {
        for (let r = 1; r < data.length; r++) {
            const row = data[r];
            const score = parseScoreValue(row[scoreIdx]);
            if (score !== null && score > maxObservedScore) {
                maxObservedScore = score;
            }

            if (accIdx >= 0 && score !== null && score > 0) {
                let acc = parsePercentValue(row[accIdx]);
                if (acc !== null && acc > 0) {
                    if (acc <= 1) acc = acc * 100; // 兼容 0.85 格式
                    if (acc >= 5 && acc <= 100) { // 过滤极端异常正确率
                        const est = score / (acc / 100);
                        if (est >= 10 && est <= 300) {
                            estimatedTotals.push(est);
                        }
                    }
                }
            }
        }
    }

    // 3. 常见满分标杆：100, 120, 150, 50, 60, 70, 80, 90, 160
    const standardBases = [100, 120, 150, 50, 60, 70, 80, 90, 160];

    if (estimatedTotals.length > 0) {
        // 对每个推算值，找最接近的标准标杆（允许 ±8 容差），统计频次
        const freqMap = {};
        estimatedTotals.forEach(est => {
            let bestBase = Math.round(est);
            for (const base of standardBases) {
                if (Math.abs(est - base) <= 6) {
                    bestBase = base;
                    break;
                }
            }
            freqMap[bestBase] = (freqMap[bestBase] || 0) + 1;
        });

        // 找出现频次最高的满分基准
        let maxCount = 0;
        let bestTotal = 100;
        for (const [baseStr, count] of Object.entries(freqMap)) {
            const base = parseInt(baseStr, 10);
            if (count > maxCount || (count === maxCount && base === 100)) {
                maxCount = count;
                bestTotal = base;
            }
        }

        // 保护：满分不能低于已观察到的最高学生分数
        if (bestTotal < maxObservedScore) {
            for (const base of standardBases) {
                if (base >= maxObservedScore) {
                    bestTotal = base;
                    break;
                }
            }
            if (bestTotal < maxObservedScore) {
                bestTotal = Math.ceil(maxObservedScore / 10) * 10;
            }
        }

        return bestTotal;
    }

    // 4. 若无正确率列，满分一般都是 100 分
    if (maxObservedScore > 100) {
        for (const base of standardBases) {
            if (base >= maxObservedScore) return base;
        }
        return Math.ceil(maxObservedScore / 10) * 10;
    }

    return 100;
}

/**
 * 判断单个学生是否达到满分 / 全对
 * 规则：
 * 1. 评语明确说明全对/无错题（全对|全部正确|满分|零失误|无错题|免除加练|错题题号为无等）；
 * 2. 正确率达到 100%（>= 99.9%）；
 * 3. 学生得分达到或超过满分（且得分 > 0）；
 * 4. 得分 >= 100 分。
 */
function checkStudentFullScore(options = {}) {
    const { score, accuracy, totalScore = 100, comment = '' } = options;

    // 评语关键词优先
    if (/(?:全对|全部正确|零失误|无错题|免除加练|错题(?:题号)?(?:为|是)?\s*[:：]\s*(?:无|0|零|没有|none))/i.test(comment || '')) {
        return true;
    }

    // 正确率达到 100%
    if (accuracy !== null && accuracy !== undefined) {
        const numAcc = typeof accuracy === 'number' ? accuracy : parsePercentValue(accuracy);
        if (numAcc !== null) {
            const normalizedAcc = numAcc <= 1 && numAcc > 0 ? numAcc * 100 : numAcc;
            if (normalizedAcc >= 99.9) return true;
        }
    }

    // 得分达到满分（或绝对达到 100 分）
    if (score !== null && score !== undefined && score > 0) {
        if (totalScore && score >= totalScore) return true;
        if (score >= 100) return true;
    }

    return false;
}

window.parsePercentValue = parsePercentValue;
window.estimateHomeworkTotalScore = estimateHomeworkTotalScore;
window.checkStudentFullScore = checkStudentFullScore;

/**
 * 智能评语错题解析引擎
 * 1. 全角数字转半角数字
 * 2. 错题前缀模糊容错提取
 * 3. 纯数字序列判定
 * 4. 自然语言非题号数字拦截
 * 5. 题库范围校验与满分兜底过滤
 */
function parseErrorQuestionsFromComment(comment, options = {}) {
    if (!comment || !comment.trim()) return null;

    // 全角数字转半角数字：如 "２，５，６" -> "2，5，6"，确保中文全角输入法下输入的题号能被正确解析
    const normalizedComment = comment.replace(/[\uff10-\uff19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

    const lines = normalizedComment.split('\n');
    const firstNonEmptyIdx = lines.findIndex(l => l.trim().length > 0);
    if (firstNonEmptyIdx === -1) return null;

    const firstLine = lines[firstNonEmptyIdx].trim();
    const remainingLines = lines.slice(firstNonEmptyIdx + 1);
    const fullCommentTrimmed = normalizedComment.trim();

    // 尝试获取题库有效题号集合（若未传入，自动从全局 sessionPayload 获取）
    let questions = options.questions;
    if (!questions && typeof sessionPayload !== 'undefined' && sessionPayload?.plusData?.questions) {
        questions = sessionPayload.plusData.questions;
    }

    let validQuestionIds = null;
    if (Array.isArray(questions) && questions.length > 0) {
        validQuestionIds = new Set();
        questions.forEach(q => {
            const ids = String(q.id || '').split(/[,、，\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            ids.forEach(id => validQuestionIds.add(id));
        });
    }

    // 辅助过滤函数：题号有效性与去重（提取1~100之间的有效题号，不因题库未完全收录而丢弃真实错题）
    const filterValidNumbers = (nums) => {
        let list = nums.map(n => parseInt(n)).filter(n => !isNaN(n) && n > 0 && n <= 100);
        return [...new Set(list)];
    };

    // 1. 显式“无错题 / 全对 / 满分”拦截
    // 1.1 纯标题行声明无错题：如 "本次作业错题为：无"、"错题：0"、"本次错题：全对"
    const pureNoErrHeaderRegex = /^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错|错误)?(?:题号|序号|编号)?(?:为|是)?\s*[:：]\s*(?:无|没有|0|零|全对|无错题|全部正确|都对|暂无|none)\s*[。!！.]?\s*$/i;
    if (pureNoErrHeaderRegex.test(firstLine)) {
        return {
            errorNums: [],
            cleanComment: remainingLines.join('\n').trim()
        };
    }

    // 1.2 行内或评语中包含全对、无错题强语义
    const noErrorGeneralKeywords = /(?:本次|本周|今天)?(?:的)?(?:作业|测验|测试)?(?:全部做对|全部正确|全做对|完全正确|零失误|无错题|没有错题|免除加练|全对)/;
    if (noErrorGeneralKeywords.test(firstLine)) {
        return {
            errorNums: [],
            cleanComment: fullCommentTrimmed
        };
    }

    // 2. 错题前缀模糊容错正则
    // 兼容：本次作业的错题为： / 本次的作业的错题为： / 本次作业错题： / 错题为： / 错题： / 做错： / 错误题号： / 本次作业的错题题号为7（漏写冒号）
    const errorPrefixRegex = /^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/i;
    const prefixMatch = firstLine.match(errorPrefixRegex);

    if (prefixMatch) {
        const afterColon = prefixMatch[1].trim();

        // 冒号后如果是 "无"、"全对"、"0" 等
        if (/^(?:无|没有|0|零|全对|全部正确|无错题|none)\s*[。!！.]?$/i.test(afterColon)) {
            return {
                errorNums: [],
                cleanComment: remainingLines.join('\n').trim()
            };
        }

        // 尝试从冒号后截取数字题号与同行后续评语
        let numsPart = afterColon;
        let inlineComment = '';

        // 分割可能存在的同行评语（题号序列后遇到中文或句号等）
        const splitMatch = afterColon.match(/^([\d\s,，、.；;和与及第题/\\-]+)(?:[。!！;；\n]\s*(.*)|(?=[\u4e00-\u9fa5]{2,})(.*))?$/);
        if (splitMatch) {
            numsPart = splitMatch[1];
            inlineComment = (splitMatch[2] || splitMatch[3] || '').trim();
        }

        const rawMatched = numsPart.match(/\d+/g);
        if (rawMatched && rawMatched.length > 0) {
            const errorNums = filterValidNumbers(rawMatched);
            if (errorNums.length > 0) {
                const cleanParts = [];
                if (inlineComment) cleanParts.push(inlineComment);
                if (remainingLines.length > 0) cleanParts.push(remainingLines.join('\n').trim());
                return {
                    errorNums,
                    cleanComment: cleanParts.filter(Boolean).join('\n').trim()
                };
            }
        }

        // 冒号后没有提取到有效题号，回退为评语
        return {
            errorNums: [],
            cleanComment: remainingLines.join('\n').trim() || afterColon
        };
    }

    // 3. 纯题号格式判定（老师未写“错题为：”，第一行直接写纯题号列表）
    // 仅当第一行是纯数字、题号及分隔符时才认作错题，如 "1, 2, 5"、"1 3 4"、"第1题、第3题"
    const pureNumbersRegex = /^(?:第?\s*\d+\s*题?[,，、\s/；;和与及\-]+)*第?\s*\d+\s*题?\s*[。.]?$/;
    if (pureNumbersRegex.test(firstLine)) {
        const rawMatched = firstLine.match(/\d+/g);
        if (rawMatched && rawMatched.length > 0) {
            const errorNums = filterValidNumbers(rawMatched);
            if (errorNums.length > 0) {
                return {
                    errorNums,
                    cleanComment: remainingLines.join('\n').trim()
                };
            }
        }
    }

    // 4. 满分学生或普通文本评语：包含汉字且无错题关键词，说明是老师给的常规评语
    // 此时即使句子中包含 "98分"、"第1名"、"第1次" 等数字，也绝不作为错题提取！
    return {
        errorNums: [],
        cleanComment: fullCommentTrimmed
    };
}
window.parseErrorQuestionsFromComment = parseErrorQuestionsFromComment;

/**
 * 查找评语列索引。
 * 优先精确匹配列名，避免把“学生批改评语/学生订正评语”误当成老师评语列。
 */
function findCommentColumnIndex(header, columnName) {
    if (!Array.isArray(header) || !columnName) return -1;
    const normalized = header.map(h => String(h ?? '').replace(/^\uFEFF/, '').trim());
    const exactIdx = normalized.indexOf(columnName);
    if (exactIdx >= 0) return exactIdx;
    return normalized.findIndex(h => h.includes(columnName) && !h.includes('学生'));
}

/**
 * 最终展示评语：订正评语非空时优先使用，否则回退批改评语。
 * 错题题号也优先从订正评语解析；订正评语没有题号时再回退批改评语。
 */
function getEffectiveComment(row, originalCommentIdx, correctionCommentIdx) {
    if (!Array.isArray(row)) return '';
    const correctionComment = correctionCommentIdx >= 0 ? String(row[correctionCommentIdx] ?? '') : '';
    if (correctionComment.trim()) return correctionComment;
    return originalCommentIdx >= 0 ? String(row[originalCommentIdx] ?? '') : '';
}

/**
 * 解析错题时优先使用订正评语；订正评语没有题号时，再回退到原批改评语。
 * 展示用评语始终取最终评语（订正评语优先），并清洗掉标准错题前缀。
 */
function parseCommentForPlus(originalComment, finalComment, options = {}) {
    const finalParsed = parseErrorQuestionsFromComment(finalComment, options);
    let errorParsed = finalParsed;

    const hasFinalErrors = !!(finalParsed && Array.isArray(finalParsed.errorNums) && finalParsed.errorNums.length > 0);
    if (!hasFinalErrors && originalComment && originalComment !== finalComment) {
        const originalParsed = parseErrorQuestionsFromComment(originalComment, options);
        if (originalParsed && Array.isArray(originalParsed.errorNums) && originalParsed.errorNums.length > 0) {
            errorParsed = originalParsed;
        }
    }

    return {
        errorParsed,
        errorNums: (errorParsed && Array.isArray(errorParsed.errorNums)) ? errorParsed.errorNums : [],
        displayComment: finalParsed ? finalParsed.cleanComment : (finalComment || '')
    };
}
window.findCommentColumnIndex = findCommentColumnIndex;
window.getEffectiveComment = getEffectiveComment;
window.parseCommentForPlus = parseCommentForPlus;


// 全站唯一 toast：showToast(message, type?)，type ∈ success/error/warning，缺省无色；旧单参调用行为不变
function showToast(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('success', 'error', 'warning');
    if (type === 'success' || type === 'error' || type === 'warning') {
        toast.classList.add(type);
    }
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

function showCustomDialog(options = {}) {
    const overlay = document.getElementById('custom-dialog');
    const boxEl = overlay ? (overlay.querySelector('.dialog-box') || overlay.querySelector('.modal-card')) : null;
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const inputWrap = document.getElementById('dialog-input-wrap');
    const inputEl = document.getElementById('dialog-input');
    const confirmBtn = document.getElementById('dialog-confirm');
    const cancelBtn = document.getElementById('dialog-cancel');
    if (!overlay || !titleEl || !bodyEl || !inputWrap || !inputEl || !confirmBtn || !cancelBtn) return;
    if (boxEl) {
        if (options.maxWidth) {
            boxEl.style.maxWidth = options.maxWidth;
        } else {
            boxEl.style.maxWidth = '';
        }
    }
    titleEl.textContent = options.title || '提示';
    bodyEl.innerHTML = options.body || '';
    if (options.showInput) {
        inputWrap.classList.add('visible');
        inputEl.value = options.inputDefault || '';
    } else {
        inputWrap.classList.remove('visible');
    }
    confirmBtn.textContent = options.confirmText || '确认';
    cancelBtn.textContent = options.cancelText || '取消';
    if (options.danger) {
        confirmBtn.classList.add('danger');
    } else {
        confirmBtn.classList.remove('danger');
    }
    overlay.classList.add('active');
    setTimeout(() => {
        if (options.showInput) inputEl.focus();
        else confirmBtn.focus();
    }, 80);
    const newConfirm = confirmBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    function closeDialog() {
        overlay.classList.remove('active');
        if (boxEl) boxEl.style.maxWidth = '';
    }
    window.closeCustomDialog = closeDialog;

    const closeBtn = overlay.querySelector('.dialog-close-btn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            closeDialog();
            if (options.onCancel) options.onCancel();
        };
    }

    newConfirm.addEventListener('click', () => {
        closeDialog();
        if (options.onConfirm) {
            if (options.showInput) {
                options.onConfirm(inputEl.value);
            } else {
                options.onConfirm();
            }
        }
    });
    newCancel.addEventListener('click', () => {
        closeDialog();
        if (options.onCancel) options.onCancel();
    });
    const overlayClickHandler = (e) => {
        if (e.target === overlay) {
            closeDialog();
            if (options.onCancel) options.onCancel();
            overlay.removeEventListener('click', overlayClickHandler);
        }
    };
    overlay.addEventListener('click', overlayClickHandler);
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeDialog();
            if (options.onCancel) options.onCancel();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

/**
 * 读取文件为文本，自动检测编码（UTF-8 / GBK / GB2312）。
 * 策略：
 *   1. 以 ArrayBuffer 读取原始字节。
 *   2. 若文件以 UTF-8 BOM (EF BB BF) 开头，直接用 UTF-8 解码。
 *   3. 否则先尝试 UTF-8 解码；若结果包含替换字符 (U+FFFD)，
 *      说明存在无效 UTF-8 序列，改用 GBK 重新解码。
 *   4. 进度回调仍基于字节进度触发。
 */
function readFileAsTextWithProgress(file, onProgress, onReaderReady) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        if (onReaderReady) onReaderReady(reader);
        reader.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
        };
        reader.onload = (e) => {
            try {
                const buffer = e.target.result;
                const bytes = new Uint8Array(buffer);

                // 检查 UTF-8 BOM (EF BB BF)
                const hasUtf8Bom = bytes.length >= 3 &&
                    bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;

                if (hasUtf8Bom) {
                    // 有 BOM，直接 UTF-8 解码（TextDecoder 会自动跳过 BOM）
                    resolve(new TextDecoder('utf-8').decode(buffer));
                    return;
                }

                // 先尝试 UTF-8
                const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
                if (!utf8Text.includes('\uFFFD')) {
                    // 没有替换字符，说明是合法 UTF-8
                    resolve(utf8Text);
                } else {
                    // 含乱码，回退到 GBK（兼容 GB2312）
                    resolve(new TextDecoder('gbk').decode(buffer));
                }
            } catch (err) {
                reject(err || new Error('编码解析失败'));
            }
        };
        reader.onerror = () => reject(reader.error || new Error('读取失败'));
        reader.onabort = () => reject(new Error('aborted'));
        reader.readAsArrayBuffer(file);
    });
}

function parseCSV(text) {
    const result = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentField += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            currentRow.push(currentField.trim());
            currentField = '';
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
            if (currentField || currentRow.length > 0) {
                currentRow.push(currentField.trim());
                if (currentRow.some(field => field !== '')) {
                    result.push(currentRow);
                }
                currentRow = [];
                currentField = '';
            }
        } else {
            currentField += char;
        }
    }
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField.trim());
        if (currentRow.some(field => field !== '')) {
            result.push(currentRow);
        }
    }
    return result;
}

function setupDropZone(dropZone, fileInput, handler, isMultiple) {
    if (!dropZone) return;
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        });
    });
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            if (isMultiple) {
                handler(files);
            } else {
                handler(files[0]);
            }
        }
    });
}

function generateSessionId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ========== 存储优化与 IndexedDB 支持 ==========
const DB_NAME = 'jf_feedback_db';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function getIndexedDB() {
    return new Promise((resolve) => {
        if (!window.indexedDB) {
            resolve(null);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

async function saveToIndexedDB(id, payload) {
    try {
        const db = await getIndexedDB();
        if (!db) return false;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put({ id, payload, updatedAt: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) {
        return false;
    }
}

async function loadFromIndexedDB(id) {
    try {
        const db = await getIndexedDB();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => {
                resolve(req.result ? req.result.payload : null);
            };
            req.onerror = () => resolve(null);
        });
    } catch (e) {
        return null;
    }
}

/**
 * 自动清理 sessionStorage 中堆积的历史会话，释放配额空间
 */
function cleanOldSessionStorage(currentIdToKeep) {
    try {
        const keysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && key.startsWith(storagePrefix) && key !== `${storagePrefix}${currentIdToKeep}`) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(k => sessionStorage.removeItem(k));
    } catch (e) {}
}

async function saveSessionDataAsync(id, payload) {
    // 1. 先清理历史旧会话缓存
    cleanOldSessionStorage(id);

    // 2. 尝试使用 sessionStorage（快速同步）
    let sessionSuccess = false;
    try {
        sessionStorage.setItem(`${storagePrefix}${id}`, JSON.stringify(payload));
        sessionSuccess = true;
    } catch (error) {
        console.warn('sessionStorage 容量已满，自动转入 IndexedDB 存储:', error);
    }

    // 3. 同时异步或作为主力保存到 IndexedDB（容量数以百兆计，彻底规避配额问题）
    const idbSuccess = await saveToIndexedDB(id, payload);

    // 4. 如果 sessionStorage 写入失败，存入轻量指向标志
    if (!sessionSuccess) {
        try {
            sessionStorage.setItem(`${storagePrefix}${id}`, JSON.stringify({
                _isIndexedDB: true,
                id: id,
                subject: payload?.subject,
                createdAt: Date.now()
            }));
        } catch (e) {}
    }

    return sessionSuccess || idbSuccess;
}

function saveSessionData(id, payload) {
    // 同步调用兼容，触发异步保存
    cleanOldSessionStorage(id);
    let sessionSuccess = false;
    try {
        sessionStorage.setItem(`${storagePrefix}${id}`, JSON.stringify(payload));
        sessionSuccess = true;
    } catch (error) {
        console.warn('sessionStorage 容量超限，尝试使用 IndexedDB 备选通道:', error);
        try {
            sessionStorage.setItem(`${storagePrefix}${id}`, JSON.stringify({
                _isIndexedDB: true,
                id: id,
                subject: payload?.subject,
                createdAt: Date.now()
            }));
        } catch (e) {}
    }
    // 后台写入 IndexedDB 作为安全备份
    saveToIndexedDB(id, payload);
    return sessionSuccess;
}

async function loadSessionDataAsync(id) {
    // 1. 优先尝试从 sessionStorage 同步读取
    const raw = sessionStorage.getItem(`${storagePrefix}${id}`);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && !parsed._isIndexedDB) {
                return parsed;
            }
        } catch (e) {}
    }
    // 2. 从 IndexedDB 异步读取
    const idbData = await loadFromIndexedDB(id);
    if (idbData) {
        return idbData;
    }
    // 3. 兜底解析
    if (raw) {
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return null;
}

function loadSessionData(id) {
    const raw = sessionStorage.getItem(`${storagePrefix}${id}`);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed;
    } catch (error) {
        return null;
    }
}

async function updateSessionDataAsync(id, update) {
    const existing = (await loadSessionDataAsync(id)) || loadSessionData(id);
    if (!existing) return;
    const next = { ...existing, ...update };
    await saveSessionDataAsync(id, next);
}

function updateSessionData(id, update) {
    const existing = loadSessionData(id);
    if (existing && !existing._isIndexedDB) {
        const next = { ...existing, ...update };
        saveSessionData(id, next);
    } else {
        updateSessionDataAsync(id, update);
    }
}

function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

function initCommon() {
    // Initialize Logger
    if (window.Logger) {
        const pageName = location.pathname.split('/').pop() || 'index.html';
        const moduleMap = {
            'upload.html': 'upload',
            'viewer.html': 'viewer',
            'admin.html': 'admin',
            'admin-login.html': 'admin',
            'question-bank.html': 'qbank',
            'index.html': 'home'
        };
        Logger.init({
            module: moduleMap[pageName] || 'global',
            page: pageName
        });
    }
    initTheme();
    setupPageTransition();
    showUpdateModalIfNeeded();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCommon);
} else {
    initCommon();
}

async function showUpdateModalIfNeeded() {
    try {
        const res = await fetch('api/changelog.php?action=getActive');
        const json = await res.json();
        if (!json.success || !json.data) return;

        const activeLog = json.data;
        const hasSeenUpdate = localStorage.getItem('seen_update_' + activeLog.id);
        if (hasSeenUpdate) return;
        
        showChangelogContentModal(activeLog, () => {
            localStorage.setItem('seen_update_' + activeLog.id, 'true');
        });
    } catch(e) { console.error('Error fetching active changelog:', e); }
}

function showChangelogContentModal(logData, onCloseParams = null) {
    let itemsHtml = (logData.items || []).map((item, index) => {
        const colors = [
            { bg: 'rgba(34,197,94,0.1)', text: '#22c55e' },
            { bg: 'rgba(59,130,246,0.1)', text: '#3b82f6' },
            { bg: 'rgba(245,158,11,0.1)', text: '#f59e0b' },
            { bg: 'rgba(168,85,247,0.1)', text: '#a855f7' }
        ];
        const color = colors[index % colors.length];
        return `
        <div style="display: flex; gap: 12px;">
            <span style="display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: ${color.bg}; color: ${color.text}; flex-shrink: 0; font-size: 0.85rem; font-weight: 600;">${index + 1}</span>
            <div>
                <div style="font-size: 0.95rem; font-weight: 600; color: var(--text-primary, #111827); margin-bottom: 4px;">${escapeHtml(item.title ?? '')}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary, #4b5563); line-height: 1.5; white-space: pre-wrap;">${escapeHtml(item.desc ?? '')}</div>
            </div>
        </div>`;
    }).join('');

    let modalHtml = `
    <!-- Update Modal -->
    <div id="global-update-modal" style="display: flex; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 10000; opacity: 0; transition: opacity 0.3s; backdrop-filter: blur(4px);">
        <div style="background: var(--bg-primary, #fff); width: 440px; max-width: 90%; max-height: 85vh; border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04); display: flex; flex-direction: column; overflow: hidden; transform: translateY(20px); transition: transform 0.3s;">
            <div style="padding: 20px 24px; border-bottom: 1px solid var(--border-color, #e5e7eb); display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, rgba(59,130,246,0.1), rgba(147,197,253,0.05)); flex-shrink: 0;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 32px; height: 32px; border-radius: 8px; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px;">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="17 8 12 3 7 8"></polyline>
                            <line x1="12" y1="3" x2="12" y2="15"></line>
                        </svg>
                    </div>
                    <div>
                        <h3 style="margin: 0; font-size: 1.1rem; color: var(--text-primary, #111827); font-weight: 600;">${escapeHtml(logData.title || '系统更新提示')}</h3>
                        <p style="margin: 4px 0 0 0; font-size: 0.8rem; color: #3b82f6;">${escapeHtml(logData.version || 'Version Update')} • ${escapeHtml(logData.date || '')}</p>
                    </div>
                </div>
                <!-- Close cross -->
                <button id="global-update-modal-close" style="background: none; border: none; cursor: pointer; color: var(--text-secondary);">&times;</button>
            </div>
            <div style="padding: 24px; overflow-y: auto;">
                <div style="display: flex; flex-direction: column; gap: 16px;">
                    ${itemsHtml}
                </div>
            </div>
            <div style="padding: 16px 24px; border-top: 1px solid var(--border-color, #e5e7eb); display: flex; justify-content: flex-end; background: var(--bg-secondary, #f9fafb); flex-shrink:0;">
                <button id="global-update-modal-btn" style="padding: 8px 24px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: background 0.2s;">我知道了</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById('global-update-modal');
    
    // Animate in
    setTimeout(() => {
        modal.style.opacity = '1';
        modal.children[0].style.transform = 'translateY(0)';
    }, 50);

    const closeModal = () => {
        if(onCloseParams) onCloseParams();
        modal.style.opacity = '0';
        modal.children[0].style.transform = 'translateY(20px)';
        setTimeout(() => modal.remove(), 300);
    };

    document.getElementById('global-update-modal-btn').onclick = closeModal;
    document.getElementById('global-update-modal-close').onclick = closeModal;
}

window.showAllChangelogsModal = async function() {
    try {
        const res = await fetch('api/changelog.php?action=getAll');
        const json = await res.json();
        if (!json.success || !json.data || !json.data.length) return;

        let logsHtml = json.data.map(log => {
            let itemsHtml = (log.items || []).map(item => `
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary);">• ${escapeHtml(item.title ?? '')}</div>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4; padding-left: 12px; margin-top:2px; white-space: pre-wrap;">${escapeHtml(item.desc ?? '')}</div>
                </div>
            `).join('');
            
            return `
            <div style="margin-bottom: 24px; border-bottom: 1px dashed var(--border-color, #e5e7eb); padding-bottom: 16px;">
                <h3 style="margin: 0 0 4px 0; font-size: 1.1rem; color: var(--text-primary);">${escapeHtml(log.title ?? '')} <span style="font-size: 0.8rem; background: rgba(59,130,246,0.1); color: #3b82f6; padding: 2px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle;">${escapeHtml(log.version ?? '')}</span></h3>
                <div style="font-size: 0.8rem; color: var(--text-muted, #9ca3af); margin-bottom: 12px;">${escapeHtml(log.date ?? '')}</div>
                <div>${itemsHtml}</div>
            </div>`;
        }).join('');

        let modalHtml = `
        <div id="all-changelogs-modal" style="display: flex; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 10000; opacity: 0; transition: opacity 0.3s; backdrop-filter: blur(4px);">
            <div style="background: var(--bg-primary, #fff); width: 600px; max-width: 90%; max-height: 85vh; border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); display: flex; flex-direction: column; overflow: hidden; transform: translateY(20px); transition: transform 0.3s;">
                <div style="padding: 20px 24px; border-bottom: 1px solid var(--border-color, #e5e7eb); display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary, #f9fafb); flex-shrink: 0;">
                    <h3 style="margin: 0; font-size: 1.25rem; color: var(--text-primary); font-weight: 600;">系统更新历史记录</h3>
                    <button id="all-changelogs-close" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-secondary);">&times;</button>
                </div>
                <div style="padding: 24px; overflow-y: auto;">
                    ${logsHtml}
                </div>
            </div>
        </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        const modal = document.getElementById('all-changelogs-modal');
        
        setTimeout(() => {
            modal.style.opacity = '1';
            modal.children[0].style.transform = 'translateY(0)';
        }, 50);

        const closeModal = () => {
            modal.style.opacity = '0';
            modal.children[0].style.transform = 'translateY(20px)';
            setTimeout(() => modal.remove(), 300);
        };

        document.getElementById('all-changelogs-close').onclick = closeModal;
        modal.onclick = (e) => {
            if(e.target === modal) closeModal();
        };
    } catch(e) { console.error('Error fetching changelogs:', e); }
};

window.toggleTheme = toggleTheme;
window.showCustomDialog = showCustomDialog;
window.showToast = showToast;
window.cleanTopicTrailingPunctuation = cleanTopicTrailingPunctuation;
window.parseCSV = parseCSV;
window.setupDropZone = setupDropZone;
window.readFileAsTextWithProgress = readFileAsTextWithProgress;
window.generateSessionId = generateSessionId;
window.saveSessionData = saveSessionData;
window.saveSessionDataAsync = saveSessionDataAsync;
window.loadSessionData = loadSessionData;
window.loadSessionDataAsync = loadSessionDataAsync;
window.updateSessionData = updateSessionData;
window.updateSessionDataAsync = updateSessionDataAsync;
window.getQueryParam = getQueryParam;

// ============================================================
// Global Network Monitor, Timeout Request & Button Loading
// ============================================================

let globalNetworkBannerTimer = null;

function initNetworkMonitor() {
    if (typeof document === 'undefined') return;
    let banner = document.getElementById('global-network-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'global-network-banner';
        banner.className = 'global-network-banner';
        document.body.appendChild(banner);
    }

    function showOfflineBanner() {
        if (globalNetworkBannerTimer) {
            clearTimeout(globalNetworkBannerTimer);
            globalNetworkBannerTimer = null;
        }
        banner.className = 'global-network-banner offline active';
        banner.innerHTML = `
            <span>网络连接已断开，请检查网络设置</span>
            <button type="button" class="global-network-retry-btn" onclick="checkNetworkReachability()">重新检测</button>
        `;
    }

    function showOnlineBanner() {
        if (banner.classList.contains('active') && banner.classList.contains('offline')) {
            banner.className = 'global-network-banner online active';
            banner.innerHTML = '<span>网络连接已恢复正常</span>';
            if (globalNetworkBannerTimer) clearTimeout(globalNetworkBannerTimer);
            globalNetworkBannerTimer = setTimeout(() => {
                banner.classList.remove('active');
            }, 3000);
        }
    }

    window.addEventListener('offline', showOfflineBanner);
    window.addEventListener('online', showOnlineBanner);

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        showOfflineBanner();
    }
}

async function checkNetworkReachability() {
    const banner = document.getElementById('global-network-banner');
    if (banner) {
        banner.innerHTML = '<span>正在检测网络连通性...</span>';
    }
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 3500);
        const resp = await fetch('api/public_config.php?_t=' + Date.now(), {
            method: 'HEAD',
            cache: 'no-store',
            signal: controller.signal
        });
        clearTimeout(tid);
        if (resp.ok || resp.status < 500) {
            if (banner) {
                banner.className = 'global-network-banner online active';
                banner.innerHTML = '<span>网络连接正常</span>';
                setTimeout(() => banner.classList.remove('active'), 2500);
            }
            if (typeof showToast === 'function') showToast('网络连接正常');
            return true;
        }
    } catch (e) {
        // Fallback check failed
    }

    if (banner) {
        banner.className = 'global-network-banner offline active';
        banner.innerHTML = `
            <span>网络仍未接通，请确认路由器或网络连线正常</span>
            <button type="button" class="global-network-retry-btn" onclick="checkNetworkReachability()">再试一次</button>
        `;
    }
    if (typeof showToast === 'function') showToast('网络未接通，请检查本地网络');
    return false;
}

async function requestWithTimeout(url, options = {}, timeoutMs = 8000) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const err = new Error('当前设备处于离线状态，请检查本地 Wi-Fi 或网络设置');
        err.code = 'NETWORK_OFFLINE';
        throw err;
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    let originalSignal = options.signal;
    if (originalSignal) {
        originalSignal.addEventListener('abort', () => controller.abort());
    }

    try {
        const resp = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutTimer);
        return resp;
    } catch (err) {
        clearTimeout(timeoutTimer);
        if (err.name === 'AbortError') {
            const timeoutErr = new Error(`网络响应超时（超过${Math.round(timeoutMs/1000)}秒），当前网络较弱，请稍后重试`);
            timeoutErr.code = 'TIMEOUT';
            throw timeoutErr;
        }
        if ((typeof navigator !== 'undefined' && !navigator.onLine) || err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) {
            const netErr = new Error('网络连接失败，无法连接到服务器，请检查您的网络设置');
            netErr.code = 'NETWORK_ERROR';
            throw netErr;
        }
        throw err;
    }
}

async function withButtonLoading(buttonEl, loadingText, asyncCallback) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (typeof showToast === 'function') {
            showToast('当前处于离线状态，请检查网络后再试');
        }
        return false;
    }

    if (!buttonEl) {
        return await asyncCallback();
    }

    if (buttonEl.disabled || buttonEl.classList.contains('btn-loading')) {
        return false;
    }

    const originalHtml = buttonEl.innerHTML;
    const originalDisabled = buttonEl.disabled;

    buttonEl.disabled = true;
    buttonEl.classList.add('btn-loading');
    buttonEl.innerHTML = `<span class="btn-spinner"></span><span>${loadingText || '正在处理...'}</span>`;

    try {
        return await asyncCallback();
    } finally {
        buttonEl.disabled = originalDisabled;
        buttonEl.classList.remove('btn-loading');
        buttonEl.innerHTML = originalHtml;
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNetworkMonitor);
    } else {
        initNetworkMonitor();
    }
}

window.initNetworkMonitor = initNetworkMonitor;
window.checkNetworkReachability = checkNetworkReachability;
window.requestWithTimeout = requestWithTimeout;
window.withButtonLoading = withButtonLoading;

// ========== 问卷星 (Wenjuanxing) 预习作答与错题匹配核心工具库 ==========

/**
 * 问卷星作答选项归一化：
 * 1. 数字代码转字母：'1'->'A', '2'->'B', '3'->'C', '4'->'D', '5'->'E', '6'->'F'
 * 2. 字母选项标准化：去除首尾空格、统一转大写
 * 3. 多选分隔符支持：支持问卷星特有的 '┋' 分隔符以及逗号、顿号、分号，排序去重后以 '┋' 重新拼接（如 '2┋1' -> 'A┋B'）
 */
function normalizeWenjuanxingAnswer(val) {
    if (val === null || val === undefined) return '';
    let str = String(val).trim().toUpperCase();
    if (!str) return '';
    const numToLetter = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };
    if (numToLetter[str]) return numToLetter[str];
    if (str.includes('┋') || str.includes(',') || str.includes('、') || str.includes(';') || str.includes('；')) {
        const parts = str.split(/[┋,、;；]/).map(p => p.trim()).filter(Boolean);
        const mapped = parts.map(p => numToLetter[p] || p);
        return [...new Set(mapped)].sort().join('┋');
    }
    return str;
}

/**
 * 从问卷星表格表头中精准提取所有题目列
 * 排除非题目列（如姓名、总分、学号、提交时间、IP、来源、序号、班级等）
 * 支持形如：'第1题'、'第 1 题'、'第1题：...'、'1、...'、'1. ...'、'1．...' 等格式
 */
function extractWenjuanxingQuestionColumns(header) {
    if (!Array.isArray(header)) return [];
    const qCols = [];
    header.forEach((h, idx) => {
        const text = String(h || '').trim();
        if (!text) return;
        // 排除常见元数据列
        if (/姓名|总分|得分|学号|时间|IP|来源|序号|用户ID|班级/i.test(text)) return;
        let qNum = null;
        const m1 = text.match(/第\s*(\d+)\s*题/);
        const m2 = text.match(/^(\d+)[\.、．\s]/);
        if (m1) qNum = parseInt(m1[1]);
        else if (m2) qNum = parseInt(m2[1]);
        if (qNum !== null && !isNaN(qNum) && qNum > 0) {
            qCols.push({ colIdx: idx, qNum, headerText: text });
        }
    });
    qCols.sort((a, b) => a.qNum - b.qNum);
    return qCols;
}

/**
 * 获取问卷星数据的标定行与标准答案
 * 标定规则：
 * 1. 优先校验首行（Row 1）：若首行得分为全表最高分（通常为老师自己答的满分测试卷），认定为标定卷；
 * 2. 容错兜底：若首行非最高分，取全表中首个达到最高分的答卷作为标准答案。
 */
function getWenjuanxingBenchmark(data) {
    if (!data || data.length < 2) return null;
    const header = data[0].map(h => String(h || '').trim());
    const nameIdx = header.findIndex(h => h.includes('您的姓名') || (h.includes('姓名') && !h.includes('时间')));
    const scoreIdx = header.findIndex(h => h === '总分' || h.includes('总分'));
    if (nameIdx < 0 || scoreIdx < 0) return null;

    const qCols = extractWenjuanxingQuestionColumns(header);
    const rawRows = data.slice(1).filter(r => r[nameIdx] && String(r[nameIdx]).trim());
    if (rawRows.length === 0) return null;

    let maxScore = -Infinity;
    rawRows.forEach(r => {
        const s = parseScoreValue(r[scoreIdx]);
        if (s !== null && !isNaN(s) && s > maxScore) maxScore = s;
    });
    if (maxScore === -Infinity || maxScore <= 0) maxScore = 100;

    const r1 = rawRows[0];
    const r1Score = parseScoreValue(r1[scoreIdx]);
    let benchmarkRow = null;
    let isR1Benchmark = false;
    let benchmarkRowIdxInRaw = 0;

    if (r1Score !== null && r1Score === maxScore) {
        benchmarkRow = r1;
        isR1Benchmark = true;
        benchmarkRowIdxInRaw = 0;
    } else {
        const bestIdx = rawRows.findIndex(r => parseScoreValue(r[scoreIdx]) === maxScore);
        benchmarkRowIdxInRaw = bestIdx >= 0 ? bestIdx : 0;
        benchmarkRow = rawRows[benchmarkRowIdxInRaw];
        isR1Benchmark = (benchmarkRowIdxInRaw === 0);
    }

    const standardAnswers = {};
    if (benchmarkRow && qCols.length > 0) {
        qCols.forEach(qc => {
            standardAnswers[qc.qNum] = normalizeWenjuanxingAnswer(benchmarkRow[qc.colIdx]);
        });
    }

    return {
        isR1Benchmark,
        benchmarkName: benchmarkRow ? String(benchmarkRow[nameIdx] || '').trim() : '',
        benchmarkScore: benchmarkRow ? benchmarkRow[scoreIdx] : null,
        benchmarkRowIdx: benchmarkRowIdxInRaw + 1,
        maxScore,
        questionCount: qCols.length,
        questionNums: qCols.map(q => q.qNum),
        standardAnswers
    };
}

/**
 * 解析问卷星表格数据，输出学生错题匹配映射与统计
 */
function parseWenjuanxingBenchmarkAndErrors(data, hwStudentNames = []) {
    if (!data || data.length < 2) {
        return { rows: [], map: {}, benchmark: null, qCols: [] };
    }
    const header = data[0].map(h => String(h || '').trim());
    const nameIdx = header.findIndex(h => h.includes('您的姓名') || (h.includes('姓名') && !h.includes('时间')));
    const scoreIdx = header.findIndex(h => h === '总分' || h.includes('总分'));
    if (nameIdx < 0 || scoreIdx < 0) {
        return { rows: data.slice(1), map: {}, benchmark: null, qCols: [] };
    }

    const qCols = extractWenjuanxingQuestionColumns(header);
    const rawRows = data.slice(1).filter(r => r[nameIdx] && String(r[nameIdx]).trim());
    const benchmark = getWenjuanxingBenchmark(data);

    let studentRows = rawRows;
    if (benchmark && benchmark.isR1Benchmark) {
        studentRows = rawRows.slice(1);
    }

    const standardAnswers = benchmark?.standardAnswers || {};
    const map = {};

    studentRows.forEach(r => {
        const rawName = String(r[nameIdx]).trim();
        const score = parseScoreValue(r[scoreIdx]);

        const errors = [];
        if (qCols.length > 0 && benchmark) {
            qCols.forEach(qc => {
                const stdAns = standardAnswers[qc.qNum];
                const studentAns = normalizeWenjuanxingAnswer(r[qc.colIdx]);
                if (stdAns && studentAns !== stdAns) {
                    errors.push(qc.qNum);
                }
            });
        }
        errors.sort((a, b) => a - b);

        let matchedName = rawName;
        if (hwStudentNames && hwStudentNames.length > 0) {
            const found = hwStudentNames.find(n => n === rawName);
            if (found) {
                matchedName = found;
            }
        }

        map[matchedName] = {
            fullName: rawName,
            isSubmitted: true,
            score: score,
            rank: null,
            errors: errors,
            errorCount: errors.length,
            comment: ''
        };
    });

    return {
        rows: studentRows,
        map,
        benchmark,
        qCols
    };
}

window.normalizeWenjuanxingAnswer = normalizeWenjuanxingAnswer;
window.extractWenjuanxingQuestionColumns = extractWenjuanxingQuestionColumns;
window.getWenjuanxingBenchmark = getWenjuanxingBenchmark;
window.parseWenjuanxingBenchmarkAndErrors = parseWenjuanxingBenchmarkAndErrors;


