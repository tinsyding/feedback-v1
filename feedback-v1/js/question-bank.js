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
        goToStep(1);
        return;
    }
    goToStep(currentStep - 1);
}

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
                showToast('该专题尚未录入【课后巩固】题库，无法录入举一反三！请先录入课后巩固题目。', 'warn');
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
                showToast('该专题尚未录入【课后巩固】题库，无法录入举一反三！请先录入课后巩固题目。', 'warn');
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
                    body: `「${subjectSelect.value} · ${gradeSelect.value} · ${tierSelect.value} · ${getTopicLabel(weekSelect.value)}」尚未录入【课后巩固】题库！<br><br>举一反三必须依赖对应课后巩固的原题和考点。请先切换题库类型录入课后巩固题目后再录入举一反三。`,
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

function getConsolidationBuckets() {
    if (homeworkQuestionsForVariation && homeworkQuestionsForVariation.length > 0) {
        return homeworkQuestionsForVariation.map((q, idx) => ({
            parentNum: parseInt(q.id || (idx + 1), 10),
            topic: (q.topic || '').trim(),
            exercisePdf: q.exercisePdf || null
        }));
    }
    return [];
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

    const hwQ = (homeworkQuestionsForVariation || []).find(item => Number(item.id) === pNum);
    const cleanTopicStr = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
    const isSameTopic = hwQ && cleanTopicStr(hwQ.topic) === cleanTopicStr(q.topic);

    if (pNums.includes(pNum)) {
        if (pNums.length > 1) {
            pNums = pNums.filter(n => n !== pNum);
        } else {
            return;
        }
    } else {
        if (isSameTopic && q.topic) {
            pNums.push(pNum);
        } else {
            pNums = [pNum];
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

async function onHoverHomeworkPreview(event, parentNum) {
    const hwQ = (homeworkQuestionsForVariation || []).find(item => Number(item.id) === Number(parentNum));
    if (!hwQ || !hwQ.exercisePdf) return;
    const title = `课后第 ${parentNum} 题${hwQ.topic ? ' · ' + hwQ.topic : ''}`;
    if (hwQ.exercisePdf.thumb) {
        showHoverPopover(event, hwQ.exercisePdf.thumb, title);
    } else if (hwQ.exercisePdf.url) {
        const thumb = await ensurePdfThumbnail(hwQ.exercisePdf);
        if (thumb) showHoverPopover(event, thumb, title);
    }
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
    previewPdf(exPdf.url, `课后第 ${parentNum} 题 · 原题${topic}`);
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
            showToast("该专题尚未录入【课后巩固】题库，无法录入举一反三！请先录入课后巩固题目。", "warn");
            return;
        }
    }
    const nextBtn = document.getElementById("step2-next-btn");
    if (nextBtn) nextBtn.disabled = true;
    try {
        const ok = await loadBatchPreviews();
        if (!ok) return;
        batchImported = false;
        buildDefaultLabels();
        renderAnnotationList();
        updateAnnotationStatus();
        goToStep(3);
    } finally {
        if (nextBtn) nextBtn.disabled = false;
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
        // High-definition render: target width around 900px so cards of 260~480px are sharp, and lightbox is crisp
        const targetWidth = Math.max(900, Math.min(1600, base.width * 2));
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

        thumbs.push(canvas.toDataURL('image/jpeg', 0.88));
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
        for (let i = 1; i <= batchQuestionPageCount; i++) {
            batchQuestionLabels.push(i);
            batchQuestionAutoFlags.push(false);
            batchQuestionInheritedFlags.push(false);
        }
        renderAnnotationList();
        updateAnnotationStatus();
        showToast(`已为 ${batchQuestionPageCount} 页题目按 1~${batchQuestionPageCount} 顺序编号`);
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

    const otherLabels = kind === 'q' ? batchAnswerLabels : batchQuestionLabels;
    const autoFlags = kind === 'q' ? batchQuestionAutoFlags : batchAnswerAutoFlags;
    const inheritedFlags = kind === 'q' ? batchQuestionInheritedFlags : batchAnswerInheritedFlags;

    thumbs.forEach((thumb, i) => {
        const card = document.createElement('div');
        const currNum = labels[i];
        const isPaired = otherLabels && otherLabels.includes(currNum);
        const isAuto = Boolean(autoFlags && autoFlags[i]);
        const isInherited = Boolean(inheritedFlags && inheritedFlags[i]);
        card.className = `page-card page-card-${kind}${isPaired ? ' paired' : ''}`;
        card.dataset.pageIndex = String(i);
        card.innerHTML = `
            <div class="page-thumb-wrap" onclick="openPageLightbox('${kind}', ${i})" title="点击全屏放大查看">
                <img class="page-thumb" src="${thumb}" alt="第 ${i + 1} 页" loading="lazy">
                <div class="page-zoom-badge">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        <line x1="11" y1="8" x2="11" y2="14"></line>
                        <line x1="8" y1="11" x2="14" y2="11"></line>
                    </svg>
                    <span>点击放大</span>
                </div>
                <div class="page-stepper-center" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" title="设置此页对应题号">
                    <span class="stepper-label">题号</span>
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
                </div>
            </div>
            <div class="page-card-footer">
                <span class="page-no-tag">第 ${i + 1} 页 ${isAuto ? '<span class="page-auto-indicator" title="题号由 PDF 文本自动识别，可手动修改">自动</span>' : (isInherited ? '<span class="page-inherited-indicator" title="此页没有印刷题号，已沿用上一页题号；请核对是否属于同一道题">沿用上页</span>' : '')} ${isPaired ? '<span class="page-paired-indicator" title="已与对应' + (kind === 'q' ? '答案' : '题目') + '匹配"></span>' : ''}</span>
                <span class="page-status-badge ${isPaired ? 'paired' : ''}">${isPaired ? '已对齐' : '未对齐'}</span>
            </div>
        `;
        el.appendChild(card);
    });
}

// ========== High-Definition Page Lightbox ==========
let lightboxKind = 'q';
let lightboxIndex = 0;
let lightboxZoom = 1;

function openPageLightbox(kind, index) {
    lightboxKind = kind;
    lightboxIndex = index;
    lightboxZoom = 1;

    const dialog = document.getElementById('page-lightbox-dialog');
    if (!dialog) return;
    updateLightboxContent();
    dialog.classList.add('active');
}

function closePageLightbox() {
    const dialog = document.getElementById('page-lightbox-dialog');
    if (dialog) dialog.classList.remove('active');
}

function updateLightboxContent() {
    const thumbs = lightboxKind === 'q' ? batchQuestionThumbs : batchAnswerThumbs;
    const labels = lightboxKind === 'q' ? batchQuestionLabels : batchAnswerLabels;
    const total = thumbs.length;
    if (lightboxIndex < 0) lightboxIndex = 0;
    if (lightboxIndex >= total) lightboxIndex = total - 1;

    const img = document.getElementById('lightbox-img');
    const title = document.getElementById('lightbox-title');
    const labelInput = document.getElementById('lightbox-page-label');
    const navInfo = document.getElementById('lightbox-nav-info');
    const prevBtn = document.getElementById('lightbox-prev-btn');
    const nextBtn = document.getElementById('lightbox-next-btn');

    const kindName = lightboxKind === 'q' ? '题目 PDF' : '答案 PDF';
    if (title) title.textContent = `${kindName} · 第 ${lightboxIndex + 1} 页`;
    if (img) {
        img.src = thumbs[lightboxIndex];
        img.style.transform = `scale(${lightboxZoom})`;
    }

    if (labelInput) labelInput.value = labels[lightboxIndex] || '';

    if (navInfo) navInfo.textContent = `第 ${lightboxIndex + 1} / ${total} 页`;

    if (prevBtn) prevBtn.disabled = lightboxIndex <= 0;
    if (nextBtn) nextBtn.disabled = lightboxIndex >= total - 1;

    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = `${Math.round(lightboxZoom * 100)}%`;
}

function navigateLightbox(direction) {
    lightboxIndex += direction;
    lightboxZoom = 1;
    updateLightboxContent();
}

function zoomLightboxImage(delta) {
    lightboxZoom = Math.max(0.5, Math.min(3.0, lightboxZoom + delta));
    const img = document.getElementById('lightbox-img');
    if (img) img.style.transform = `scale(${lightboxZoom})`;
    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = `${Math.round(lightboxZoom * 100)}%`;
}

function resetLightboxZoom() {
    lightboxZoom = 1;
    const img = document.getElementById('lightbox-img');
    if (img) img.style.transform = 'scale(1)';
    const zoomVal = document.getElementById('lightbox-zoom-val');
    if (zoomVal) zoomVal.textContent = '100%';
}

function onLightboxLabelChange(val) {
    onPageLabelChange(lightboxKind, lightboxIndex, val);
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
    const lbModal = document.getElementById('page-lightbox');
    if (!lbModal || lbModal.style.display === 'none') return;
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
        const otherLabels = k === 'q' ? batchAnswerLabels : batchQuestionLabels;
        labels.forEach((num, i) => {
            const card = document.querySelector(`.page-card-${k}:nth-child(${i + 1})`);
            if (!card) return;
            const isPaired = otherLabels && otherLabels.includes(num);
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
                    badge.textContent = '已配对';
                } else {
                    badge.classList.remove('paired');
                    badge.textContent = '未配对';
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

    // 题号智能顺延：当修改题号（如第 6 页由 6 改为 5 时，后续原本的 7 会自动换回 6，且后续全部页码自动同步顺延）
    if (autoCascadeNumbers && diff !== 0 && index + 1 < arr.length) {
        for (let j = index + 1; j < arr.length; j++) {
            arr[j] = Math.max(1, arr[j] + diff);
            markPageLabelManual(kind, j);
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

        showToast(`题号已自动顺延：后续第 ${index + 2}~${arr.length} 页题号已调整 (${diff > 0 ? '+' : ''}${diff})`);
    }

    updatePairedIndicators();
    updateAnnotationStatus();
    updateAutoDetectStatus();
}

function updateAnnotationStatus() {
    const el = document.getElementById('mapping-status-text');
    if (!el) return;
    const qSet = new Set(batchQuestionLabels.filter(n => Number.isInteger(n) && n > 0));
    el.textContent = `题目 ${batchQuestionPageCount} 页 → ${qSet.size} 道题 / 答案 ${batchAnswerPageCount} 页`;
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

    const qSet = new Set(batchQuestionLabels);
    for (let i = 0; i < batchAnswerLabels.length; i++) {
        if (!qSet.has(batchAnswerLabels[i])) {
            showToast(`答案第 ${i + 1} 页标注了题目页没有的题号 ${batchAnswerLabels[i]}，请检查`);
            return;
        }
    }

    const btn = document.getElementById('mapping-next-btn');
    if (btn) btn.disabled = true;
    try {
        const ok = await importWithLabels(batchExerciseFile, batchAnswerFile);
        batchImported = ok && currentQuestions.length > 0;
    } finally {
        if (btn) btn.disabled = false;
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

    // Background load thumbnails for loaded questions
    currentQuestions.forEach(async (q, idx) => {
        let updated = false;
        if (q.exercisePdf && q.exercisePdf.url && !q.exercisePdf.thumb) {
            const thumb = await ensurePdfThumbnail(q.exercisePdf);
            if (thumb) updated = true;
        }
        if (q.answerPdf && q.answerPdf.url && !q.answerPdf.thumb) {
            const thumb = await ensurePdfThumbnail(q.answerPdf);
            if (thumb) updated = true;
        }
        if (updated) {
            const itemEl = questionItems.querySelector(`.question-item[data-index="${idx}"]`) || questionItems.children[idx];
            if (itemEl) {
                const actions = itemEl.querySelector('.question-pdf-actions');
                if (actions) {
                    actions.innerHTML = `${renderPdfBtn(q, idx, 'exercise')}${renderPdfBtn(q, idx, 'answer')}`;
                }
            }
        }
    });
}

async function generatePdfThumbnailFromFile(file) {
    try {
        if (!window.pdfjsLib) return null;
        const data = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (pdf.numPages < 1) return null;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(800, Math.min(1600, base.width * 2));
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const thumb = canvas.toDataURL('image/jpeg', 0.88);
        page.cleanup();
        return thumb;
    } catch (e) {
        console.warn('生成本地 PDF 缩略图失败:', e);
        return null;
    }
}

async function ensurePdfThumbnail(pdfObj) {
    if (!pdfObj || !pdfObj.url || pdfObj.thumb) return pdfObj ? pdfObj.thumb : null;
    try {
        if (!window.pdfjsLib) return null;
        const resp = await fetch(pdfObj.url);
        if (!resp.ok) return null;
        const data = await resp.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (pdf.numPages < 1) return null;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(800, Math.min(1600, base.width * 2));
        const scale = targetWidth / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        pdfObj.thumb = canvas.toDataURL('image/jpeg', 0.88);
        page.cleanup();
        return pdfObj.thumb;
    } catch (e) {
        console.warn('ensurePdfThumbnail 失败:', pdfObj.url, e);
        return null;
    }
}

async function saveQuestions() {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法保存题库修改！', 'warn');
        return;
    }
    // 自动清洗知识点末尾的标点符号（逗号、句号、分号、点、顿号等），避免与系统自带顿号重合
    currentQuestions.forEach(q => {
        if (q && q.topic && typeof cleanTopicTrailingPunctuation === 'function') {
            q.topic = cleanTopicTrailingPunctuation(q.topic);
        }
    });

    if (!currentQuestions || currentQuestions.length === 0) {
        showToast('题目列表为空，请先添加或导入题目！', 'warn');
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
                showToast(`第 ${qNum} 题关联的原题缺少知识点，请在课后巩固中完善！`, 'warn');
            } else {
                showToast(`第 ${qNum} 题【知识点】为必填项，请填写完整！`, 'warn');
            }
            const itemEls = questionItems.querySelectorAll('.question-item');
            if (itemEls[i]) {
                itemEls[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                const topicInput = itemEls[i].querySelector('.question-topic-input') || itemEls[i].querySelector('.var-item-left');
                if (topicInput) {
                    if (typeof topicInput.focus === 'function') topicInput.focus();
                    topicInput.classList.add('input-error');
                    setTimeout(() => topicInput.classList.remove('input-error'), 2500);
                }
            }
            return;
        }

        if (!hasExercise) {
            showToast(`第 ${qNum} 题【错题文件】（题目PDF）为必传项，请上传！`, 'warn');
            const itemEls = questionItems.querySelectorAll('.question-item');
            if (itemEls[i]) {
                itemEls[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                const exBtn = itemEls[i].querySelector('.q-pdf-thumb-card.empty, .q-pdf-btn.empty');
                if (exBtn) {
                    exBtn.classList.add('pulse-active');
                    setTimeout(() => exBtn.classList.remove('pulse-active'), 2500);
                }
            }
            return;
        }
    }

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
                const currentSummary = [data.grade, data.subject, `${data.tier}班`, getTopicLabel(data.week)].filter(Boolean).join(' · ');
                showQbankOverwriteModal({
                    title: '题目配置变动确认',
                    summary: `检测到【<strong>${escapeHtml(currentSummary)}</strong>】已有配置与本次拟保存内容存在变动。保存将<strong>覆盖原有配置</strong>！`,
                    meta: checkRes.data,
                    diffs: diffs,
                    confirmText: '确认覆盖保存',
                    onConfirm: () => executeSaveQuestions(data)
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
                <div style="flex:1;">${summary || '检测到该专题配置存在变动，本次操作将<strong>覆盖原有配置</strong>！'}</div>
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

async function doBatchSyncTiers(data, targetTiers, currentTier, isAutoPrompt = false) {
    if (!targetTiers || targetTiers.length === 0) return;
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
        showToast(isAutoPrompt ? `保存成功！已同步至 ${tierLabels}` : `已成功同步至 ${tierLabels}！`, 'success');
    } else if (successCount > 0) {
        showToast(`部分同步成功 (${successCount}/${targetTiers.length})，失败: ${errors.join('; ')}`, 'warn');
    } else {
        showToast(`同步失败: ${errors.join('; ')}`, 'warn');
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
                    检测到 <strong>${diffTiers.length}</strong> 个目标班层已有题目变动，同步将<strong>完全覆盖</strong>原有题目！
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
        showToast('助教账号仅拥有查看权限，无法同步题库！', 'warn');
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
    try {
        const result = await apiPost(data);
        if (result.success) {
            isDirty = false;
            renderQuestionList();
            updateStatus();
            renderSavedDataList();

            const candidateTiers = getCandidateTiers(data.tier);
            const hasCandidates = candidateTiers && candidateTiers.length > 0;

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

            // 保存完成后若有其他候选班层，弹出班层互通提示（默认不勾选，精简直达）
            if (hasCandidates) {
                setTimeout(() => {
                    openTierSyncModal(data, true);
                }, 300);
            }
        } else {
            showToast('保存失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (e) {
        console.error('保存失败:', e);
        showToast('保存失败，请检查网络', 'error');
    }
}

function deleteStoredData(subject, grade, tier, week, year, season, bankType) {
    if (window.currentUser && window.currentUser.role === 'assistant') {
        showToast('助教账号仅拥有查看权限，无法删除题库！', 'warn');
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
        if (hintText && sameTopicGroups.length > 0) {
            const sampleGroup = topicMap[sameTopicGroups[0]];
            hintText.innerHTML = `<strong>举一反三智能考点提示：</strong>检测到本专题有 <strong>${sameTopicGroups.length} 组</strong> 同知识点原题（如第 ${sampleGroup.join('、')} 题【${escapeHtml(sameTopicGroups[0])}】），支持一道变式同时覆盖！`;
        }
    }

    filtered.forEach(({ q, originalIndex }) => {
        const item = document.createElement('div');
        item.className = 'question-item' + (isAssistant ? ' readonly-item' : '');
        item.dataset.index = originalIndex;
        const parentNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
            ? q.parentQuestionNums
            : [parseInt(q.parentQuestionNum || q.id, 10) || 1];
        const primaryParentNum = parentNums[0] || 1;
        const subNum = parseInt(q.subNum, 10) || 1;
        const parentNumsLabel = parentNums.join('、');
        const badgeLabel = parentNums.length > 1 ? `${parentNums.join('+')}-${subNum}` : `${primaryParentNum}-${subNum}`;

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
                            const isSelected = parentNums.includes(Number(b.parentNum));
                            const isSameTopic = curTopicClean && cleanTopicStr(b.topic) === curTopicClean;
                            const cls = ['var-parent-pill'];
                            if (isSelected) cls.push('active');
                            else if (isSameTopic) cls.push('same-topic-hint');
                            return `<button type="button" class="${cls.join(' ')}"
                                onclick="onVariationParentChange(${originalIndex}, ${b.parentNum})"
                                onmouseenter="onHoverHomeworkPreview(event, ${b.parentNum})"
                                onmouseleave="hideHoverPopover()"
                                title="关联课后第 ${b.parentNum} 题${b.topic ? '：' + escapeHtml(b.topic) : ''}${isSameTopic ? ' (同知识点)' : ''}"
                                ${isAssistant ? 'disabled' : ''}>第${b.parentNum}题</button>`;
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

async function editSavedItem(subject, grade, tier, week, year, season, bankType) {
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
        const requiredCls = type === 'exercise' ? ' required-empty' : '';
        const statusText = type === 'exercise' ? '未上传 (必传)' : '未上传 (选传)';
        return `
            <div class="q-pdf-thumb-card empty${requiredCls}" onclick="triggerPdfUpload(${index}, '${type}')" title="点击上传${label} PDF${type === 'exercise' ? ' (必传)' : ''}">
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
        ? `<img class="q-pdf-mini-thumb" src="${data.thumb}" alt="${label}缩略图" onmouseenter="showHoverPopover(event, '${escapeHtml(data.thumb)}', '${label} · 第 ${q.id} 题')" onmouseleave="hideHoverPopover()">`
        : `<span class="q-pdf-mini-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></span>`;

    return `
        <div class="q-pdf-thumb-card" onclick="previewPdf('${escapeHtml(data.url)}', '${escapeHtml(data.name || label + ' PDF')}')" title="点击全屏预览${label} PDF">
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

function showHoverPopover(e, thumbUrl, title) {
    const popover = document.getElementById('quick-hover-popover');
    if (!popover || !thumbUrl) return;
    const img = document.getElementById('popover-img');
    const titleEl = document.getElementById('popover-title');
    if (img) img.src = thumbUrl;
    if (titleEl) titleEl.textContent = title || '预览';

    const rect = e.target.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    if (top + 420 > window.innerHeight) {
        top = Math.max(10, rect.top - 400);
    }
    if (left + 330 > window.innerWidth) {
        left = window.innerWidth - 340;
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.classList.add('active');
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
    currentQuestions[index][targetKey] = { status: 'uploading', name: file.name };
    renderQuestionList();
    
    try {
        const [result, thumb] = await Promise.all([
            uploadPdfBlob(file),
            generatePdfThumbnailFromFile(file)
        ]);
        currentQuestions[index][targetKey] = {
            url: result.url,
            name: result.originalName,
            status: 'uploaded',
            thumb: thumb || null
        };
        isDirty = true;
        updateStatus();
        showToast('上传成功');
    } catch (e) {
        if (e && e.unauthorized) {
            handleUnauthorized();
            return;
        }
        console.error('Upload failed', e);
        currentQuestions[index][targetKey] = null;
        showToast('上传失败: ' + (e.message || '网络错误或服务器异常'));
    }
    renderQuestionList();
}

function removePdf(index, type) {
    if (currentQuestions[index]) {
        const targetKey = type === 'exercise' ? 'exercisePdf' : 'answerPdf';
        currentQuestions[index][targetKey] = null;
        isDirty = true;
        updateStatus();
        renderQuestionList();
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
    pdfPreviewUrl = '';
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
    const item = document.querySelector(`.question-item[data-index="${index}"]`);
    if (!item) return;
    const actionsEl = item.querySelector('.question-pdf-actions');
    if (!actionsEl) return;
    const q = currentQuestions[index];
    if (!q) return;
    actionsEl.innerHTML = `
        ${renderPdfBtn(q, index, 'exercise')}
        ${renderPdfBtn(q, index, 'answer')}
    `;
}

async function startBackgroundSlicing(exerciseSrc, answerSrc, groups, questionNums, isVar) {
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
            切片就绪中 (0/${questionNums.length})...
        `;
    }
    if (syncBtn) syncBtn.disabled = true;

    const total = questionNums.length;
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

    async function processQuestion(idx) {
        if (sessionId !== currentSlicingSessionId) return;
        const num = questionNums[idx];
        const key = String(num);
        const q = currentQuestions[idx];
        if (!q) return;

        const qThumb = batchQuestionThumbs[groups[key].question[0]] || null;
        const pLabel = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 1
            ? q.parentQuestionNums.join('_')
            : (q.parentQuestionNum || 1);
        const exFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_题目.pdf`
            : `题目_第${num}题.pdf`;
        const anFileName = isVar
            ? `课后第${pLabel}题_变式${q.subNum}_答案.pdf`
            : `答案_第${num}题.pdf`;

        // 1. 题目切片合并与上传
        try {
            const exBlob = await mergePages(exerciseSrc, groups[key].question);
            const exFile = new File([exBlob], exFileName, { type: 'application/pdf' });
            const exRes = await uploadPdfBlob(exFile);
            if (sessionId === currentSlicingSessionId && currentQuestions[idx]) {
                currentQuestions[idx].exercisePdf = { url: exRes.url, name: exRes.originalName, status: 'uploaded', thumb: qThumb };
            }
        } catch (e) {
            console.error('题目切片上传失败', num, e);
            if (sessionId === currentSlicingSessionId && currentQuestions[idx]) {
                currentQuestions[idx].exercisePdf = null;
            }
            failCount++;
        }

        // 2. 答案切片合并与上传（若有答案页）
        const answerPages = groups[key].answer;
        if (answerPages && answerPages.length > 0) {
            const aThumb = batchAnswerThumbs[answerPages[0]] || null;
            try {
                const anBlob = await mergePages(answerSrc, answerPages);
                const anFile = new File([anBlob], anFileName, { type: 'application/pdf' });
                const anRes = await uploadPdfBlob(anFile);
                if (sessionId === currentSlicingSessionId && currentQuestions[idx]) {
                    currentQuestions[idx].answerPdf = { url: anRes.url, name: anRes.originalName, status: 'uploaded', thumb: aThumb };
                }
            } catch (e) {
                console.error('答案切片上传失败', num, e);
                if (sessionId === currentSlicingSessionId && currentQuestions[idx]) {
                    currentQuestions[idx].answerPdf = null;
                }
                failCount++;
            }
        }

        if (sessionId === currentSlicingSessionId) {
            completedCount++;
            updateSingleQuestionPdfDom(idx);
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
            await processQuestion(currentTaskIdx);
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
            : `全部 ${total} 道题目切片已就绪`;
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
        showToast(`全部 ${total} 道题目切片已就绪`, 'success');
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

    // 按题号分组：题目页定义题目，答案页归并到对应题号
    const groups = {};
    batchQuestionLabels.forEach((label, pageIdx) => {
        const key = String(label);
        if (!groups[key]) groups[key] = { question: [], answer: [] };
        groups[key].question.push(pageIdx);
    });
    batchAnswerLabels.forEach((label, pageIdx) => {
        const key = String(label);
        if (!groups[key]) groups[key] = { question: [], answer: [] };
        groups[key].answer.push(pageIdx);
    });

    const questionNums = Object.keys(groups)
        .filter(k => groups[k].question.length > 0)
        .map(k => Number(k))
        .sort((a, b) => a - b);

    if (questionNums.length === 0) {
        showToast('没有标注任何题目页');
        return false;
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
            const maxP = Math.max(8, ...questionNums);
            for (let k = 1; k <= maxP; k++) {
                buckets.push({ parentNum: k, topic: '', exercisePdf: null });
            }
        }
        buckets.forEach(b => {
            bucketTopicMap[b.parentNum] = b.topic || '';
        });
    }

    currentQuestions = questionNums.map((num, idx) => {
        const key = String(num);
        const qThumb = batchQuestionThumbs[groups[key].question[0]] || null;
        const aThumb = groups[key].answer.length > 0 ? (batchAnswerThumbs[groups[key].answer[0]] || null) : null;
        const parentNum = isVar
            ? (buckets.some(b => b.parentNum === num)
                ? num
                : (buckets[idx]?.parentNum || buckets[buckets.length - 1]?.parentNum || num || (idx + 1)))
            : null;
        const topic = isVar ? (bucketTopicMap[parentNum] || '') : '';
        return {
            id: num,
            parentQuestionNum: parentNum,
            subNum: 1,
            topic: topic,
            videoUrl: '',
            exercisePdf: { status: 'uploading', name: `题目_第${num}题.pdf`, thumb: qThumb },
            answerPdf: aThumb ? { status: 'uploading', name: `答案_第${num}题.pdf`, thumb: aThumb } : null
        };
    });
    if (isVar) recalcVariationSubNums(currentQuestions);
    isDirty = true;

    // 立即进入第 4 步呈现骨架屏与题目列表
    renderQuestionList();
    updateStatus();
    goToStep(4);

    // 启动后台异步切片与并发上传，不阻塞界面交互
    startBackgroundSlicing(exerciseSrc, answerSrc, groups, questionNums, isVar);
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
