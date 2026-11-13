// ========== Question Bank Management Logic (PHP API) ==========
const API_BASE = 'api/qbank.php';
const LOG_API = 'api/logs.php';

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

let currentQuestions = [];
let isDirty = false;
let browserFingerprint = '';
let currentStep = 1;
let batchExerciseFile = null;
let batchAnswerFile = null;
let batchUploadType = null;
let batchImported = false;
let batchQuestionPageCount = 0;
let batchAnswerPageCount = 0;
let batchQuestionLabels = [];
let batchAnswerLabels = [];
let batchQuestionThumbs = [];
let batchAnswerThumbs = [];
// 每页题目/答案 PDF 上的大题小问框选坐标数组: batchPageBoxes[pageIndex] = [{ x, y, w, h }, ...]
let batchPageBoxes = [];
let batchAnswerPageBoxes = [];
// 每页题目 PDF 上的大题原文区框选坐标数组: batchStemBoxes[pageIndex] = [{ x, y, w, h }, ...]
let batchStemBoxes = [];
// 自动识别出的题号（null 表示该页未识别到），以及当前题号是否仍来自自动识别
let batchQuestionDetectedLabels = [];
let batchAnswerDetectedLabels = [];
let batchQuestionAutoFlags = [];
let batchAnswerAutoFlags = [];
let batchQuestionInheritedFlags = [];
let batchAnswerInheritedFlags = [];
let batchQuestionAutoCount = 0;
let batchAnswerAutoCount = 0;
let batchQuestionInheritedCount = 0;
let batchAnswerInheritedCount = 0;

// ========== PDF 页面题号自动识别 ==========
// 题库上传的题目/答案 PDF 通常会在每页左上角印刷“6.”、“第 11 题”等作业题号。
// 这里直接使用 PDF.js 提取的文字坐标做本地识别，不发送 PDF 内容、不依赖 OCR。
function normalizeQuestionNumber(raw) {
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n >= 1 && n <= 300 ? n : null;
}

function parseQuestionNumberFromText(raw, allowBareNumber = true) {
    let s = String(raw || '').replace(/\u00a0/g, ' ').trim();
    if (!s) return null;
    // 常见题目前缀，如“典例15．”“例 3.”“变式2”
    s = s.replace(/^(?:典例|例题|例|变式|拓展|【典例】|【例】)[\s:：]*/, '');
    s = s.replace(/\s+/g, '');
    if (!s) return null;
    // 排除页眉/页脚中的“第1页”“共3页”“Page 1”“1/10”等
    if (/第\d+页|共\d+页|page\d+/i.test(s)) return null;
    if (/^\d{1,3}\/\d{1,3}/.test(s)) return null;
    // 第 11 题
    let m = s.match(/^第(\d{1,3})题/);
    if (m) return normalizeQuestionNumber(m[1]);
    // ( ) 2. / （ ）2． / (   )13.
    m = s.match(/^[（(]\s*[）)]\s*(\d{1,3})\s*(?:[.．、,，:：]|题)/);
    if (m) return normalizeQuestionNumber(m[1]);
    // （2） / (2).
    m = s.match(/^[（(]\s*(\d{1,3})\s*[）)]\s*(?:[.．、,，:：]|题)?/);
    if (m) return normalizeQuestionNumber(m[1]);
    // 6. / 24． / 5、 / 3: / 第3题
    m = s.match(/^(\d{1,3})\s*(?:[.．、,，:：]|题)(?![0-9])/);
    if (m) return normalizeQuestionNumber(m[1]);
    // 整行只有一个数字（如题号单独占一行）
    if (allowBareNumber && /^\d{1,3}$/.test(s)) return normalizeQuestionNumber(s);
    return null;
}

function detectQuestionNumberFromPageText(items, pageWidth, pageHeight, pageNumber = null) {
    if (!Array.isArray(items) || !items.length || !pageWidth || !pageHeight) return null;

    // 先按纵坐标把文字合并成行，行内再按横坐标从左到右排列
    const lines = [];
    const tolerance = 3.5;
    const sorted = items
        .filter(item => item && typeof item.str === 'string' && item.str.trim() && item.transform)
        .map(item => {
            const tr = item.transform;
            return {
                text: item.str.trim(),
                x: Number(tr[4]) || 0,
                y: Number(tr[5]) || 0,
                fontSize: Math.hypot(Number(tr[2]) || 0, Number(tr[3]) || 0)
            };
        })
        .sort((a, b) => b.y - a.y || a.x - b.x);

    for (const item of sorted) {
        let line = lines.find(l => Math.abs(l.y - item.y) <= tolerance);
        if (!line) {
            line = { y: item.y, items: [] };
            lines.push(line);
        }
        line.items.push(item);
    }
    lines.sort((a, b) => b.y - a.y);

    const candidates = [];
    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        const first = line.items[0];
        const yRatio = line.y / pageHeight;
        if (yRatio < 0.72) continue; // 只认页面上部靠近顶端的位置，避免正文中的小问编号/上标
        if (first.fontSize > 0 && first.fontSize < 8) continue;

        const compact = line.items.map(item => item.text.replace(/\s+/g, '')).join('');
        const explicit = /第\d{1,3}题/.test(compact);
        // 普通题号必须紧贴左侧；只有“第X题”这种明确格式允许居中
        if (!explicit && first.x > pageWidth * 0.18) continue;

        // 只有真正贴着左上角且靠近页顶的单独数字，才允许不带“.”“题”等标记
        const allowBare = yRatio >= 0.85 && first.x < pageWidth * 0.12;
        let num = parseQuestionNumberFromText(compact, allowBare);
        // 单独一个数字很可能只是页眉/页脚页码；若它正好等于当前页码，优先按页码处理，
        // 不作为题号，后续会沿用上一页题号。带“.”“题”等标记的才是明确题号。
        if (num !== null && pageNumber && /^\d{1,3}$/.test(compact) && num === Number(pageNumber)) {
            num = null;
        }
        if (num === null) {
            // 行内文字被拆成多个 item 时（常见于“1”“5”“．”分开），再逐项尝试
            for (const item of line.items.slice(0, 8)) {
                if (!explicit && item.x > pageWidth * 0.18) break;
                const n = parseQuestionNumberFromText(item.text, false);
                if (n !== null) {
                    num = n;
                    break;
                }
            }
        }
        if (num === null) continue;

        let score = 100;
        if (yRatio >= 0.80 && yRatio <= 0.95) score += 20;
        else if (yRatio > 0.95) score -= 10;
        if (first.x < pageWidth * 0.10) score += 10;
        else if (first.x < pageWidth * 0.18) score += 5;
        if (first.fontSize >= 9) score += 5;
        if (compact.length > 6) score += 5;
        if (explicit) score += 5;
        candidates.push({ num, score, y: line.y, x: first.x });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.y - a.y || a.x - b.x);
    return candidates[0].num;
}

const yearSelect = document.getElementById('qb-year');
const seasonSelect = document.getElementById('qb-season');
const bankTypeSelect = document.getElementById('qb-bank-type');
const subjectSelect = document.getElementById('qb-subject');
const gradeSelect = document.getElementById('qb-grade');
const tierSelect = document.getElementById('qb-tier');
const weekSelect = document.getElementById('qb-week');
const questionItems = document.getElementById('question-items');
const statusEl = document.getElementById('qb-status');
const statusText = document.getElementById('qb-status-text');
const saveInfo = document.getElementById('save-info');

// 配置 pdf.js worker（优先使用本地极速加载，彻底告别 unpkg.com 外部网络阻塞）
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/libs/pdfjs/pdf.worker.min.js';
}

// ========== Browser Fingerprint ==========
async function generateFingerprint() {
    const components = [];
    
    components.push(navigator.userAgent || '');
    components.push(navigator.language || '');
    components.push(screen.width + 'x' + screen.height);
    components.push(screen.colorDepth || '');
    components.push(new Date().getTimezoneOffset());
    components.push(navigator.platform || '');
    
    const canvas = document.createElement('canvas');
    try {
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('fingerprint', 2, 2);
        components.push(canvas.toDataURL());
    } catch (e) {
        components.push('canvas-blocked');
    }
    
    const webgl = document.createElement('canvas');
    try {
        const gl = webgl.getContext('webgl') || webgl.getContext('experimental-webgl');
        if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                components.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL));
                components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
            }
        }
    } catch (e) {
        components.push('webgl-blocked');
    }
    
    const fingerprint = components.join('###');
    let hashHex = '';
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(fingerprint);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        // Fallback simple hash for non-secure contexts (e.g. LAN IP over HTTP)
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) {
            const char = fingerprint.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        hashHex = Math.abs(hash).toString(16).padStart(32, '0');
    }
    return hashHex.substring(0, 32);
}



let maxWeeks = 30; // Default max weeks

async function initQuestionBank() {
    updateBankTypeUi();
    browserFingerprint = await generateFingerprint();
    if (window.Logger) {
        Logger.setContext({ fingerprint: browserFingerprint });
    }
    
    // Load semester weeks from config (via脱敏公开接口；config.json 已被 nginx 禁止直读)
    fetch('api/public_config.php')
        .then(response => response.json())
        .then(config => {
            if (config.semesterWeeks && config.semesterWeeks > 0) {
                maxWeeks = config.semesterWeeks;
            }
            if (config.semesterYear) {
                window.adminSemesterYear = config.semesterYear;
                if (yearSelect) yearSelect.value = String(config.semesterYear);
            }
            if (config.defaultSeason !== undefined) {
                window.defaultSeason = config.defaultSeason;
                const seasonZhMap = { 'spring': '春', 'summer': '暑', 'autumn': '秋', 'winter': '寒' };
                window.adminDefaultSeasonZh = seasonZhMap[config.defaultSeason] || config.defaultSeason;
                if (seasonSelect) {
                    seasonSelect.value = window.adminDefaultSeasonZh;
                }
            }
            populateWeekSelector();
            if (subjectSelect) subjectSelect.value = '';
            if (gradeSelect) gradeSelect.value = '';
            if (tierSelect) tierSelect.value = '';
            if (weekSelect) weekSelect.value = '';
            loadCurrentData();
            renderSavedDataList();
        })
        .catch(() => {
            populateWeekSelector();
            if (subjectSelect) subjectSelect.value = '';
            if (gradeSelect) gradeSelect.value = '';
            if (tierSelect) tierSelect.value = '';
            if (weekSelect) weekSelect.value = '';
            loadCurrentData();
            renderSavedDataList();
        });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initQuestionBank();
        applyAssistantReadOnlyModeIfNeed();
    });
} else {
    initQuestionBank();
    applyAssistantReadOnlyModeIfNeed();
}

// 助教只读模式适配
function applyAssistantReadOnlyModeIfNeed(user) {
    user = user || window.currentUser;
    if (!user || user.role !== 'assistant') return;

    // 移除顶部只读横幅提示
    const existingBanner = document.getElementById('qb-assistant-banner');
    if (existingBanner) existingBanner.remove();

    // 2. Step 1: 适配按钮为“查看所选专题题目”
    const step1NextBtn = document.querySelector('button[onclick="goNextFromStep1()"]');
    if (step1NextBtn) {
        step1NextBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;margin-right:4px;">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
            查看所选专题题目
        `;
        step1NextBtn.style.display = 'inline-flex';
    }

    // 3. Step 4: 隐藏添加/清空按钮、隐藏保存按钮并展示只读提示
    const editActions = document.querySelector('.question-list-actions');
    if (editActions) {
        editActions.style.display = 'none';
    }
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
        saveBtn.style.display = 'none';
    }
    let roBadge = document.getElementById('qb-assistant-save-badge');
    if (!roBadge) {
        roBadge = document.createElement('span');
        roBadge.id = 'qb-assistant-save-badge';
        roBadge.className = 'badge-assistant-readonly';
        roBadge.textContent = '助教只读浏览，不可保存';
        const saveBar = document.querySelector('.qb-save-bar');
        if (saveBar) saveBar.appendChild(roBadge);
    }
}

window.addEventListener('authChecked', (e) => {
    applyAssistantReadOnlyModeIfNeed(e.detail);
    if (typeof applySavedDataFilter === 'function' && allSavedDataList.length > 0) {
        applySavedDataFilter();
    }
    if (typeof renderQuestionList === 'function' && currentQuestions.length > 0) {
        renderQuestionList();
    }
});

// 数字转中文数字（支持 1-99）
function numToChinese(n) {
    const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n <= 9) return digits[n] || String(n);
    if (n === 10) return '十';
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    if (tens === 1) return '十' + (ones ? digits[ones] : '');
    return digits[tens] + '十' + (ones ? digits[ones] : '');
}

function getTopicLabel(w) {
    if (!w || isNaN(parseInt(w))) return '';
    return '专题' + numToChinese(parseInt(w));
}

function getBankType() {
    return bankTypeSelect ? bankTypeSelect.value : '';
}

function getBankTypeLabel(type) {
    if (type === 'preview') return '预习';
    if (type === 'homework') return '课后巩固';
    if (type === 'variation') return '课后举一反三';
    return '';
}

function updateBankTypeUi() {
    const type = getBankType();
    const weekLabel = document.getElementById('qb-week-label');
    if (weekLabel) {
        weekLabel.textContent = type === 'preview' ? '预习专题' : (type === 'variation' ? '举一反三专题' : (type === 'homework' ? '课后巩固专题' : '专题'));
    }
    const step3TabLabel = document.getElementById('step3-tab-label');
    if (step3TabLabel) {
        step3TabLabel.textContent = '标注题号';
    }
    const searchInput = document.getElementById('qb-search-input');
    if (searchInput) {
        searchInput.placeholder = (type === 'preview' || type === 'variation')
            ? '按题号或知识点过滤...'
            : '按题号、知识点或微课链接过滤...';
    }
    const previewHintBanner = document.getElementById('qb-preview-hint-banner');
    if (previewHintBanner) {
        previewHintBanner.style.display = type === 'preview' ? 'flex' : 'none';
    }
    const variationHintBanner = document.getElementById('qb-variation-hint-banner');
    if (variationHintBanner) {
        variationHintBanner.style.display = type === 'variation' ? 'flex' : 'none';
    }
}

function onBankTypeChange() {
    updateBankTypeUi();
    // 切换题库类型时清空当前编辑内容，避免把课后巩固题目误存到预习题库
    currentQuestions = [];
    isDirty = false;
    batchImported = false;
    renderQuestionList();
    updateStatus();
    loadCurrentData();
    if (typeof applySavedDataFilter === 'function') applySavedDataFilter();
}

function populateWeekSelector() {
    weekSelect.innerHTML = '<option value="" selected>请选择专题</option>';
    for (let i = 1; i <= maxWeeks; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = getTopicLabel(i);
        weekSelect.appendChild(opt);
    }
    weekSelect.value = '';
}

// ========== API Helpers ==========
async function apiGet(action, params = {}) {
    const query = new URLSearchParams({ action, ...params }).toString();
    const resp = await fetch(`${API_BASE}?${query}`, { credentials: 'same-origin' });
    if (resp.status === 401) {
        handleUnauthorized();
        return { success: false, error: '未登录' };
    }
    return await resp.json();
}

async function apiPost(data) {
    const resp = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(data)
    });
    if (resp.status === 401) {
        handleUnauthorized();
        return { success: false, error: '未登录' };
    }
    return await resp.json();
}

async function apiDelete(params) {
    const query = new URLSearchParams(params).toString();
    const resp = await fetch(`${API_BASE}?${query}`, { method: 'DELETE', credentials: 'same-origin' });
    if (resp.status === 401) {
        handleUnauthorized();
        return { success: false, error: '未登录' };
    }
    return await resp.json();
}

function handleUnauthorized() {
    showCustomDialog({
        title: '登录状态已失效',
        body: '您的教师登录会话已过期，请重新登录账号以继续操作。<br><span style="font-size:12px;color:var(--text-muted, #94a3b8);">（提示：重新登录后无需刷新页面，当前编辑内容将被保留。若需退出可前往 <a href="index.html" style="color:var(--primary, #2563eb);">登录首页</a>）</span>',
        confirmText: '立即登录',
        cancelText: '取消',
        onConfirm: () => {
            if (typeof window.showAuthModal === 'function') {
                window.showAuthModal();
            } else {
                window.location.href = 'index.html';
            }
        }
    });
}

// ========== Selector Change ==========
async function onSelectorChange() {
    batchExerciseFile = null;
    batchAnswerFile = null;
    batchImported = false;
    batchQuestionDetectedLabels = [];
    batchAnswerDetectedLabels = [];
    batchQuestionAutoFlags = [];
    batchAnswerAutoFlags = [];
    batchQuestionInheritedFlags = [];
    batchAnswerInheritedFlags = [];
    batchQuestionAutoCount = 0;
    batchAnswerAutoCount = 0;
    batchQuestionInheritedCount = 0;
    batchAnswerInheritedCount = 0;
    updateBatchPdfStatus();

    const resetStep = () => goToStep(1);

    if (isDirty) {
        showCustomDialog({
            title: '未保存的更改',
            body: '当前题目数据尚未保存，是否放弃更改并切换？',
            confirmText: '放弃更改',
            danger: true,
            onConfirm: async () => {
                isDirty = false;
                await loadCurrentData();
                resetStep();
                if (typeof applySavedDataFilter === 'function') applySavedDataFilter();
            }
        });
        return;
    }
    await loadCurrentData();
    resetStep();
    if (typeof applySavedDataFilter === 'function') applySavedDataFilter();
}

// ========== Step Navigation ==========
function goToStep(n) {
    const isAssistant = window.currentUser && window.currentUser.role === 'assistant';
    if (isAssistant && (n === 2 || n === 3)) {
        showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
        return;
    }
    currentStep = n;
    document.querySelectorAll('.step-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `step-${n}`);
    });
    document.querySelectorAll('.step-item').forEach(item => {
        const step = parseInt(item.dataset.step, 10);
        item.classList.toggle('active', step === n);
        item.classList.toggle('completed', step < n);
    });
    document.querySelectorAll('.step-line').forEach((line, i) => {
        line.classList.toggle('active', i + 1 < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (isAssistant) {
        applyAssistantReadOnlyModeIfNeed();
    }

    if (n === 3) {
        updateAutoDetectStatus();
    }

    if (n === 4) {
        const step4BackBtn = document.getElementById('qb-step4-prev-btn');
        if (step4BackBtn) {
            step4BackBtn.style.display = batchImported ? 'inline-flex' : 'none';
        }
        requestAnimationFrame(() => {
            if (typeof resizeAllTopicTextareas === 'function') resizeAllTopicTextareas();
        });
        setTimeout(() => {
            if (typeof resizeAllTopicTextareas === 'function') resizeAllTopicTextareas();
        }, 50);
        setTimeout(() => {
            if (typeof resizeAllTopicTextareas === 'function') resizeAllTopicTextareas();
        }, 250);
    }
}

function goBack() {
    if (currentStep <= 1) return;
    // Existing-data path (no upload/mapping): back from edit goes to selector
    if (currentStep === 4 && !batchImported) {
        goToConfigStep();
        return;
    }
    // Step 4 回退到 Step 3 前检查是否有未保存修改
    if (currentStep === 4 && isDirty) {
        const targetStep = window.rgImportedActive ? 'debug' : (currentStep - 1);
        const backDesc = window.rgImportedActive ? '返回整卷框题工作台' : '返回上一步（标注题号）';
        showCustomDialog({
            title: '未保存的更改',
            body: `当前题目与知识点配置尚未保存，确定要${backDesc}吗？`,
            confirmText: '返回上一步',
            danger: true,
            onConfirm: () => {
                isDirty = false;
                goToStep(targetStep);
            }
        });
        return;
    }
    if (currentStep === 4 && window.rgImportedActive) {
        goToStep('debug');
        return;
    }
    goToStep(currentStep - 1);
}

// 回到错题本配置页面（第1步学科与专题选择）
async function goToConfigStep() {
    if (isDirty) {
        showCustomDialog({
            title: '未保存的更改',
            body: '当前题目与知识点配置尚未保存，确定要放弃更改并回到错题本配置页面吗？',
            confirmText: '确定放弃并返回',
            danger: true,
            onConfirm: async () => {
                isDirty = false;
                batchImported = false;
                window.rgImportedActive = false;
                await loadCurrentData();
                goToStep(1);
            }
        });
        return;
    }
    batchImported = false;
    window.rgImportedActive = false;
    goToStep(1);
}
window.goToConfigStep = goToConfigStep;

// 回到系统主页 (upload.html)
function goToHome() {
    if (isDirty) {
        showCustomDialog({
            title: '未保存的更改',
            body: '当前题目与知识点配置尚未保存，确定要放弃更改并回到系统主页吗？',
            confirmText: '确定放弃并回到主页',
            danger: true,
            onConfirm: () => {
                isDirty = false;
                window.location.href = 'upload.html';
            }
        });
        return;
    }
    window.location.href = 'upload.html';
}
window.goToHome = goToHome;

async function handleStepIndicatorClick(n) {
    if (n === currentStep) return;
    const isAssistant = window.currentUser && window.currentUser.role === 'assistant';
    if (isAssistant && (n === 2 || n === 3)) {
        showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
        return;
    }
    if (n < currentStep) {
        goToStep(n);
        return;
    }
    // Jumping forward: validate prerequisites
    if (n === 2) {
        if (!bankTypeSelect?.value || !subjectSelect.value || !gradeSelect.value || !tierSelect.value || !weekSelect.value) {
            showToast('请先选择题库类型、学科、年级、班层和专题');
            return;
        }
        if (getBankType() === 'variation') {
            await loadHomeworkQuestionsForVariation();
            if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
                showToast('该专题尚未录入【课后巩固】题库，无法录入举一反三，请先录入课后巩固题目', 'warn');
                return;
            }
        }
        goToStep(2);
    } else if (n === 3) {
        if (!batchExerciseFile || !batchAnswerFile) {
            showToast('请先在第2步上传题目和答案 PDF');
            return;
        }
        if (getBankType() === 'variation') {
            await loadHomeworkQuestionsForVariation();
            if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
                showToast('该专题尚未录入【课后巩固】题库，无法录入举一反三，请先录入课后巩固题目', 'warn');
                return;
            }
        }
        if (!batchQuestionThumbs || batchQuestionThumbs.length === 0) {
            goNextFromStep2();
        } else {
            goToStep(3);
        }
    } else if (n === 4) {
        if (currentQuestions.length === 0 && subjectSelect?.value && gradeSelect?.value && tierSelect?.value && weekSelect?.value) {
            await loadCurrentData();
        }
        if (currentQuestions.length === 0) {
            showToast('暂无题目，请点击下方已有题库卡片「查看 / 更改题目」或上传新题', 'info');
            return;
        }
        goToStep(4);
    }
}

window.handleStepIndicatorClick = handleStepIndicatorClick;

function updateStep1ButtonState() {
    const step1NextBtn = document.querySelector('button[onclick="goNextFromStep1()"]');
    if (!step1NextBtn) return;
    const isAssistant = Boolean(window.currentUser && window.currentUser.role === 'assistant');
    if (isAssistant) {
        step1NextBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;margin-right:4px;">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
            查看所选专题题目
        `;
        return;
    }
    if (currentQuestions && currentQuestions.length > 0) {
        step1NextBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;margin-right:4px;">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
            查看 / 修改已保存题目 (${currentQuestions.length}题)
        `;
    } else {
        step1NextBtn.innerHTML = `录入新错题本 / 下一步`;
    }
}
window.updateStep1ButtonState = updateStep1ButtonState;

async function goNextFromStep1() {
    const isAssistant = Boolean(window.currentUser && window.currentUser.role === 'assistant');
    if (!bankTypeSelect?.value || !subjectSelect.value || !gradeSelect.value || !tierSelect.value || !weekSelect.value) {
        showToast('请选择题库类型、学科、年级、班层和专题');
        return;
    }
    const step1NextBtn = document.querySelector('button[onclick="goNextFromStep1()"]');
    const origHtml = step1NextBtn ? step1NextBtn.innerHTML : '';
    if (step1NextBtn) {
        if (step1NextBtn.disabled && step1NextBtn.dataset.loading === '1') return;
        step1NextBtn.disabled = true;
        step1NextBtn.dataset.loading = '1';
        step1NextBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation: spin 0.8s linear infinite; margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
            </svg>
            <span>正在加载...</span>
        `;
    }
    try {
        await loadCurrentData();
        batchImported = false;
        if (currentQuestions.length > 0) {
            goToStep(4);
        } else {
            if (isAssistant) {
                showToast('该专题暂未录入题目，请在下方列表选择已有专题查看', 'warn');
                return;
            }
            if (getBankType() === 'variation') {
                await loadHomeworkQuestionsForVariation();
                if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
                    showCustomDialog({
                        title: '未录入课后巩固题库',
                        body: `「${subjectSelect.value} · ${gradeSelect.value} · ${tierSelect.value} · ${getTopicLabel(weekSelect.value)}」尚未录入【课后巩固】题库。<br><br>举一反三必须依赖对应课后巩固的原题和考点，请先切换题库类型录入课后巩固题目后再录入举一反三。`,
                        confirmText: '去录入课后巩固',
                        cancelText: '知道了',
                        onConfirm: () => {
                            if (bankTypeSelect) bankTypeSelect.value = 'homework';
                            updateBankTypeUi();
                            loadCurrentData();
                        }
                    });
                    return;
                }
            }
            goToStep(2);
        }
    } finally {
        if (step1NextBtn) {
            step1NextBtn.disabled = false;
            delete step1NextBtn.dataset.loading;
            step1NextBtn.innerHTML = origHtml || '录入新错题本 / 下一步';
        }
    }
}

// ========== 举一反三 (Variation) 关联原题管理 ==========
let homeworkQuestionsForVariation = [];

async function loadHomeworkQuestionsForVariation() {
    const year = yearSelect ? parseInt(yearSelect.value, 10) : 2026;
    const season = seasonSelect ? seasonSelect.value : '春';
    const subject = subjectSelect ? subjectSelect.value : '';
    const grade = gradeSelect ? gradeSelect.value : '';
    const tier = tierSelect ? tierSelect.value : '';
    const week = weekSelect ? weekSelect.value : '';

    if (!subject || !grade || !tier || !week) {
        homeworkQuestionsForVariation = [];
        return;
    }

    try {
        const res = await apiGet('get', {
            year, season, bankType: 'homework', subject, grade, tier, week
        });
        if (res && res.success && res.data && Array.isArray(res.data.questions) && res.data.questions.length > 0) {
            homeworkQuestionsForVariation = res.data.questions;
            // 后台异步预热课后原题缩略图，供悬停原题即时预览
            homeworkQuestionsForVariation.forEach(q => {
                if (q.exercisePdf && q.exercisePdf.url && !q.exercisePdf.thumb) {
                    ensurePdfThumbnail(q.exercisePdf).catch(() => {});
                }
            });
        } else {
            homeworkQuestionsForVariation = [];
        }
    } catch (e) {
        console.warn('获取课后巩固题库失败:', e);
        homeworkQuestionsForVariation = [];
    }
}

function formatCompactNumList(nums) {
    const arr = Array.from(new Set((nums || []).map(n => parseInt(n, 10)).filter(n => n > 0))).sort((a, b) => a - b);
    if (arr.length === 0) return '';
    if (arr.length === 1) return String(arr[0]);
    const parts = [];
    let start = arr[0];
    let prev = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] === prev + 1) {
            prev = arr[i];
        } else {
            parts.push(start === prev ? String(start) : (prev - start >= 2 ? `${start}~${prev}` : `${start}、${prev}`));
            start = prev = arr[i];
        }
    }
    parts.push(start === prev ? String(start) : (prev - start >= 2 ? `${start}~${prev}` : `${start}、${prev}`));
    return parts.join('、');
}

function getConsolidationBuckets() {
    if (!Array.isArray(homeworkQuestionsForVariation) || homeworkQuestionsForVariation.length === 0) {
        return [];
    }
    const bucketMap = new Map();
    const order = [];
    homeworkQuestionsForVariation.forEach((q, idx) => {
        const qNum = parseInt(q.id || (idx + 1), 10);
        if (!qNum || qNum <= 0) return;
        const meta = q.questionMeta || null;
        let key = `single:${qNum}`;
        let groupNums = [qNum];

        if (meta && Array.isArray(meta.groupNums) && meta.groupNums.length > 1) {
            groupNums = Array.from(new Set(meta.groupNums.map(n => parseInt(n, 10)).filter(n => n > 0))).sort((a, b) => a - b);
            key = `group:${groupNums.join(',')}`;
        } else if ((!meta || meta.mode !== 'region_crop') && q.exercisePdf && q.exercisePdf.url) {
            key = `url:${q.exercisePdf.url}`;
        }

        if (!bucketMap.has(key)) {
            const b = {
                parentNum: groupNums[0],
                nums: [...groupNums],
                topic: (q.topic || '').trim(),
                exercisePdf: q.exercisePdf || null
            };
            bucketMap.set(key, b);
            order.push(b);
        } else {
            const existing = bucketMap.get(key);
            if (!existing.nums.includes(qNum)) {
                existing.nums.push(qNum);
                existing.nums.sort((a, b) => a - b);
                existing.parentNum = existing.nums[0];
            }
            if (!existing.topic && q.topic) existing.topic = String(q.topic).trim();
            if (!existing.exercisePdf && q.exercisePdf) existing.exercisePdf = q.exercisePdf;
        }
    });

    return order.map(b => ({
        ...b,
        label: b.nums.length > 1 ? `第${formatCompactNumList(b.nums)}题` : `第${b.parentNum}题`
    }));
}
const getVariationBucketList = getConsolidationBuckets;

function recalcVariationSubNums(questions = currentQuestions) {
    if (getBankType() !== 'variation' || !Array.isArray(questions)) return;
    const counts = {};
    questions.forEach((q, idx) => {
        q.id = idx + 1;
        if (Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0) {
            q.parentQuestionNums = Array.from(new Set(q.parentQuestionNums.map(n => parseInt(n, 10)).filter(n => n > 0))).sort((a, b) => a - b);
            q.parentQuestionNum = q.parentQuestionNums[0];
        } else {
            const pNum = parseInt(q.parentQuestionNum, 10) || 1;
            q.parentQuestionNum = pNum;
            q.parentQuestionNums = [pNum];
        }
        const pKey = q.parentQuestionNums.join(',');
        counts[pKey] = (counts[pKey] || 0) + 1;
        q.subNum = counts[pKey];
    });
}

function onVariationParentChange(index, parentNum) {
    if (index < 0 || index >= currentQuestions.length) return;
    const q = currentQuestions[index];
    const pNum = parseInt(parentNum, 10);
    if (!pNum || pNum <= 0) return;

    let pNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
        ? [...q.parentQuestionNums]
        : [parseInt(q.parentQuestionNum || 1, 10)];

    const bucket = getConsolidationBuckets().find(b => (b.nums || [b.parentNum]).includes(pNum));
    const bucketNums = bucket && Array.isArray(bucket.nums) && bucket.nums.length > 0 ? bucket.nums : [pNum];
    const hwQ = (homeworkQuestionsForVariation || []).find(item => Number(item.id) === pNum);
    const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
    const isSameTopic = hwQ && cleanTopicStr(hwQ.topic) === cleanTopicStr(q.topic);

    const allSelected = bucketNums.every(n => pNums.includes(n));
    if (allSelected) {
        const remaining = pNums.filter(n => !bucketNums.includes(n));
        if (remaining.length > 0) {
            pNums = remaining;
        } else {
            return;
        }
    } else {
        if (isSameTopic && q.topic) {
            bucketNums.forEach(n => {
                if (!pNums.includes(n)) pNums.push(n);
            });
        } else {
            pNums = [...bucketNums];
            if (hwQ && hwQ.topic) {
                q.topic = hwQ.topic.trim();
            }
        }
    }

    pNums = Array.from(new Set(pNums)).sort((a, b) => a - b);
    q.parentQuestionNums = pNums;
    q.parentQuestionNum = pNums[0];

    if (!q.topic && hwQ && hwQ.topic) {
        q.topic = hwQ.topic.trim();
    }

    recalcVariationSubNums(currentQuestions);
    isDirty = true;
    renderQuestionList();
    updateStatus();
}
window.onVariationParentChange = onVariationParentChange;

function onVariationMergeSameTopic(index) {
    if (index < 0 || index >= currentQuestions.length) return;
    const q = currentQuestions[index];
    const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
    const curTopicClean = cleanTopicStr(q.topic);
    if (!curTopicClean) return;

    let pNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
        ? [...q.parentQuestionNums]
        : [parseInt(q.parentQuestionNum || 1, 10)];

    (homeworkQuestionsForVariation || []).forEach(hw => {
        const p = parseInt(hw.id, 10);
        if (p > 0 && cleanTopicStr(hw.topic) === curTopicClean) {
            if (!pNums.includes(p)) {
                pNums.push(p);
            }
        }
    });

    pNums = Array.from(new Set(pNums)).sort((a, b) => a - b);
    q.parentQuestionNums = pNums;
    q.parentQuestionNum = pNums[0];

    recalcVariationSubNums(currentQuestions);
    isDirty = true;
    renderQuestionList();
    updateStatus();
    showToast(`已关联同考点所有原题（第 ${pNums.join('、')} 题）`, 'success');
}
window.onVariationMergeSameTopic = onVariationMergeSameTopic;

function mergeAllSameTopicVariations() {
    if (getBankType() !== 'variation' || !Array.isArray(currentQuestions) || currentQuestions.length === 0) return;
    const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
    let mergedCount = 0;

    currentQuestions.forEach(q => {
        const curTopic = cleanTopicStr(q.topic);
        if (!curTopic) return;
        const matchedHwNums = (homeworkQuestionsForVariation || [])
            .filter(hw => cleanTopicStr(hw.topic) === curTopic)
            .map(hw => parseInt(hw.id, 10))
            .filter(n => n > 0);

        if (matchedHwNums.length > 1) {
            const currentNums = Array.isArray(q.parentQuestionNums) ? q.parentQuestionNums : [parseInt(q.parentQuestionNum || 1, 10)];
            const newNums = Array.from(new Set(currentNums.concat(matchedHwNums))).sort((a, b) => a - b);
            if (newNums.length > currentNums.length) {
                q.parentQuestionNums = newNums;
                q.parentQuestionNum = newNums[0];
                mergedCount++;
            }
        }
    });

    if (mergedCount > 0) {
        recalcVariationSubNums(currentQuestions);
        isDirty = true;
        renderQuestionList();
        updateStatus();
        showToast(`已为 ${mergedCount} 道变式题自动扩展关联同考点原题`, 'success');
    } else {
        showToast('当前变式题已完整关联同考点原题', 'info');
    }
}
window.mergeAllSameTopicVariations = mergeAllSameTopicVariations;
window.onVariationParentChange = onVariationParentChange;

async function onHoverHomeworkPreview() {
    // 已关闭悬停预览，点击可直接打开查看
}
window.onHoverHomeworkPreview = onHoverHomeworkPreview;

function previewHomeworkQuestion(parentNum, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (typeof hideHoverPopover === "function") hideHoverPopover();
    const hwQ = (homeworkQuestionsForVariation || []).find(q => Number(q.id) === Number(parentNum));
    const exPdf = hwQ && hwQ.exercisePdf ? hwQ.exercisePdf : null;
    if (!exPdf || !exPdf.url) {
        showToast(`课后第 ${parentNum} 题暂无原题 PDF 文件`);
        return;
    }
    const topic = hwQ && hwQ.topic ? ` (${hwQ.topic})` : "";
    const title = `课后第 ${parentNum} 题 · 原题${topic}`;
    if (hwQ && hwQ.questionMeta && hwQ.questionMeta.mode === 'region_crop' && Array.isArray(hwQ.questionMeta.regions) && hwQ.questionMeta.regions.length > 0) {
        previewSlicedRegions(exPdf.url, hwQ.questionMeta.regions, title, exPdf.name);
        return;
    }
    previewPdf(exPdf.url, title);
}
window.previewHomeworkQuestion = previewHomeworkQuestion;

async function goNextFromStep2() {
    if (!batchExerciseFile || !batchAnswerFile) {
        showToast("请先上传题目 PDF 和答案 PDF");
        return;
    }
    if (getBankType() === "variation") {
        await loadHomeworkQuestionsForVariation();
        if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
            showToast("该专题尚未录入【课后巩固】题库，无法录入举一反三，请先录入课后巩固题目", "warn");
            return;
        }
    }
    const nextBtn = document.getElementById("step2-next-btn");
    const origNextHtml = nextBtn ? nextBtn.innerHTML : '';
    if (nextBtn) {
        if (nextBtn.disabled && nextBtn.dataset.loading === '1') return;
        nextBtn.disabled = true;
        nextBtn.dataset.loading = '1';
        nextBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation: spin 0.8s linear infinite; margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
            </svg>
            <span>正在解析PDF页面...</span>
        `;
    }
    try {
        const ok = await loadBatchPreviews();
        if (!ok) return;
        batchImported = false;
        buildDefaultLabels();
        renderAnnotationList();
        updateAnnotationStatus();
        goToStep(3);
    } finally {
        if (nextBtn) {
            nextBtn.disabled = false;
            delete nextBtn.dataset.loading;
            nextBtn.innerHTML = origNextHtml || '下一步';
        }
    }
}

// ========== Page Annotation (Step 3) ==========
let currentMappingView = 'split'; // 强制左右分栏对照
let currentThumbSize = 'large'; // 预览大小强制为大

async function renderPdfToThumbs(file) {
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF.js 组件未正确加载，请刷新页面后重试');
    }
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/libs/pdfjs/pdf.worker.min.js';
    }
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    // 移动端 OOM 防护：单文件页数上限（每页约 900~1600px 高清缩略图常驻内存），超出请拆分专题分批录入
    const MAX_BATCH_PDF_PAGES = 60;
    if (pdf.numPages > MAX_BATCH_PDF_PAGES) {
        if (typeof pdf.destroy === 'function') { try { await pdf.destroy(); } catch (_) {} }
        throw new Error(`PDF 共 ${pdf.numPages} 页，超出单次上限 ${MAX_BATCH_PDF_PAGES} 页，请拆分为多个专题分批录入`);
    }
    const thumbs = [];
    const detectedLabels = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        // 轻量高清缩略图：宽度限制在 600px（卡片宽 260~360px，2x 视网膜屏细腻且不爆显存），质量 0.72
        const targetWidth = Math.min(600, Math.max(360, Math.floor(base.width)));
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        // 在渲染缩略图的同时读取文字坐标，自动识别页面左上角印刷题号。
        // 识别失败不影响预览；该页会保留默认序号，老师可继续手动修改。
        let detectedNumber = null;
        try {
            const textContent = await page.getTextContent();
            detectedNumber = detectQuestionNumberFromPageText(
                textContent && textContent.items,
                base.width,
                base.height,
                i
            );
        } catch (textErr) {
            console.warn('PDF 题号自动识别失败，保留手动填写:', textErr);
        }
        detectedLabels.push(detectedNumber);

        thumbs.push(canvas.toDataURL('image/jpeg', 0.72));
        page.cleanup();
    }
    if (typeof pdf.destroy === 'function') { try { await pdf.destroy(); } catch (_) {} }
    return { pageCount: pdf.numPages, thumbs, detectedLabels };
}

async function loadBatchPreviews() {
    try {
        showToast('正在生成页面预览并自动识别题号...');
        const [q, a] = await Promise.all([
            renderPdfToThumbs(batchExerciseFile),
            renderPdfToThumbs(batchAnswerFile)
        ]);
        batchQuestionPageCount = q.pageCount;
        batchAnswerPageCount = a.pageCount;
        batchQuestionThumbs = q.thumbs;
        batchAnswerThumbs = a.thumbs;
        batchQuestionDetectedLabels = q.detectedLabels || [];
        batchAnswerDetectedLabels = a.detectedLabels || [];
        return true;
    } catch (e) {
        console.error('PDF 预览生成失败', e);
        showToast('PDF 处理失败，请确认文件有效');
        return false;
    }
}

function buildDefaultLabels() {
    batchQuestionLabels = [];
    batchQuestionAutoFlags = [];
    batchQuestionInheritedFlags = [];
    batchQuestionAutoCount = 0;
    batchQuestionInheritedCount = 0;
    batchPageBoxes = Array.from({ length: batchQuestionPageCount }, () => []);
    batchStemBoxes = Array.from({ length: batchQuestionPageCount }, () => []);
    for (let i = 0; i < batchQuestionPageCount; i++) {
        const detected = batchQuestionDetectedLabels[i];
        const hasDetected = Number.isInteger(detected) && detected > 0;
        if (hasDetected) {
            batchQuestionLabels.push(detected);
            batchQuestionAutoFlags.push(true);
            batchQuestionInheritedFlags.push(false);
            batchQuestionAutoCount++;
        } else if (i > 0 && Number.isInteger(batchQuestionLabels[i - 1]) && batchQuestionLabels[i - 1] > 0) {
            // 一题跨多页时，续页通常没有重复印刷题号；沿用上一页题号，避免被默认页序拆成下一题。
            batchQuestionLabels.push(batchQuestionLabels[i - 1]);
            batchQuestionAutoFlags.push(false);
            batchQuestionInheritedFlags.push(true);
            batchQuestionInheritedCount++;
        } else {
            batchQuestionLabels.push(i + 1);
            batchQuestionAutoFlags.push(false);
            batchQuestionInheritedFlags.push(false);
        }
    }
    batchAnswerLabels = [];
    batchAnswerAutoFlags = [];
    batchAnswerInheritedFlags = [];
    batchAnswerAutoCount = 0;
    batchAnswerInheritedCount = 0;
    batchAnswerPageBoxes = Array.from({ length: batchAnswerPageCount }, () => []);
    for (let i = 0; i < batchAnswerPageCount; i++) {
        const detected = batchAnswerDetectedLabels[i];
        const hasDetected = Number.isInteger(detected) && detected > 0;
        if (hasDetected) {
            batchAnswerLabels.push(detected);
            batchAnswerAutoFlags.push(true);
            batchAnswerInheritedFlags.push(false);
            batchAnswerAutoCount++;
        } else if (i > 0 && Number.isInteger(batchAnswerLabels[i - 1]) && batchAnswerLabels[i - 1] > 0) {
            batchAnswerLabels.push(batchAnswerLabels[i - 1]);
            batchAnswerAutoFlags.push(false);
            batchAnswerInheritedFlags.push(true);
            batchAnswerInheritedCount++;
        } else {
            batchAnswerLabels.push(i + 1);
            batchAnswerAutoFlags.push(false);
            batchAnswerInheritedFlags.push(false);
        }
    }
    lastLabelState = null;
    const undoBtn = document.getElementById('undo-cascade-btn');
    if (undoBtn) undoBtn.style.display = 'none';
    updateAutoDetectStatus();
}

/**
 * 获取具有相同起始题号的所有题目/答案页索引（升序），题目与答案完全独立
 */
function getGroupPagesByStartLabel(startLabel, kind = 'q') {
    const target = parseInt(startLabel, 10);
    if (!target || target <= 0) return [];
    const labels = kind === 'a' ? batchAnswerLabels : batchQuestionLabels;
    const pages = [];
    for (let i = 0; i < labels.length; i++) {
        if (parseInt(labels[i], 10) === target) {
            pages.push(i);
        }
    }
    return pages;
}

/**
 * 获取指定起始题号对应的大题框选与题号区间信息（kind: 'q' 题目 | 'a' 答案，完全独立不关联）
 */
function getGroupBoxesInfo(startLabel, kind = 'q') {
    const startNum = parseInt(startLabel, 10) || 1;
    const pages = getGroupPagesByStartLabel(startNum, kind);
    const allBoxes = kind === 'a' ? batchAnswerPageBoxes : batchPageBoxes;
    const boxesWithMeta = [];
    const stemBoxesWithMeta = [];
    pages.forEach((pIdx, pageOffset) => {
        const pBoxes = Array.isArray(allBoxes[pIdx]) ? allBoxes[pIdx] : [];
        pBoxes.forEach((b, bIdx) => {
            const qNum = startNum + boxesWithMeta.length;
            boxesWithMeta.push({
                num: qNum,
                pageIndex: pIdx,
                pageOffset: pageOffset,
                localBoxIndex: bIdx,
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h
            });
        });
        if (kind === 'q') {
            const sBoxes = Array.isArray(batchStemBoxes[pIdx]) ? batchStemBoxes[pIdx] : [];
            sBoxes.forEach((sb, sbIdx) => {
                stemBoxesWithMeta.push({
                    pageIndex: pIdx,
                    pageOffset: pageOffset,
                    localBoxIndex: sbIdx,
                    x: sb.x,
                    y: sb.y,
                    w: sb.w,
                    h: sb.h
                });
            });
        }
    });
    const count = boxesWithMeta.length;
    const isBigQuestion = count > 0 || stemBoxesWithMeta.length > 0;
    const span = count > 0 ? count : 1;
    const endNum = startNum + span - 1;
    const groupNums = [];
    for (let k = startNum; k <= endNum; k++) {
        groupNums.push(k);
    }
    return {
        isBigQuestion,
        startNum,
        endNum,
        count,
        span,
        groupNums,
        pages,
        boxesWithMeta,
        stemBoxesWithMeta
    };
}

/**
 * 获取当前所有题目页覆盖的完整题号集合（含大题展开后的各小问题号）
 */
function getAllCoveredQuestionNumsSet() {
    const covered = new Set();
    const visitedLabels = new Set();
    for (let i = 0; i < batchQuestionLabels.length; i++) {
        const lbl = parseInt(batchQuestionLabels[i], 10);
        if (!lbl || lbl <= 0 || visitedLabels.has(lbl)) continue;
        visitedLabels.add(lbl);
        const info = getGroupBoxesInfo(lbl);
        info.groupNums.forEach(n => covered.add(n));
    }
    return covered;
}

/**
 * 判断答案页题号是否已与题目页（或某道大题的任意小问）对齐，并返回所属大题信息
 */
function matchAnswerLabelToQuestionGroup(ansLabel) {
    const num = parseInt(ansLabel, 10);
    if (!num || num <= 0) return { isPaired: false, groupInfo: null };
    const visited = new Set();
    for (let i = 0; i < batchQuestionLabels.length; i++) {
        const lbl = parseInt(batchQuestionLabels[i], 10);
        if (!lbl || visited.has(lbl)) continue;
        visited.add(lbl);
        const info = getGroupBoxesInfo(lbl);
        if (info.groupNums.includes(num)) {
            return { isPaired: true, groupInfo: info };
        }
    }
    return { isPaired: false, groupInfo: null };
}

/**
 * 当某页框选小问数量变化时，自动重算该大题之后所有同类型页（题目或答案）的起始题号
 */
function cascadeQuestionLabelsAfterGroup(anchorPageIdx, kind = 'q') {
    const labels = kind === 'a' ? batchAnswerLabels : batchQuestionLabels;
    const boxesArr = kind === 'a' ? batchAnswerPageBoxes : batchPageBoxes;
    if (!autoCascadeNumbers || anchorPageIdx < 0 || anchorPageIdx >= labels.length) return;
    const startLbl = parseInt(labels[anchorPageIdx], 10) || 1;
    const groupPages = getGroupPagesByStartLabel(startLbl, kind);
    const lastPageOfGroup = groupPages.length > 0 ? Math.max(...groupPages) : anchorPageIdx;
    const groupInfo = getGroupBoxesInfo(startLbl, kind);

    let nextExpectedStart = groupInfo.endNum + 1;
    let i = lastPageOfGroup + 1;
    while (i < labels.length) {
        const oldLbl = parseInt(labels[i], 10) || 1;
        // 找出原本与第 i 页共享同一题号的连续续页
        let j = i;
        while (j + 1 < labels.length && parseInt(labels[j + 1], 10) === oldLbl) {
            j++;
        }
        // 统计这一组页面上的框选总数
        let boxCnt = 0;
        for (let k = i; k <= j; k++) {
            boxCnt += (Array.isArray(boxesArr[k]) ? boxesArr[k].length : 0);
        }
        const span = boxCnt > 0 ? boxCnt : 1;
        for (let k = i; k <= j; k++) {
            labels[k] = nextExpectedStart;
            markPageLabelManual(kind, k);
        }
        nextExpectedStart += span;
        i = j + 1;
    }
}

function updateAutoDetectStatus() {
    const el = document.getElementById('auto-detect-status');
    if (!el) return;
    const qTotal = batchQuestionPageCount || 0;
    const aTotal = batchAnswerPageCount || 0;
    const total = qTotal + aTotal;
    if (total === 0) {
        el.style.display = 'none';
        return;
    }
    const autoTotal = batchQuestionAutoCount + batchAnswerAutoCount;
    const inheritedTotal = batchQuestionInheritedCount + batchAnswerInheritedCount;
    const remainingAuto = batchQuestionAutoFlags.filter(Boolean).length + batchAnswerAutoFlags.filter(Boolean).length;
    const remainingInherited = batchQuestionInheritedFlags.filter(Boolean).length + batchAnswerInheritedFlags.filter(Boolean).length;
    const manualTotal = Math.max(0, autoTotal + inheritedTotal - remainingAuto - remainingInherited);
    el.style.display = 'inline-flex';
    if (autoTotal === 0 && inheritedTotal === 0) {
        el.className = 'qb-auto-status no-match';
        el.textContent = '未识别到题号，请手动填写';
        el.title = 'PDF 中没有找到可识别的印刷题号，已保留默认序号；可直接在每页题号框中修改';
    } else if (autoTotal === 0) {
        el.className = 'qb-auto-status no-match';
        el.textContent = '未识别到印刷题号，已沿用上页';
        el.title = `题目 ${batchQuestionInheritedCount}/${qTotal} 页、答案 ${batchAnswerInheritedCount}/${aTotal} 页已沿用上页题号；请核对续页是否属于同一道题` +
            (manualTotal > 0 ? `；其中 ${manualTotal} 页已手动修改` : '');
    } else {
        el.className = 'qb-auto-status';
        el.textContent = `已自动识别 ${autoTotal}/${total} 页` + (inheritedTotal > 0 ? ` · ${inheritedTotal} 页沿用上页` : '');
        el.title = `题目 ${batchQuestionAutoCount}/${qTotal} 页自动识别${batchQuestionInheritedCount ? `，${batchQuestionInheritedCount} 页沿用上页` : ''}；` +
            `答案 ${batchAnswerAutoCount}/${aTotal} 页自动识别${batchAnswerInheritedCount ? `，${batchAnswerInheritedCount} 页沿用上页` : ''}；` +
            '识别结果可直接修改' + (manualTotal > 0 ? `；其中 ${manualTotal} 页已手动修改` : '');
    }
}

function setMappingView(view = 'split') {
    currentMappingView = 'split';
    const container = document.getElementById('mapping-sections-container');
    if (container) {
        container.className = 'mapping-sections-container view-split';
    }
}

function setThumbSize(size = 'large') {
    currentThumbSize = 'large';
    const qGrid = document.getElementById('qpdf-page-grid');
    const aGrid = document.getElementById('apdf-page-grid');
    [qGrid, aGrid].forEach(grid => {
        if (!grid) return;
        grid.className = 'page-grid size-large';
    });
}

function autoNumberPages(kind) {
    lastLabelState = null;
    const undoBtn = document.getElementById('undo-cascade-btn');
    if (undoBtn) undoBtn.style.display = 'none';

    if (kind === 'q') {
        batchQuestionLabels = [];
        batchQuestionAutoFlags = [];
        batchQuestionInheritedFlags = [];
        batchQuestionAutoCount = 0;
        batchQuestionInheritedCount = 0;
        let nextNum = 1;
        for (let i = 0; i < batchQuestionPageCount; i++) {
            batchQuestionLabels.push(nextNum);
            batchQuestionAutoFlags.push(false);
            batchQuestionInheritedFlags.push(false);
            const pBoxes = Array.isArray(batchPageBoxes[i]) ? batchPageBoxes[i].length : 0;
            nextNum += (pBoxes > 0 ? pBoxes : 1);
        }
        renderAnnotationList();
        updateAnnotationStatus();
        showToast(`已为 ${batchQuestionPageCount} 页题目按顺序编号`);
    } else if (kind === 'a') {
        batchAnswerLabels = [];
        batchAnswerAutoFlags = [];
        batchAnswerInheritedFlags = [];
        batchAnswerAutoCount = 0;
        batchAnswerInheritedCount = 0;
        for (let i = 1; i <= batchAnswerPageCount; i++) {
            batchAnswerLabels.push(i);
            batchAnswerAutoFlags.push(false);
            batchAnswerInheritedFlags.push(false);
        }
        renderAnnotationList();
        updateAnnotationStatus();
        showToast(`已为 ${batchAnswerPageCount} 页答案按 1~${batchAnswerPageCount} 顺序编号`);
    }
}

function syncAnswerToQuestionNumbers() {
    if (!batchQuestionLabels || batchQuestionLabels.length === 0) {
        showToast('题目页尚未标注题号');
        return;
    }
    const minCount = Math.min(batchAnswerPageCount, batchQuestionLabels.length);
    for (let i = 0; i < minCount; i++) {
        batchAnswerLabels[i] = batchQuestionLabels[i];
        batchAnswerAutoFlags[i] = false;
        batchAnswerInheritedFlags[i] = false;
    }
    batchAnswerAutoCount = 0;
    batchAnswerInheritedCount = 0;
    renderAnnotationList();
    updateAnnotationStatus();
    showToast(`已将前 ${minCount} 页答案题号快速对齐题目`);
}

function renderAnnotationList() {
    const qCount = document.getElementById('qpdf-page-count');
    const aCount = document.getElementById('apdf-page-count');
    const tabQ = document.getElementById('tab-q-count');
    const tabA = document.getElementById('tab-a-count');
    if (qCount) qCount.textContent = batchQuestionPageCount;
    if (aCount) aCount.textContent = batchAnswerPageCount;
    if (tabQ) tabQ.textContent = batchQuestionPageCount;
    if (tabA) tabA.textContent = batchAnswerPageCount;

    renderPageGrid('qpdf-page-grid', batchQuestionThumbs, batchQuestionLabels, 'q');
    renderPageGrid('apdf-page-grid', batchAnswerThumbs, batchAnswerLabels, 'a');
    setThumbSize(currentThumbSize);
    updateAutoDetectStatus();
}

function renderPageGrid(containerId, thumbs, labels, kind) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';

    const autoFlags = kind === 'q' ? batchQuestionAutoFlags : batchAnswerAutoFlags;
    const inheritedFlags = kind === 'q' ? batchQuestionInheritedFlags : batchAnswerInheritedFlags;

    thumbs.forEach((thumb, i) => {
        const card = document.createElement('div');
        const currNum = labels[i];
        let isPaired = false;
        let groupInfo = null;
        let pageBoxesMeta = [];
        let pageStemMeta = [];
        let matchedQGroupInfo = null;

        if (kind === 'q') {
            groupInfo = getGroupBoxesInfo(currNum, 'q');
            isPaired = Array.isArray(batchAnswerLabels) && batchAnswerLabels.some((aNum, aIdx) => {
                const aInfo = getGroupBoxesInfo(aNum, 'a');
                return aInfo.groupNums.some(n => groupInfo.groupNums.includes(n));
            });
            pageBoxesMeta = groupInfo.boxesWithMeta.filter(b => b.pageIndex === i);
            pageStemMeta = (groupInfo.stemBoxesWithMeta || []).filter(sb => sb.pageIndex === i);
        } else {
            groupInfo = getGroupBoxesInfo(currNum, 'a');
            pageBoxesMeta = groupInfo.boxesWithMeta.filter(b => b.pageIndex === i);
            const matchRes = matchAnswerLabelToQuestionGroup(currNum);
            isPaired = matchRes.isPaired || (groupInfo.isBigQuestion && groupInfo.groupNums.some(n => matchAnswerLabelToQuestionGroup(n).isPaired));
            matchedQGroupInfo = matchRes.groupInfo;
        }

        const isAuto = Boolean(autoFlags && autoFlags[i]);
        const isInherited = Boolean(inheritedFlags && inheritedFlags[i]);
        card.className = `page-card page-card-${kind}${isPaired ? ' paired' : ''}`;
        card.dataset.pageIndex = String(i);

        const stemOverlayHtml = pageStemMeta.map(sb => `
            <div class="page-thumb-mini-box stem-box" style="left:${(sb.x * 100).toFixed(2)}%;top:${(sb.y * 100).toFixed(2)}%;width:${(sb.w * 100).toFixed(2)}%;height:${(sb.h * 100).toFixed(2)}%;">
                <span class="page-thumb-mini-tag compact">原文</span>
            </div>
        `).join('');

        const miniBoxesHtml = (pageBoxesMeta.length > 0 || pageStemMeta.length > 0)
            ? `<div class="page-thumb-box-overlay">${stemOverlayHtml}${pageBoxesMeta.map(b => {
                const compact = isBoxCrowded(b, pageBoxesMeta, true);
                return `
                <div class="page-thumb-mini-box${kind === 'a' ? ' answer-box' : ''}" style="left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%;">
                    <span class="page-thumb-mini-tag${compact ? ' compact' : ''}">${compact ? b.num : `第${b.num}题`}</span>
                </div>`;
            }).join('')}</div>`
            : '';

        const rangePillHtml = (groupInfo && groupInfo.isBigQuestion)
            ? `<span class="page-range-pill" title="本大题包含第 ${groupInfo.startNum} ~ ${groupInfo.endNum} 题（共 ${groupInfo.count} 问）">${groupInfo.startNum} ~ ${groupInfo.endNum} (${groupInfo.count}问)</span>`
            : (kind === 'a' && matchedQGroupInfo && matchedQGroupInfo.isBigQuestion
                ? `<span class="page-range-pill" title="对应题目第 ${matchedQGroupInfo.startNum} ~ ${matchedQGroupInfo.endNum} 题">${matchedQGroupInfo.startNum} ~ ${matchedQGroupInfo.endNum} 解析</span>`
                : '');

        const bigQBtnHtml = `<button type="button" class="page-bigq-btn ${groupInfo && groupInfo.isBigQuestion ? 'active' : ''}"
                       onclick="openBigQuestionBoxMode(${i}, event, '${kind}')"
                       title="${kind === 'a' ? '将本页答案设为大题，并在图上拉框标出各小问答案位置与题号' : '将本页设为大题，并在图上拉框标出各小问位置与题号'}">
                   <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                       <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                       <path d="M9 3v18M3 9h6M3 15h6"></path>
                   </svg>
                   <span>${groupInfo && groupInfo.isBigQuestion ? `已框 ${groupInfo.count} 问 (${groupInfo.startNum}~${groupInfo.endNum})` : '设为大题'}</span>
               </button>`;

        card.innerHTML = `
            <div class="page-thumb-wrap" onclick="openPageLightbox('${kind}', ${i})" title="点击全屏放大查看">
                <div class="page-thumb-stage">
                    <img class="page-thumb" src="${thumb}" alt="第 ${i + 1} 页" loading="lazy">
                    ${miniBoxesHtml}
                </div>
                <div class="page-zoom-badge">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        <line x1="11" y1="8" x2="11" y2="14"></line>
                        <line x1="8" y1="11" x2="14" y2="11"></line>
                    </svg>
                    <span>点击放大</span>
                </div>
                <div class="page-stepper-center" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" title="设置此页起始题号">
                    <span class="stepper-label">${groupInfo && groupInfo.isBigQuestion ? '起始' : '题号'}</span>
                    <button type="button" class="stepper-btn stepper-btn-minus" onclick="stepPageLabel('${kind}', ${i}, -1, event)" title="题号减 1" aria-label="减少题号">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <input type="number" class="page-label-input${isAuto ? ' auto-detected' : ''}${isInherited ? ' inherited-detected' : ''}" min="1" step="1"
                           value="${currNum}" data-kind="${kind}" data-index="${i}"
                           title="${isAuto ? '题号由 PDF 自动识别，可直接修改' : (isInherited ? '此页没有印刷题号，已沿用上一页题号；请核对是否属于同一道题' : '请手动填写此页对应的作业题号')}"
                           onwheel="this.blur()"
                           onclick="event.stopPropagation()"
                           onkeydown="if(event.key==='Enter') this.blur(); event.stopPropagation();"
                           onchange="onPageLabelChange('${kind}', ${i}, this.value)">
                    <button type="button" class="stepper-btn stepper-btn-plus" onclick="stepPageLabel('${kind}', ${i}, 1, event)" title="题号加 1" aria-label="增加题号">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    ${rangePillHtml}
                </div>
            </div>
            <div class="page-card-footer">
                <span class="page-no-tag">第 ${i + 1} 页 ${isAuto ? '<span class="page-auto-indicator" title="题号由 PDF 文本自动识别，可手动修改">自动</span>' : (isInherited ? '<span class="page-inherited-indicator" title="此页没有印刷题号，已沿用上一页题号；请核对是否属于同一道题">沿用上页</span>' : '')} ${isPaired ? '<span class="page-paired-indicator" title="已与对应' + (kind === 'q' ? '答案' : '题目') + '匹配"></span>' : ''}</span>
                <div class="page-card-footer-actions">
                    ${bigQBtnHtml}
                    <span class="page-status-badge ${isPaired ? 'paired' : ''}">${isPaired ? '已对齐' : '未对齐'}</span>
                </div>
            </div>
        `;
        el.appendChild(card);
    });
}

// ========== High-Definition Page Lightbox & 大题框选小问交互 ==========
let lightboxKind = 'q';
let lightboxIndex = 0;
let lightboxZoom = 1;
let lightboxBoxMode = false;
// 框选目标: 'stem'（原文区） | 'subq'（小问题号）
let lightboxDrawTarget = 'subq';
// 单栏试卷：松手自动左右通栏打满
let lightboxFullWidthSnap = true;
// Step 4 独立重框模式上下文: { startNum, groupIndices, pageThumbs, pageBoxes, stemBoxes }
let lightboxStep4Context = null;

function setLightboxDrawTarget(target) {
    if (target === 'stem' && lightboxKind === 'a' && !lightboxStep4Context) {
        lightboxDrawTarget = 'subq';
    } else {
        lightboxDrawTarget = target === 'stem' ? 'stem' : 'subq';
    }
    renderLightboxBoxesOverlay();
}
window.setLightboxDrawTarget = setLightboxDrawTarget;

function toggleLightboxFullWidthSnap() {
    lightboxFullWidthSnap = !lightboxFullWidthSnap;
    const btn = document.getElementById('lightbox-fullwidth-btn');
    if (btn) {
        btn.classList.toggle('active', lightboxFullWidthSnap);
        const span = btn.querySelector('span');
        if (span) span.textContent = lightboxFullWidthSnap ? '横向通栏: 开' : '横向通栏: 关';
    }
    showToast(lightboxFullWidthSnap ? '已开启：拉框松手自动左右打满' : '已关闭：按实际拖拽宽度框选');
}
window.toggleLightboxFullWidthSnap = toggleLightboxFullWidthSnap;

function openPageLightbox(kind, index, enterBoxMode = false) {
    lightboxStep4Context = null;
    lightboxKind = kind;
    lightboxIndex = index;
    lightboxZoom = 1;
    lightboxBoxMode = Boolean(enterBoxMode);

    if (lightboxBoxMode && kind === 'q') {
        const currStart = parseInt(batchQuestionLabels[index], 10) || 1;
        const summary = getGroupBoxesInfo(currStart, 'q');
        lightboxDrawTarget = (summary.stemBoxesWithMeta && summary.stemBoxesWithMeta.length > 0) ? 'subq' : 'stem';
    } else {
        lightboxDrawTarget = 'subq';
    }

    const dialog = document.getElementById('page-lightbox-dialog');
    if (!dialog) return;
    initLightboxBoxDrawingEvents();
    updateLightboxContent();
    dialog.classList.add('active');
}

function openBigQuestionBoxMode(pageIndex, event, kind = 'q') {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const targetKind = kind === 'a' ? 'a' : 'q';
    const pageCount = targetKind === 'a' ? batchAnswerPageCount : batchQuestionPageCount;
    const labels = targetKind === 'a' ? batchAnswerLabels : batchQuestionLabels;
    if (targetKind === 'a') {
        if (!Array.isArray(batchAnswerPageBoxes) || batchAnswerPageBoxes.length < pageCount) {
            batchAnswerPageBoxes = Array.from({ length: pageCount }, (_, idx) => (batchAnswerPageBoxes && batchAnswerPageBoxes[idx]) ? batchAnswerPageBoxes[idx] : []);
        }
    } else {
        if (!Array.isArray(batchPageBoxes) || batchPageBoxes.length < pageCount) {
            batchPageBoxes = Array.from({ length: pageCount }, (_, idx) => (batchPageBoxes && batchPageBoxes[idx]) ? batchPageBoxes[idx] : []);
        }
    }
    const boxesArr = targetKind === 'a' ? batchAnswerPageBoxes : batchPageBoxes;
    // 若当前页尚未框选且不是第 1 页，根据同类型上一页结束题号自动校准本页起始题号（题目与答案完全独立）
    const curBoxes = boxesArr[pageIndex] || [];
    if (curBoxes.length === 0 && pageIndex > 0) {
        const prevLbl = parseInt(labels[pageIndex - 1], 10) || 1;
        const prevInfo = getGroupBoxesInfo(prevLbl, targetKind);
        const curLbl = parseInt(labels[pageIndex], 10) || 1;
        if (curLbl !== prevLbl) {
            const expectedStart = prevInfo.endNum + 1;
            if (curLbl !== expectedStart) {
                labels[pageIndex] = expectedStart;
                markPageLabelManual(targetKind, pageIndex);
                cascadeQuestionLabelsAfterGroup(pageIndex, targetKind);
            }
        }
    }
    openPageLightbox(targetKind, pageIndex, true);
}
window.openBigQuestionBoxMode = openBigQuestionBoxMode;

function closePageLightbox() {
    const dialog = document.getElementById('page-lightbox-dialog');
    if (dialog) dialog.classList.remove('active');
    if (lightboxStep4Context) {
        lightboxStep4Context = null;
    } else if (currentStep === 3) {
        renderAnnotationList();
        updateAnnotationStatus();
    }
}

function toggleLightboxBoxMode() {
    if (lightboxKind !== 'q' && lightboxKind !== 'a' && !lightboxStep4Context) return;
    lightboxBoxMode = !lightboxBoxMode;
    updateLightboxContent();
}
window.toggleLightboxBoxMode = toggleLightboxBoxMode;

function finishLightboxBoxMode() {
    if (lightboxStep4Context) {
        applyStep4BigQuestionBoxes();
        closePageLightbox();
        return;
    }
    lightboxBoxMode = false;
    renderAnnotationList();
    updateAnnotationStatus();
    closePageLightbox();
}
window.finishLightboxBoxMode = finishLightboxBoxMode;

function getActiveLightboxBoxesForCurrentPage() {
    if (lightboxStep4Context) {
        return lightboxStep4Context.pageBoxes[lightboxIndex] || [];
    }
    if (lightboxKind === 'a') {
        if (!Array.isArray(batchAnswerPageBoxes[lightboxIndex])) {
            batchAnswerPageBoxes[lightboxIndex] = [];
        }
        return batchAnswerPageBoxes[lightboxIndex];
    }
    if (!Array.isArray(batchPageBoxes[lightboxIndex])) {
        batchPageBoxes[lightboxIndex] = [];
    }
    return batchPageBoxes[lightboxIndex];
}

function getActiveLightboxStemBoxesForCurrentPage() {
    if (lightboxStep4Context) {
        if (!Array.isArray(lightboxStep4Context.stemBoxes[lightboxIndex])) {
            lightboxStep4Context.stemBoxes[lightboxIndex] = [];
        }
        return lightboxStep4Context.stemBoxes[lightboxIndex];
    }
    if (lightboxKind !== 'q') return [];
    if (!Array.isArray(batchStemBoxes[lightboxIndex])) {
        batchStemBoxes[lightboxIndex] = [];
    }
    return batchStemBoxes[lightboxIndex];
}

function getActiveLightboxGroupSummary() {
    if (lightboxStep4Context) {
        const startNum = lightboxStep4Context.startNum;
        const boxesWithMeta = [];
        const stemBoxesWithMeta = [];
        lightboxStep4Context.pageBoxes.forEach((pBoxes, pOffset) => {
            (pBoxes || []).forEach((b, bIdx) => {
                boxesWithMeta.push({
                    num: startNum + boxesWithMeta.length,
                    pageIndex: pOffset,
                    pageOffset: pOffset,
                    localBoxIndex: bIdx,
                    ...b
                });
            });
        });
        (lightboxStep4Context.stemBoxes || []).forEach((sBoxes, pOffset) => {
            (sBoxes || []).forEach((sb, sbIdx) => {
                stemBoxesWithMeta.push({
                    pageIndex: pOffset,
                    pageOffset: pOffset,
                    localBoxIndex: sbIdx,
                    ...sb
                });
            });
        });
        const count = boxesWithMeta.length;
        return {
            isBigQuestion: count > 0 || stemBoxesWithMeta.length > 0,
            startNum,
            endNum: count > 0 ? (startNum + count - 1) : startNum,
            count,
            boxesWithMeta,
            stemBoxesWithMeta
        };
    }
    const labels = lightboxKind === 'a' ? batchAnswerLabels : batchQuestionLabels;
    const currStart = parseInt(labels[lightboxIndex], 10) || 1;
    return getGroupBoxesInfo(currStart, lightboxKind);
}

function isBoxCrowded(b, allBoxes, isThumb = false) {
    if (!b) return false;
    if (isThumb) {
        if (b.w < 0.25 || b.h < 0.08 || (Array.isArray(allBoxes) && allBoxes.length >= 4)) {
            return true;
        }
    } else {
        if (b.w < 0.16 || b.h < 0.055 || (Array.isArray(allBoxes) && allBoxes.length >= 6)) {
            return true;
        }
    }
    if (!Array.isArray(allBoxes)) return false;
    const hThresh = isThumb ? 0.09 : 0.06;
    const vThresh = isThumb ? 0.07 : 0.045;
    return allBoxes.some(other => {
        if (!other || other === b) return false;
        const hGap = Math.max(0, Math.max(b.x, other.x) - Math.min(b.x + b.w, other.x + other.w));
        const vGap = Math.max(0, Math.max(b.y, other.y) - Math.min(b.y + b.h, other.y + other.h));
        return hGap < hThresh && vGap < vThresh;
    });
}

function renderLightboxBoxesOverlay() {
    const layer = document.getElementById('lightbox-box-layer');
    if (!layer) return;
    const canBox = (lightboxKind === 'q' || lightboxKind === 'a') || Boolean(lightboxStep4Context);
    layer.classList.toggle('drawing-enabled', Boolean(canBox && lightboxBoxMode));

    if (!canBox) {
        layer.innerHTML = '';
        return;
    }

    const summary = getActiveLightboxGroupSummary();
    const currentPageBoxes = summary.boxesWithMeta.filter(b => b.pageIndex === lightboxIndex);
    const currentPageStems = (summary.stemBoxesWithMeta || []).filter(sb => sb.pageIndex === lightboxIndex);
    const isAnswerMode = !lightboxStep4Context && lightboxKind === 'a';

    const stemsHtml = currentPageStems.map((sb, idx) => `
        <div class="lightbox-subq-box stem-box" style="left:${(sb.x * 100).toFixed(2)}%;top:${(sb.y * 100).toFixed(2)}%;width:${(sb.w * 100).toFixed(2)}%;height:${(sb.h * 100).toFixed(2)}%;">
            <span class="lightbox-subq-tag" title="大题原文/题干区域">${currentPageStems.length > 1 ? `原文 ${idx + 1}` : '原文'}</span>
            <button type="button" class="lightbox-subq-del" onclick="deleteStemBox(${sb.localBoxIndex}, event)" title="删除此原文选框">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
    `).join('');

    const subqsHtml = currentPageBoxes.map(b => {
        const compact = isBoxCrowded(b, currentPageBoxes, false);
        const tagText = compact ? `${b.num}` : `第 ${b.num} 题`;
        return `
        <div class="lightbox-subq-box${compact ? ' compact' : ''}${isAnswerMode ? ' answer-box' : ''}" style="left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%;">
            <span class="lightbox-subq-tag${compact ? ' compact' : ''}" title="第 ${b.num} 题">${tagText}</span>
            <button type="button" class="lightbox-subq-del" onclick="deletePageBox(${b.localBoxIndex}, event)" title="删除第 ${b.num} 题选框">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        </div>
    `;
    }).join('');

    layer.innerHTML = stemsHtml + subqsHtml;

    // 更新顶部胶囊与工具栏计数
    const rangePill = document.getElementById('lightbox-group-range-pill');
    const summaryEl = document.getElementById('lightbox-boxmode-summary');
    const guideEl = document.getElementById('lightbox-boxmode-guide');
    const dotEl = document.getElementById('lightbox-boxmode-dot');
    const targetSwitch = document.getElementById('lightbox-target-switch');
    const stemBtn = document.getElementById('lightbox-target-stem-btn');
    const subqBtn = document.getElementById('lightbox-target-subq-btn');
    const fwBtn = document.getElementById('lightbox-fullwidth-btn');
    const undoBtn = document.getElementById('lightbox-box-undo-btn');
    const clearBtn = document.getElementById('lightbox-box-clear-btn');
    const alignBtn = document.getElementById('lightbox-box-align-btn');
    const extendBtn = document.getElementById('lightbox-box-extend-btn');

    const isDrawingStem = !isAnswerMode && lightboxDrawTarget === 'stem';
    if (targetSwitch) {
        targetSwitch.style.display = isAnswerMode ? 'none' : 'inline-flex';
    }
    if (stemBtn) stemBtn.classList.toggle('active', isDrawingStem);
    if (subqBtn) subqBtn.classList.toggle('active', !isDrawingStem);
    if (dotEl) dotEl.classList.toggle('stem-mode', isDrawingStem);
    if (fwBtn) {
        fwBtn.classList.toggle('active', lightboxFullWidthSnap);
        const span = fwBtn.querySelector('span');
        if (span) span.textContent = lightboxFullWidthSnap ? '横向通栏: 开' : '横向通栏: 关';
    }
    if (guideEl) {
        if (isDrawingStem) {
            guideEl.textContent = '第 1 步：请拖拽框选大题「原文/题干」区域（框好后自动切换框选题号）';
        } else if (isAnswerMode) {
            guideEl.textContent = '请依次拖拽框选各小题答案区域';
        } else {
            guideEl.textContent = '第 2 步：请依次拖拽框选各小问题号与作答区';
        }
    }

    if (rangePill) {
        if (summary.count > 0) {
            rangePill.style.display = 'inline-flex';
            rangePill.textContent = `涵盖第 ${summary.startNum} ~ ${summary.endNum} 题（共 ${summary.count} 问）`;
        } else {
            rangePill.style.display = 'none';
        }
    }
    if (summaryEl) {
        const unitLabel = isAnswerMode ? '题答案' : '问';
        const stemBadge = (!isAnswerMode && (summary.stemBoxesWithMeta || []).length > 0)
            ? `原文 ${(summary.stemBoxesWithMeta || []).length} 段 · `
            : '';
        summaryEl.textContent = summary.count > 0
            ? `${stemBadge}已框选 ${summary.count} ${unitLabel}（第 ${summary.startNum} ~ ${summary.endNum} 题）· 下一框为第 ${summary.endNum + 1} 题`
            : `${stemBadge}起始第 ${summary.startNum} 题 · ${isDrawingStem ? '等待框选原文' : `请框选第 1 ${unitLabel}`}`;
    }
    const pageRawBoxes = getActiveLightboxBoxesForCurrentPage();
    const pageStemBoxes = getActiveLightboxStemBoxesForCurrentPage();
    if (alignBtn) alignBtn.disabled = pageRawBoxes.length < 2;
    if (undoBtn) undoBtn.disabled = (isDrawingStem ? pageStemBoxes.length === 0 : pageRawBoxes.length === 0);
    if (clearBtn) clearBtn.disabled = (pageRawBoxes.length === 0 && pageStemBoxes.length === 0);
    if (extendBtn) {
        if (lightboxStep4Context) {
            extendBtn.style.display = (lightboxIndex + 1 < lightboxStep4Context.pageThumbs.length) ? 'inline-flex' : 'none';
        } else {
            const totalCount = lightboxKind === 'a' ? batchAnswerPageCount : batchQuestionPageCount;
            extendBtn.style.display = (lightboxIndex + 1 < totalCount) ? 'inline-flex' : 'none';
        }
    }
}

function deleteStemBox(localIdx, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const arr = getActiveLightboxStemBoxesForCurrentPage();
    if (localIdx >= 0 && localIdx < arr.length) {
        arr.splice(localIdx, 1);
        onBoxesMutated();
    }
}
window.deleteStemBox = deleteStemBox;

function onBoxesMutated() {
    if (!lightboxStep4Context) {
        cascadeQuestionLabelsAfterGroup(lightboxIndex, lightboxKind);
        updatePairedIndicators();
        updateAnnotationStatus();
    }
    renderLightboxBoxesOverlay();
}

function deletePageBox(localIdx, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const arr = getActiveLightboxBoxesForCurrentPage();
    if (localIdx >= 0 && localIdx < arr.length) {
        arr.splice(localIdx, 1);
        onBoxesMutated();
    }
}
window.deletePageBox = deletePageBox;

function undoLastPageBox() {
    const isDrawingStem = (lightboxKind === 'q' || Boolean(lightboxStep4Context)) && lightboxDrawTarget === 'stem';
    if (isDrawingStem) {
        const sArr = getActiveLightboxStemBoxesForCurrentPage();
        if (sArr.length > 0) {
            sArr.pop();
            onBoxesMutated();
        }
        return;
    }
    const arr = getActiveLightboxBoxesForCurrentPage();
    if (arr.length > 0) {
        arr.pop();
        onBoxesMutated();
    }
}
window.undoLastPageBox = undoLastPageBox;

/**
 * 安全对齐同页框选坐标：
 * 1. 绝不缩小任何框（防止漏掉原题文字）
 * 2. 绝不侵占相邻框（水平或垂直冲突时自动保守退避，留足安全间隙）
 */
function normalizePageBoxesSafely(boxes) {
    if (!Array.isArray(boxes) || boxes.length < 2) {
        return Array.isArray(boxes) ? boxes.map(b => ({ ...b })) : [];
    }
    const out = boxes.map(b => ({ ...b }));
    const COL_TOL = 0.022;
    const SAFE_GAP = 0.004;

    const overlapsOther = (cand, idx) => {
        for (let j = 0; j < out.length; j++) {
            if (j === idx) continue;
            const o = out[j];
            const orig = boxes[j];
            const hOverlap = cand.x < Math.max(o.x + o.w, orig.x + orig.w) + SAFE_GAP && (cand.x + cand.w) > Math.min(o.x, orig.x) - SAFE_GAP;
            const vOverlap = cand.y < Math.max(o.y + o.h, orig.y + orig.h) + SAFE_GAP && (cand.y + cand.h) > Math.min(o.y, orig.y) - SAFE_GAP;
            // 若原本未重叠，则不允许调整后发生重叠
            const origSelf = boxes[idx];
            const wasOverlapping = origSelf.x < (orig.x + orig.w) && (origSelf.x + origSelf.w) > orig.x && origSelf.y < (orig.y + orig.h) && (origSelf.y + origSelf.h) > orig.y;
            if (!wasOverlapping && hOverlap && vOverlap) {
                return true;
            }
        }
        return false;
    };

    // 1. 左边缘按列聚簇并向外对齐（只向左扩，绝不向右缩）
    const leftClusters = [];
    out.forEach((b, idx) => {
        const match = leftClusters.find(c => Math.abs(c.anchor - b.x) <= COL_TOL);
        if (match) {
            match.indices.push(idx);
            match.minX = Math.min(match.minX, b.x);
        } else {
            leftClusters.push({ anchor: b.x, minX: b.x, indices: [idx] });
        }
    });
    leftClusters.forEach(c => {
        if (c.indices.length < 2) return;
        c.indices.forEach(idx => {
            const cur = out[idx];
            if (c.minX < cur.x) {
                const cand = { ...cur, x: c.minX, w: (cur.x + cur.w) - c.minX };
                if (!overlapsOther(cand, idx)) {
                    out[idx] = cand;
                }
            }
        });
    });

    // 2. 右边缘按列聚簇并向外对齐（只向右扩，绝不向左缩）
    const rightClusters = [];
    out.forEach((b, idx) => {
        const r = b.x + b.w;
        const match = rightClusters.find(c => Math.abs(c.anchor - r) <= COL_TOL);
        if (match) {
            match.indices.push(idx);
            match.maxR = Math.max(match.maxR, r);
        } else {
            rightClusters.push({ anchor: r, maxR: r, indices: [idx] });
        }
    });
    rightClusters.forEach(c => {
        if (c.indices.length < 2) return;
        c.indices.forEach(idx => {
            const cur = out[idx];
            const curR = cur.x + cur.w;
            if (c.maxR > curR) {
                const cand = { ...cur, w: Math.min(1.0 - cur.x, c.maxR - cur.x) };
                if (!overlapsOther(cand, idx)) {
                    out[idx] = cand;
                }
            }
        });
    });

    // 3. 相近规格高度微调统一（仅扩展到安全间隙内，绝不缩小且绝不侵占上下题）
    const sortedByY = out.map((b, idx) => ({ idx, b })).sort((a, b) => a.b.y - b.b.y);
    const heightGroups = [];
    sortedByY.forEach(entry => {
        if (entry.b.h > 0.14) return;
        const g = heightGroups.find(grp => {
            const ratio = Math.abs(entry.b.h - grp.anchorH) / Math.max(0.01, grp.anchorH);
            return ratio <= 0.22;
        });
        if (g) {
            g.entries.push(entry);
            g.maxH = Math.max(g.maxH, entry.b.h);
        } else {
            heightGroups.push({ anchorH: entry.b.h, maxH: entry.b.h, entries: [entry] });
        }
    });

    heightGroups.forEach(g => {
        if (g.entries.length < 2) return;
        g.entries.forEach(({ idx }) => {
            const cur = out[idx];
            const need = g.maxH - cur.h;
            if (need <= 0.001) return;

            // 计算同水平投影列上紧邻上下框的安全间隙
            let maxAbove = cur.y;
            let maxBelow = 1.0 - (cur.y + cur.h);
            out.forEach((other, j) => {
                if (j === idx) return;
                const hOverlap = cur.x < (other.x + other.w) && (cur.x + cur.w) > other.x;
                if (!hOverlap) return;
                if (other.y + other.h <= cur.y + 0.002) {
                    maxAbove = Math.min(maxAbove, Math.max(0, cur.y - (other.y + other.h) - SAFE_GAP));
                }
                if (other.y >= (cur.y + cur.h) - 0.002) {
                    maxBelow = Math.min(maxBelow, Math.max(0, other.y - (cur.y + cur.h) - SAFE_GAP));
                }
            });

            const allowUp = Math.min(need * 0.5, maxAbove * 0.42);
            const allowDown = Math.min(need - allowUp, maxBelow * 0.42);
            const finalUp = Math.min(need - allowDown, maxAbove * 0.42);
            const addUp = Math.max(0, finalUp);
            const addDown = Math.max(0, allowDown);
            if (addUp + addDown > 0.001) {
                const cand = {
                    ...cur,
                    y: Math.max(0, cur.y - addUp),
                    h: Math.min(1.0 - Math.max(0, cur.y - addUp), cur.h + addUp + addDown)
                };
                if (!overlapsOther(cand, idx)) {
                    out[idx] = cand;
                }
            }
        });
    });

    return out.map(b => ({
        ...b,
        x: Number(b.x.toFixed(4)),
        y: Number(b.y.toFixed(4)),
        w: Number(b.w.toFixed(4)),
        h: Number(b.h.toFixed(4))
    }));
}

function alignCurrentPageBoxes() {
    const arr = getActiveLightboxBoxesForCurrentPage();
    if (!Array.isArray(arr) || arr.length < 2) {
        showToast('本页至少需要 2 个选框才可对齐规整');
        return;
    }
    const aligned = normalizePageBoxesSafely(arr);
    for (let i = 0; i < arr.length; i++) {
        let nx = aligned[i].x;
        let nw = aligned[i].w;
        if (lightboxFullWidthSnap) {
            const nr = Math.max(nx + nw, 0.97);
            nx = Math.min(nx, 0.03);
            nw = nr - nx;
        }
        arr[i].x = Number(nx.toFixed(4));
        arr[i].y = aligned[i].y;
        arr[i].w = Number(nw.toFixed(4));
        arr[i].h = aligned[i].h;
    }
    onBoxesMutated();
    showToast('已按单栏通栏与安全间隙完成对齐规整', 'success');
}
window.alignCurrentPageBoxes = alignCurrentPageBoxes;

function clearCurrentPageBoxes() {
    const arr = getActiveLightboxBoxesForCurrentPage();
    const sArr = (lightboxKind === 'q' || lightboxStep4Context) ? getActiveLightboxStemBoxesForCurrentPage() : [];
    if (arr.length > 0 || sArr.length > 0) {
        arr.length = 0;
        if (sArr.length > 0) sArr.length = 0;
        if (lightboxKind === 'q' || lightboxStep4Context) {
            lightboxDrawTarget = 'stem';
        }
        onBoxesMutated();
        showToast('已清空本页框选内容');
    }
}
window.clearCurrentPageBoxes = clearCurrentPageBoxes;

function extendBigQuestionToNextPage() {
    if (lightboxStep4Context) {
        if (lightboxIndex + 1 < lightboxStep4Context.pageThumbs.length) {
            lightboxIndex++;
            lightboxZoom = 1;
            updateLightboxContent();
            showToast(`已翻至第 ${lightboxIndex + 1} 页，继续拉框将顺延题号`);
        }
        return;
    }
    const targetKind = lightboxKind === 'a' ? 'a' : 'q';
    const totalCount = targetKind === 'a' ? batchAnswerPageCount : batchQuestionPageCount;
    const labels = targetKind === 'a' ? batchAnswerLabels : batchQuestionLabels;
    if (lightboxIndex + 1 >= totalCount) {
        showToast('已经是最后一页');
        return;
    }
    const currStart = parseInt(labels[lightboxIndex], 10) || 1;
    const nextIdx = lightboxIndex + 1;
    labels[nextIdx] = currStart;
    markPageLabelManual(targetKind, nextIdx);
    cascadeQuestionLabelsAfterGroup(nextIdx, targetKind);
    lightboxIndex = nextIdx;
    lightboxZoom = 1;
    lightboxBoxMode = true;
    updateLightboxContent();
    const summary = getGroupBoxesInfo(currStart, targetKind);
    showToast(`第 ${nextIdx + 1} 页已并入本大题（第 ${currStart} 题起），请继续拉框（下一框为第 ${summary.count > 0 ? summary.endNum + 1 : currStart} 题）`);
}
window.extendBigQuestionToNextPage = extendBigQuestionToNextPage;

let lightboxDrawBound = false;
function initLightboxBoxDrawingEvents() {
    if (lightboxDrawBound) return;
    const layer = document.getElementById('lightbox-box-layer');
    if (!layer) return;
    lightboxDrawBound = true;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let draftEl = null;

    const getRelPos = (clientX, clientY) => {
        const rect = layer.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        return { x, y };
    };

    layer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!lightboxBoxMode || (lightboxKind !== 'q' && lightboxKind !== 'a' && !lightboxStep4Context)) return;
        if (e.target && e.target.closest('.lightbox-subq-del')) return;

        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        const pos = getRelPos(e.clientX, e.clientY);
        startX = pos.x;
        startY = pos.y;

        const summary = getActiveLightboxGroupSummary();
        const nextNum = summary.count > 0 ? (summary.endNum + 1) : summary.startNum;
        const isAnswerMode = !lightboxStep4Context && lightboxKind === 'a';
        const isDrawingStem = !isAnswerMode && lightboxDrawTarget === 'stem';

        draftEl = document.createElement('div');
        draftEl.className = `lightbox-subq-box draft-box${isAnswerMode ? ' answer-box' : ''}${isDrawingStem ? ' stem-box' : ''}`;
        draftEl.style.left = `${(startX * 100).toFixed(2)}%`;
        draftEl.style.top = `${(startY * 100).toFixed(2)}%`;
        draftEl.style.width = '0%';
        draftEl.style.height = '0%';
        draftEl.innerHTML = `<span class="lightbox-subq-tag">${isDrawingStem ? '原文' : (summary.count >= 5 ? nextNum : `第 ${nextNum} 题`)}</span>`;
        layer.appendChild(draftEl);
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging || !draftEl) return;
        const pos = getRelPos(e.clientX, e.clientY);
        const left = Math.min(startX, pos.x);
        const top = Math.min(startY, pos.y);
        const width = Math.abs(pos.x - startX);
        const height = Math.abs(pos.y - startY);
        draftEl.style.left = `${(left * 100).toFixed(2)}%`;
        draftEl.style.top = `${(top * 100).toFixed(2)}%`;
        draftEl.style.width = `${(width * 100).toFixed(2)}%`;
        draftEl.style.height = `${(height * 100).toFixed(2)}%`;
    });

    window.addEventListener('mouseup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        const pos = getRelPos(e.clientX, e.clientY);
        let left = Math.min(startX, pos.x);
        const top = Math.min(startY, pos.y);
        let width = Math.abs(pos.x - startX);
        const height = Math.abs(pos.y - startY);

        if (draftEl && draftEl.parentNode) {
            draftEl.parentNode.removeChild(draftEl);
        }
        draftEl = null;

        // 过滤误触单击（宽度 >= 1.5% 且高度 >= 1.0% 视为有效拉框）
        if (width < 0.015 || height < 0.010) {
            return;
        }

        // 单栏横向自动通栏打满（左至 3%，右至 97%）
        if (lightboxFullWidthSnap) {
            const right = Math.max(left + width, 0.97);
            left = Math.min(left, 0.03);
            width = right - left;
        }

        const newBox = {
            x: Number(left.toFixed(4)),
            y: Number(top.toFixed(4)),
            w: Number(width.toFixed(4)),
            h: Number(height.toFixed(4))
        };

        const isDrawingStem = (lightboxKind === 'q' || Boolean(lightboxStep4Context)) && lightboxDrawTarget === 'stem';
        if (isDrawingStem) {
            const sArr = getActiveLightboxStemBoxesForCurrentPage();
            sArr.push(newBox);
            // 框好原文后自动切入第 2 步：框选题号
            lightboxDrawTarget = 'subq';
            onBoxesMutated();
            showToast('原文区已框选！请按顺序框选各小问题号（若原文跨页可点“1. 框选原文”继续补框）', 'success');
            return;
        }

        const arr = getActiveLightboxBoxesForCurrentPage();
        arr.push(newBox);
        onBoxesMutated();
    });
}

function updateLightboxContent() {
    const isStep4 = Boolean(lightboxStep4Context);
    const thumbs = isStep4
        ? lightboxStep4Context.pageThumbs
        : (lightboxKind === 'q' ? batchQuestionThumbs : batchAnswerThumbs);
    const labels = isStep4
        ? lightboxStep4Context.pageThumbs.map(() => lightboxStep4Context.startNum)
        : (lightboxKind === 'q' ? batchQuestionLabels : batchAnswerLabels);
    const total = thumbs.length;
    if (lightboxIndex < 0) lightboxIndex = 0;
    if (lightboxIndex >= total) lightboxIndex = total - 1;

    const stage = document.getElementById('lightbox-stage');
    const img = document.getElementById('lightbox-img');
    const title = document.getElementById('lightbox-title');
    const labelEditor = document.getElementById('lightbox-label-editor-standard');
    const labelInput = document.getElementById('lightbox-page-label');
    const navInfo = document.getElementById('lightbox-nav-info');
    const prevBtn = document.getElementById('lightbox-prev-btn');
    const nextBtn = document.getElementById('lightbox-next-btn');
    const bigqToggleBtn = document.getElementById('lightbox-bigq-toggle-btn');
    const bigqToggleText = document.getElementById('lightbox-bigq-toggle-text');
    const boxmodeBar = document.getElementById('lightbox-boxmode-bar');

    const kindName = isStep4 ? '大题小问框选' : (lightboxKind === 'q' ? '题目 PDF' : '答案 PDF');
    if (title) title.textContent = `${kindName} · 第 ${lightboxIndex + 1} 页`;
    if (img) {
        img.src = thumbs[lightboxIndex];
        img.style.transform = '';
    }
    if (stage) {
        stage.style.transform = `scale(${lightboxZoom})`;
    }

    if (labelEditor) {
        labelEditor.style.display = isStep4 ? 'none' : 'flex';
    }
    if (labelInput) labelInput.value = labels[lightboxIndex] || '';

    const canBox = (lightboxKind === 'q' || lightboxKind === 'a') || isStep4;
    const summary = canBox ? getActiveLightboxGroupSummary() : null;
    if (bigqToggleBtn) {
        bigqToggleBtn.style.display = ((lightboxKind === 'q' || lightboxKind === 'a') && !isStep4) ? 'inline-flex' : 'none';
        bigqToggleBtn.classList.toggle('active', Boolean(lightboxBoxMode));
    }
    if (bigqToggleText && summary) {
        bigqToggleText.textContent = lightboxBoxMode
            ? '退出框选模式'
            : (summary.count > 0 ? `编辑大题框选 (${summary.count}问)` : '设为大题（框选小问）');
    }
    if (boxmodeBar) {
        boxmodeBar.style.display = (canBox && (lightboxBoxMode || (summary && summary.count > 0))) ? 'flex' : 'none';
    }

    if (navInfo) navInfo.textContent = `第 ${lightboxIndex + 1} / ${total} 页`;

    if (prevBtn) prevBtn.disabled = lightboxIndex <= 0;
    if (nextBtn) nextBtn.disabled = lightboxIndex >= total - 1;

    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = `${Math.round(lightboxZoom * 100)}%`;

    renderLightboxBoxesOverlay();
}

function navigateLightbox(direction) {
    lightboxIndex += direction;
    lightboxZoom = 1;
    updateLightboxContent();
}

function zoomLightboxImage(delta) {
    lightboxZoom = Math.max(0.5, Math.min(3.0, lightboxZoom + delta));
    const stage = document.getElementById('lightbox-stage');
    if (stage) stage.style.transform = `scale(${lightboxZoom})`;
    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = `${Math.round(lightboxZoom * 100)}%`;
}

function resetLightboxZoom() {
    lightboxZoom = 1;
    const stage = document.getElementById('lightbox-stage');
    if (stage) stage.style.transform = 'scale(1)';
    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = '100%';
}

function onLightboxLabelChange(val) {
    onPageLabelChange(lightboxKind, lightboxIndex, val);
    renderLightboxBoxesOverlay();
}

function stepPageLabel(kind, index, delta, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const arr = kind === 'q' ? batchQuestionLabels : batchAnswerLabels;
    const input = document.querySelector(`input.page-label-input[data-kind="${kind}"][data-index="${index}"]`);
    const currentVal = input ? (parseInt(input.value, 10) || arr[index] || 1) : (parseInt(arr[index], 10) || 1);
    const newVal = Math.max(1, currentVal + delta);
    if (newVal !== currentVal) {
        if (input) input.value = newVal;
        onPageLabelChange(kind, index, String(newVal));
    }
}

function stepLightboxLabel(delta, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const el = document.getElementById('lightbox-page-label');
    if (!el) return;
    const currentVal = parseInt(el.value, 10) || 1;
    const newVal = Math.max(1, currentVal + delta);
    el.value = newVal;
    onLightboxLabelChange(String(newVal));
}

// Global keydown for lightbox navigation
window.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('page-lightbox-dialog');
    if (!lightbox || !lightbox.classList.contains('active')) return;
    if (e.target && e.target.tagName === 'INPUT') return;

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateLightbox(1);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        closePageLightbox();
    } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomLightboxImage(0.25);
    } else if (e.key === '-') {
        e.preventDefault();
        zoomLightboxImage(-0.25);
    }
});

// 题目高清切片大图预览灯箱：支持鼠标滚轮缩放 (Mouse Wheel Zoom)
window.addEventListener('wheel', function (e) {
    const lbModal = document.getElementById('page-lightbox-dialog');
    if (!lbModal || !lbModal.classList.contains('active')) return;
    const lbBody = document.getElementById('lightbox-body');
    if (lbBody && (lbBody === e.target || lbBody.contains(e.target))) {
        if (e.target.tagName !== 'INPUT') {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15;
            zoomLightboxImage(delta);
        }
    }
}, { passive: false });

// 全局禁用题号及数字输入框的滚轮调节，确保滚轮始终用于平滑滑动浏览页面
window.addEventListener('wheel', function (e) {
    if (document.activeElement && (
        document.activeElement.tagName === 'INPUT' && (
            document.activeElement.type === 'number' ||
            document.activeElement.classList.contains('page-label-input') ||
            document.activeElement.classList.contains('question-id-input') ||
            document.activeElement.id === 'lightbox-page-label'
        )
    )) {
        document.activeElement.blur();
    }
    const target = e.target;
    if (target && target.tagName === 'INPUT' && (
        target.type === 'number' ||
        target.classList.contains('page-label-input') ||
        target.classList.contains('question-id-input') ||
        target.id === 'lightbox-page-label'
    )) {
        target.blur();
    }
}, { capture: true, passive: true });

window.setMappingView = setMappingView;
window.setThumbSize = setThumbSize;
window.autoNumberPages = autoNumberPages;
window.syncAnswerToQuestionNumbers = syncAnswerToQuestionNumbers;
window.openPageLightbox = openPageLightbox;
window.closePageLightbox = closePageLightbox;
window.navigateLightbox = navigateLightbox;
window.zoomLightboxImage = zoomLightboxImage;
window.resetLightboxZoom = resetLightboxZoom;
window.onLightboxLabelChange = onLightboxLabelChange;
window.onPageLabelChange = onPageLabelChange;
window.stepPageLabel = stepPageLabel;
window.stepLightboxLabel = stepLightboxLabel;
window.toggleAutoCascade = toggleAutoCascade;
window.undoLastLabelChange = undoLastLabelChange;

Object.defineProperty(window, 'batchQuestionLabels', {
    get: () => batchQuestionLabels,
    set: (val) => { batchQuestionLabels = val; },
    configurable: true
});
Object.defineProperty(window, 'batchAnswerLabels', {
    get: () => batchAnswerLabels,
    set: (val) => { batchAnswerLabels = val; },
    configurable: true
});
Object.defineProperty(window, 'batchQuestionThumbs', {
    get: () => batchQuestionThumbs,
    set: (val) => { batchQuestionThumbs = val; },
    configurable: true
});
Object.defineProperty(window, 'batchAnswerThumbs', {
    get: () => batchAnswerThumbs,
    set: (val) => { batchAnswerThumbs = val; },
    configurable: true
});
Object.defineProperty(window, 'batchQuestionPageCount', {
    get: () => batchQuestionPageCount,
    set: (val) => { batchQuestionPageCount = val; },
    configurable: true
});
Object.defineProperty(window, 'batchAnswerPageCount', {
    get: () => batchAnswerPageCount,
    set: (val) => { batchAnswerPageCount = val; },
    configurable: true
});

let autoCascadeNumbers = true;
let lastLabelState = null;

function toggleAutoCascade(checked) {
    autoCascadeNumbers = !!checked;
    showToast(autoCascadeNumbers ? '已开启题号智能顺延' : '已关闭题号智能顺延');
}

function undoLastLabelChange() {
    if (!lastLabelState) return;
    const { kind, labels } = lastLabelState;
    if (kind === 'q') {
        batchQuestionLabels = [...labels];
    } else {
        batchAnswerLabels = [...labels];
    }

    labels.forEach((val, i) => {
        const input = document.querySelector(`input.page-label-input[data-kind="${kind}"][data-index="${i}"]`);
        if (input) input.value = val;
    });

    if (lightboxKind === kind) {
        const lbInput = document.getElementById('lightbox-page-label');
        if (lbInput) lbInput.value = labels[lightboxIndex];
    }

    updatePairedIndicators();
    updateAnnotationStatus();

    const undoBtn = document.getElementById('undo-cascade-btn');
    if (undoBtn) undoBtn.style.display = 'none';

    showToast('已撤销上次题号顺延调整');
    lastLabelState = null;
}

function updatePairedIndicators() {
    ['q', 'a'].forEach(k => {
        const labels = k === 'q' ? batchQuestionLabels : batchAnswerLabels;
        labels.forEach((num, i) => {
            const card = document.querySelector(`.page-card-${k}:nth-child(${i + 1})`);
            if (!card) return;
            let isPaired = false;
            if (k === 'q') {
                const gInfo = getGroupBoxesInfo(num, 'q');
                isPaired = Array.isArray(batchAnswerLabels) && batchAnswerLabels.some(aNum => {
                    const aInfo = getGroupBoxesInfo(aNum, 'a');
                    return aInfo.groupNums.some(n => gInfo.groupNums.includes(n));
                });
            } else {
                const aInfo = getGroupBoxesInfo(num, 'a');
                isPaired = matchAnswerLabelToQuestionGroup(num).isPaired || (aInfo.isBigQuestion && aInfo.groupNums.some(n => matchAnswerLabelToQuestionGroup(n).isPaired));
            }
            if (isPaired) {
                card.classList.add('paired');
            } else {
                card.classList.remove('paired');
            }
            const noTag = card.querySelector('.page-no-tag');
            if (noTag) {
                let ind = noTag.querySelector('.page-paired-indicator');
                if (isPaired && !ind) {
                    ind = document.createElement('span');
                    ind.className = 'page-paired-indicator';
                    ind.title = `已与对应${k === 'q' ? '答案' : '题目'}匹配`;
                    noTag.appendChild(ind);
                } else if (!isPaired && ind) {
                    ind.remove();
                }
            }
            const badge = card.querySelector('.page-status-badge');
            if (badge) {
                if (isPaired) {
                    badge.classList.add('paired');
                    badge.textContent = '已对齐';
                } else {
                    badge.classList.remove('paired');
                    badge.textContent = '未对齐';
                }
            }
        });
    });
}

function markPageLabelManual(kind, index) {
    const flags = kind === 'q' ? batchQuestionAutoFlags : batchAnswerAutoFlags;
    const inheritedFlags = kind === 'q' ? batchQuestionInheritedFlags : batchAnswerInheritedFlags;
    if (flags) flags[index] = false;
    if (inheritedFlags) inheritedFlags[index] = false;
    const card = document.querySelector(`.page-card-${kind}[data-page-index="${index}"]`);
    if (!card) return;
    const indicator = card.querySelector('.page-auto-indicator');
    if (indicator) indicator.remove();
    const inheritedIndicator = card.querySelector('.page-inherited-indicator');
    if (inheritedIndicator) inheritedIndicator.remove();
    const input = card.querySelector('.page-label-input');
    if (input) {
        input.classList.remove('auto-detected');
        input.classList.remove('inherited-detected');
        input.title = '请手动填写此页对应的作业题号';
    }
}

function onPageLabelChange(kind, index, value) {
    const arr = kind === 'q' ? batchQuestionLabels : batchAnswerLabels;
    const oldVal = arr[index];
    const strVal = String(value == null ? '' : value).trim();
    const num = parseInt(strVal, 10);
    if (strVal === '' || isNaN(num) || num <= 0 || !Number.isInteger(num)) {
        showToast('请输入正整数题号');
        const input = document.querySelector(`input.page-label-input[data-kind="${kind}"][data-index="${index}"]`);
        if (input) input.value = oldVal;
        return;
    }

    if (num === oldVal) {
        return;
    }

    const diff = num - oldVal;

    // 保存当前状态供撤销
    lastLabelState = {
        kind,
        labels: [...arr],
        index,
        oldVal,
        newVal: num,
        diff
    };

    arr[index] = num;
    markPageLabelManual(kind, index);

    const currInput = document.querySelector(`input.page-label-input[data-kind="${kind}"][data-index="${index}"]`);
    if (currInput) {
        currInput.value = num;
        currInput.classList.remove('pulse-active');
        void currInput.offsetWidth;
        currInput.classList.add('pulse-active');
        setTimeout(() => currInput.classList.remove('pulse-active'), 350);
    }
    if (lightboxKind === kind && lightboxIndex === index) {
        const lbInput = document.getElementById('lightbox-page-label');
        if (lbInput && lbInput.value !== String(num)) lbInput.value = num;
    }

    // 题号智能顺延：当修改题号时，自动考虑大题跨度顺延同类型后续页码（题目与答案独立）
    if (autoCascadeNumbers && diff !== 0 && index + 1 < arr.length) {
        cascadeQuestionLabelsAfterGroup(index, kind);
        for (let j = index + 1; j < arr.length; j++) {
            const input = document.querySelector(`input.page-label-input[data-kind="${kind}"][data-index="${j}"]`);
            if (input) {
                input.value = arr[j];
                input.classList.remove('cascade-highlight');
                void input.offsetWidth;
                input.classList.add('cascade-highlight');
                setTimeout(() => {
                    input.classList.remove('cascade-highlight');
                }, 1200);
            }
        }

        // 若全屏高清 Lightbox 正在查看后续受影响页面，同步更新其输入框
        if (lightboxKind === kind && lightboxIndex > index) {
            const lbInput = document.getElementById('lightbox-page-label');
            if (lbInput) lbInput.value = arr[lightboxIndex];
        }

        const undoBtn = document.getElementById('undo-cascade-btn');
        if (undoBtn) {
            undoBtn.style.display = 'inline-flex';
            undoBtn.textContent = `↩ 撤销顺延 (${diff > 0 ? '+' : ''}${diff})`;
        }

        showToast(`题号已自动顺延：后续第 ${index + 2}~${arr.length} 页题号已调整`);
    }

    updatePairedIndicators();
    updateAnnotationStatus();
    updateAutoDetectStatus();
}

function updateAnnotationStatus() {
    const el = document.getElementById('mapping-status-text');
    if (!el) return;
    const coveredSet = getAllCoveredQuestionNumsSet();
    el.textContent = `题目 ${batchQuestionPageCount} 页 → ${coveredSet.size} 道题 / 答案 ${batchAnswerPageCount} 页`;
}

async function goNextFromMapping() {
    const isValid = n => Number.isInteger(n) && n > 0;

    for (let i = 0; i < batchQuestionLabels.length; i++) {
        if (!isValid(batchQuestionLabels[i])) {
            showToast(`第 ${i + 1} 页题目未标注有效题号`);
            return;
        }
    }
    for (let i = 0; i < batchAnswerLabels.length; i++) {
        if (!isValid(batchAnswerLabels[i])) {
            showToast(`第 ${i + 1} 页答案未标注有效题号`);
            return;
        }
    }

    const coveredSet = getAllCoveredQuestionNumsSet();
    for (let i = 0; i < batchAnswerLabels.length; i++) {
        const aInfo = getGroupBoxesInfo(batchAnswerLabels[i], 'a');
        const hasAnyCovered = aInfo.groupNums.some(n => coveredSet.has(n));
        if (!hasAnyCovered) {
            showToast(`答案第 ${i + 1} 页标注了题目页没有的题号 ${batchAnswerLabels[i]}，请检查`);
            return;
        }
    }

    const btn = document.getElementById('mapping-next-btn');
    const origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        if (btn.disabled && btn.dataset.loading === '1') return;
        btn.disabled = true;
        btn.dataset.loading = '1';
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation: spin 0.8s linear infinite; margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
            </svg>
            <span>正在建立题目切片...</span>
        `;
    }
    try {
        const ok = await importWithLabels(batchExerciseFile, batchAnswerFile);
        batchImported = ok && currentQuestions.length > 0;
    } finally {
        if (btn) {
            btn.disabled = false;
            delete btn.dataset.loading;
            btn.innerHTML = origBtnHtml || '完成标注并导入';
        }
    }
}

function updateBatchPdfStatus() {
    const exStatus = document.getElementById('batch-exercise-status');
    const anStatus = document.getElementById('batch-answer-status');
    const nextBtn = document.getElementById('step2-next-btn');
    if (exStatus) {
        exStatus.textContent = batchExerciseFile ? batchExerciseFile.name : '未上传';
        exStatus.classList.toggle('completed', !!batchExerciseFile);
    }
    if (anStatus) {
        anStatus.textContent = batchAnswerFile ? batchAnswerFile.name : '未上传';
        anStatus.classList.toggle('completed', !!batchAnswerFile);
    }
    if (nextBtn) {
        nextBtn.disabled = !(batchExerciseFile && batchAnswerFile);
    }
}

function selectBatchPdf(type) {
    batchUploadType = type;
    let input = document.getElementById('batch-pdf-uploader');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'batch-pdf-uploader';
        input.accept = 'application/pdf';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', (e) => {
            const t = batchUploadType;
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                showToast('仅支持 PDF 文件');
                input.value = '';
                return;
            }
            if (file.size > 20 * 1024 * 1024) {
                showToast('文件过大，请保持在 20MB 以内');
                input.value = '';
                return;
            }
            if (t === 'exercise') {
                batchExerciseFile = file;
                batchQuestionDetectedLabels = [];
                batchQuestionAutoFlags = [];
                batchQuestionInheritedFlags = [];
                batchQuestionAutoCount = 0;
                batchQuestionInheritedCount = 0;
            } else if (t === 'answer') {
                batchAnswerFile = file;
                batchAnswerDetectedLabels = [];
                batchAnswerAutoFlags = [];
                batchAnswerInheritedFlags = [];
                batchAnswerAutoCount = 0;
                batchAnswerInheritedCount = 0;
            }
            batchImported = false;
            updateBatchPdfStatus();
            input.value = '';
        });
    }
    input.click();
}

// ========== Load / Save ==========
async function loadCurrentData() {
    const year = yearSelect ? parseInt(yearSelect.value) : 2026;
    const season = seasonSelect ? seasonSelect.value : '春';
    const bankType = getBankType();
    const subject = subjectSelect ? subjectSelect.value : '';
    const grade = gradeSelect ? gradeSelect.value : '';
    const tier = tierSelect ? tierSelect.value : '';
    const week = weekSelect ? weekSelect.value : '';

    if (!bankType || !subject || !grade || !tier || !week) {
        currentQuestions = [];
        isDirty = false;
        renderQuestionList();
        updateStatus();
        highlightActiveSavedItem();
        updateStep1ButtonState();
        return;
    }

    try {
        if (bankType === 'variation') {
            await loadHomeworkQuestionsForVariation();
        }
        const result = await apiGet('get', { year, season, bankType, subject, grade, tier, week });
        if (result.success && result.data) {
            currentQuestions = result.data.questions || [];
            if (bankType === 'variation') {
                recalcVariationSubNums(currentQuestions);
            }
            if (window.Logger) Logger.action('load_question_bank', { year, season, bankType, subject, grade, tier, week, questionCount: currentQuestions.length });
        } else {
            currentQuestions = [];
        }
    } catch (e) {
        console.error('加载数据失败:', e);
        currentQuestions = [];
        showToast('加载数据失败，请检查网络');
    }

    isDirty = false;
    renderQuestionList();
    updateStatus();
    highlightActiveSavedItem();
    updateStep1ButtonState();

    // Background load thumbnails for loaded questions with smooth concurrency throttle (不阻塞主线程)
    preloadThumbnailsWithThrottle(currentQuestions).catch(() => {});
}

// 查找某道题对应的卡片 DOM（兼容单题行与大题聚合卡片）
function findQuestionCardDomByIndex(idx) {
    if (!questionItems) return null;
    const direct = questionItems.querySelector(`.question-item[data-index="${idx}"]`);
    if (direct) return direct;
    const groupCards = questionItems.querySelectorAll('.question-item[data-group-indices]');
    for (const card of groupCards) {
        const list = (card.dataset.groupIndices || '').split(',').map(Number);
        if (list.includes(Number(idx))) return card;
    }
    return questionItems.children[idx] || null;
}

// 后台平滑预热缩略图：严格限制并发数最大为 2，且每个切片解析完成后让出 25ms 主线程，保障界面交互 60 FPS
async function preloadThumbnailsWithThrottle(questions) {
    if (!Array.isArray(questions) || questions.length === 0) return;
    const tasks = [];
    const seenUrls = new Map();
    questions.forEach((q, idx) => {
        if (q.exercisePdf && q.exercisePdf.url && !q.exercisePdf.thumb) {
            tasks.push({ q, idx, type: 'exercise', pdfObj: q.exercisePdf });
        }
        if (q.answerPdf && q.answerPdf.url && !q.answerPdf.thumb) {
            tasks.push({ q, idx, type: 'answer', pdfObj: q.answerPdf });
        }
    });
    if (tasks.length === 0) return;

    let cursor = 0;
    const maxConcurrency = 2;
    const worker = async () => {
        while (cursor < tasks.length) {
            const task = tasks[cursor++];
            if (!task) break;
            try {
                const cropBox = getRegionCropThumbBox(task.q, task.type);
                let thumb = cropBox ? null : seenUrls.get(task.pdfObj.url);
                if (!thumb) {
                    thumb = await ensurePdfThumbnail(task.pdfObj, cropBox);
                    if (thumb && task.pdfObj.url && !cropBox) {
                        seenUrls.set(task.pdfObj.url, thumb);
                    }
                } else {
                    task.pdfObj.thumb = thumb;
                }
                if (thumb) {
                    const itemEl = findQuestionCardDomByIndex(task.idx);
                    if (itemEl) {
                        const actions = itemEl.querySelector('.question-pdf-actions');
                        const primaryIdx = parseInt(itemEl.dataset.index, 10);
                        const primaryQ = !isNaN(primaryIdx) && currentQuestions[primaryIdx] ? currentQuestions[primaryIdx] : task.q;
                        const renderIdx = !isNaN(primaryIdx) ? primaryIdx : task.idx;
                        if (actions) {
                            actions.innerHTML = `${renderPdfBtn(primaryQ, renderIdx, 'exercise')}${renderPdfBtn(primaryQ, renderIdx, 'answer')}`;
                        }
                    }
                }
            } catch (err) {
                console.warn('平滑生成缩略图跳过:', err);
            }
            // 主动让出 25ms 主线程微任务与渲染时间片
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    };

    const runners = [];
    for (let i = 0; i < Math.min(maxConcurrency, tasks.length); i++) {
        runners.push(worker());
    }
    await Promise.all(runners);
}

async function generatePdfThumbnailFromFile(file) {
    try {
        if (!window.pdfjsLib) return null;
        const data = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (pdf.numPages < 1) return null;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        // 轻量化缩略图：限制在 400px（卡片尺寸 32px，浮窗预览 300px，2x 视网膜高清足够锐利且体积降 95%）
        const targetWidth = Math.min(420, Math.max(280, Math.floor(base.width)));
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const thumb = canvas.toDataURL('image/jpeg', 0.68);
        page.cleanup();
        if (typeof pdf.destroy === 'function') { try { await pdf.destroy(); } catch (_) {} }
        return thumb;
    } catch (e) {
        console.warn('生成本地 PDF 缩略图失败:', e);
        return null;
    }
}

function getRegionCropThumbBox(q, type) {
    if (!q || !q.questionMeta || q.questionMeta.mode !== 'region_crop') return null;
    if (type === 'answer') {
        if (q.questionMeta.answerBox) return q.questionMeta.answerBox;
        if (Array.isArray(q.questionMeta.answerRegions) && q.questionMeta.answerRegions.length > 0) {
            return q.questionMeta.answerRegions[0];
        }
        return null;
    }
    if (q.questionMeta.box) return q.questionMeta.box;
    if (Array.isArray(q.questionMeta.regions) && q.questionMeta.regions.length > 0) {
        return q.questionMeta.regions[0];
    }
    return null;
}

async function ensurePdfThumbnail(pdfObj, cropRegion = null) {
    if (!pdfObj || !pdfObj.url || pdfObj.thumb) return pdfObj ? pdfObj.thumb : null;
    try {
        if (!window.pdfjsLib) return null;
        let data = regionPreviewBytesCache.get(pdfObj.url);
        if (!data) {
            const resp = await fetch(pdfObj.url);
            if (!resp.ok) return null;
            data = await resp.arrayBuffer();
            regionPreviewBytesCache.set(pdfObj.url, data);
        }
        const pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
        if (pdf.numPages < 1) return null;
        const pageNum = cropRegion
            ? Math.min(pdf.numPages, Math.max(1, (parseInt(cropRegion.pageOffset, 10) || 0) + 1))
            : 1;
        const page = await pdf.getPage(pageNum);
        const base = page.getViewport({ scale: 1 });
        const targetWidth = cropRegion
            ? Math.min(900, Math.max(560, Math.floor(base.width)))
            : Math.min(420, Math.max(280, Math.floor(base.width)));
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        if (cropRegion) {
            const sx = Math.max(0, Math.floor((cropRegion.x ?? 0) * canvas.width));
            const sy = Math.max(0, Math.floor((cropRegion.y ?? 0) * canvas.height));
            const sw = Math.max(12, Math.min(canvas.width - sx, Math.ceil((cropRegion.w ?? 1) * canvas.width)));
            const sh = Math.max(12, Math.min(canvas.height - sy, Math.ceil((cropRegion.h ?? 1) * canvas.height)));
            const out = document.createElement('canvas');
            const outW = Math.min(480, sw);
            const outScale = outW / sw;
            out.width = outW;
            out.height = Math.max(12, Math.round(sh * outScale));
            const octx = out.getContext('2d', { alpha: false });
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, out.width, out.height);
            octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
            pdfObj.thumb = out.toDataURL('image/jpeg', 0.8);
        } else {
            pdfObj.thumb = canvas.toDataURL('image/jpeg', 0.68);
        }

        page.cleanup();
        if (typeof pdf.destroy === 'function') { try { await pdf.destroy(); } catch (_) {} }
        return pdfObj.thumb;
    } catch (e) {
        console.warn('ensurePdfThumbnail 失败:', pdfObj.url, e);
        return null;
    }
}

// 0ms 保存按钮 Loading 状态管理（防重复点击与即时交互反馈）
let isSavingQuestions = false;
function setSaveButtonLoading(loading) {
    isSavingQuestions = loading;
    const saveBtn = document.getElementById('save-btn');
    if (!saveBtn) return;
    saveBtn.disabled = loading;
    if (loading) {
        if (!saveBtn.dataset.origHtml) {
            saveBtn.dataset.origHtml = saveBtn.innerHTML;
        }
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation: spin 0.8s linear infinite; margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
            </svg>
            <span>正在保存...</span>
        `;
    } else {
        if (saveBtn.dataset.origHtml) {
            saveBtn.innerHTML = saveBtn.dataset.origHtml;
            delete saveBtn.dataset.origHtml;
        } else {
            saveBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                </svg>
                <span>保存</span>
            `;
        }
    }
}

async function saveQuestions() {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法保存题库修改', 'warn');
        return;
    }
    // 自动清洗知识点末尾的标点符号（逗号、句号、分号、点、顿号等），避免与系统自带顿号重合
    currentQuestions.forEach(q => {
        if (q && q.topic && typeof cleanTopicTrailingPunctuation === 'function') {
            q.topic = cleanTopicTrailingPunctuation(q.topic);
        }
    });

    if (!currentQuestions || currentQuestions.length === 0) {
        showToast('题目列表为空，请先添加或导入题目', 'warn');
        return;
    }

    const isSlicing = currentQuestions.some(q => 
        (q.exercisePdf && q.exercisePdf.status === 'uploading') ||
        (q.answerPdf && q.answerPdf.status === 'uploading')
    );
    if (isSlicing) {
        showToast('题目切片正在后台生成与上传中，请稍候...', 'warn');
        return;
    }

    // 必填项校验：知识点（预习题库选填）和 错题文件（题目 PDF 必填）
    for (let i = 0; i < currentQuestions.length; i++) {
        const q = currentQuestions[i];
        const qNum = q.id || (i + 1);
        const topic = (q.topic || '').trim();
        const hasExercise = Boolean(q.exercisePdf && q.exercisePdf.url);

        const isVar = getBankType() === 'variation';
        const isPreview = getBankType() === 'preview';

        if (!topic && !isPreview) {
            if (isVar) {
                showToast(`第 ${qNum} 题关联的原题缺少知识点，请在课后巩固中完善`, 'warn');
            } else {
                showToast(`第 ${qNum} 题【知识点】为必填项，请填写完整`, 'warn');
            }
            const targetCard = findQuestionCardDomByIndex(i);
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const topicInput = targetCard.querySelector(`.question-topic-input[data-sub-index="${i}"]`) || targetCard.querySelector('.question-topic-input') || targetCard.querySelector('.var-item-left');
                if (topicInput) {
                    if (typeof topicInput.focus === 'function') topicInput.focus();
                    topicInput.classList.add('input-error');
                    setTimeout(() => topicInput.classList.remove('input-error'), 2500);
                }
            }
            return;
        }

        if (!hasExercise) {
            showToast(`第 ${qNum} 题【错题文件】（题目PDF）为必传项，请上传`, 'warn');
            const targetCard = findQuestionCardDomByIndex(i);
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const exBtn = targetCard.querySelector('.q-pdf-thumb-card.empty, .q-pdf-btn.empty');
                if (exBtn) {
                    exBtn.classList.add('pulse-active');
                    setTimeout(() => exBtn.classList.remove('pulse-active'), 2500);
                }
            }
            return;
        }

        const hasAnswer = Boolean(q.answerPdf && q.answerPdf.url);
        if (!hasAnswer) {
            showToast(`第 ${qNum} 题【答案解析】（答案PDF）为必传项，请上传`, 'warn');
            const targetCard = findQuestionCardDomByIndex(i);
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const emptyBtns = targetCard.querySelectorAll('.q-pdf-thumb-card.empty, .q-pdf-btn.empty');
                const ansBtn = emptyBtns[emptyBtns.length - 1];
                if (ansBtn) {
                    ansBtn.classList.add('pulse-active');
                    setTimeout(() => ansBtn.classList.remove('pulse-active'), 2500);
                }
            }
            return;
        }
    }

    // 0ms 瞬间反馈：校验通过后立刻将保存按钮置为 loading 态，防连击并给用户即时视觉确认
    setSaveButtonLoading(true);

    const bankType = getBankType();
    // 预习题库及举一反三题库不需要微课讲解链接
    const questionsForSave = (bankType === 'preview' || bankType === 'variation')
        ? currentQuestions.map(q => ({ ...q, videoUrl: '', video_url: '' }))
        : currentQuestions;
    const data = {
        bankType,
        year: yearSelect ? parseInt(yearSelect.value) : 2026,
        season: seasonSelect ? seasonSelect.value : '春',
        subject: subjectSelect.value,
        grade: gradeSelect.value,
        tier: tierSelect.value,
        week: parseInt(weekSelect.value),
        questions: questionsForSave,
        teacher_username: window.currentUser?.username || '',
        teacher_name: window.currentUser?.real_name || ''
    };

    // 覆盖检测：检查当前专题在服务端是否已有历史题目数据
    try {
        const checkRes = await apiGet('get', {
            year: data.year,
            season: data.season,
            bankType: data.bankType,
            subject: data.subject,
            grade: data.grade,
            tier: data.tier,
            week: data.week
        });
        if (checkRes && checkRes.success && checkRes.data && Array.isArray(checkRes.data.questions) && checkRes.data.questions.length > 0) {
            const diffs = compareQuestions(checkRes.data.questions, questionsForSave);
            // 如果对比没有任何变动，则不弹窗，直接保存
            if (diffs.length > 0) {
                setSaveButtonLoading(false); // 弹出确认弹窗前解锁按钮
                const currentSummary = [data.grade, data.subject, `${data.tier}班`, getTopicLabel(data.week)].filter(Boolean).join(' · ');
                showQbankOverwriteModal({
                    title: '题目配置变动确认',
                    summary: `检测到【<strong>${escapeHtml(currentSummary)}</strong>】已有配置与本次拟保存内容存在变动，保存将<strong>覆盖原有配置</strong>`,
                    meta: checkRes.data,
                    diffs: diffs,
                    confirmText: '确认覆盖保存',
                    onConfirm: () => executeSaveQuestions(data),
                    onCancel: () => setSaveButtonLoading(false)
                });
                return;
            }
        }
    } catch (checkErr) {
        console.warn('检查历史题库配置失败:', checkErr);
    }

    await executeSaveQuestions(data);
}

function compareQuestions(oldQuestions, newQuestions) {
    const diffs = [];
    const oldList = oldQuestions || [];
    const newList = newQuestions || [];

    // 1. 题数变动
    if (oldList.length !== newList.length) {
        diffs.push(`题数变动：历史共 <strong>${oldList.length}</strong> 道题 → 本次拟保存 <strong>${newList.length}</strong> 道题`);
    }

    const maxLen = Math.max(oldList.length, newList.length);
    for (let i = 0; i < maxLen; i++) {
        const oldQ = oldList[i];
        const newQ = newList[i];
        const qNum = (newQ && (newQ.id || newQ.question_num)) || (oldQ && (oldQ.id || oldQ.question_num)) || (i + 1);

        if (!oldQ && newQ) {
            diffs.push(`第 <strong>${qNum}</strong> 题（新增）：考查「${escapeHtml(newQ.topic || '未填写知识点')}」`);
        } else if (oldQ && !newQ) {
            diffs.push(`第 <strong>${qNum}</strong> 题（删除）：原考查「${escapeHtml(oldQ.topic || '未填写知识点')}」`);
        } else {
            const changes = [];
            const oldTopic = (oldQ.topic || '').trim();
            const newTopic = (newQ.topic || '').trim();
            if (oldTopic !== newTopic) {
                changes.push(`知识点修改为「<span style="color:#38bdf8;">${escapeHtml(newTopic)}</span>」（原：「${escapeHtml(oldTopic)}」）`);
            }

            const oldVideo = (oldQ.videoUrl || '').trim();
            const newVideo = (newQ.videoUrl || '').trim();
            if (oldVideo !== newVideo) {
                if (!oldVideo && newVideo) changes.push(`新增微课视频链接`);
                else if (oldVideo && !newVideo) changes.push(`删除微课视频链接`);
                else changes.push(`更新微课视频链接`);
            }

            const oldExUrl = oldQ.exercisePdf?.url || oldQ.exercisePdf?.name || '';
            const newExUrl = newQ.exercisePdf?.url || newQ.exercisePdf?.name || '';
            if (oldExUrl !== newExUrl) {
                changes.push(`更新题目切片文件`);
            }

            const oldAnsUrl = oldQ.answerPdf?.url || oldQ.answerPdf?.name || '';
            const newAnsUrl = newQ.answerPdf?.url || newQ.answerPdf?.name || '';
            if (oldAnsUrl !== newAnsUrl) {
                changes.push(`更新答案解析文件`);
            }

            const oldMetaStr = JSON.stringify(oldQ.questionMeta || null);
            const newMetaStr = JSON.stringify(newQ.questionMeta || null);
            if (oldMetaStr !== newMetaStr) {
                changes.push(`更新大题分组或小问框选坐标`);
            }

            if (changes.length > 0) {
                diffs.push(`第 <strong>${qNum}</strong> 题：${changes.join('；')}`);
            }
        }
    }
    return diffs;
}

function showQbankOverwriteModal(options) {
    const { title, summary, meta, diffs, onConfirm, onCancel, confirmText } = options;
    const updatedAt = (meta && meta.updatedAtFormatted) ? meta.updatedAtFormatted : (meta && meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间');
    const operator = (meta && meta.operatorName) ? `${meta.operatorName} (${meta.operator || meta.updatedBy || meta.createdBy || ''})` : ((meta && (meta.operator || meta.updatedBy || meta.createdBy)) || '未知教师');

    let diffsHtml = (diffs || []).map((d, idx) => `
        <div style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; background:rgba(255,255,255,0.04); border-radius:6px; border:1px solid rgba(255,255,255,0.07); margin-bottom:6px; font-size:0.85rem; line-height:1.5;">
            <span style="color:#f59e0b; flex-shrink:0; font-weight:bold;">${idx + 1}.</span>
            <div style="flex:1; color:var(--text-primary,#fff);">${d}</div>
        </div>
    `).join('');

    const bodyHtml = `
        <div style="font-size:0.9rem; line-height:1.6; text-align:left;">
            <div style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px 12px; margin-bottom:12px; color:#fca5a5; display:flex; align-items:flex-start; gap:8px;">
                <svg style="flex-shrink:0; width:18px; height:18px; color:#ef4444; margin-top:2px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <div style="flex:1;">${summary || '检测到该专题配置存在变动，本次操作将<strong>覆盖原有配置</strong>'}</div>
            </div>

            <div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:12px; font-size:0.8rem; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); padding:8px 12px; border-radius:8px;">
                <div><span style="color:var(--text-secondary,#94a3b8);">上次保存：</span><strong style="color:var(--text-primary,#fff);">${updatedAt}</strong></div>
                <div><span style="color:var(--text-secondary,#94a3b8);">录入教师：</span><strong style="color:var(--text-primary,#fff);">${escapeHtml(operator)}</strong></div>
            </div>

            <div style="font-weight:600; color:var(--text-primary,#fff); margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;">
                <span>检测到以下 ${diffs.length} 处变动：</span>
            </div>

            <div style="max-height:240px; overflow-y:auto; padding-right:4px; margin-bottom:6px;" class="custom-scrollbar">
                ${diffsHtml}
            </div>
        </div>
    `;

    showCustomDialog({
        title: title || '题目配置变动确认',
        body: bodyHtml,
        maxWidth: '560px',
        confirmText: confirmText || '确认覆盖保存',
        cancelText: '取消',
        danger: true,
        onConfirm: onConfirm,
        onCancel: onCancel
    });
}

// ── 班层互通同步逻辑 (面向内部教师，支持全班层自由多选互通) ──
window._selectedSyncTiers = new Set();
window._isTierSyncAutoPrompt = false;

window.toggleTierSyncItem = function(cardEl, tierName) {
    if (!cardEl || !tierName) return;
    if (window._selectedSyncTiers.has(tierName)) {
        window._selectedSyncTiers.delete(tierName);
        cardEl.classList.remove('selected');
        const cb = cardEl.querySelector('.tier-sync-checkbox');
        if (cb) cb.checked = false;
    } else {
        window._selectedSyncTiers.add(tierName);
        cardEl.classList.add('selected');
        const cb = cardEl.querySelector('.tier-sync-checkbox');
        if (cb) cb.checked = true;
    }
    const count = window._selectedSyncTiers.size;
    const confirmBtn = document.getElementById('dialog-confirm');
    if (confirmBtn) {
        if (window._isTierSyncAutoPrompt) {
            confirmBtn.textContent = count > 0 ? `立即保存 (${count})` : '立即保存';
        } else {
            confirmBtn.textContent = count > 0 ? `立即同步 (${count})` : '立即同步';
        }
    }
};

function getCandidateTiers(currentTier) {
    const predefinedTiers = ['S+', 'S', 'A+', 'A', 'U'];
    const selectTiers = [];
    if (tierSelect && tierSelect.options) {
        for (let i = 0; i < tierSelect.options.length; i++) {
            const val = String(tierSelect.options[i].value || '').trim();
            if (val) selectTiers.push(val);
        }
    }
    const dataTiers = Array.isArray(allSavedDataList)
        ? allSavedDataList.map(it => String(it.tier || '').trim()).filter(Boolean)
        : [];
    const all = Array.from(new Set([...predefinedTiers, ...selectTiers, ...dataTiers]));
    const curUpper = String(currentTier || '').trim().toUpperCase();
    return all.filter(t => t && t.toUpperCase() !== curUpper);
}

function getTierSavedMeta(bankType, year, season, subject, grade, tier, week) {
    if (!Array.isArray(allSavedDataList)) return null;
    const curWeek = parseInt(week);
    const curYear = parseInt(year);
    const targetUpper = String(tier || '').trim().toUpperCase();
    return allSavedDataList.find(it => 
        (it.bankType === bankType || (!it.bankType && bankType === 'homework')) &&
        parseInt(it.year) === curYear &&
        it.season === season &&
        it.subject === subject &&
        it.grade === grade &&
        String(it.tier || '').trim().toUpperCase() === targetUpper &&
        parseInt(it.week) === curWeek
    ) || null;
}

let isSyncingTiers = false;
async function doBatchSyncTiers(data, targetTiers, currentTier, isAutoPrompt = false) {
    if (!targetTiers || targetTiers.length === 0) return;
    if (isSyncingTiers) return;
    isSyncingTiers = true;

    const tierSyncBtn = document.getElementById('tier-sync-btn');
    const origSyncHtml = tierSyncBtn ? tierSyncBtn.innerHTML : '';
    if (tierSyncBtn) {
        tierSyncBtn.disabled = true;
        tierSyncBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon" style="animation: spin 0.8s linear infinite; margin-right: 4px;">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path>
            </svg>
            <span>正在同步...</span>
        `;
    }
    try {
        const tierLabels = targetTiers.map(t => `${t}班`).join('、');
        showToast(`正在同步至 ${tierLabels}...`);
        let successCount = 0;
        const errors = [];
        for (const targetTier of targetTiers) {
            try {
                const syncData = {
                    ...data,
                    tier: targetTier,
                    questions: JSON.parse(JSON.stringify(currentQuestions))
                };
                const syncRes = await apiPost(syncData);
                if (syncRes && syncRes.success) {
                    successCount++;
                    if (window.Logger) {
                        Logger.action('sync_question_bank_tier', {
                            fromTier: currentTier,
                            toTier: targetTier,
                            grade: data.grade,
                            subject: data.subject,
                            week: data.week
                        });
                    }
                } else {
                    errors.push(`${targetTier}班: ${syncRes?.error || '保存失败'}`);
                }
            } catch (err) {
                console.error(`同步至 ${targetTier}班 失败:`, err);
                errors.push(`${targetTier}班: 网络异常`);
            }
        }
        renderSavedDataList();
        if (errors.length === 0) {
            showToast(isAutoPrompt ? `保存成功，已同步至 ${tierLabels}` : `已同步至 ${tierLabels}`, 'success');
        } else if (successCount > 0) {
            showToast(`部分同步成功 (${successCount}/${targetTiers.length})，失败: ${errors.join('; ')}`, 'warn');
        } else {
            showToast(`同步失败: ${errors.join('; ')}`, 'warn');
        }
    } finally {
        isSyncingTiers = false;
        if (tierSyncBtn) {
            tierSyncBtn.disabled = false;
            tierSyncBtn.innerHTML = origSyncHtml;
        }
    }
}

async function doSyncTier(data, targetTier, targetSummary, currentTier) {
    return doBatchSyncTiers(data, [targetTier], currentTier);
}

async function handleTierSyncConfirm(data, targetTiers, isAutoPrompt = false) {
    if (!targetTiers || targetTiers.length === 0) return;
    showToast('正在检测目标班层配置...');
    const diffTiers = [];
    for (const targetTier of targetTiers) {
        try {
            const checkRes = await apiGet('get', {
                year: data.year,
                season: data.season,
                bankType: data.bankType,
                subject: data.subject,
                grade: data.grade,
                tier: targetTier,
                week: data.week
            });
            if (checkRes && checkRes.success && checkRes.data && Array.isArray(checkRes.data.questions) && checkRes.data.questions.length > 0) {
                const diffs = compareQuestions(checkRes.data.questions, currentQuestions);
                if (diffs.length > 0) {
                    diffTiers.push({
                        tier: targetTier,
                        meta: checkRes.data,
                        diffs: diffs
                    });
                }
            }
        } catch (e) {
            console.warn(`检测班层 ${targetTier} 失败:`, e);
        }
    }

    if (diffTiers.length > 0) {
        const diffsHtml = diffTiers.map(dt => {
            const op = dt.meta.operatorName || dt.meta.operator || '未知教师';
            const time = dt.meta.updatedAtFormatted || (dt.meta.updatedAt ? new Date(dt.meta.updatedAt).toLocaleDateString() : '');
            const items = dt.diffs.map(d => `<div style="padding:2px 0;">• ${d}</div>`).join('');
            return `
                <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px 10px; margin-bottom:8px; font-size:0.83rem;">
                    <div style="font-weight:600; color:var(--text-primary); margin-bottom:4px; display:flex; justify-content:space-between;">
                        <span>【${escapeHtml(dt.tier)}班】现有 ${dt.meta.questions?.length || 0} 题</span>
                        <span style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(op)} ${escapeHtml(time)}</span>
                    </div>
                    <div style="color:var(--text-secondary); line-height:1.4;">${items}</div>
                </div>
            `;
        }).join('');

        const bodyHtml = `
            <div style="font-size:0.9rem; line-height:1.5; text-align:left;">
                <div style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px 12px; margin-bottom:12px; color:#fca5a5;">
                    检测到 <strong>${diffTiers.length}</strong> 个目标班层已有题目变动，同步将<strong>完全覆盖</strong>原有题目
                </div>
                <div style="max-height:220px; overflow-y:auto; margin-bottom:8px;" class="custom-scrollbar">
                    ${diffsHtml}
                </div>
            </div>
        `;

        showCustomDialog({
            title: '覆盖目标班层配置确认',
            body: bodyHtml,
            maxWidth: '560px',
            confirmText: `确认覆盖并同步 (${targetTiers.length}个班层)`,
            cancelText: '取消',
            danger: true,
            onConfirm: () => doBatchSyncTiers(data, targetTiers, data.tier, isAutoPrompt),
            onCancel: () => {
                if (isAutoPrompt) {
                    showToast('保存成功（已取消同步至其他班层）', 'info');
                }
            }
        });
        return;
    }

    await doBatchSyncTiers(data, targetTiers, data.tier, isAutoPrompt);
}

function openTierSyncModal(sourceData = null, isAutoPrompt = false) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法同步题库', 'warn');
        return;
    }

    const bankType = getBankType();
    const year = yearSelect ? parseInt(yearSelect.value) : 2026;
    const season = seasonSelect ? seasonSelect.value : '春';
    const subject = subjectSelect ? subjectSelect.value : '';
    const grade = gradeSelect ? gradeSelect.value : '';
    const tier = tierSelect ? tierSelect.value : '';
    const week = weekSelect ? parseInt(weekSelect.value) : 0;

    if (!subject || !grade || !tier || !week) {
        showToast('请先选择学科、年级、班层及专题', 'warn');
        return;
    }
    if (currentQuestions.length === 0) {
        showToast('当前题目列表为空，无可同步题目', 'warn');
        return;
    }
    const isSlicing = currentQuestions.some(q => 
        (q.exercisePdf && q.exercisePdf.status === 'uploading') ||
        (q.answerPdf && q.answerPdf.status === 'uploading')
    );
    if (isSlicing) {
        showToast('题目切片正在后台生成与上传中，请稍候再同步...', 'warn');
        return;
    }

    const questionsForSave = (bankType === 'preview' || bankType === 'variation')
        ? currentQuestions.map(q => ({ ...q, videoUrl: '', video_url: '' }))
        : currentQuestions;
    const data = sourceData || {
        bankType,
        year,
        season,
        subject,
        grade,
        tier,
        week,
        questions: questionsForSave,
        teacher_username: window.currentUser?.username || '',
        teacher_name: window.currentUser?.real_name || ''
    };

    const candidateTiers = getCandidateTiers(data.tier);
    if (candidateTiers.length === 0) {
        if (!isAutoPrompt) {
            showToast('未找到其他可选的目标班层', 'warn');
        }
        return;
    }

    // 默认不勾选任何班层
    window._selectedSyncTiers = new Set();
    window._isTierSyncAutoPrompt = Boolean(isAutoPrompt);

    const currentSummary = [data.grade, data.subject, `${data.tier}班`, getTopicLabel(data.week)].filter(Boolean).join(' · ');

    const gridHtml = candidateTiers.map(t => {
        const meta = getTierSavedMeta(data.bankType, data.year, data.season, data.subject, data.grade, t, data.week);
        const badgeHtml = meta 
            ? `<span class="tier-sync-badge exist">已有 ${meta.questionCount || 0} 题 (覆盖)</span>`
            : `<span class="tier-sync-badge empty">未录入</span>`;
        return `
            <div class="tier-sync-item" onclick="window.toggleTierSyncItem(this, '${escapeHtml(t)}')">
                <div class="tier-sync-item-top">
                    <input type="checkbox" class="tier-sync-checkbox" onclick="event.stopPropagation(); window.toggleTierSyncItem(this.closest('.tier-sync-item'), '${escapeHtml(t)}');">
                    <span class="tier-sync-item-name">${escapeHtml(t)} 班</span>
                </div>
                ${badgeHtml}
            </div>
        `;
    }).join('');

    const bodyHtml = `
        <div class="tier-sync-box">
            <div class="tier-sync-source-card">
                当前配置：<strong>${escapeHtml(currentSummary)}</strong> (${currentQuestions.length} 道题)
            </div>
            <div class="tier-sync-label">选择要同步的目标班层（支持多选）：</div>
            <div class="tier-sync-grid">
                ${gridHtml}
            </div>
            <div class="tier-sync-tips">
                同步将完整覆盖目标班层的题目及解析配置。
            </div>
        </div>
    `;

    showCustomDialog({
        title: '班层题目互通',
        body: bodyHtml,
        maxWidth: '520px',
        confirmText: isAutoPrompt ? '立即保存' : '立即同步',
        cancelText: isAutoPrompt ? '不同步直接保存' : '取消',
        onCancel: () => {
            if (isAutoPrompt) {
                showToast('保存成功', 'success');
            }
        },
        onConfirm: async () => {
            const targetTiers = Array.from(window._selectedSyncTiers || []);
            if (targetTiers.length === 0) {
                if (isAutoPrompt) {
                    showToast('保存成功', 'success');
                } else {
                    showToast('未选择任何目标班层，已取消同步', 'info');
                }
                return;
            }
            await handleTierSyncConfirm(data, targetTiers, isAutoPrompt);
        }
    });
}
window.openTierSyncModal = openTierSyncModal;

async function executeSaveQuestions(data) {
    setSaveButtonLoading(true);
    try {
        const result = await apiPost(data);
        if (result.success) {
            isDirty = false;
            // 性能优化：不再执行全量 DOM 清空重绘 renderQuestionList()，仅更新保存状态与已有统计
            updateStatus();
            renderSavedDataList();
            if (data.bankType === 'preview') {
                const filledCount = currentQuestions.filter(q => q.topic && q.topic.trim()).length;
                if (filledCount === 0) {
                    showToast(`已保存 ${currentQuestions.length} 道预习题目（未填知识点，错题本将按题号呈现）`, 'success');
                } else if (filledCount < currentQuestions.length) {
                    showToast(`已保存 ${currentQuestions.length} 道预习题目（${filledCount} 题已填知识点）`, 'success');
                } else {
                    showToast(`已保存 ${currentQuestions.length} 道预习题目`, 'success');
                }
            } else {
                showToast(`已保存 ${currentQuestions.length} 道题目`, 'success');
            }

            if (window.Logger) {
                Logger.action('save_question_bank', {
                    bankType: data.bankType,
                    year: data.year,
                    season: data.season,
                    subject: data.subject,
                    grade: data.grade,
                    tier: data.tier,
                    week: data.week,
                    questionCount: currentQuestions.length
                });
            }
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (e) {
        console.error('保存失败:', e);
        showToast('保存失败，请检查网络', 'error');
    } finally {
        setSaveButtonLoading(false);
    }
}

function deleteStoredData(subject, grade, tier, week, year, season, bankType) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法删除题库', 'warn');
        return;
    }
    const delYear = year || (yearSelect ? parseInt(yearSelect.value) : 2026);
    const delSeason = season || (seasonSelect ? seasonSelect.value : '春');
    const delBankType = (bankType === 'preview' || bankType === 'variation') ? bankType : 'homework';
    showCustomDialog({
        title: '删除数据',
        body: `确定要删除「${getBankTypeLabel(delBankType)} · ${delYear} ${delSeason}季 · ${subject} · ${grade} · ${tier} · ${getTopicLabel(week)}」的题目数据吗？此操作不可恢复。`,
        confirmText: '删除',
        danger: true,
        onConfirm: async () => {
            try {
                const result = await apiDelete({ year: delYear, season: delSeason, bankType: delBankType, subject, grade, tier, week, teacher_username: window.currentUser?.username || '' });
                if (result.success) {
                    const curYear = yearSelect ? parseInt(yearSelect.value) : 2026;
                    const curSeason = seasonSelect ? seasonSelect.value : '春';
                    if (delBankType === getBankType() && delYear === curYear && delSeason === curSeason && subject === subjectSelect.value && grade === gradeSelect.value && tier === tierSelect.value && String(week) === weekSelect.value) {
                        await loadCurrentData();
                    }
                    renderSavedDataList();
                    showToast('已删除');
                    
                    if (window.Logger) {
                        Logger.action('delete_question_bank', {
                            bankType: delBankType,
                            year: delYear,
                            season: delSeason,
                            subject: subject,
                            grade: grade,
                            tier: tier,
                            week: week
                        });
                    }
                } else {
                    showToast('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (e) {
                console.error('删除失败:', e);
                showToast('删除失败，请检查网络');
            }
        }
    });
}

// ========== Question List Operations ==========
function getMaxId() {
    if (currentQuestions.length === 0) return 0;
    let max = 0;
    currentQuestions.forEach(q => {
        const ids = String(q.id).split(/[,、，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (ids.length > 0) {
            max = Math.max(max, ...ids);
        }
    });
    return max;
}

function addQuestion() {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法添加题目', 'warn');
        return;
    }
    const nextId = getMaxId() + 1;
    const isVar = getBankType() === 'variation';
    if (isVar) {
        const buckets = getConsolidationBuckets();
        const nextBucket = buckets[currentQuestions.length] || buckets[buckets.length - 1] || null;
        const pNum = nextBucket ? nextBucket.parentNum : (currentQuestions.reduce((m, q) => Math.max(m, q.parentQuestionNum || 1), 1));
        const inheritedTopic = nextBucket ? (nextBucket.topic || '') : '';
        currentQuestions.push({
            id: nextId,
            parentQuestionNum: pNum,
            parentQuestionNums: [pNum],
            subNum: 1,
            topic: inheritedTopic,
            videoUrl: ''
        });
        recalcVariationSubNums(currentQuestions);
    } else {
        currentQuestions.push({ id: nextId, topic: '', videoUrl: '' });
    }
    isDirty = true;
    renderQuestionList();
    updateStatus();
    // Focus the new input
    setTimeout(() => {
        const inputs = questionItems.querySelectorAll('.question-topic-input');
        if (inputs.length > 0) {
            inputs[inputs.length - 1].focus();
        }
    }, 50);
}

function addBatchQuestions() {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法批量添加题目', 'warn');
        return;
    }
    showCustomDialog({
        title: '批量添加题目',
        body: '输入要添加的题目数量：',
        showInput: true,
        inputDefault: '16',
        confirmText: '添加',
        onConfirm: (val) => {
            const count = parseInt(val);
            if (!count || count <= 0 || count > 100) {
                showToast('请输入1-100之间的数字');
                return;
            }
            const startId = getMaxId() + 1;
            const isVar = getBankType() === 'variation';
            const buckets = isVar ? getConsolidationBuckets() : [];
            for (let i = 0; i < count; i++) {
                if (isVar) {
                    const idx = currentQuestions.length;
                    const b = buckets[idx] || buckets[buckets.length - 1] || null;
                    currentQuestions.push({
                        id: startId + i,
                        parentQuestionNum: b ? b.parentNum : (idx + 1),
                        subNum: 1,
                        topic: b ? (b.topic || '') : '',
                        videoUrl: ''
                    });
                } else {
                    currentQuestions.push({ id: startId + i, topic: '', videoUrl: '' });
                }
            }
            if (isVar) recalcVariationSubNums(currentQuestions);
            isDirty = true;
            renderQuestionList();
            updateStatus();
            showToast(`已添加 ${count} 道题目`);
        }
    });
}

function removeQuestion(index) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法删除题目', 'warn');
        return;
    }
    currentQuestions.splice(index, 1);
    if (getBankType() === 'variation') {
        recalcVariationSubNums(currentQuestions);
    }
    // Do not re-number automatically to preserve merged groups
    isDirty = true;
    renderQuestionList();
    updateStatus();
}

function clearAllQuestions() {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法清空题目', 'warn');
        return;
    }
    if (currentQuestions.length === 0) return;
    showCustomDialog({
        title: '清空题目列表',
        body: '确定要清空当前所有题目吗？',
        confirmText: '清空',
        danger: true,
        onConfirm: () => {
            currentSlicingSessionId++;
            const progressPanel = document.getElementById('qb-slice-progress-panel');
            if (progressPanel) progressPanel.style.display = 'none';
            const saveBtn = document.getElementById('save-btn');
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                        <polyline points="17 21 17 13 7 13 7 21"></polyline>
                        <polyline points="7 3 7 8 15 8"></polyline>
                    </svg>
                    保存
                `;
            }
            const syncBtn = document.getElementById('tier-sync-btn');
            if (syncBtn) syncBtn.disabled = false;

            currentQuestions = [];
            isDirty = true;
            renderQuestionList();
            updateStatus();
            showToast('已清空');
        }
    });
}

function onTopicChange(index, value) {
    if (index >= 0 && index < currentQuestions.length) {
        currentQuestions[index].topic = value;
        isDirty = true;
        updateStatus();
    }
}

function autoResizeTopicTextarea(el) {
    if (!el) return;
    if (el.offsetParent === null && !el.matches(':focus')) {
        return;
    }
    el.style.height = 'auto';
    const targetHeight = Math.max(38, el.scrollHeight);
    el.style.height = targetHeight + 'px';
    if (targetHeight > 320) {
        el.style.overflowY = 'auto';
    } else {
        el.style.overflowY = 'hidden';
    }
}
window.autoResizeTopicTextarea = autoResizeTopicTextarea;

function resizeAllTopicTextareas() {
    requestAnimationFrame(() => {
        const textareas = document.querySelectorAll('.question-topic-input');
        textareas.forEach(el => {
            if (el.offsetParent !== null) {
                el.style.height = 'auto';
                const targetHeight = Math.max(38, el.scrollHeight);
                el.style.height = targetHeight + 'px';
                if (targetHeight > 320) {
                    el.style.overflowY = 'auto';
                } else {
                    el.style.overflowY = 'hidden';
                }
            }
        });
    });
}
window.resizeAllTopicTextareas = resizeAllTopicTextareas;

function onTopicBlur(index, inputEl) {
    if (index >= 0 && index < currentQuestions.length) {
        const raw = currentQuestions[index].topic || '';
        const cleaned = typeof cleanTopicTrailingPunctuation === 'function' 
            ? cleanTopicTrailingPunctuation(raw) 
            : raw.replace(/[\s,，.。;；:：、\-_—]+$/u, '').trim();
        if (cleaned !== raw) {
            currentQuestions[index].topic = cleaned;
            if (inputEl) {
                inputEl.value = cleaned;
                autoResizeTopicTextarea(inputEl);
            }
            isDirty = true;
            updateStatus();
        }
    }
}

function onVideoUrlChange(index, value) {
    if (index >= 0 && index < currentQuestions.length) {
        currentQuestions[index].videoUrl = value.trim();
        isDirty = true;
        updateStatus();

        // 动态同步更新该行的微课快捷预览链接小图标
        const itemEl = questionItems.querySelector(`.question-item[data-index="${index}"]`);
        if (itemEl) {
            const wrap = itemEl.querySelector('.question-video-input-wrap');
            if (wrap) {
                let link = wrap.querySelector('.video-preview-link');
                const v = value.trim();
                if (v) {
                    if (!link) {
                        link = document.createElement('a');
                        link.className = 'video-preview-link';
                        link.target = '_blank';
                        link.title = '新窗口打开微课链接';
                        link.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
                        wrap.appendChild(link);
                    }
                    link.href = v;
                } else if (link) {
                    link.remove();
                }
            }
        }
    }
}
window.onVideoUrlChange = onVideoUrlChange;

function onIdChange(index, value) {
    if (index < 0 || index >= currentQuestions.length) return;
    const num = Number(value);
    if (value.trim() === '' || isNaN(num) || num <= 0 || !Number.isInteger(num)) {
        showToast('请输入正整数题号');
        const input = questionItems.querySelectorAll('.question-id-input')[index];
        if (input) input.value = currentQuestions[index].id;
        return;
    }
    currentQuestions[index].id = num;
    isDirty = true;
    updateStatus();
}

function mergeToTarget(sourceIndex, targetIndex) {
    const source = currentQuestions[sourceIndex];
    const target = currentQuestions[targetIndex];
    
    if (source.topic && target.topic && source.topic.trim() !== target.topic.trim()) {
        showCustomDialog({
            title: '知识点冲突',
            body: `目标题目已有知识点：<b>${escapeHtml(target.topic)}</b><br>当前题目知识点：<b>${escapeHtml(source.topic)}</b><br><br>合并后将保留目标题目的知识点，确定合并吗？`,
            confirmText: '继续合并',
            danger: true,
            onConfirm: () => executeMerge(sourceIndex, targetIndex)
        });
        return;
    }
    executeMerge(sourceIndex, targetIndex);
}

function executeMerge(sourceIndex, targetIndex) {
    const source = currentQuestions[sourceIndex];
    const target = currentQuestions[targetIndex];
    
    const combinedIdsStr = target.id + ", " + source.id;
    const ids = combinedIdsStr.split(/[,、，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const uniqueSorted = [...new Set(ids)].sort((a,b)=>a-b);
    target.id = uniqueSorted.join(', ');
    
    if (!target.topic && source.topic) {
        target.topic = source.topic;
    }
    if (!target.videoUrl && source.videoUrl) {
        target.videoUrl = source.videoUrl;
    }
    
    currentQuestions.splice(sourceIndex, 1);
    isDirty = true;
    renderQuestionList();
    updateStatus();
}

function mergeWithPrevious(index) {
    if (index > 0 && index < currentQuestions.length) {
        mergeToTarget(index, index - 1);
    }
}

function openMergeDialog(index) {
    if (currentQuestions.length <= 1) {
        showToast('没有其他题目可以合并');
        return;
    }
    const optionsHTML = currentQuestions.map((q, i) => {
        if (i === index) return '';
        const t = q.topic ? q.topic : '未填写知识点';
        return `<option value="${i}">合并到: 包含题号 [${q.id}] (${escapeHtml(t)})</option>`;
    }).join('');

    showCustomDialog({
        title: '合并题目',
        body: `<p style="margin-bottom:12px; font-size:0.9rem; color:var(--text-secondary);">请选择要将 <b>包含题号 [${currentQuestions[index].id}] 的行</b> 合并到哪里：</p>
               <select id="merge-target-select" class="qb-select" style="width:100%;">
                   ${optionsHTML}
               </select>`,
        confirmText: '确认合并',
        onConfirm: () => {
            const targetSelect = document.getElementById('merge-target-select');
            if (targetSelect) {
                const targetIndex = parseInt(targetSelect.value);
                if (!isNaN(targetIndex) && targetIndex >= 0 && targetIndex < currentQuestions.length) {
                    mergeToTarget(index, targetIndex);
                }
            }
        }
    });
}

// ========== Step 4 Big Question Group Helpers ==========
const expandedBigQuestionSubTopicGroups = new Set();

function getQuestionGroupKey(q) {
    if (!q || !q.questionMeta || !Array.isArray(q.questionMeta.groupNums) || q.questionMeta.groupNums.length <= 1) {
        return null;
    }
    return q.questionMeta.groupNums.map(n => parseInt(n, 10)).filter(n => n > 0).sort((a, b) => a - b).join(',');
}

function getBigQuestionGroupMemberIndices(index) {
    const q = currentQuestions[index];
    if (!q) return [index];
    const key = getQuestionGroupKey(q);
    if (!key) return [index];
    const indices = [];
    currentQuestions.forEach((item, idx) => {
        if (getQuestionGroupKey(item) === key) {
            indices.push(idx);
        }
    });
    return indices.length > 0 ? indices : [index];
}

function onBigGroupTopicChange(firstIndex, value) {
    const indices = getBigQuestionGroupMemberIndices(firstIndex);
    indices.forEach(idx => {
        if (currentQuestions[idx]) {
            currentQuestions[idx].topic = value;
            const subInput = questionItems ? questionItems.querySelector(`.question-topic-input[data-sub-index="${idx}"]`) : null;
            if (subInput && subInput.value !== value) {
                subInput.value = value;
            }
        }
    });
    isDirty = true;
    updateStatus();
}
window.onBigGroupTopicChange = onBigGroupTopicChange;

function onBigGroupTopicBlur(firstIndex, inputEl) {
    const indices = getBigQuestionGroupMemberIndices(firstIndex);
    const raw = inputEl ? inputEl.value : (currentQuestions[firstIndex]?.topic || '');
    const cleaned = typeof cleanTopicTrailingPunctuation === 'function'
        ? cleanTopicTrailingPunctuation(raw)
        : raw.replace(/[\s,，.。;；:：、\-_—]+$/u, '').trim();
    if (cleaned !== raw && inputEl) {
        inputEl.value = cleaned;
        autoResizeTopicTextarea(inputEl);
    }
    indices.forEach(idx => {
        if (currentQuestions[idx]) {
            currentQuestions[idx].topic = cleaned;
        }
    });
    isDirty = true;
    updateStatus();
}
window.onBigGroupTopicBlur = onBigGroupTopicBlur;

function onBigGroupSubTopicChange(subIndex, firstIndex, value) {
    if (currentQuestions[subIndex]) {
        currentQuestions[subIndex].topic = value;
        isDirty = true;
        updateStatus();
    }
}
window.onBigGroupSubTopicChange = onBigGroupSubTopicChange;

function onBigGroupVideoChange(firstIndex, value) {
    const indices = getBigQuestionGroupMemberIndices(firstIndex);
    const trimmed = (value || '').trim();
    indices.forEach(idx => {
        if (currentQuestions[idx]) {
            currentQuestions[idx].videoUrl = trimmed;
        }
    });
    isDirty = true;
    updateStatus();

    const itemEl = findQuestionCardDomByIndex(firstIndex);
    if (itemEl) {
        const wrap = itemEl.querySelector('.question-video-input-wrap');
        if (wrap) {
            let link = wrap.querySelector('.video-preview-link');
            if (trimmed) {
                if (!link) {
                    link = document.createElement('a');
                    link.className = 'video-preview-link';
                    link.target = '_blank';
                    link.title = '新窗口打开微课链接';
                    link.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
                    wrap.appendChild(link);
                }
                link.href = trimmed;
            } else if (link) {
                link.remove();
            }
        }
    }
}
window.onBigGroupVideoChange = onBigGroupVideoChange;

function toggleBigGroupSubTopics(groupKey) {
    if (expandedBigQuestionSubTopicGroups.has(groupKey)) {
        expandedBigQuestionSubTopicGroups.delete(groupKey);
    } else {
        expandedBigQuestionSubTopicGroups.add(groupKey);
    }
    renderQuestionList();
}
window.toggleBigGroupSubTopics = toggleBigGroupSubTopics;

function removeBigQuestionGroup(firstIndex) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法删除题目', 'warn');
        return;
    }
    const indices = getBigQuestionGroupMemberIndices(firstIndex).sort((a, b) => b - a);
    const nums = indices.map(i => currentQuestions[i]?.id).filter(Boolean).reverse();
    showCustomDialog({
        title: '删除大题组',
        body: `确定要删除大题组「第 ${nums[0]} ~ ${nums[nums.length - 1]} 题」（共 ${nums.length} 问）吗？`,
        confirmText: '确认删除',
        danger: true,
        onConfirm: () => {
            indices.forEach(idx => {
                currentQuestions.splice(idx, 1);
            });
            isDirty = true;
            renderQuestionList();
            updateStatus();
            showToast(`已删除第 ${nums[0]}~${nums[nums.length - 1]} 题大题组`);
        }
    });
}
window.removeBigQuestionGroup = removeBigQuestionGroup;

function ungroupBigQuestion(firstIndex) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限', 'warn');
        return;
    }
    const indices = getBigQuestionGroupMemberIndices(firstIndex).sort((a, b) => a - b);
    if (indices.length <= 1) return;
    const firstQ = currentQuestions[indices[0]];
    const startNum = parseInt(firstQ.id, 10) || 1;
    const endNum = parseInt(currentQuestions[indices[indices.length - 1]].id, 10) || startNum;

    showCustomDialog({
        title: '拆回普通单题',
        body: `确定要将「第 ${startNum} ~ ${endNum} 题」取消大题聚合吗？<br><span style="font-size:0.84rem;color:var(--text-secondary);">取消后将合并回 1 道普通单题（第 ${startNum} 题），后续题号自动顺延调整。</span>`,
        confirmText: '确认拆回',
        onConfirm: () => {
            const delta = 1 - indices.length; // negative
            const lastGroupIdx = indices[indices.length - 1];
            // Shift subsequent questions
            for (let i = lastGroupIdx + 1; i < currentQuestions.length; i++) {
                const q = currentQuestions[i];
                const curId = parseInt(q.id, 10);
                if (!isNaN(curId)) {
                    q.id = Math.max(1, curId + delta);
                }
                if (q.questionMeta && Array.isArray(q.questionMeta.groupNums)) {
                    q.questionMeta.groupNums = q.questionMeta.groupNums.map(n => Math.max(1, parseInt(n, 10) + delta));
                }
            }
            // Keep first question, clear its questionMeta, remove the rest of the group
            firstQ.id = startNum;
            delete firstQ.questionMeta;
            for (let k = indices.length - 1; k >= 1; k--) {
                currentQuestions.splice(indices[k], 1);
            }
            isDirty = true;
            renderQuestionList();
            updateStatus();
            showToast(`已恢复为单题（第 ${startNum} 题），后续题号已自动调整`);
        }
    });
}
window.ungroupBigQuestion = ungroupBigQuestion;

async function openStep4BigQuestionBoxModal(firstIndex) {
    const indices = getBigQuestionGroupMemberIndices(firstIndex).sort((a, b) => a - b);
    const firstQ = currentQuestions[indices[0]];
    if (!firstQ || !firstQ.exercisePdf || !firstQ.exercisePdf.url) {
        showToast('请先为该题上传题目 PDF，再框选大题小问', 'warn');
        return;
    }
    if (!window.pdfjsLib) {
        showToast('PDF 渲染组件未就绪，请刷新页面重试', 'warn');
        return;
    }

    showToast('正在加载高清题目页面供框选...', 'info');
    try {
        const resp = await fetch(firstQ.exercisePdf.url);
        if (!resp.ok) throw new Error('PDF 加载失败');
        const buf = await resp.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        const pageThumbs = [];
        const pageBoxes = [];
        const stemBoxes = [];

        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(2.2, Math.max(1.5, 1200 / base.width));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport }).promise;
            pageThumbs.push(canvas.toDataURL('image/jpeg', 0.88));
            page.cleanup();
            pageBoxes.push([]);
            stemBoxes.push([]);
        }
        if (typeof pdf.destroy === 'function') {
            try { await pdf.destroy(); } catch (_) {}
        }

        // Pre-populate existing stemBoxes & sub-question boxes from group members
        const existingStems = firstQ.questionMeta && Array.isArray(firstQ.questionMeta.stemBoxes)
            ? firstQ.questionMeta.stemBoxes
            : [];
        existingStems.forEach(sb => {
            if (sb && typeof sb.x === 'number') {
                const offset = Math.min(pageThumbs.length - 1, Math.max(0, parseInt(sb.pageOffset, 10) || 0));
                stemBoxes[offset].push({ x: sb.x, y: sb.y, w: sb.w, h: sb.h });
            }
        });

        indices.forEach(idx => {
            const mq = currentQuestions[idx];
            const box = mq && mq.questionMeta && mq.questionMeta.box;
            if (box && typeof box.x === 'number') {
                const offset = Math.min(pageThumbs.length - 1, Math.max(0, parseInt(box.pageOffset, 10) || 0));
                if (!pageBoxes[offset]) pageBoxes[offset] = [];
                pageBoxes[offset].push({
                    x: box.x,
                    y: box.y,
                    w: box.w,
                    h: box.h
                });
            }
        });

        const startNum = parseInt(firstQ.id, 10) || 1;
        lightboxStep4Context = {
            firstIndex: indices[0],
            memberIndices: indices,
            startNum,
            pageThumbs,
            pageBoxes,
            stemBoxes
        };
        lightboxKind = 'q';
        lightboxIndex = 0;
        lightboxZoom = 1;
        lightboxBoxMode = true;
        lightboxDrawTarget = existingStems.length > 0 ? 'subq' : 'stem';

        const lightbox = document.getElementById('page-lightbox-dialog');
        if (lightbox) {
            initLightboxBoxDrawingEvents();
            updateLightboxContent();
            lightbox.classList.add('active');
        }
    } catch (err) {
        console.error('加载题目 PDF 供框选失败:', err);
        showToast('加载题目 PDF 失败，请重试', 'error');
    }
}
window.openStep4BigQuestionBoxModal = openStep4BigQuestionBoxModal;

function applyStep4BigQuestionBoxes() {
    if (!lightboxStep4Context) return;
    const { memberIndices, startNum, pageThumbs, pageBoxes, stemBoxes } = lightboxStep4Context;
    const sortedOldIndices = [...memberIndices].sort((a, b) => a - b);
    const firstIdx = sortedOldIndices[0];
    const lastOldIdx = sortedOldIndices[sortedOldIndices.length - 1];
    const baseQ = currentQuestions[firstIdx];
    if (!baseQ) return;

    const flatStemBoxes = [];
    for (let offset = 0; offset < pageThumbs.length; offset++) {
        const sList = (stemBoxes && stemBoxes[offset]) || [];
        sList.forEach(sb => {
            flatStemBoxes.push({ pageOffset: offset, x: sb.x, y: sb.y, w: sb.w, h: sb.h });
        });
    }

    const flatBoxes = [];
    for (let offset = 0; offset < pageThumbs.length; offset++) {
        const list = pageBoxes[offset] || [];
        list.forEach(box => {
            flatBoxes.push({
                qNum: startNum + flatBoxes.length,
                pageOffset: offset,
                box: { ...box }
            });
        });
    }

    const newCount = Math.max(1, flatBoxes.length);
    const oldCount = sortedOldIndices.length;
    const delta = newCount - oldCount;

    // Shift subsequent questions after lastOldIdx
    if (delta !== 0) {
        for (let i = lastOldIdx + 1; i < currentQuestions.length; i++) {
            const q = currentQuestions[i];
            const curId = parseInt(q.id, 10);
            if (!isNaN(curId)) {
                q.id = Math.max(1, curId + delta);
            }
            if (q.questionMeta && Array.isArray(q.questionMeta.groupNums)) {
                q.questionMeta.groupNums = q.questionMeta.groupNums.map(n => Math.max(1, parseInt(n, 10) + delta));
            }
        }
    }

    if (flatBoxes.length === 0) {
        // Reverted to a single normal question
        const singleQ = {
            ...baseQ,
            id: startNum
        };
        delete singleQ.questionMeta;
        currentQuestions.splice(firstIdx, oldCount, singleQ);
        isDirty = true;
        renderQuestionList();
        updateStatus();
        showToast(`已清除框选，恢复为单题（第 ${startNum} 题）`);
        return;
    }

    const groupNums = flatBoxes.map(item => item.qNum);
    const newGroupQuestions = flatBoxes.map((item, k) => {
        const prevMember = sortedOldIndices[k] !== undefined ? currentQuestions[sortedOldIndices[k]] : null;
        const qMeta = {
            groupNums: [...groupNums],
            box: {
                pageOffset: item.pageOffset,
                x: item.box.x,
                y: item.box.y,
                w: item.box.w,
                h: item.box.h
            }
        };
        if (flatStemBoxes.length > 0) {
            qMeta.stemBoxes = flatStemBoxes.map(sb => ({ ...sb }));
        }
        if (prevMember && prevMember.questionMeta && prevMember.questionMeta.answerBox) {
            qMeta.answerBox = { ...prevMember.questionMeta.answerBox };
        }
        return {
            id: item.qNum,
            parentQuestionNum: null,
            subNum: 1,
            topic: prevMember && prevMember.topic ? prevMember.topic : (baseQ.topic || ''),
            videoUrl: prevMember && prevMember.videoUrl ? prevMember.videoUrl : (baseQ.videoUrl || ''),
            exercisePdf: baseQ.exercisePdf ? { ...baseQ.exercisePdf } : null,
            answerPdf: baseQ.answerPdf ? { ...baseQ.answerPdf } : null,
            questionMeta: qMeta
        };
    });

    currentQuestions.splice(firstIdx, oldCount, ...newGroupQuestions);
    isDirty = true;
    renderQuestionList();
    updateStatus();
    showToast(`已应用大题框选：第 ${groupNums[0]}~${groupNums[groupNums.length - 1]} 题（共 ${groupNums.length} 问）`, 'success');
}

// ========== Rendering ==========
let questionSearchFilter = '';

function onQuestionSearch(val) {
    questionSearchFilter = (val || '').trim().toLowerCase();
    renderQuestionList();
}
window.onQuestionSearch = onQuestionSearch;

function renderQuestionList() {
    if (currentQuestions.length === 0) {
        questionItems.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <line x1="8" y1="6" x2="21" y2="6"></line>
                        <line x1="8" y1="12" x2="21" y2="12"></line>
                        <line x1="8" y1="18" x2="21" y2="18"></line>
                        <circle cx="4" cy="6" r="1"></circle>
                        <circle cx="4" cy="12" r="1"></circle>
                        <circle cx="4" cy="18" r="1"></circle>
                    </svg>
                </div>
                <p class="empty-text">点击"添加题目"或"批量添加"开始填写</p>
            </div>
        `;
        return;
    }

    const isPreviewBank = getBankType() === 'preview';
    const isVariationBank = getBankType() === 'variation';
    const filtered = currentQuestions.map((q, index) => ({ q, originalIndex: index })).filter(({ q }) => {
        if (!questionSearchFilter) return true;
        const idStr = String(q.id).toLowerCase();
        const topicStr = (q.topic || '').toLowerCase();
        const videoStr = (isPreviewBank || isVariationBank) ? '' : (q.videoUrl || q.video_url || '').toLowerCase();
        const parentLabelStr = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0 ? q.parentQuestionNums.join('、') : (q.parentQuestionNum || '');
        const varStr = (parentLabelStr ? `第${parentLabelStr}题 变式${q.subNum || 1}` : '').toLowerCase();
        return idStr.includes(questionSearchFilter) || topicStr.includes(questionSearchFilter) || videoStr.includes(questionSearchFilter) || varStr.includes(questionSearchFilter);
    });

    if (filtered.length === 0) {
        questionItems.innerHTML = `
            <div class="empty-state" style="padding: 32px 20px;">
                <p class="empty-text">未找到匹配「${escapeHtml(questionSearchFilter)}」的题目</p>
            </div>
        `;
        return;
    }

    questionItems.innerHTML = '';
    const isAssistant = window.currentUser && window.currentUser.role === 'assistant';
    const readonlyAttr = isAssistant ? 'readonly' : '';
    const idReadonlyAttr = isAssistant ? 'readonly disabled' : '';

    let variationBuckets = [];
    if (isVariationBank) {
        recalcVariationSubNums(currentQuestions);
        variationBuckets = getConsolidationBuckets();
        if (variationBuckets.length === 0) {
            const maxP = Math.max(8, ...currentQuestions.map(q => parseInt(q.parentQuestionNum, 10) || 1));
            for (let k = 1; k <= maxP; k++) {
                variationBuckets.push({ parentNum: k, topic: '', exercisePdf: null });
            }
        }

        const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
        const topicMap = {};
        (homeworkQuestionsForVariation || []).forEach(hw => {
            const ct = cleanTopicStr(hw.topic);
            if (ct) {
                if (!topicMap[ct]) topicMap[ct] = [];
                topicMap[ct].push(parseInt(hw.id, 10));
            }
        });
        const sameTopicGroups = Object.keys(topicMap).filter(k => topicMap[k].length > 1);
        const mergeBtn = document.getElementById('qb-merge-same-topic-btn');
        const hintText = document.getElementById('qb-variation-hint-text');
        if (mergeBtn) {
            mergeBtn.style.display = sameTopicGroups.length > 0 && !isAssistant ? 'inline-flex' : 'none';
        }
        if (hintText) {
            if (sameTopicGroups.length > 0) {
                const sampleGroup = topicMap[sameTopicGroups[0]];
                hintText.innerHTML = `<strong>同考点关联提示：</strong>检测到本专题有 <strong>${sameTopicGroups.length} 组</strong> 同知识点原题（如第 ${sampleGroup.join('、')} 题【${escapeHtml(sameTopicGroups[0])}】）。`;
            } else {
                hintText.innerHTML = '';
                const hintBox = document.getElementById('qb-variation-hint');
                if (hintBox) hintBox.style.display = 'none';
            }
        }
    }

    const renderedBigGroups = new Set();

    filtered.forEach(({ q, originalIndex }) => {
        const groupKey = !isVariationBank ? getQuestionGroupKey(q) : null;
        if (groupKey) {
            if (renderedBigGroups.has(groupKey)) return;
            renderedBigGroups.add(groupKey);

            const memberIndices = getBigQuestionGroupMemberIndices(originalIndex);
            const firstIdx = memberIndices[0];
            const firstQ = currentQuestions[firstIdx] || q;
            const groupNums = firstQ.questionMeta.groupNums;
            const startNum = groupNums[0];
            const endNum = groupNums[groupNums.length - 1];

            // Check if sub-topics differ across members
            const memberTopics = memberIndices.map(idx => (currentQuestions[idx]?.topic || '').trim());
            const hasDistinctSubTopics = memberTopics.some(t => t !== memberTopics[0]);
            const isDrawerOpen = expandedBigQuestionSubTopicGroups.has(groupKey) || hasDistinctSubTopics;

            const videoVal = firstQ.videoUrl || firstQ.video_url || '';
            const videoRowHtml = isPreviewBank ? '' : `
                <div class="question-field-row">
                    <label class="question-field-label video-label">微课链接：</label>
                    <div class="question-video-input-wrap">
                        <svg viewBox="0 0 24 24" class="video-input-icon" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="23 7 16 12 23 17 23 7"></polygon>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                        </svg>
                        <input type="url" class="question-video-input"
                               placeholder="输入本篇大题微课讲解链接 (选填)..."
                               value="${escapeHtml(videoVal)}"
                               oninput="onBigGroupVideoChange(${firstIdx}, this.value)"
                               title="填写本篇大题的微课讲解链接（选填）" ${readonlyAttr}>
                        ${videoVal ? `<a href="${escapeHtml(videoVal)}" target="_blank" class="video-preview-link" title="新窗口打开微课链接"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a>` : ''}
                    </div>
                </div>
            `;

            const topicLabelHtml = isPreviewBank
                ? `<label class="question-field-label topic-label">统一考点<span class="qb-optional-tag">(选填)</span>：</label>`
                : `<label class="question-field-label topic-label">统一考点：</label>`;
            const topicPlaceholder = isPreviewBank
                ? '输入本篇大题知识点（如：阅读理解A篇·记叙文，留空则仅显示题号）...'
                : '输入本篇大题统一知识点（如：阅读理解A篇·细节与主旨，必填）...';

            const subPillsHtml = memberIndices.map(idx => {
                const mq = currentQuestions[idx];
                const hasBox = Boolean(mq && mq.questionMeta && mq.questionMeta.box);
                return `<span class="big-question-sub-pill ${hasBox ? 'has-box' : ''}" title="第 ${mq.id} 题${hasBox ? '（已标记框选坐标）' : ''}">#${mq.id}</span>`;
            }).join('');

            const subTopicRowsHtml = memberIndices.map(idx => {
                const mq = currentQuestions[idx];
                return `
                    <div class="big-question-subtopic-row">
                        <span class="big-question-subtopic-num">第 ${mq.id} 题</span>
                        <input type="text" class="question-topic-input" data-sub-index="${idx}"
                               style="min-height:32px; height:32px; padding:4px 10px; font-size:0.82rem;"
                               placeholder="第 ${mq.id} 题细分考点..."
                               value="${escapeHtml(mq.topic || '')}"
                               oninput="onBigGroupSubTopicChange(${idx}, ${firstIdx}, this.value)"
                               ${readonlyAttr}>
                    </div>
                `;
            }).join('');

            const item = document.createElement('div');
            item.className = 'question-item big-question-group-card' + (isAssistant ? ' readonly-item' : '');
            item.dataset.index = firstIdx;
            item.dataset.groupIndices = memberIndices.join(',');

            item.innerHTML = `
                <div class="big-question-header-bar">
                    <div class="big-question-header-left">
                        <span class="big-question-range-badge">${startNum} ~ ${endNum}</span>
                        <span class="big-question-type-tag">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"></rect>
                                <path d="M9 12h6M12 9v6"></path>
                            </svg>
                            大题组 · 共 ${memberIndices.length} 问 · 错题本自动去重合并
                        </span>
                        <div class="big-question-sub-pills">${subPillsHtml}</div>
                    </div>
                    ${isAssistant ? '' : `
                    <div class="big-question-header-actions">
                        <button type="button" class="big-question-action-btn" onclick="openStep4BigQuestionBoxModal(${firstIdx})" title="在高清大图上预览或微调每道小问的框选位置">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"></rect>
                                <circle cx="9" cy="9" r="1.5"></circle>
                            </svg>
                            <span>预览 / 调整框选</span>
                        </button>
                        <button type="button" class="big-question-action-btn" onclick="toggleBigGroupSubTopics('${escapeHtml(groupKey)}')" title="展开或收起各小问独立知识点设置">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="8" y1="6" x2="21" y2="6"></line>
                                <line x1="8" y1="12" x2="21" y2="12"></line>
                                <line x1="8" y1="18" x2="21" y2="18"></line>
                                <line x1="3" y1="6" x2="3.01" y2="6"></line>
                                <line x1="3" y1="12" x2="3.01" y2="12"></line>
                                <line x1="3" y1="18" x2="3.01" y2="18"></line>
                            </svg>
                            <span>${isDrawerOpen ? '收起小问考点' : '按小问细分考点'}</span>
                        </button>
                        <button type="button" class="big-question-action-btn" onclick="ungroupBigQuestion(${firstIdx})" title="取消大题模式，恢复为普通单题">
                            <span>拆回单题</span>
                        </button>
                    </div>`}
                </div>
                <div class="big-question-body-grid">
                    <div class="question-main-fields">
                        <div class="question-field-row question-topic-row">
                            ${topicLabelHtml}
                            <textarea class="question-topic-input"
                                   placeholder="${topicPlaceholder}"
                                   rows="1"
                                   oninput="onBigGroupTopicChange(${firstIdx}, this.value); autoResizeTopicTextarea(this);"
                                   onfocus="autoResizeTopicTextarea(this)"
                                   onblur="onBigGroupTopicBlur(${firstIdx}, this)" ${readonlyAttr}>${escapeHtml(firstQ.topic || '')}</textarea>
                        </div>
                        ${videoRowHtml}
                    </div>
                    <div class="question-pdf-actions">
                        ${renderPdfBtn(firstQ, firstIdx, 'exercise')}
                        ${renderPdfBtn(firstQ, firstIdx, 'answer')}
                    </div>
                    ${isAssistant ? '' : `
                    <div class="question-actions">
                        <button class="question-action-btn question-remove-btn" onclick="removeBigQuestionGroup(${firstIdx})" title="删除整组大题">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>`}
                </div>
                <div class="big-question-subtopics-drawer ${isDrawerOpen ? 'open' : ''}">
                    ${subTopicRowsHtml}
                </div>
            `;
            questionItems.appendChild(item);
            const topicTextarea = item.querySelector('.question-topic-input');
            if (topicTextarea) {
                autoResizeTopicTextarea(topicTextarea);
            }
            return;
        }

        const item = document.createElement('div');
        item.className = 'question-item' + (isAssistant ? ' readonly-item' : '');
        item.dataset.index = originalIndex;
        const parentNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
            ? q.parentQuestionNums
            : [parseInt(q.parentQuestionNum || q.id, 10) || 1];
        const primaryParentNum = parentNums[0] || 1;
        const subNum = parseInt(q.subNum, 10) || 1;
        const parentNumsLabel = formatCompactNumList(parentNums);
        const badgeLabel = parentNums.length > 1 ? `${parentNumsLabel}-${subNum}` : `${primaryParentNum}-${subNum}`;

        if (isVariationBank) {
            item.classList.add('variation-item');
            const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
            const curTopicClean = cleanTopicStr(q.topic);
            const unselectedSameTopicBuckets = variationBuckets.filter(b => {
                return curTopicClean && cleanTopicStr(b.topic) === curTopicClean && !parentNums.includes(Number(b.parentNum));
            });

            const previewBtnsHtml = parentNums.length === 1
                ? `<button type="button" class="var-hw-preview-btn"
                           onclick="previewHomeworkQuestion(${primaryParentNum}, event)"
                           onmouseenter="onHoverHomeworkPreview(event, ${primaryParentNum})"
                           onmouseleave="hideHoverPopover()"
                           title="查阅课后第 ${primaryParentNum} 题原题 PDF">
                       <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                           <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                           <circle cx="12" cy="12" r="3"></circle>
                       </svg>
                       <span>原题</span>
                   </button>`
                : `<div class="var-hw-preview-group" title="查阅关联原题 PDF">
                       <span class="var-hw-preview-label">原题:</span>
                       ${parentNums.map(p => `
                           <button type="button" class="var-hw-preview-btn compact"
                                   onclick="previewHomeworkQuestion(${p}, event)"
                                   onmouseenter="onHoverHomeworkPreview(event, ${p})"
                                   onmouseleave="hideHoverPopover()"
                                   title="查阅课后第 ${p} 题原题 PDF">${p}</button>
                       `).join('')}
                   </div>`;

            const mergePillHtml = (unselectedSameTopicBuckets.length > 0 && !isAssistant)
                ? `<button type="button" class="var-parent-pill var-parent-pill-merge"
                           onclick="onVariationMergeSameTopic(${originalIndex})"
                           title="一键将考点相同的第 ${unselectedSameTopicBuckets.map(b => b.parentNum).join('、')} 题合并关联">
                       <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
                           <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                           <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                       </svg>
                       <span>关联同考点(第${unselectedSameTopicBuckets.map(b => b.parentNum).join('、')}题)</span>
                   </button>`
                : '';

            item.innerHTML = `
                <div class="question-id-tags">
                    <span class="question-id-var-badge" title="课后第 ${parentNumsLabel} 题 · 变式 ${subNum}">
                        <span class="var-badge-parent">${parentNums.length > 1 ? parentNumsLabel : ('第' + primaryParentNum + '题')}</span>
                        <span class="var-badge-sub">变式 ${subNum}</span>
                    </span>
                </div>
                <div class="var-item-left">
                    <div class="var-parent-header">
                        <span class="var-parent-current" title="当前关联课后巩固第 ${parentNumsLabel} 题">课后第 <strong>${parentNumsLabel}</strong> 题</span>
                        <span class="var-sub-badge">变式 ${subNum}</span>
                        ${previewBtnsHtml}
                    </div>
                    ${(() => {
                        if (!q.topic && Array.isArray(homeworkQuestionsForVariation) && homeworkQuestionsForVariation.length > 0) {
                            const matchedHw = homeworkQuestionsForVariation.find(item => Number(item.id) === Number(primaryParentNum));
                            if (matchedHw && matchedHw.topic) q.topic = String(matchedHw.topic).trim();
                        }
                        return '';
                    })()}
                    <div class="var-topic-readonly" title="${escapeHtml(q.topic || '跟随原题自动同步')}">
                        <span class="var-topic-label">知识点：</span>
                        <span class="var-topic-text">${escapeHtml(q.topic || '跟随原题自动同步')}</span>
                        <span class="var-topic-lock-icon" title="知识点随关联原题自动带出，不可在此直接更改">
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                        </span>
                    </div>
                </div>
                <div class="var-item-center">
                    <span class="var-selector-label">选择原题：</span>
                    <div class="variation-parent-pills">
                        ${variationBuckets.map(b => {
                            const bNums = Array.isArray(b.nums) && b.nums.length > 0 ? b.nums : [Number(b.parentNum)];
                            const isSelected = bNums.every(n => parentNums.includes(n));
                            const isSameTopic = curTopicClean && cleanTopicStr(b.topic) === curTopicClean;
                            const cls = ['var-parent-pill'];
                            if (isSelected) cls.push('active');
                            else if (isSameTopic) cls.push('same-topic-hint');
                            const bLabel = b.label || ('第' + b.parentNum + '题');
                            return `<button type="button" class="${cls.join(' ')}"
                                onclick="onVariationParentChange(${originalIndex}, ${b.parentNum})"
                                title="关联课后 ${escapeHtml(bLabel)}${b.topic ? '：' + escapeHtml(b.topic) : ''}${isSameTopic ? ' (同知识点)' : ''}"
                                ${isAssistant ? 'disabled' : ''}>${escapeHtml(bLabel)}</button>`;
                        }).join('')}
                        ${mergePillHtml}
                    </div>
                </div>
                <div class="question-pdf-actions">
                    ${renderPdfBtn(q, originalIndex, 'exercise')}
                    ${renderPdfBtn(q, originalIndex, 'answer')}
                </div>
                ${isAssistant ? '' : `
                <div class="question-actions">
                    <button class="question-action-btn question-remove-btn" onclick="removeQuestion(${originalIndex})" title="删除此题">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>`}
            `;
        } else {
            const videoVal = q.videoUrl || q.video_url || '';
            const videoRowHtml = isPreviewBank ? '' : `
                <div class="question-field-row">
                    <label class="question-field-label video-label">微课链接：</label>
                    <div class="question-video-input-wrap">
                        <svg viewBox="0 0 24 24" class="video-input-icon" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="23 7 16 12 23 17 23 7"></polygon>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                        </svg>
                        <input type="url" class="question-video-input"
                               placeholder="输入微课讲解链接 (选填)..."
                               value="${escapeHtml(videoVal)}"
                               oninput="onVideoUrlChange(${originalIndex}, this.value)"
                               title="填写本道题的微课讲解链接（选填）" ${readonlyAttr}>
                        ${videoVal ? `<a href="${escapeHtml(videoVal)}" target="_blank" class="video-preview-link" title="新窗口打开微课链接"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a>` : ''}
                    </div>
                </div>
            `;
            const idTagHtml = `
                <input type="number" class="question-id-input" min="1" step="1" value="${escapeHtml(q.id)}" onwheel="this.blur()" onchange="onIdChange(${originalIndex}, this.value)" ${idReadonlyAttr}>
            `;
            const topicLabelHtml = isPreviewBank
                ? `<label class="question-field-label topic-label">知识点<span class="qb-optional-tag">(选填)</span>：</label>`
                : `<label class="question-field-label topic-label">知识点：</label>`;
            const topicPlaceholder = isPreviewBank
                ? '输入知识点 (选填，留空则错题本仅显示题号)...'
                : '输入知识点 (必填)...';
            const canConvertBigQ = Boolean(q.exercisePdf && q.exercisePdf.url);
            item.innerHTML = `
                <div class="question-id-tags">
                    ${idTagHtml}
                </div>
                <div class="question-main-fields">
                    <div class="question-field-row question-topic-row">
                        ${topicLabelHtml}
                        <textarea class="question-topic-input"
                               placeholder="${topicPlaceholder}"
                               rows="1"
                               oninput="onTopicChange(${originalIndex}, this.value); autoResizeTopicTextarea(this);"
                               onfocus="autoResizeTopicTextarea(this)"
                               onblur="onTopicBlur(${originalIndex}, this)" ${readonlyAttr}>${escapeHtml(q.topic || '')}</textarea>
                    </div>
                    ${videoRowHtml}
                </div>
                <div class="question-pdf-actions">
                    ${renderPdfBtn(q, originalIndex, 'exercise')}
                    ${renderPdfBtn(q, originalIndex, 'answer')}
                </div>
                ${isAssistant ? '' : `
                <div class="question-actions">
                    ${canConvertBigQ ? `
                    <button class="question-action-btn" onclick="openStep4BigQuestionBoxModal(${originalIndex})" title="设为大题并框选各小问位置">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"></rect>
                            <path d="M9 12h6M12 9v6"></path>
                        </svg>
                    </button>` : ''}
                    <button class="question-action-btn question-remove-btn" onclick="removeQuestion(${originalIndex})" title="删除此题">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>`}
            `;
        }
        questionItems.appendChild(item);
        const topicTextarea = item.querySelector('.question-topic-input');
        if (topicTextarea) {
            autoResizeTopicTextarea(topicTextarea);
        }
    });

    requestAnimationFrame(() => {
        if (typeof resizeAllTopicTextareas === 'function') resizeAllTopicTextareas();
    });
    setTimeout(() => {
        if (typeof resizeAllTopicTextareas === 'function') resizeAllTopicTextareas();
    }, 60);
}

function updateStatus() {
    const hasAllSelectors = Boolean(bankTypeSelect && bankTypeSelect.value && subjectSelect && subjectSelect.value && gradeSelect && gradeSelect.value && tierSelect && tierSelect.value && weekSelect && weekSelect.value);

    if (isDirty) {
        statusEl.className = 'qb-status unsaved';
        statusText.textContent = '有未保存的更改';
    } else if (currentQuestions.length > 0) {
        statusEl.className = 'qb-status saved';
        statusText.textContent = `已保存 (${currentQuestions.length}题)`;
    } else if (!hasAllSelectors) {
        statusEl.className = 'qb-status unsaved';
        statusText.textContent = '未选择专题';
    } else {
        statusEl.className = 'qb-status unsaved';
        statusText.textContent = '未保存';
    }

    if (saveInfo) {
        if (!hasAllSelectors) {
            saveInfo.textContent = '请先选择题库类型、学科、年级、班层和专题';
        } else {
            saveInfo.textContent = `${getBankTypeLabel(getBankType())} · ${subjectSelect.value} · ${gradeSelect.value} · ${tierSelect.value} · ${getTopicLabel(weekSelect.value)} · ${currentQuestions.length}道题`;
        }
    }
}

let allSavedDataList = [];
let savedBankTypeFilter = 'all';
let savedSubjectFilter = 'all';
let savedGradeFilter = 'all';
let savedTierFilter = 'all';
let savedWeekFilter = 'all';
let savedSearchQuery = '';

function getSubjectBadgeClass(subject) {
    switch (subject) {
        case '数学': return 'badge-math';
        case '英语': return 'badge-english';
        case '物理': return 'badge-physics';
        case '化学': return 'badge-chemistry';
        case '语文': return 'badge-chinese';
        default: return 'badge-default';
    }
}

async function renderSavedDataList() {
    const grid = document.getElementById('saved-data-grid');
    const emptyEl = document.getElementById('saved-empty');
    const emptyText = document.getElementById('saved-empty-text');
    const countBadge = document.getElementById('saved-total-count');

    try {
        const adminYear = window.adminSemesterYear || (yearSelect ? parseInt(yearSelect.value) : 2026);
        const adminSeason = window.adminDefaultSeasonZh || (seasonSelect ? seasonSelect.value : '秋');

        let result = await apiGet('list', { year: adminYear, season: adminSeason });
        if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
            const fallbackResult = await apiGet('list');
            if (fallbackResult.success && Array.isArray(fallbackResult.data) && fallbackResult.data.length > 0) {
                const matched = fallbackResult.data.filter(it => (!it.year || it.year == adminYear) && (!it.season || it.season === adminSeason));
                result = { success: true, data: matched.length > 0 ? matched : fallbackResult.data };
            }
        }

        allSavedDataList = (result.success && Array.isArray(result.data)) ? result.data : [];
        if (countBadge) {
            countBadge.textContent = `共 ${allSavedDataList.length} 个专题`;
        }

        renderSavedBankTypeTabs();
        renderSavedSubjectTabs();
        renderSavedTierTabs();
        renderSavedGradeTabs();
        renderSavedWeekTabs();
        applySavedDataFilter();
    } catch (e) {
        console.error('加载已保存数据失败:', e);
        if (grid) grid.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        if (emptyText) emptyText.textContent = '加载已保存数据失败，请检查网络连接';
    }
}

function renderAllCategoryTabs() {
    renderSavedBankTypeTabs();
    renderSavedSubjectTabs();
    renderSavedTierTabs();
    renderSavedGradeTabs();
    renderSavedWeekTabs();
}

function renderSavedBankTypeTabs() {
    const tabsContainer = document.getElementById('saved-bank-type-tabs');
    if (!tabsContainer) return;

    const counts = { homework: 0, preview: 0, variation: 0 };
    allSavedDataList.forEach(item => {
        if (savedSubjectFilter !== 'all' && item.subject !== savedSubjectFilter) return;
        if (savedTierFilter !== 'all' && item.tier !== savedTierFilter) return;
        if (savedGradeFilter !== 'all' && item.grade !== savedGradeFilter) return;
        if (savedWeekFilter !== 'all' && String(item.week) !== String(savedWeekFilter)) return;
        const type = item.bankType === 'preview' ? 'preview' : (item.bankType === 'variation' ? 'variation' : 'homework');
        counts[type] = (counts[type] || 0) + 1;
    });

    const total = counts.homework + counts.preview + counts.variation;
    let html = `
        <button type="button" class="ui-pill ${savedBankTypeFilter === 'all' ? 'active' : ''}" onclick="setSavedBankTypeFilter('all')">
            全部类型 <span class="pill-count">${total}</span>
        </button>
        <button type="button" class="ui-pill ${savedBankTypeFilter === 'homework' ? 'active' : ''}" onclick="setSavedBankTypeFilter('homework')">
            课后巩固 <span class="pill-count">${counts.homework}</span>
        </button>
        <button type="button" class="ui-pill ${savedBankTypeFilter === 'variation' ? 'active' : ''}" onclick="setSavedBankTypeFilter('variation')">
            课后举一反三 <span class="pill-count">${counts.variation}</span>
        </button>
        <button type="button" class="ui-pill ${savedBankTypeFilter === 'preview' ? 'active' : ''}" onclick="setSavedBankTypeFilter('preview')">
            预习 <span class="pill-count">${counts.preview}</span>
        </button>
    `;
    tabsContainer.innerHTML = html;
}

function setSavedBankTypeFilter(type) {
    savedBankTypeFilter = (type === 'preview' || type === 'homework' || type === 'variation') ? type : 'all';
    renderAllCategoryTabs();
    applySavedDataFilter();
}

function renderSavedSubjectTabs() {
    const tabsContainer = document.getElementById('saved-subject-tabs');
    if (!tabsContainer) return;

    const predefinedSubjects = subjectSelect ? Array.from(subjectSelect.options).map(o => o.value) : [];
    const subjectsFromData = allSavedDataList.map(item => item.subject);
    const allSubjects = Array.from(new Set([...predefinedSubjects, ...subjectsFromData])).filter(Boolean);

    const counts = {};
    allSubjects.forEach(s => { counts[s] = 0; });
    let totalMatching = 0;

    allSavedDataList.forEach(item => {
        if (savedBankTypeFilter !== 'all' && (item.bankType || 'homework') !== savedBankTypeFilter) return;
        if (savedTierFilter !== 'all' && item.tier !== savedTierFilter) return;
        if (savedGradeFilter !== 'all' && item.grade !== savedGradeFilter) return;
        if (savedWeekFilter !== 'all' && String(item.week) !== String(savedWeekFilter)) return;
        totalMatching++;
        if (counts[item.subject] !== undefined) {
            counts[item.subject]++;
        } else {
            counts[item.subject] = 1;
        }
    });

    let html = `
        <button type="button" class="ui-pill ${savedSubjectFilter === 'all' ? 'active' : ''}" onclick="setSavedSubjectFilter('all')">
            全部学科 <span class="pill-count">${totalMatching}</span>
        </button>
    `;

    allSubjects.forEach(sub => {
        const count = counts[sub] || 0;
        const isActive = savedSubjectFilter === sub;
        html += `
            <button type="button" class="ui-pill ${isActive ? 'active' : ''}" onclick="setSavedSubjectFilter('${escapeHtml(sub)}')">
                ${escapeHtml(sub)} <span class="pill-count">${count}</span>
            </button>
        `;
    });

    tabsContainer.innerHTML = html;
}

function renderSavedTierTabs() {
    const tabsContainer = document.getElementById('saved-tier-tabs');
    if (!tabsContainer) return;

    const predefinedTiers = ['U', 'S+', 'S', 'A+', 'A'];
    const tiersFromData = allSavedDataList.map(item => item.tier);
    const allTiers = Array.from(new Set([...predefinedTiers, ...tiersFromData])).filter(Boolean);

    const counts = {};
    allTiers.forEach(t => { counts[t] = 0; });
    let totalMatching = 0;

    allSavedDataList.forEach(item => {
        if (savedBankTypeFilter !== 'all' && (item.bankType || 'homework') !== savedBankTypeFilter) return;
        if (savedSubjectFilter !== 'all' && item.subject !== savedSubjectFilter) return;
        if (savedGradeFilter !== 'all' && item.grade !== savedGradeFilter) return;
        if (savedWeekFilter !== 'all' && String(item.week) !== String(savedWeekFilter)) return;
        totalMatching++;
        if (counts[item.tier] !== undefined) {
            counts[item.tier]++;
        } else {
            counts[item.tier] = 1;
        }
    });

    let html = `
        <button type="button" class="ui-pill ${savedTierFilter === 'all' ? 'active' : ''}" onclick="setSavedTierFilter('all')">
            全部班层 <span class="pill-count">${totalMatching}</span>
        </button>
    `;

    allTiers.forEach(tier => {
        const count = counts[tier] || 0;
        const isActive = savedTierFilter === tier;
        html += `
            <button type="button" class="ui-pill ${isActive ? 'active' : ''}" onclick="setSavedTierFilter('${escapeHtml(tier)}')">
                ${escapeHtml(tier)}层 <span class="pill-count">${count}</span>
            </button>
        `;
    });

    tabsContainer.innerHTML = html;
}

function renderSavedGradeTabs() {
    const tabsContainer = document.getElementById('saved-grade-tabs');
    if (!tabsContainer) return;

    const predefinedGrades = gradeSelect ? Array.from(gradeSelect.options).map(o => o.value) : ['七年级先学', '七年级', '八年级', '九年级', '高一先学', '高一', '高二'];
    const gradesFromData = allSavedDataList.map(item => item.grade);
    const allGrades = Array.from(new Set([...predefinedGrades, ...gradesFromData])).filter(Boolean);

    const counts = {};
    allGrades.forEach(g => { counts[g] = 0; });
    let totalMatching = 0;

    allSavedDataList.forEach(item => {
        if (savedBankTypeFilter !== 'all' && (item.bankType || 'homework') !== savedBankTypeFilter) return;
        if (savedSubjectFilter !== 'all' && item.subject !== savedSubjectFilter) return;
        if (savedTierFilter !== 'all' && item.tier !== savedTierFilter) return;
        if (savedWeekFilter !== 'all' && String(item.week) !== String(savedWeekFilter)) return;
        totalMatching++;
        if (counts[item.grade] !== undefined) {
            counts[item.grade]++;
        } else {
            counts[item.grade] = 1;
        }
    });

    let html = `
        <button type="button" class="ui-pill ${savedGradeFilter === 'all' ? 'active' : ''}" onclick="setSavedGradeFilter('all')">
            全部年级 <span class="pill-count">${totalMatching}</span>
        </button>
    `;

    allGrades.forEach(grade => {
        const count = counts[grade] || 0;
        const isActive = savedGradeFilter === grade;
        html += `
            <button type="button" class="ui-pill ${isActive ? 'active' : ''}" onclick="setSavedGradeFilter('${escapeHtml(grade)}')">
                ${escapeHtml(grade)} <span class="pill-count">${count}</span>
            </button>
        `;
    });

    tabsContainer.innerHTML = html;
}

function renderSavedWeekTabs() {
    const tabsContainer = document.getElementById('saved-week-tabs');
    if (!tabsContainer) return;

    const weeksFromData = Array.from(new Set(allSavedDataList.map(item => parseInt(item.week)).filter(n => !isNaN(n)))).sort((a, b) => a - b);
    const predefinedWeeks = weekSelect ? Array.from(weekSelect.options).map(o => parseInt(o.value)).filter(n => !isNaN(n)) : [];
    const allWeeks = weeksFromData.length > 0 ? weeksFromData : (predefinedWeeks.length > 0 ? predefinedWeeks : [1, 2, 3, 4, 5]);

    const counts = {};
    allWeeks.forEach(w => { counts[w] = 0; });
    let totalMatching = 0;

    allSavedDataList.forEach(item => {
        if (savedBankTypeFilter !== 'all' && (item.bankType || 'homework') !== savedBankTypeFilter) return;
        if (savedSubjectFilter !== 'all' && item.subject !== savedSubjectFilter) return;
        if (savedTierFilter !== 'all' && item.tier !== savedTierFilter) return;
        if (savedGradeFilter !== 'all' && item.grade !== savedGradeFilter) return;
        totalMatching++;
        const w = parseInt(item.week);
        if (!isNaN(w)) {
            if (counts[w] !== undefined) {
                counts[w]++;
            } else {
                counts[w] = 1;
            }
        }
    });

    let html = `
        <button type="button" class="ui-pill ${savedWeekFilter === 'all' ? 'active' : ''}" onclick="setSavedWeekFilter('all')">
            全部专题 <span class="pill-count">${totalMatching}</span>
        </button>
    `;

    allWeeks.forEach(w => {
        const count = counts[w] || 0;
        const isActive = String(savedWeekFilter) === String(w);
        const label = getTopicLabel(w);
        html += `
            <button type="button" class="ui-pill ${isActive ? 'active' : ''}" onclick="setSavedWeekFilter('${w}')">
                ${escapeHtml(label)} <span class="pill-count">${count}</span>
            </button>
        `;
    });

    tabsContainer.innerHTML = html;
}

function setSavedSubjectFilter(sub) {
    savedSubjectFilter = sub;
    if (sub !== 'all' && subjectSelect) {
        const hasOpt = Array.from(subjectSelect.options).some(o => o.value === sub);
        if (hasOpt && subjectSelect.value !== sub) {
            subjectSelect.value = sub;
        }
    }
    renderAllCategoryTabs();
    applySavedDataFilter();
}

function setSavedTierFilter(tier) {
    savedTierFilter = tier;
    renderAllCategoryTabs();
    applySavedDataFilter();
}

function setSavedGradeFilter(grade) {
    savedGradeFilter = grade;
    if (grade !== 'all' && gradeSelect) {
        const hasOpt = Array.from(gradeSelect.options).some(o => o.value === grade);
        if (hasOpt && gradeSelect.value !== grade) {
            gradeSelect.value = grade;
        }
    }
    renderAllCategoryTabs();
    applySavedDataFilter();
}

function setSavedWeekFilter(week) {
    savedWeekFilter = String(week);
    if (week !== 'all' && weekSelect) {
        const hasOpt = Array.from(weekSelect.options).some(o => String(o.value) === String(week));
        if (hasOpt && String(weekSelect.value) !== String(week)) {
            weekSelect.value = week;
        }
    }
    renderAllCategoryTabs();
    applySavedDataFilter();
}

function onSavedFilterChange() {
    const searchInputEl = document.getElementById('saved-search-input');
    savedSearchQuery = searchInputEl ? searchInputEl.value.trim().toLowerCase() : '';
    applySavedDataFilter();
}

function resetSavedFilters() {
    savedBankTypeFilter = 'all';
    savedSubjectFilter = 'all';
    savedTierFilter = 'all';
    savedGradeFilter = 'all';
    savedWeekFilter = 'all';
    savedSearchQuery = '';

    const searchInputEl = document.getElementById('saved-search-input');
    if (searchInputEl) searchInputEl.value = '';

    renderAllCategoryTabs();
    applySavedDataFilter();
}

function applySavedDataFilter() {
    const grid = document.getElementById('saved-data-grid');
    const emptyEl = document.getElementById('saved-empty');
    const emptyText = document.getElementById('saved-empty-text');
    if (!grid) return;
    const isAssistant = Boolean(window.currentUser && window.currentUser.role === 'assistant');

    let filtered = allSavedDataList.filter(item => {
        if (savedBankTypeFilter !== 'all' && (item.bankType || 'homework') !== savedBankTypeFilter) return false;
        if (savedSubjectFilter !== 'all' && item.subject !== savedSubjectFilter) return false;
        if (savedTierFilter !== 'all' && item.tier !== savedTierFilter) return false;
        if (savedGradeFilter !== 'all' && item.grade !== savedGradeFilter) return false;
        if (savedWeekFilter !== 'all' && String(item.week) !== String(savedWeekFilter)) return false;
        if (savedSearchQuery) {
            const topicLabel = getTopicLabel(item.week);
            const typeLabel = getBankTypeLabel(item.bankType);
            const fullSearch = `${typeLabel} ${item.subject} ${item.grade} ${item.tier} ${topicLabel} 专题${item.week} 第${item.week}周`.toLowerCase();
            if (!fullSearch.includes(savedSearchQuery)) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        grid.style.display = 'none';
        if (emptyEl) {
            emptyEl.style.display = 'flex';
            if (emptyText) {
                if (allSavedDataList.length === 0) {
                    emptyText.textContent = '暂无保存的题目数据，可通过上方选择学科后录入新题库';
                } else {
                    emptyText.textContent = '未找到匹配当前筛选条件的已保存题库';
                }
            }
        }
        return;
    }

    grid.style.display = 'grid';
    if (emptyEl) emptyEl.style.display = 'none';
    grid.innerHTML = '';

    const currentYear = yearSelect ? parseInt(yearSelect.value) : 2026;
    const currentSeason = seasonSelect ? seasonSelect.value : '春';
    const currentBankType = getBankType();
    const currentSubject = subjectSelect ? subjectSelect.value : '';
    const currentGrade = gradeSelect ? gradeSelect.value : '';
    const currentTier = tierSelect ? tierSelect.value : '';
    const currentWeek = weekSelect ? weekSelect.value : '';

    filtered.forEach(item => {
        const itemYear = item.year || 2026;
        const itemSeason = item.season || '春';
        const itemGrade = item.grade || '未指定年级';
        const itemBankType = item.bankType === 'preview' ? 'preview' : (item.bankType === 'variation' ? 'variation' : 'homework');
        const isActive = itemBankType === currentBankType && item.year === currentYear && item.season === currentSeason && item.subject === currentSubject && item.grade === currentGrade && item.tier === currentTier && String(item.week) === currentWeek;
        const topicName = getTopicLabel(item.week);
        const subjectClass = getSubjectBadgeClass(item.subject);
        const typeBadge = itemBankType === 'preview'
            ? '<span class="saved-badge badge-preview">预习</span>'
            : (itemBankType === 'variation'
                ? '<span class="saved-badge badge-variation" style="background:#ecfdf5;color:#059669;border-color:#a7f3d0;">举一反三</span>'
                : '<span class="saved-badge badge-homework">课后巩固</span>');

        const card = document.createElement('div');
        card.className = 'saved-data-card' + (isActive ? ' active' : '');
        card.onclick = () => editSavedItem(item.subject, itemGrade, item.tier, item.week, itemYear, itemSeason, itemBankType);
        card.innerHTML = `
            <div class="saved-card-header">
                <div class="saved-card-tags">
                    ${typeBadge}
                    <span class="saved-badge ${subjectClass}">${escapeHtml(item.subject)}</span>
                    <span class="saved-grade-tag">${escapeHtml(itemGrade)} · ${escapeHtml(item.tier)}层</span>
                </div>
                <span class="saved-card-time">${item.updatedAt ? formatTime(item.updatedAt) : ''}</span>
            </div>
            <div class="saved-card-body">
                <h4 class="saved-card-title">${escapeHtml(topicName)}</h4>
                <div class="saved-card-subinfo">
                    <span class="saved-question-count">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                        </svg>
                        共 ${item.questionCount} 道题
                    </span>
                </div>
            </div>
            <div class="saved-card-actions">
                <button type="button" class="saved-btn edit-btn" onclick="event.stopPropagation(); editSavedItem('${escapeHtml(item.subject)}', '${escapeHtml(itemGrade)}', '${escapeHtml(item.tier)}', ${item.week}, ${itemYear}, '${escapeHtml(itemSeason)}', '${itemBankType}')">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                    ${isAssistant ? '查看题目' : '查看 / 更改题目'}
                </button>
                ${isAssistant ? '' : `
                <button type="button" class="saved-btn delete-btn" onclick="event.stopPropagation(); deleteStoredData('${escapeHtml(item.subject)}', '${escapeHtml(itemGrade)}', '${escapeHtml(item.tier)}', ${item.week}, ${itemYear}, '${escapeHtml(itemSeason)}', '${itemBankType}')" title="删除此专题数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>`}
            </div>
        `;
        grid.appendChild(card);
    });
}

let isEnteringSavedItem = false;
async function editSavedItem(subject, grade, tier, week, year, season, bankType) {
    if (isEnteringSavedItem) return;
    isEnteringSavedItem = true;
    showToast('正在载入专题题目数据...', 'info');

    try {
        if (year && yearSelect) yearSelect.value = String(year);
        if (season && seasonSelect) seasonSelect.value = season;
        if (bankType && bankTypeSelect) {
            bankTypeSelect.value = (bankType === 'preview' || bankType === 'variation') ? bankType : 'homework';
            updateBankTypeUi();
        }
        if (subjectSelect) subjectSelect.value = subject;

        if (gradeSelect) {
            let gradeOptionExists = Array.from(gradeSelect.options).some(o => o.value === grade);
            if (!gradeOptionExists) {
                if (grade === '未指定年级') {
                    gradeSelect.value = '七年级';
                } else {
                    const opt = document.createElement('option');
                    opt.value = grade;
                    opt.textContent = grade;
                    gradeSelect.appendChild(opt);
                    gradeSelect.value = grade;
                }
            } else {
                gradeSelect.value = grade;
            }
        }

        if (tierSelect) tierSelect.value = tier;
        if (weekSelect) weekSelect.value = week;

        isDirty = false;
        batchImported = false; // Mark as direct edit mode so "返回学科选择" returns to Step 1

        await loadCurrentData();
        goToStep(4);
        const isAssistant = window.currentUser && window.currentUser.role === 'assistant';
        const typeLabel = getBankTypeLabel(bankType);
        showToast(isAssistant 
            ? `已载入「${typeLabel} · ${subject} · ${grade} · ${tier} · ${getTopicLabel(week)}」，当前为助教只读浏览模式`
            : `已载入「${typeLabel} · ${subject} · ${grade} · ${tier} · ${getTopicLabel(week)}」，可直接修改`);
    } finally {
        isEnteringSavedItem = false;
    }
}

function loadSavedItem(subject, grade, tier, week, year, season, bankType) {
    editSavedItem(subject, grade, tier, week, year, season, bankType);
}

function highlightActiveSavedItem() {
    applySavedDataFilter();
}

// ========== Helpers ==========
// Note: escapeHtml is defined at top of this file and in common.js

function formatTime(ts) {
    const d = new Date(ts);
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== Expose to window ==========
window.onSelectorChange = onSelectorChange;
window.onBankTypeChange = onBankTypeChange;
window.setSavedBankTypeFilter = setSavedBankTypeFilter;
window.addQuestion = addQuestion;
window.addBatchQuestions = addBatchQuestions;
window.removeQuestion = removeQuestion;
window.clearAllQuestions = clearAllQuestions;
window.onTopicChange = onTopicChange;
window.onTopicBlur = onTopicBlur;
window.onIdChange = onIdChange;
window.mergeWithPrevious = mergeWithPrevious;
window.openMergeDialog = openMergeDialog;
window.goToStep = goToStep;
window.goBack = goBack;
window.goNextFromStep1 = goNextFromStep1;
window.goNextFromStep2 = goNextFromStep2;
window.goNextFromMapping = goNextFromMapping;
window.onPageLabelChange = onPageLabelChange;
window.selectBatchPdf = selectBatchPdf;
window.updateBatchPdfStatus = updateBatchPdfStatus;

// ========== PDF Upload Logic ==========
let currentUploadContext = null;

function renderPdfBtn(q, index, type) {
    const data = type === 'exercise' ? q.exercisePdf : q.answerPdf;
    const label = type === 'exercise' ? '题目' : '答案';

    const iconEmpty = type === 'exercise'
        ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>`
        : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;

    const iconUploading = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`;

    if (!data || (!data.url && data.status !== 'uploading')) {
        const requiredCls = ' required-empty';
        const statusText = '未上传 (必传)';
        return `
            <div class="q-pdf-thumb-card empty${requiredCls}" onclick="triggerPdfUpload(${index}, '${type}')" title="点击上传${label} PDF (必传)">
                <div class="q-pdf-mini-thumb empty-thumb-wrap">
                    ${iconEmpty}
                </div>
                <div class="q-pdf-info">
                    <span class="q-pdf-tag-title">${label}</span>
                    <span class="q-pdf-status-text empty">${statusText}</span>
                </div>
            </div>
        `;
    }

    if (data.status === 'uploading') {
        const thumbContent = data.thumb 
            ? `<div class="q-pdf-mini-thumb qb-skeleton-wrap"><img class="q-pdf-mini-thumb" src="${data.thumb}" alt="缩略图"><div class="qb-skeleton-shimmer"></div></div>`
            : `<div class="q-pdf-mini-thumb qb-skeleton"><div class="qb-skeleton-shimmer"></div></div>`;
        return `
            <div class="q-pdf-thumb-card skeleton-card" title="${label}切片生成与上传中...">
                ${thumbContent}
                <div class="q-pdf-info">
                    <span class="q-pdf-tag-title">${label}</span>
                    <span class="q-pdf-status-text skeleton-status">
                        <span class="skeleton-pulse-dot"></span>切片中...
                    </span>
                </div>
            </div>
        `;
    }

    // Uploaded: Has thumbnail preview
    const thumbImg = data.thumb 
        ? `<img class="q-pdf-mini-thumb" src="${data.thumb}" alt="${label}缩略图">`
        : `<span class="q-pdf-mini-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></span>`;

    const hasRegionCrop = q && q.questionMeta && q.questionMeta.mode === 'region_crop' &&
        Array.isArray(type === 'answer' ? q.questionMeta.answerRegions : q.questionMeta.regions) &&
        (type === 'answer' ? q.questionMeta.answerRegions : q.questionMeta.regions).length > 0;
    const clickHandler = hasRegionCrop
        ? `previewRegionCropQuestion(${index}, '${type}')`
        : `previewPdf('${escapeHtml(data.url)}', '${escapeHtml(data.name || label + ' PDF')}')`;

    return `
        <div class="q-pdf-thumb-card" onclick="${clickHandler}" title="点击全屏预览${label} PDF">
            ${thumbImg}
            <div class="q-pdf-info">
                <span class="q-pdf-tag-title">${label}</span>
                <span class="q-pdf-status-text">已切片</span>
            </div>
            <button type="button" class="pdf-action-manage-btn" onclick="event.stopPropagation(); openPdfManageDialog(${index}, '${type}')" title="管理/替换此附件">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
            </button>
        </div>
    `;
}

function showHoverPopover() {
    // 已关闭悬停预览，点击卡片直接打开预览
    const popover = document.getElementById('quick-hover-popover');
    if (popover) popover.classList.remove('active');
}

function hideHoverPopover() {
    const popover = document.getElementById('quick-hover-popover');
    if (popover) popover.classList.remove('active');
}

window.showHoverPopover = showHoverPopover;
window.hideHoverPopover = hideHoverPopover;

function openPdfManageDialog(index, type) {
    const data = type === 'exercise' ? currentQuestions[index].exercisePdf : currentQuestions[index].answerPdf;
    const label = type === 'exercise' ? '题目' : '答案';

    showCustomDialog({
        title: `管理${label} PDF`,
        body: `<p style="margin-bottom:12px; font-size:0.9rem; color:var(--text-secondary);">当前已上传文件：<br><b style="color:var(--text-primary); word-break:break-all;">${escapeHtml(data.name)}</b></p>
               <p style="font-size:0.85rem; color:var(--text-muted);">可预览、重新上传覆盖，或删除该附件。</p>`,
        confirmText: '删除附件',
        cancelText: '关闭',
        danger: true,
        onConfirm: () => {
            removePdf(index, type);
        }
    });

    // Add 预览 / 重新上传 buttons to the dialog footer
    setTimeout(() => {
        const footer = document.querySelector('#custom-dialog .dialog-footer');
        if (!footer) return;
        const existing = document.getElementById('pdf-manage-extra');
        if (existing) existing.remove();
        const wrap = document.createElement('span');
        wrap.id = 'pdf-manage-extra';
        wrap.style.cssText = 'display:flex; gap:8px; margin-right:auto;';

        const previewBtn = document.createElement('button');
        previewBtn.className = 'btn secondary';
        previewBtn.textContent = '预览';
        previewBtn.onclick = () => {
            document.getElementById('custom-dialog').classList.remove('active');
            previewPdf(data.url, data.name || `${label} PDF`);
        };

        const reuploadBtn = document.createElement('button');
        reuploadBtn.className = 'btn secondary';
        reuploadBtn.textContent = '重新上传';
        reuploadBtn.onclick = () => {
            document.getElementById('custom-dialog').classList.remove('active');
            triggerPdfUpload(index, type);
        };

        wrap.appendChild(previewBtn);
        wrap.appendChild(reuploadBtn);
        footer.insertBefore(wrap, footer.firstChild);
    }, 50);
}

function triggerPdfUpload(index, type) {
    let input = document.getElementById('global-pdf-uploader');
    if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = 'global-pdf-uploader';
        input.accept = 'application/pdf';
        input.style.display = 'none';
        document.body.appendChild(input);
        
        input.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                if (currentUploadContext) {
                    await doUploadPdf(file, currentUploadContext.index, currentUploadContext.type);
                }
            }
            input.value = ''; // clear
        });
    }
    
    currentUploadContext = { index, type };
    input.click();
}

async function uploadPdfBlob(file) {
    const formData = new FormData();
    formData.append('file', file);
    
    const res = await fetch('api/upload_pdf.php', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
    });
    
    if (res.status === 401) {
        const err = new Error('unauthorized');
        err.unauthorized = true;
        throw err;
    }
    
    const json = await res.json();
    
    if (json.success) {
        return { url: json.url, originalName: json.originalName };
    }
    throw new Error(json.error || '未知错误');
}

function updateQuestionPdfActionsOnly(index) {
    const q = currentQuestions[index];
    if (!q) return;
    const itemEl = findQuestionCardDomByIndex(index);
    if (itemEl) {
        const actions = itemEl.querySelector('.question-pdf-actions');
        const primaryIdx = parseInt(itemEl.dataset.index, 10);
        const primaryQ = !isNaN(primaryIdx) && currentQuestions[primaryIdx] ? currentQuestions[primaryIdx] : q;
        const renderIdx = !isNaN(primaryIdx) ? primaryIdx : index;
        if (actions) {
            actions.innerHTML = `${renderPdfBtn(primaryQ, renderIdx, 'exercise')}${renderPdfBtn(primaryQ, renderIdx, 'answer')}`;
        }
    }
}

async function doUploadPdf(file, index, type) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        showToast('仅支持 PDF 文件');
        return;
    }
    if (file.size > 20 * 1024 * 1024) {
        showToast('文件过大，请保持在 20MB 以内');
        return;
    }
    
    if (!currentQuestions[index]) return;
    const targetKey = type === 'exercise' ? 'exercisePdf' : 'answerPdf';
    const memberIndices = getBigQuestionGroupMemberIndices(index);
    memberIndices.forEach(idx => {
        if (currentQuestions[idx]) {
            currentQuestions[idx][targetKey] = { status: 'uploading', name: file.name };
        }
    });
    // 局部精准更新该题卡片，避免全量 renderQuestionList 销毁重绘导致焦点丢失与掉帧
    updateQuestionPdfActionsOnly(index);
    
    try {
        const [result, thumb] = await Promise.all([
            uploadPdfBlob(file),
            generatePdfThumbnailFromFile(file)
        ]);
        const uploadedObj = {
            url: result.url,
            name: result.originalName,
            status: 'uploaded',
            thumb: thumb || null
        };
        memberIndices.forEach(idx => {
            if (currentQuestions[idx]) {
                currentQuestions[idx][targetKey] = { ...uploadedObj };
            }
        });
        isDirty = true;
        updateStatus();
        showToast('上传成功');
    } catch (e) {
        if (e && e.unauthorized) {
            handleUnauthorized();
            return;
        }
        console.error('Upload failed', e);
        memberIndices.forEach(idx => {
            if (currentQuestions[idx]) {
                currentQuestions[idx][targetKey] = null;
            }
        });
        showToast('上传失败: ' + (e.message || '网络错误或服务器异常'));
    } finally {
        updateQuestionPdfActionsOnly(index);
    }
}

function removePdf(index, type) {
    if (currentQuestions[index]) {
        const targetKey = type === 'exercise' ? 'exercisePdf' : 'answerPdf';
        const memberIndices = getBigQuestionGroupMemberIndices(index);
        memberIndices.forEach(idx => {
            if (currentQuestions[idx]) {
                currentQuestions[idx][targetKey] = null;
            }
        });
        isDirty = true;
        updateStatus();
        updateQuestionPdfActionsOnly(index);
        showToast('已删除 PDF 附件');
    }
}

// ========== PDF Preview ==========
let pdfPreviewUrl = '';

function previewPdf(url, name) {
    pdfPreviewUrl = url || '';
    const dialog = document.getElementById('pdf-preview-dialog');
    const titleEl = document.getElementById('pdf-preview-title');
    const frame = document.getElementById('pdf-preview-frame');
    if (!dialog || !frame) {
        showToast('无法预览此 PDF');
        return;
    }
    if (titleEl) titleEl.textContent = name || 'PDF 预览';
    frame.src = pdfPreviewUrl;
    dialog.classList.add('active');
}

function closePdfPreview() {
    const dialog = document.getElementById('pdf-preview-dialog');
    const frame = document.getElementById('pdf-preview-frame');
    if (dialog) dialog.classList.remove('active');
    if (frame) frame.src = '';
    if (pdfPreviewUrl && pdfPreviewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(pdfPreviewUrl); } catch (_) {}
    }
    pdfPreviewUrl = '';
}

const regionPreviewBytesCache = new Map();

async function previewSlicedRegions(pdfUrl, regions, title, fallbackName) {
    if (!pdfUrl) {
        showToast('暂无可预览的 PDF');
        return;
    }
    if (!Array.isArray(regions) || regions.length === 0 || !window.PDFLib) {
        previewPdf(pdfUrl, title || fallbackName || 'PDF 预览');
        return;
    }

    try {
        let pdfBytes = regionPreviewBytesCache.get(pdfUrl);
        if (!pdfBytes) {
            const res = await fetch(pdfUrl, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('PDF 加载失败');
            pdfBytes = await res.arrayBuffer();
            regionPreviewBytesCache.set(pdfUrl, pdfBytes);
        }
        const srcDoc = await PDFLib.PDFDocument.load(pdfBytes);
        const outDoc = await PDFLib.PDFDocument.create();
        const pageCount = srcDoc.getPageCount();
        const sorted = [...regions].sort((a, b) => (a.pageOffset || 0) - (b.pageOffset || 0) || (a.y || 0) - (b.y || 0));

        for (const rg of sorted) {
            const pOff = Math.min(pageCount - 1, Math.max(0, parseInt(rg.pageOffset, 10) || 0));
            const srcPage = srcDoc.getPage(pOff);
            const viewBox = (typeof srcPage.getCropBox === 'function' ? srcPage.getCropBox() : null) || srcPage.getMediaBox();
            const origW = viewBox.width;
            const origH = viewBox.height;
            const padPt = 2;
            const leftPt = Math.max(0, (rg.x ?? 0) * origW);
            const rightPt = Math.min(origW, ((rg.x ?? 0) + (rg.w ?? 1)) * origW);
            const effW = Math.max(24, rightPt - leftPt);
            const topPt = Math.max(0, (rg.y ?? 0) * origH - padPt);
            const bottomPt = Math.min(origH, ((rg.y ?? 0) + (rg.h ?? 1)) * origH + padPt);
            const effH = Math.max(18, bottomPt - topPt);

            const embedded = await outDoc.embedPage(srcPage, {
                left: viewBox.x + leftPt,
                bottom: viewBox.y + (origH - bottomPt),
                right: viewBox.x + rightPt,
                top: viewBox.y + (origH - topPt)
            });
            const page = outDoc.addPage([effW, effH]);
            page.drawPage(embedded, { x: 0, y: 0, width: effW, height: effH });
        }

        const outBytes = await outDoc.save();
        const blobUrl = URL.createObjectURL(new Blob([outBytes], { type: 'application/pdf' }));
        previewPdf(blobUrl, title || fallbackName || 'PDF 预览');
    } catch (err) {
        console.error('Region crop preview failed:', err);
        previewPdf(pdfUrl, title || fallbackName || 'PDF 预览');
    }
}

async function previewRegionCropQuestion(index, type) {
    const q = currentQuestions[index];
    if (!q) return;
    const data = type === 'answer' ? q.answerPdf : q.exercisePdf;
    if (!data || !data.url) {
        showToast('暂无可预览的 PDF');
        return;
    }
    const regions = (q.questionMeta && q.questionMeta.mode === 'region_crop')
        ? (type === 'answer' ? q.questionMeta.answerRegions : q.questionMeta.regions)
        : null;
    const label = type === 'answer' ? '答案' : '题目';
    await previewSlicedRegions(data.url, regions, `${label} · 第 ${q.id} 题（框选切片）`, data.name);
}

function openPdfInNewTab() {
    if (pdfPreviewUrl) {
        window.open(pdfPreviewUrl, '_blank');
    }
}

function batchImportPdfs() {
    showCustomDialog({
        title: '批量导入整本 PDF',
        body: `
            <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:14px;line-height:1.6;">
                请上传「题目 PDF」和「答案 PDF」两个文件，每页一道题，两文件页数需一致。
                <br>系统将按页分割，自动生成题目（第 1 页 = 第 1 题）。
                <br><b>注意：导入会清空当前题目列表。</b>
            </p>
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:6px;color:var(--text-primary);">题目 PDF</label>
                <input type="file" id="batch-exercise-pdf" accept="application/pdf" style="width:100%;box-sizing:border-box;">
            </div>
            <div>
                <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:6px;color:var(--text-primary);">答案 PDF</label>
                <input type="file" id="batch-answer-pdf" accept="application/pdf" style="width:100%;box-sizing:border-box;">
            </div>
        `,
        confirmText: '开始导入',
        onConfirm: () => {
            const exerciseInput = document.getElementById('batch-exercise-pdf');
            const answerInput = document.getElementById('batch-answer-pdf');
            const exerciseFile = exerciseInput && exerciseInput.files && exerciseInput.files[0];
            const answerFile = answerInput && answerInput.files && answerInput.files[0];
            if (!exerciseFile || !answerFile) {
                showToast('请选择题目 PDF 和答案 PDF');
                return;
            }
            doBatchImportPdfs(exerciseFile, answerFile);
        }
    });
}

async function splitSinglePage(srcDoc, pageIndex) {
    const newDoc = await PDFLib.PDFDocument.create();
    const [page] = await newDoc.copyPages(srcDoc, [pageIndex]);
    newDoc.addPage(page);
    const bytes = await newDoc.save();
    return new Blob([bytes], { type: 'application/pdf' });
}

async function mergePages(srcDoc, indices) {
    const newDoc = await PDFLib.PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, indices);
    pages.forEach(pg => newDoc.addPage(pg));
    const bytes = await newDoc.save();
    return new Blob([bytes], { type: 'application/pdf' });
}

let currentSlicingSessionId = 0;

function updateSingleQuestionPdfDom(index) {
    updateQuestionPdfActionsOnly(index);
}

async function startBackgroundSlicing(exerciseSrc, answerSrc, groups, sliceNums, isVar) {
    const sessionId = ++currentSlicingSessionId;
    const progressPanel = document.getElementById('qb-slice-progress-panel');
    const progressFill = document.getElementById('qb-slice-progress-fill');
    const progressText = document.getElementById('qb-slice-progress-text');
    const progressCount = document.getElementById('qb-slice-progress-count');
    const saveBtn = document.getElementById('save-btn');
    const syncBtn = document.getElementById('tier-sync-btn');

    if (progressPanel) progressPanel.style.display = 'block';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '正在后台生成切片并上传...';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon">
                <line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line>
            </svg>
            切片就绪中 (0/${sliceNums.length})...
        `;
    }
    if (syncBtn) syncBtn.disabled = true;

    const total = sliceNums.length;
    let completedCount = 0;
    let failCount = 0;

    const updateProgressUi = () => {
        if (sessionId !== currentSlicingSessionId) return;
        const pct = Math.round((completedCount / total) * 100);
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressCount) progressCount.textContent = `${completedCount} / ${total} (${pct}%)`;
        if (saveBtn && saveBtn.disabled) {
            saveBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon">
                    <line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line>
                </svg>
                切片就绪中 (${completedCount}/${total})...
            `;
        }
    };

    updateProgressUi();

    async function processSliceGroup(sliceTaskIdx) {
        if (sessionId !== currentSlicingSessionId) return;
        const num = sliceNums[sliceTaskIdx];
        const key = String(num);
        const grp = groups[key];
        if (!grp) return;
        const targetIndices = Array.isArray(grp.targetIndices) && grp.targetIndices.length > 0
            ? grp.targetIndices
            : [sliceTaskIdx];
        const firstIdx = targetIndices[0];
        const q = currentQuestions[firstIdx];
        if (!q) return;

        const qThumb = batchQuestionThumbs[grp.question[0]] || null;
        const pLabel = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 1
            ? q.parentQuestionNums.join('_')
            : (q.parentQuestionNum || 1);
        const rangeLabel = (grp.groupNums && grp.groupNums.length > 1)
            ? `${grp.groupNums[0]}-${grp.groupNums[grp.groupNums.length - 1]}`
            : String(num);
        const exFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_题目.pdf`
            : `题目_第${rangeLabel}题.pdf`;
        const anFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_答案.pdf`
            : `答案_第${rangeLabel}题.pdf`;

        // 1. 题目切片合并与上传（大题整组仅切片上传 1 次，共享给组内全部小问）
        try {
            const exBlob = await mergePages(exerciseSrc, grp.question);
            const exFile = new File([exBlob], exFileName, { type: 'application/pdf' });
            const exRes = await uploadPdfBlob(exFile);
            if (sessionId === currentSlicingSessionId) {
                const exObj = { url: exRes.url, name: exRes.originalName, status: 'uploaded', thumb: qThumb };
                targetIndices.forEach(tIdx => {
                    if (currentQuestions[tIdx]) {
                        currentQuestions[tIdx].exercisePdf = { ...exObj };
                    }
                });
            }
        } catch (e) {
            console.error('题目切片上传失败', rangeLabel, e);
            if (sessionId === currentSlicingSessionId) {
                targetIndices.forEach(tIdx => {
                    if (currentQuestions[tIdx]) {
                        currentQuestions[tIdx].exercisePdf = null;
                    }
                });
            }
            failCount++;
        }

        // 2. 答案切片合并与上传（若有答案页）
        const answerPages = grp.answer;
        if (answerPages && answerPages.length > 0) {
            const aThumb = batchAnswerThumbs[answerPages[0]] || null;
            try {
                const anBlob = await mergePages(answerSrc, answerPages);
                const anFile = new File([anBlob], anFileName, { type: 'application/pdf' });
                const anRes = await uploadPdfBlob(anFile);
                if (sessionId === currentSlicingSessionId) {
                    const anObj = { url: anRes.url, name: anRes.originalName, status: 'uploaded', thumb: aThumb };
                    targetIndices.forEach(tIdx => {
                        if (currentQuestions[tIdx]) {
                            currentQuestions[tIdx].answerPdf = { ...anObj };
                        }
                    });
                }
            } catch (e) {
                console.error('答案切片上传失败', rangeLabel, e);
                if (sessionId === currentSlicingSessionId) {
                    targetIndices.forEach(tIdx => {
                        if (currentQuestions[tIdx]) {
                            currentQuestions[tIdx].answerPdf = null;
                        }
                    });
                }
                failCount++;
            }
        }

        if (sessionId === currentSlicingSessionId) {
            completedCount++;
            updateSingleQuestionPdfDom(firstIdx);
            updateProgressUi();
            updateStatus();
        }
    }

    // 并发池 (并发度 3)
    const CONCURRENCY = 3;
    let nextIdx = 0;
    async function worker() {
        while (nextIdx < total) {
            if (sessionId !== currentSlicingSessionId) break;
            const currentTaskIdx = nextIdx++;
            await processSliceGroup(currentTaskIdx);
        }
    }

    const workers = [];
    const actualConcurrency = Math.min(CONCURRENCY, total);
    for (let i = 0; i < actualConcurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    if (sessionId !== currentSlicingSessionId) return;

    // 全部切片完成
    if (progressText) {
        progressText.innerHTML = failCount > 0
            ? `切片处理完成（有 ${failCount} 个附件上传失败）`
            : `全部 ${currentQuestions.length} 道题目切片已就绪`;
    }
    if (progressFill) progressFill.style.width = '100%';

    // 恢复保存与同步按钮
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
            保存
        `;
    }
    if (syncBtn) syncBtn.disabled = false;

    if (failCount > 0) {
        showToast(`切片完成，但有 ${failCount} 个页面上传失败，可在题目卡片中重试`, 'warn');
    } else {
        showToast(`全部 ${currentQuestions.length} 道题目切片已就绪`, 'success');
    }

    setTimeout(() => {
        if (sessionId === currentSlicingSessionId && progressPanel) {
            progressPanel.style.display = 'none';
        }
    }, 1800);
}

async function importWithLabels(exerciseFile, answerFile) {
    if (typeof PDFLib === 'undefined') {
        showToast('PDF 处理组件未完全就绪，请刷新重试');
        return false;
    }
    let exerciseSrc, answerSrc;
    try {
        const [exBuf, anBuf] = await Promise.all([
            exerciseFile.arrayBuffer(),
            answerFile.arrayBuffer()
        ]);
        exerciseSrc = await PDFLib.PDFDocument.load(exBuf);
        answerSrc = await PDFLib.PDFDocument.load(anBuf);
    } catch (e) {
        console.error('PDF 处理失败', e);
        showToast('PDF 处理失败，请确认文件有效');
        return false;
    }

    // 按起始题号收集题目页，并将落在大题题号区间内的答案页自动归并到该组
    const groups = {};
    batchQuestionLabels.forEach((label, pageIdx) => {
        const key = String(label);
        if (!groups[key]) {
            const gInfo = getGroupBoxesInfo(label);
            groups[key] = {
                question: [],
                answer: [],
                groupInfo: gInfo,
                groupNums: gInfo.groupNums,
                targetIndices: []
            };
        }
        groups[key].question.push(pageIdx);
    });

    const sliceNums = Object.keys(groups)
        .filter(k => groups[k].question.length > 0)
        .map(k => Number(k))
        .sort((a, b) => a - b);

    if (sliceNums.length === 0) {
        showToast('没有标注任何题目页');
        return false;
    }

    // 独立收集所有答案大题的框选坐标映射（按题号独立映射，不与题目框数强制绑定）
    const answerBoxByQNum = {};
    const visitedAnsStarts = new Set();
    batchAnswerLabels.forEach(lbl => {
        const aStart = parseInt(lbl, 10);
        if (!aStart || visitedAnsStarts.has(aStart)) return;
        visitedAnsStarts.add(aStart);
        const aInfo = getGroupBoxesInfo(aStart, 'a');
        if (aInfo.isBigQuestion && Array.isArray(aInfo.boxesWithMeta)) {
            aInfo.boxesWithMeta.forEach(ab => {
                answerBoxByQNum[ab.num] = {
                    pageIndex: ab.pageIndex,
                    x: ab.x,
                    y: ab.y,
                    w: ab.w,
                    h: ab.h
                };
            });
        }
    });

    batchAnswerLabels.forEach((label, pageIdx) => {
        const aNum = parseInt(label, 10);
        const aInfo = getGroupBoxesInfo(aNum, 'a');
        const ansTargetNums = (aInfo.isBigQuestion && aInfo.groupNums.length > 0) ? aInfo.groupNums : [aNum];
        // 查找包含该答案页（或答案大题任意小问）的题目组
        sliceNums.forEach(sNum => {
            const k = String(sNum);
            const grp = groups[k];
            if (!grp) return;
            const grpNums = Array.isArray(grp.groupNums) && grp.groupNums.length > 0 ? grp.groupNums : [sNum];
            if (ansTargetNums.some(n => grpNums.includes(n))) {
                if (!grp.answer.includes(pageIdx)) {
                    grp.answer.push(pageIdx);
                }
            }
        });
    });

    const isVar = getBankType() === 'variation';
    let buckets = [];
    const bucketTopicMap = {};
    if (isVar) {
        if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
            await loadHomeworkQuestionsForVariation();
        }
        buckets = getConsolidationBuckets();
        if (buckets.length === 0) {
            const maxP = Math.max(8, ...sliceNums);
            for (let k = 1; k <= maxP; k++) {
                buckets.push({ parentNum: k, topic: '', exercisePdf: null });
            }
        }
        buckets.forEach(b => {
            bucketTopicMap[b.parentNum] = b.topic || '';
        });
    }

    const buildAnswerBoxForQNum = (qNum, grp) => {
        const ansItem = answerBoxByQNum[qNum];
        if (!ansItem) return null;
        if (!grp.answer.includes(ansItem.pageIndex)) {
            grp.answer.push(ansItem.pageIndex);
        }
        const pageOffset = grp.answer.indexOf(ansItem.pageIndex);
        return {
            pageOffset: pageOffset >= 0 ? pageOffset : 0,
            x: ansItem.x,
            y: ansItem.y,
            w: ansItem.w,
            h: ansItem.h
        };
    };

    currentQuestions = [];
    sliceNums.forEach((num, sliceIdx) => {
        const key = String(num);
        const grp = groups[key];
        const gInfo = grp.groupInfo || getGroupBoxesInfo(num);
        const qThumb = batchQuestionThumbs[grp.question[0]] || null;
        const aThumb = grp.answer.length > 0 ? (batchAnswerThumbs[grp.answer[0]] || null) : null;

        if (!isVar && gInfo.isBigQuestion && Array.isArray(gInfo.boxesWithMeta) && gInfo.boxesWithMeta.length > 0) {
            const rangeStr = `${gInfo.startNum}-${gInfo.endNum}`;
            const stemBoxesPayload = Array.isArray(gInfo.stemBoxesWithMeta) && gInfo.stemBoxesWithMeta.length > 0
                ? gInfo.stemBoxesWithMeta.map(sb => ({
                    pageOffset: sb.pageOffset,
                    x: sb.x,
                    y: sb.y,
                    w: sb.w,
                    h: sb.h
                }))
                : null;
            gInfo.boxesWithMeta.forEach(flatItem => {
                const targetIdx = currentQuestions.length;
                grp.targetIndices.push(targetIdx);
                const qMeta = {
                    groupNums: [...gInfo.groupNums],
                    box: {
                        pageOffset: flatItem.pageOffset,
                        x: flatItem.x,
                        y: flatItem.y,
                        w: flatItem.w,
                        h: flatItem.h
                    }
                };
                if (stemBoxesPayload) {
                    qMeta.stemBoxes = stemBoxesPayload.map(sb => ({ ...sb }));
                }
                const ansBox = buildAnswerBoxForQNum(flatItem.num, grp);
                if (ansBox) {
                    qMeta.answerBox = ansBox;
                }
                currentQuestions.push({
                    id: flatItem.num,
                    parentQuestionNum: null,
                    subNum: 1,
                    topic: '',
                    videoUrl: '',
                    questionMeta: qMeta,
                    exercisePdf: { status: 'uploading', name: `题目_第${rangeStr}题.pdf`, thumb: qThumb },
                    answerPdf: aThumb ? { status: 'uploading', name: `答案_第${rangeStr}题.pdf`, thumb: aThumb } : null
                });
            });
        } else {
            const parentNum = isVar
                ? (buckets.some(b => b.parentNum === num)
                    ? num
                    : (buckets[sliceIdx]?.parentNum || buckets[buckets.length - 1]?.parentNum || num || (sliceIdx + 1)))
                : null;
            const topic = isVar ? (bucketTopicMap[parentNum] || '') : '';
            const targetIdx = currentQuestions.length;
            grp.targetIndices.push(targetIdx);
            const qItemObj = {
                id: num,
                parentQuestionNum: parentNum,
                subNum: 1,
                topic: topic,
                videoUrl: '',
                exercisePdf: { status: 'uploading', name: `题目_第${num}题.pdf`, thumb: qThumb },
                answerPdf: aThumb ? { status: 'uploading', name: `答案_第${num}题.pdf`, thumb: aThumb } : null
            };
            const ansBox = !isVar ? buildAnswerBoxForQNum(num, grp) : null;
            if (ansBox) {
                qItemObj.questionMeta = { answerBox: ansBox };
            }
            currentQuestions.push(qItemObj);
        }
    });

    if (isVar) recalcVariationSubNums(currentQuestions);
    isDirty = true;

    // 立即进入第 4 步呈现骨架屏与题目列表
    renderQuestionList();
    updateStatus();
    goToStep(4);

    // 启动后台异步切片与并发上传，不阻塞界面交互
    startBackgroundSlicing(exerciseSrc, answerSrc, groups, sliceNums, isVar);
    return true;
}

async function doBatchImportPdfs(exerciseFile, answerFile) {
    const pairs = [[exerciseFile, '题目'], [answerFile, '答案']];
    for (const [file, label] of pairs) {
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
            showToast(label + ' PDF 格式不正确');
            return;
        }
        if (file.size > 20 * 1024 * 1024) {
            showToast(label + ' PDF 超过 20MB');
            return;
        }
    }

    if (typeof PDFLib === 'undefined') {
        showToast('PDF 处理组件未完全就绪，请刷新重试');
        return;
    }
    let exerciseSrc, answerSrc, pageCount;
    try {
        showToast('正在解析 PDF...');
        const [exBuf, anBuf] = await Promise.all([
            exerciseFile.arrayBuffer(),
            answerFile.arrayBuffer()
        ]);
        exerciseSrc = await PDFLib.PDFDocument.load(exBuf);
        answerSrc = await PDFLib.PDFDocument.load(anBuf);
        pageCount = exerciseSrc.getPageCount();
        const answerPageCount = answerSrc.getPageCount();
        if (pageCount !== answerPageCount) {
            showToast('题目 PDF 与答案 PDF 页数不一致，无法导入');
            return;
        }
        if (pageCount <= 0) {
            showToast('PDF 没有可导入的页面');
            return;
        }
    } catch (e) {
        console.error('PDF 解析失败', e);
        showToast('PDF 处理失败，请确认文件有效');
        return;
    }

    const isVar = getBankType() === 'variation';
    let buckets = [];
    const bucketTopicMap = {};
    if (isVar) {
        if (!homeworkQuestionsForVariation || homeworkQuestionsForVariation.length === 0) {
            await loadHomeworkQuestionsForVariation();
        }
        buckets = getConsolidationBuckets();
        if (buckets.length === 0) {
            const maxP = Math.max(8, pageCount);
            for (let k = 1; k <= maxP; k++) {
                buckets.push({ parentNum: k, topic: '', exercisePdf: null });
            }
        }
        buckets.forEach(b => {
            bucketTopicMap[b.parentNum] = b.topic || '';
        });
    }

    // 清空重建：第 N 页 = 第 N 题
    currentQuestions = [];
    for (let i = 1; i <= pageCount; i++) {
        const parentNum = isVar
            ? (buckets.some(b => b.parentNum === i)
                ? i
                : (buckets[i - 1]?.parentNum || buckets[buckets.length - 1]?.parentNum || i))
            : null;
        const topic = isVar ? (bucketTopicMap[parentNum] || '') : '';
        currentQuestions.push({
            id: i,
            parentQuestionNum: parentNum,
            subNum: 1,
            topic: topic,
            videoUrl: '',
            exercisePdf: { status: 'uploading', name: `题目_第${i}题.pdf` },
            answerPdf: { status: 'uploading', name: `答案_第${i}题.pdf` }
        });
    }
    if (isVar) recalcVariationSubNums(currentQuestions);
    isDirty = true;
    renderQuestionList();
    updateStatus();

    let failCount = 0;

    for (let i = 0; i < pageCount; i++) {
        const no = i + 1;
        const q = currentQuestions[i];
        showToast(`正在导入 ${no}/${pageCount}...`);

        const pLabel = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 1
            ? q.parentQuestionNums.join('_')
            : (q.parentQuestionNum || 1);
        const exFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_题目.pdf`
            : `题目_第${no}题.pdf`;
        const anFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_答案.pdf`
            : `答案_第${no}题.pdf`;

        try {
            const exBlob = await splitSinglePage(exerciseSrc, i);
            const exFile = new File([exBlob], exFileName, { type: 'application/pdf' });
            const [exRes, exThumb] = await Promise.all([
                uploadPdfBlob(exFile),
                generatePdfThumbnailFromFile(exFile)
            ]);
            currentQuestions[i].exercisePdf = { url: exRes.url, name: exRes.originalName, status: 'uploaded', thumb: exThumb || null };
        } catch (e) {
            console.error('题目页上传失败', no, e);
            currentQuestions[i].exercisePdf = null;
            failCount++;
        }

        try {
            const anBlob = await splitSinglePage(answerSrc, i);
            const anFile = new File([anBlob], anFileName, { type: 'application/pdf' });
            const [anRes, anThumb] = await Promise.all([
                uploadPdfBlob(anFile),
                generatePdfThumbnailFromFile(anFile)
            ]);
            currentQuestions[i].answerPdf = { url: anRes.url, name: anRes.originalName, status: 'uploaded', thumb: anThumb || null };
        } catch (e) {
            console.error('答案页上传失败', no, e);
            currentQuestions[i].answerPdf = null;
            failCount++;
        }
    }

    renderQuestionList();
    updateStatus();
    if (failCount > 0) {
        showToast(`导入完成，但有 ${failCount} 个页面上传失败`);
    } else {
        showToast(`已导入 ${pageCount} 道题`);
    }
}

window.triggerPdfUpload = triggerPdfUpload;
window.openPdfManageDialog = openPdfManageDialog;
window.removePdf = removePdf;
window.batchImportPdfs = batchImportPdfs;
window.previewPdf = previewPdf;
window.closePdfPreview = closePdfPreview;
window.openPdfInNewTab = openPdfInNewTab;

window.saveQuestions = saveQuestions;
window.deleteStoredData = deleteStoredData;
window.loadSavedItem = loadSavedItem;
window.editSavedItem = editSavedItem;
window.setSavedSubjectFilter = setSavedSubjectFilter;
window.setSavedTierFilter = setSavedTierFilter;
window.setSavedGradeFilter = setSavedGradeFilter;
window.setSavedWeekFilter = setSavedWeekFilter;
window.onSavedFilterChange = onSavedFilterChange;
window.resetSavedFilters = resetSavedFilters;

window.previewHomeworkQuestion = previewHomeworkQuestion;
window.onVariationParentChange = onVariationParentChange;
window.onHoverHomeworkPreview = onHoverHomeworkPreview;

window.addEventListener('resize', () => {
    document.querySelectorAll('.question-topic-input').forEach(el => {
        if (typeof autoResizeTopicTextarea === 'function') autoResizeTopicTextarea(el);
    });
});
