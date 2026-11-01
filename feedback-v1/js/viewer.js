function hideViewerLoadingScreen() {
    const el = document.getElementById('viewer-loading-screen');
    if (!el) return;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    setTimeout(() => {
        el.style.display = 'none';
    }, 350);
}

// 错题本基础链接：生产站默认走 vip.wxjifang.cn，预览/测试站（feedbackbackup / feedbacktest）自适应走当前站点
function getRetestBaseUrl() {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return `${window.location.origin}${window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'))}/retest.html`;
    }
    if (/feedback(backup|test)\.wxjifang\.cn$/.test(host)) {
        return `https://${host}/retest.html`;
    }
    return 'https://vip.wxjifang.cn/retest.html';
}

// ========== Spring/Autumn Semester Viewer Logic ==========
window.defaultSeason = 'autumn';
fetch('api/public_config.php').then(r=>r.json()).then(c=>{ 
    if(c.defaultSeason !== undefined) window.defaultSeason = c.defaultSeason; 
    if(c.semesterYear !== undefined) window.semesterYear = c.semesterYear;
});
function isVacationSeason(season) {
    return season === 0 || season === 'summer' || season === 'winter' || season === '暑' || season === '寒';
}
function getLessonUnit() {
    if (typeof sessionPayload !== "undefined" && sessionPayload && sessionPayload.seasonMode !== undefined) {
        return isVacationSeason(sessionPayload.seasonMode) ? "次" : "周";
    }
    return isVacationSeason(window.defaultSeason) ? "次" : "周";
}
function getHomeworkLabel() {
    if (typeof sessionPayload !== "undefined" && sessionPayload && sessionPayload.seasonMode !== undefined) {
        return isVacationSeason(sessionPayload.seasonMode) ? "" : "课后巩固";
    }
    return isVacationSeason(window.defaultSeason) ? "" : "课后巩固";
}
function getHomeworkLabelFull() {
    const label = getHomeworkLabel();
    return label ? label + '作业' : '作业';
}


function shouldForceIntegerScores() {
    return true; // 系统强制开启四舍五入强行取整，统一以整型规范存储与计算
}

function parseScoreValue(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
    const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
    if (isNaN(parsed)) return null;
    if (shouldForceIntegerScores()) {
        return Math.round(parsed);
    }
    return Math.round(parsed * 100) / 100;
}

function formatScoreDisplay(val) {
    if (val === null || val === undefined || isNaN(val)) return '-';
    if (shouldForceIntegerScores()) {
        return Math.round(val).toString();
    }
    return Number.isInteger(val) ? val.toString() : (Math.round(val * 10) / 10).toString();
}

function roundAvgScore(val) {
    if (val === null || val === undefined || isNaN(val)) return 0;
    if (shouldForceIntegerScores()) {
        return Math.round(val);
    }
    return Math.round(val * 10) / 10;
}

const compoundSurnames = ['欧阳', '司马', '上官', '诸葛', '慕容', '令狐', '公孙', '西门', '南宫', '夏侯', '尉迟', '轩辕', '端木', '东方', '闾丘', '亓官', '司寇', '仉', '督', '子车', '颛孙', '巫马', '公西', '漆雕', '乐正', '壤驷', '公良', '拓跋', '夹谷', '宰父', '谷利', '句容', '鲜于', '伯夷', '申屠', '公羊', '南荣'];

function getStudentDisplayName(studentName) {
    if (!studentName || studentName.length < 2) return studentName;
    for (const surname of compoundSurnames) {
        if (studentName.startsWith(surname)) {
            return studentName;
        }
    }
    return '小' + studentName.charAt(0);
}

let homeworkData = null;
let previewData = null;
let noteData = null;
let classTestData = null;
let reportData = null;
let homeworkFileName = '';
let previewFileName = '';
let noteFileName = '';
let classTestFileName = '';
let reportFileName = '';
let onlineOverrides = {};
let onlineStudents = {};
let currentFileIndex = 0;
let sessionId = '';
let sessionPayload = null;
let focusedRowIndex = -1;
let cachedPreviewMap = {};
let cachedPreviewStats = {};
let cachedPlusData = null;
let cachedPlusErrorStats = {};
let globalAppendText = '';
let previewReminderText = '';
let homeworkReminderText = '';
let noteReminderText = '';
let classTestReminderText = '';
let currentFeedbackViewMode = 'full'; // 'full' | 'plus-with-name' | 'plus-pure' | 'academic-only'

const hwStatsSection = document.getElementById('hw-stats-section');
const pvStatsSection = document.getElementById('pv-stats-section');
const resultSection = document.getElementById('result-section');
const resultBody = document.getElementById('result-body');
const emptyState = document.getElementById('empty-state');
const reuploadBtn = document.getElementById('reupload-btn');



async function initViewerSemester() {
    sessionId = getQueryParam('id') || '';
    if (reuploadBtn) {
        reuploadBtn.addEventListener('click', () => { window.location.href = 'upload.html'; });
    }

    // Setup dropdown hover with grace period & click handlers
    document.querySelectorAll('.vw-dropdown').forEach(dd => {
        let hideTimer = null;
        dd.addEventListener('mouseenter', () => {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            document.querySelectorAll('.vw-dropdown.hover-active').forEach(other => {
                if (other !== dd) other.classList.remove('hover-active');
            });
            dd.classList.add('hover-active');
        });
        dd.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(() => {
                dd.classList.remove('hover-active');
            }, 250);
        });
    });

    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('.vw-dropdown-trigger');
        if (trigger) {
            // 功能区下拉按钮纯悬停触发，直接点击不切换常驻 active 状态，防止下拉区卡住
            e.preventDefault();
            return;
        }

        if (e.target.closest('.vw-dropdown-item')) {
            const activeDd = e.target.closest('.vw-dropdown');
            if (activeDd) {
                activeDd.classList.remove('hover-active');
            }
        } else {
            document.querySelectorAll('.vw-dropdown.hover-active').forEach(dd => dd.classList.remove('hover-active'));
        }
    });
    if (!sessionId) {
        window.location.replace('upload.html');
        return;
    }
    sessionPayload = (typeof loadSessionDataAsync === 'function')
        ? await loadSessionDataAsync(sessionId)
        : loadSessionData(sessionId);
    const hasHomeworkFiles = Array.isArray(sessionPayload?.homeworkFiles) && sessionPayload.homeworkFiles.length > 0;
    const hasPreviewFiles = Array.isArray(sessionPayload?.previewFiles) && sessionPayload.previewFiles.length > 0;
    if (!sessionPayload || (!hasHomeworkFiles && !hasPreviewFiles)) {
        handleInvalidSession('文件标识无效或已过期'); return;
    }
    const screen = document.getElementById('viewer-loading-screen');
    if (screen && screen.style.display === 'none') {
        screen.style.display = 'flex';
    }
    hydrateFromPayload(sessionPayload);
    setupViewerHotkeys();
    renderFeedback();
    hideViewerLoadingScreen();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewerSemester);
} else {
    initViewerSemester();
}

function handleInvalidSession(message) {
    Logger.warn('invalid_session', { message, sessionId: typeof sessionId !== 'undefined' ? sessionId : '' });
    hideViewerLoadingScreen();
    showCustomDialog({ title: '链接无效', body: message + '，即将返回上传页。', confirmText: '立即返回',
        onConfirm: () => { window.location.replace('upload.html'); }
    });
    setTimeout(() => { window.location.replace('upload.html'); }, 1500);
}

function hydrateFromPayload(payload) {
    const restoredFiles = (payload.homeworkFiles || []).map(file => ({
        name: file.name,
        text: file.text,
        data: (Array.isArray(file.data) && file.data.length > 0) ? file.data : parseCSV(file.text)
    }));
    sessionPayload.homeworkFiles = restoredFiles;

    // Preview files
    if (payload.previewFiles && payload.previewFiles.length > 0) {
        const restoredPreview = payload.previewFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: (Array.isArray(file.data) && file.data.length > 0) ? file.data : parseCSV(file.text)
        }));
        sessionPayload.previewFiles = restoredPreview;
        // Merge preview data
        const pvHeader = restoredPreview[0].data[0];
        let pvRows = [];
        restoredPreview.forEach(f => { if (f.data.length > 1) pvRows.push(...f.data.slice(1)); });
        previewData = [pvHeader, ...pvRows];
        previewFileName = restoredPreview[0].name;
    }

    // Note files (English only)
    if (payload.noteFiles && payload.noteFiles.length > 0) {
        const restoredNote = payload.noteFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: (Array.isArray(file.data) && file.data.length > 0) ? file.data : parseCSV(file.text)
        }));
        sessionPayload.noteFiles = restoredNote;
        // Merge note data
        const noteHeader = restoredNote[0].data[0];
        let noteRows = [];
        restoredNote.forEach(f => { if (f.data.length > 1) noteRows.push(...f.data.slice(1)); });
        noteData = [noteHeader, ...noteRows];
        noteFileName = restoredNote[0].name;
    }

    // Class test files (English only)
    if (payload.classTestFiles && payload.classTestFiles.length > 0) {
        const restoredClassTest = payload.classTestFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: (Array.isArray(file.data) && file.data.length > 0) ? file.data : parseCSV(file.text)
        }));
        sessionPayload.classTestFiles = restoredClassTest;
        // Merge class test data
        const classTestHeader = restoredClassTest[0].data[0];
        let classTestRows = [];
        restoredClassTest.forEach(f => { if (f.data.length > 1) classTestRows.push(...f.data.slice(1)); });
        classTestData = [classTestHeader, ...classTestRows];
        classTestFileName = restoredClassTest[0].name;
    }

    // Report
    if (payload.reportFile && payload.reportFile.text) {
        reportData = parseCSV(payload.reportFile.text);
        reportFileName = payload.reportFile.name;
    }
    const runtime = payload.runtime || {};
    onlineOverrides = runtime.onlineOverrides || {};
}

function updateRuntimeState(partial) {
    const runtime = sessionPayload.runtime || {};
    sessionPayload.runtime = { ...runtime, ...partial };
    updateSessionData(sessionId, { runtime: sessionPayload.runtime });
}

function setupViewerHotkeys() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && focusedRowIndex >= 0) { clearFocusMode(); return; }
        if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
    });
}

function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
}

function extractLessonNumber(fileName, type) {
    if (type === 'homework' || type === 'preview' || type === 'note' || type === 'class_test') {
        const cm = fileName.match(/专题([一二三四五六七八九十百]+)/);
        if (cm) return chineseToNumber(cm[1]);
        const am = fileName.match(/专题(\d+)/);
        if (am) return parseInt(am[1]);
        const lc = fileName.match(/第([一二三四五六七八九十百]+)[次周]/);
        if (lc) return chineseToNumber(lc[1]);
        const la = fileName.match(/第(\d+)[次周]/);
        if (la) return parseInt(la[1]);
    } else if (type === 'report') {
        const m = fileName.match(/-(\d+)统计报告/);
        if (m) return parseInt(m[1]);
        const m2 = fileName.match(/[）)]-(\d+)/);
        if (m2) return parseInt(m2[1]);
    }
    return 1;
}

function chineseToNumber(chinese) {
    const d = { '零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9 };
    if (d[chinese] !== undefined) return d[chinese];
    if (chinese === '十') return 10;
    if (chinese.startsWith('十')) return 10 + (d[chinese.substring(1)] || 0);
    const ti = chinese.indexOf('十');
    if (ti > 0) return (d[chinese.charAt(0)] || 0) * 10 + (ti < chinese.length - 1 ? (d[chinese.charAt(ti + 1)] || 0) : 0);
    return 1;
}

function getPreviewCommentSource() {
    return sessionPayload.previewCommentSource || sessionPayload.commentSource || 'file';
}

function getHomeworkCommentSource() {
    return sessionPayload.homeworkCommentSource || sessionPayload.commentSource || 'file';
}

function getCommentSummary() {
    return sessionPayload.commentSummary || sessionPayload.manualComments?.summary || '';
}

function getPreviewManualComments() {
    return sessionPayload.previewManualComments || sessionPayload.manualComments || {};
}

function getHomeworkManualComments() {
    return sessionPayload.homeworkManualComments || sessionPayload.manualComments || {};
}

function getCommentByScore(score, maxScore, avgScore, rank, totalStudents) {
    const comments = getHomeworkManualComments();
    const top20Cutoff = Math.ceil(totalStudents * 0.2);
    if (score === 0) return comments.zero || '（零分评语未填写）';
    if (score === maxScore) return comments.full || '（满分评语未填写）';
    if (rank <= top20Cutoff) return comments.top20 || '（前20%评语未填写）';
    if (score >= avgScore) return comments.aboveAvg || '（均分以上评语未填写）';
    return comments.belowAvg || '（均分以下评语未填写）';
}

function getPreviewCommentByMetric(pvInfo, stats, mode) {
    const comments = getPreviewManualComments();
    const submittedCount = stats?.submittedCount || 0;
    const top20Cutoff = Math.ceil(submittedCount * 0.2);
    const bestValue = parseFloat(String(stats?.displayMax || '').replace('%', ''));
    const avgValue = parseFloat(String(stats?.displayAvg || '').replace('%', ''));
    const hasBest = !isNaN(bestValue);
    const hasAvg = !isNaN(avgValue);
    let metricValue = null;
    if (mode === 'score_rank' || mode === 'score_only') metricValue = pvInfo.score;
    else if (mode === 'accuracy') metricValue = pvInfo.accuracy;
    else metricValue = pvInfo.correctCount;
    if (metricValue === null || metricValue === undefined) return comments.belowAvg || '预习完成情况良好，请继续保持。';
    if ((mode === 'score_rank' || mode === 'score_only' || mode === 'accuracy') && metricValue === 0) {
        return comments.zero || '（零分评语未填写）';
    }
    if (hasBest && metricValue === bestValue) return comments.full || '（满分评语未填写）';
    if (pvInfo.rank && top20Cutoff > 0 && pvInfo.rank <= top20Cutoff) return comments.top20 || '（前20%评语未填写）';
    if (hasAvg) {
        if (metricValue >= avgValue) return comments.aboveAvg || '（均分以上评语未填写）';
        return comments.belowAvg || '（均分以下评语未填写）';
    }
    return comments.belowAvg || '预习完成情况良好，请继续保持。';
}

function getFocusCommentSource() {
    return sessionPayload?.focusCommentSource || 'default';
}

function getFocusMaxScore() {
    return sessionPayload?.focusMaxScore || 6;
}

function getFocusScoreOffset() {
    return sessionPayload?.focusScoreOffset || 0;
}

function getPhysicsPreviewSource() {
    return sessionPayload?.physicsPreviewSource || 'aiwenyun';
}

function getAdjustedFocusScore(originalScore) {
    const offset = getFocusScoreOffset();
    return Math.max(0, originalScore + offset);
}

function getAdjustedFocusAvg(originalAvg) {
    const offset = getFocusScoreOffset();
    return Math.round((originalAvg + offset) * 10) / 10;
}

function getFocusComments() {
    return sessionPayload?.focusComments || {};
}

function getFocusComment(score) {
    const source = getFocusCommentSource();
    if (source === 'custom') {
        const comments = getFocusComments();
        return comments[score] || comments[String(score)] || '';
    }
    if (score >= 6) return '专注度很好，给你点赞，请继续保持！';
    if (score === 5) return '专注度尚可，但未全神贯注，下次争取全心投入，拿满分！';
    if (score >= 3 && score <= 4) return '专注度一般，请及时作出调整；';
    if (score >= 1 && score <= 2) return '专注度较差，请私聊老师说明情况';
    return '未获得课堂积分，请及时调整状态！';
}

function resolvePreviewMetricMode(payload) {
    const mode = payload?.previewMetricMode;
    if (!mode) return 'score_rank';
    if (mode === 'error_count') return 'correct_count';
    return mode;
}

function parsePercentValue(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const cleaned = text.replace('%', '');
    const val = parseFloat(cleaned);
    return isNaN(val) ? null : val;
}

function formatMetricValue(value) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    if (shouldForceIntegerScores()) {
        return Math.round(value).toString();
    }
    return Number.isInteger(value) ? value.toString() : (Math.round(value * 10) / 10).toString();
}

function buildPreviewMetrics(data, mode, totalQuestions = 0) {
    const pvHeader = data[0];
    const pvNameIdx = pvHeader.findIndex(h => h.includes('姓名'));
    const pvErrIdx = pvHeader.findIndex(h => h.includes('错题数'));
    const pvStatusIdx = pvHeader.findIndex(h => h.includes('作业状态'));
    const pvScoreIdx = pvHeader.findIndex(h => h.includes('得分'));
    const pvAccIdx = pvHeader.findIndex(h => h.includes('正确率'));
    const pvCommentIdx = findCommentColumnIndex(pvHeader, '批改评语');
    const pvCorrectionCommentIdx = findCommentColumnIndex(pvHeader, '订正评语');
    const rows = data.slice(1).filter(r => r[pvNameIdx] && r[pvNameIdx].trim());

    const map = {};
    const scoreEntries = [];
    const accuracyEntries = [];
    const correctEntries = [];

    rows.forEach(r => {
        const fullName = r[pvNameIdx] || '';
        const nameMatch = fullName.match(/\d+(.+)/);
        const studentName = nameMatch ? nameMatch[1] : fullName;
        const status = r[pvStatusIdx] || '';
        const score = parseScoreValue(r[pvScoreIdx]);
        const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正') || (status.includes('批改中') && score !== null);
        const accuracy = parsePercentValue(r[pvAccIdx]);
        const rawErr = parseInt(r[pvErrIdx]);
        const errorCount = isNaN(rawErr) ? null : rawErr;
        const correctCount = (totalQuestions > 0 && errorCount !== null) ? Math.max(totalQuestions - errorCount, 0) : null;

        map[studentName] = {
            fullName,
            status,
            isSubmitted,
            score,
            accuracy,
            accuracyText: accuracy === null ? '-' : `${Math.round(accuracy)}%`,
            errorCount,
            correctCount,
            rank: null,
            comment: getEffectiveComment(r, pvCommentIdx, pvCorrectionCommentIdx)
        };

        if (!isSubmitted) return;
        if (score !== null) scoreEntries.push({ name: studentName, score });
        if (accuracy !== null) accuracyEntries.push({ name: studentName, score: accuracy });
        if (correctCount !== null) correctEntries.push({ name: studentName, score: correctCount });
    });

    const stats = {
        mode,
        submittedCount: Object.values(map).filter(x => x.isSubmitted).length,
        displayMax: '-',
        displayAvg: '-',
        displayExtra: '0',
        maxLabel: '最高正确数',
        avgLabel: '平均正确数',
        extraLabel: '总题数',
        rankEnabled: false,
        rankEntries: [],
        rankTitle: '预习作业排名',
        rankColLabel: '分值'
    };

    if (mode === 'score_rank') {
        if (scoreEntries.length > 0) {
            const max = Math.max(...scoreEntries.map(s => s.score));
            const avg = scoreEntries.reduce((a, b) => a + b.score, 0) / scoreEntries.length;
            stats.displayMax = formatScoreDisplay(max);
            stats.displayAvg = formatScoreDisplay(avg);
            const sorted = [...scoreEntries].sort((a, b) => b.score - a.score);
            let curRank = 1;
            let prevScore = null;
            sorted.forEach((item, idx) => {
                if (prevScore !== null && item.score < prevScore) curRank = idx + 1;
                if (map[item.name]) map[item.name].rank = curRank;
                prevScore = item.score;
            });
            stats.rankEntries = sorted;
        }
        stats.maxLabel = '最高分';
        stats.avgLabel = '平均分';
        stats.extraLabel = '已评分';
        stats.displayExtra = `${stats.submittedCount}`;
        stats.rankEnabled = true;
        stats.rankTitle = '预习作业得分排名';
        stats.rankColLabel = '得分';
    } else if (mode === 'score_only') {
        if (scoreEntries.length > 0) {
            const max = Math.max(...scoreEntries.map(s => s.score));
            const avg = scoreEntries.reduce((a, b) => a + b.score, 0) / scoreEntries.length;
            stats.displayMax = formatScoreDisplay(max);
            stats.displayAvg = formatScoreDisplay(avg);
            const sorted = [...scoreEntries].sort((a, b) => b.score - a.score);
            let curRank = 1;
            let prevScore = null;
            sorted.forEach((item, idx) => {
                if (prevScore !== null && item.score < prevScore) curRank = idx + 1;
                if (map[item.name]) map[item.name].rank = curRank;
                prevScore = item.score;
            });
            stats.rankEntries = sorted;
        }
        stats.maxLabel = '最高分';
        stats.avgLabel = '平均分';
        stats.extraLabel = '已评分';
        stats.displayExtra = `${stats.submittedCount}`;
        stats.rankEnabled = false;
        stats.rankTitle = '预习作业得分排名';
        stats.rankColLabel = '得分';
    } else if (mode === 'accuracy') {
        if (accuracyEntries.length > 0) {
            const max = Math.max(...accuracyEntries.map(s => s.score));
            const avg = accuracyEntries.reduce((a, b) => a + b.score, 0) / accuracyEntries.length;
            stats.displayMax = `${formatMetricValue(max)}%`;
            stats.displayAvg = `${formatMetricValue(avg)}%`;
            const sorted = [...accuracyEntries].sort((a, b) => b.score - a.score);
            let curRank = 1;
            let prevScore = null;
            sorted.forEach((item, idx) => {
                if (prevScore !== null && item.score < prevScore) curRank = idx + 1;
                if (map[item.name]) map[item.name].rank = curRank;
                prevScore = item.score;
            });
            stats.rankEntries = sorted;
        }
        stats.maxLabel = '最高正确率';
        stats.avgLabel = '平均正确率';
        stats.extraLabel = '已统计';
        stats.displayExtra = `${stats.submittedCount}`;
    } else {
        if (correctEntries.length > 0) {
            const max = Math.max(...correctEntries.map(s => s.score));
            const avg = correctEntries.reduce((a, b) => a + b.score, 0) / correctEntries.length;
            stats.displayMax = formatScoreDisplay(max);
            stats.displayAvg = formatScoreDisplay(avg);
            const sorted = [...correctEntries].sort((a, b) => b.score - a.score);
            let curRank = 1;
            let prevScore = null;
            sorted.forEach((item, idx) => {
                if (prevScore !== null && item.score < prevScore) curRank = idx + 1;
                if (map[item.name]) map[item.name].rank = curRank;
                prevScore = item.score;
            });
            stats.rankEntries = sorted;
        }
        stats.maxLabel = '最高对题数';
        stats.avgLabel = '平均对题数';
        if (totalQuestions > 0) {
            stats.extraLabel = '总题数';
            stats.displayExtra = `${totalQuestions}`;
        } else {
            stats.extraLabel = '总题数';
            stats.displayExtra = '-';
        }
    }

    return { rows, map, stats };
}

// ========== Wenjuanxing (问卷星) Preview Metrics ==========
function buildWenjuanxingPreviewMetrics(data, hwStudentNames) {
    const header = data[0].map(h => String(h).trim());
    // Find the "您的姓名：" column and "总分" column
    const nameIdx = header.findIndex(h => h.includes('您的姓名'));
    const scoreIdx = header.findIndex(h => h === '总分' || h.includes('总分'));
    
    if (nameIdx < 0 || scoreIdx < 0) {
        console.error('问卷星数据缺少必要列。需要"您的姓名："和"总分"列。找到的列：', header);
        return { rows: data.slice(1), map: {}, stats: getEmptyWenjuanxingStats() };
    }
    
    const rows = data.slice(1).filter(r => r[nameIdx] && String(r[nameIdx]).trim());
    const map = {};
    const scoreEntries = [];
    
    // Build a reverse lookup: wenjuanxing raw name -> matched homework student name
    // hwStudentNames is an array of student names extracted from homework data (without student IDs)
    
    rows.forEach(r => {
        const rawName = String(r[nameIdx]).trim();
        const score = parseScoreValue(r[scoreIdx]);
        
        // Match the raw name to a homework student name
        // The wenjuanxing name has no student ID, so we need to find the matching name
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
            comment: '' // wenjuanxing has no comments
        };
        
        if (score !== null) {
            scoreEntries.push({ name: matchedName, score });
        }
    });
    
    const stats = {
        mode: 'wenjuanxing',
        submittedCount: Object.keys(map).length,
        displayMax: '-',
        displayAvg: '-',
        displayExtra: `${Object.keys(map).length}`,
        maxLabel: '最高分',
        avgLabel: '平均分',
        extraLabel: '已提交',
        rankEnabled: true,
        rankEntries: [],
        rankTitle: '预习作业得分排名',
        rankColLabel: '得分'
    };
    
    if (scoreEntries.length > 0) {
        const max = Math.max(...scoreEntries.map(s => s.score));
        const avg = scoreEntries.reduce((a, b) => a + b.score, 0) / scoreEntries.length;
        stats.displayMax = formatMetricValue(max);
        stats.displayAvg = formatMetricValue(avg);
        const sorted = [...scoreEntries].sort((a, b) => b.score - a.score);
        let curRank = 1;
        let prevScore = null;
        sorted.forEach((item, idx) => {
            if (prevScore !== null && item.score < prevScore) curRank = idx + 1;
            if (map[item.name]) map[item.name].rank = curRank;
            prevScore = item.score;
        });
        stats.rankEntries = sorted;
    }
    
    return { rows, map, stats };
}

function getEmptyWenjuanxingStats() {
    return {
        mode: 'wenjuanxing',
        submittedCount: 0,
        displayMax: '-',
        displayAvg: '-',
        displayExtra: '0',
        maxLabel: '最高分',
        avgLabel: '平均分',
        extraLabel: '已提交',
        rankEnabled: false,
        rankEntries: [],
        rankTitle: '预习作业得分排名',
        rankColLabel: '得分'
    };
}

function buildWenjuanxingFeedbackSection(pvInfo, pvLesson, stats, rankFormat) {
    let text = `-------------------------\n`;
    if (!pvInfo || !pvInfo.isSubmitted) {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业未提交。\n`;
        return text;
    }
    
    if (pvInfo.score === null) {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业已完成，\n`;
    } else {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业得分为${formatMetricValue(pvInfo.score)}，\n`;
        if (stats.submittedCount > 0) {
            if (!pvInfo.rank || pvInfo.score === 0) {
                text += `最高${stats.displayMax}，平均${stats.displayAvg}。\n`;
            } else {
                let rankText;
                if (rankFormat === 'exact') {
                    rankText = `排名${pvInfo.rank}/${stats.submittedCount}`;
                } else {
                    const rawPercentile = (pvInfo.rank / stats.submittedCount) * 100;
                    const lowerBound = Math.floor((pvInfo.rank - 1) / stats.submittedCount * 100 / 10) * 10;
                    const upperBound = Math.min(Math.ceil(rawPercentile / 10) * 10, 100);
                    rankText = `排名${lowerBound}%~${upperBound}%`;
                }
                text += `最高${stats.displayMax}，平均${stats.displayAvg}，${rankText}。\n`;
            }
        }
    }
    
    // Wenjuanxing uses teacher-entered fixed template comments (same as manual mode)
    const pvComment = getPreviewCommentByMetric(pvInfo, stats, 'score_rank');
    if (pvComment) {
        text += `${pvComment}\n`;
    }
    return text;
}

function applyPreviewStatsUI(stats, hasPreviewData) {
    const pvRankBtn = document.getElementById('preview-rank-btn');
    const pvReminderBtn = document.getElementById('preview-reminder-btn');
    if (!hasPreviewData) {
        if (pvStatsSection) pvStatsSection.style.display = 'none';
        if (pvRankBtn) pvRankBtn.style.display = 'none';
        if (pvReminderBtn) pvReminderBtn.style.display = 'none';
        return;
    }
    if (pvReminderBtn) pvReminderBtn.style.display = '';
    if (document.getElementById('pv-stat-total')) document.getElementById('pv-stat-total').textContent = `${stats.submittedCount}`;
    if (document.getElementById('pv-stat-max')) document.getElementById('pv-stat-max').textContent = stats.displayMax;
    if (document.getElementById('pv-stat-avg')) document.getElementById('pv-stat-avg').textContent = stats.displayAvg;
    if (document.getElementById('pv-stat-questions')) document.getElementById('pv-stat-questions').textContent = stats.displayExtra;
    const maxLabelEl = document.getElementById('pv-stat-max-label');
    const avgLabelEl = document.getElementById('pv-stat-avg-label');
    const extraLabelEl = document.getElementById('pv-stat-extra-label');
    if (maxLabelEl) maxLabelEl.textContent = stats.maxLabel;
    if (avgLabelEl) avgLabelEl.textContent = stats.avgLabel;
    if (extraLabelEl) extraLabelEl.textContent = stats.extraLabel;
    if (pvStatsSection) pvStatsSection.style.display = 'grid';
    if (pvRankBtn) {
        pvRankBtn.style.display = stats.rankEnabled && stats.rankEntries.length > 0 ? '' : 'none';
    }
}

function buildPreviewFeedbackSection(pvInfo, pvLesson, stats, mode, rankFormat) {
    let text = `-------------------------\n`;
    if (!pvInfo || !pvInfo.isSubmitted) {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业未提交。\n`;
        return text;
    }

    if (mode === 'score_rank') {
        if (pvInfo.score === null) {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业已完成，\n`;
        } else {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业得分为${formatMetricValue(pvInfo.score)}，\n`;
            if (stats.submittedCount > 0) {
                if (!pvInfo.rank || pvInfo.score === 0) {
                    text += `最高${stats.displayMax}，平均${stats.displayAvg}。\n`;
                } else {
                    let rankText;
                    if (rankFormat === 'exact') {
                        rankText = `排名${pvInfo.rank}/${stats.submittedCount}`;
                    } else {
                        const rawPercentile = (pvInfo.rank / stats.submittedCount) * 100;
                        const lowerBound = Math.floor((pvInfo.rank - 1) / stats.submittedCount * 100 / 10) * 10;
                        const upperBound = Math.min(Math.ceil(rawPercentile / 10) * 10, 100);
                        rankText = `排名${lowerBound}%~${upperBound}%`;
                    }
                    text += `最高${stats.displayMax}，平均${stats.displayAvg}，${rankText}。\n`;
                }
            }
        }
        const previewSource = getPreviewCommentSource();
        if (previewSource === 'file') {
            if (pvInfo.comment) {
                text += `${pvInfo.comment.trim()}\n`;
            }
        } else if (previewSource === 'manual') {
            text += `${getPreviewCommentByMetric(pvInfo, stats, mode)}\n`;
        } else if (previewSource === 'merge') {
            // Merge mode: file comment first, then manual comment
            const parts = [];
            if (pvInfo.comment) {
                parts.push(pvInfo.comment.trim());
            }
            const manualComment = getPreviewCommentByMetric(pvInfo, stats, mode);
            if (manualComment) {
                parts.push(manualComment);
            }
            if (parts.length > 0) {
                text += `${parts.join('\n')}\n`;
            }
        }
        return text;
    }

    if (mode === 'score_only') {
        if (pvInfo.score === null) {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业已完成，\n`;
        } else {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业得分为${formatMetricValue(pvInfo.score)}，\n`;
            if (stats.submittedCount > 0) {
                text += `最高${stats.displayMax}，平均${stats.displayAvg}。\n`;
            }
        }
        const previewSource = getPreviewCommentSource();
        if (previewSource === 'file') {
            if (pvInfo.comment) {
                text += `${pvInfo.comment.trim()}\n`;
            }
        } else if (previewSource === 'manual') {
            text += `${getPreviewCommentByMetric(pvInfo, stats, mode)}\n`;
        } else if (previewSource === 'merge') {
            const parts = [];
            if (pvInfo.comment) {
                parts.push(pvInfo.comment.trim());
            }
            const manualComment = getPreviewCommentByMetric(pvInfo, stats, mode);
            if (manualComment) {
                parts.push(manualComment);
            }
            if (parts.length > 0) {
                text += `${parts.join('\n')}\n`;
            }
        }
        return text;
    }

    if (mode === 'accuracy') {
        if (pvInfo.accuracy === null) {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业已完成，\n`;
        } else {
            text += `第${pvLesson}${getLessonUnit()}课前预习作业正确率为${pvInfo.accuracyText}，\n`;
            if (stats.submittedCount > 0) {
                text += `最高${stats.displayMax}，平均${stats.displayAvg}。\n`;
            }
        }
        const previewSource = getPreviewCommentSource();
        if (previewSource === 'file') {
            if (pvInfo.comment) {
                text += `${pvInfo.comment.trim()}\n`;
            }
        } else if (previewSource === 'manual') {
            text += `${getPreviewCommentByMetric(pvInfo, stats, mode)}\n`;
        } else if (previewSource === 'merge') {
            const parts = [];
            if (pvInfo.comment) {
                parts.push(pvInfo.comment.trim());
            }
            const manualComment = getPreviewCommentByMetric(pvInfo, stats, mode);
            if (manualComment) {
                parts.push(manualComment);
            }
            if (parts.length > 0) {
                text += `${parts.join('\n')}\n`;
            }
        }
        return text;
    }

    if (pvInfo.correctCount === null) {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业已完成，\n`;
    } else {
        text += `第${pvLesson}${getLessonUnit()}课前预习作业正确个数为${pvInfo.correctCount}，\n`;
        if (stats.submittedCount > 0) {
            if (!pvInfo.rank) {
                text += `最高${stats.displayMax}，平均${stats.displayAvg}。\n`;
            } else {
                let rankText;
                if (rankFormat === 'exact') {
                    rankText = `排名${pvInfo.rank}/${stats.submittedCount}`;
                } else {
                    const rawPercentile = (pvInfo.rank / stats.submittedCount) * 100;
                    const lowerBound = Math.floor((pvInfo.rank - 1) / stats.submittedCount * 100 / 10) * 10;
                    const upperBound = Math.min(Math.ceil(rawPercentile / 10) * 10, 100);
                    rankText = `排名${lowerBound}%~${upperBound}%`;
                }
                text += `最高${stats.displayMax}，平均${stats.displayAvg}，${rankText}。\n`;
            }
        }
    }
    const previewSource = getPreviewCommentSource();
    if (previewSource === 'file') {
        if (pvInfo.comment) {
            text += `${pvInfo.comment.trim()}\n`;
        }
    } else if (previewSource === 'manual') {
        text += `${getPreviewCommentByMetric(pvInfo, stats, mode)}\n`;
    } else if (previewSource === 'merge') {
        const parts = [];
        if (pvInfo.comment) {
            parts.push(pvInfo.comment.trim());
        }
        const manualComment = getPreviewCommentByMetric(pvInfo, stats, mode);
        if (manualComment) {
            parts.push(manualComment);
        }
        if (parts.length > 0) {
            text += `${parts.join('\n')}\n`;
        }
    }
    return text;
}

// ========== Core: Render Feedback ==========
function renderFeedback() {
    if (sessionPayload.homeworkFiles && sessionPayload.homeworkFiles.length > 0) {
        const hwHeader = sessionPayload.homeworkFiles[0].data[0];
        let hwRows = [];
        sessionPayload.homeworkFiles.forEach(f => { if (f.data.length > 1) hwRows.push(...f.data.slice(1)); });
        homeworkData = [hwHeader, ...hwRows];
        homeworkFileName = sessionPayload.homeworkFiles[0].name;
    } else {
        homeworkData = null;
        homeworkFileName = '';
    }
    doGenerateFeedback();
}

async function doGenerateFeedback(skipUnsubmittedCheck = false) {
    if (!homeworkData && previewData) {
        doGeneratePreviewOnlyFeedback();
        return;
    }
    if (!homeworkData) return;
    const hwHeader = homeworkData[0];
    const nameIdx = hwHeader.findIndex(h => h.includes('姓名'));
    const scoreIdx = hwHeader.findIndex(h => h.includes('得分'));
    const commentIdx = findCommentColumnIndex(hwHeader, '批改评语');
    const correctionCommentIdx = findCommentColumnIndex(hwHeader, '订正评语');
    const hwStatusIdx = hwHeader.findIndex(h => h.includes('作业状态'));
    const accIdx = hwHeader.findIndex(h => h.includes('正确率') || h.includes('正答率'));
    const totalScoreIdx = hwHeader.findIndex(h => h.includes('满分') || h.includes('总分'));
    const batchTotalScore = (typeof estimateHomeworkTotalScore === 'function') ? estimateHomeworkTotalScore(homeworkData) : 100;
    const rawHwRows = homeworkData.slice(1).filter(r => r[nameIdx] && r[nameIdx].trim());
    // 学生行去重保护：若存在同名/同学号重复行，以最后出现的最优最新数据行为准，防止返工重新上传时旧数据残留
    const idIdxForDedup = hwHeader.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('卡号'));
    const studentRowMap = new Map();
    rawHwRows.forEach(r => {
        const fn = (r[nameIdx] || '').trim();
        const nm = fn.match(/\d+(.+)/);
        const sn = nm ? nm[1] : fn;
        const idMatch = fn.match(/^(\d+)/);
        const sid = (idIdxForDedup >= 0 && r[idIdxForDedup]) ? String(r[idIdxForDedup]).trim() : (idMatch ? idMatch[1] : '');
        const key = sid ? `${sid}_${sn}` : fn;
        studentRowMap.set(key, r);
    });
    const hwRows = Array.from(studentRowMap.values());

    // Build dropped students set from payload
    const droppedStudents = sessionPayload.droppedStudents || null;
    const droppedHwSet = new Set(droppedStudents?.homework || []);
    const droppedPvSet = new Set(droppedStudents?.preview || []);
    const allDroppedSet = new Set([...droppedHwSet, ...droppedPvSet]);

    // Build exclusion set from payload
    const exclusionListText = sessionPayload.exclusionList || '';
    const exclusionSet = new Set(
        exclusionListText.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
    );

    // Filter out dropped students and excluded students from hwRows for score calculations
    const activeHwRows = hwRows.filter(r => {
        const fn = r[nameIdx] || '';
        const nm = fn.match(/\d+(.+)/);
        const sn = nm ? nm[1] : fn;
        if (droppedHwSet.has(sn)) return false;
        if (exclusionSet.has(fn)) return false; // Match by 学号+姓名
        return true;
    });

    // Build homework status map
    const homeworkMap = {};
    hwRows.forEach(r => {
        const fullName = r[nameIdx] || '';
        const nameMatch = fullName.match(/\d+(.+)/);
        const studentName = nameMatch ? nameMatch[1] : fullName;
        const status = hwStatusIdx >= 0 ? (r[hwStatusIdx] || '') : '';
        const rowScore = parseScoreValue(r[scoreIdx]);
        const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正') || (status.includes('批改中') && rowScore !== null);
        homeworkMap[studentName] = { isSubmitted, status };
    });

    const scoresWithIdx = activeHwRows.map((r, i) => {
        const status = hwStatusIdx >= 0 ? (r[hwStatusIdx] || '') : '';
        const rowScore = parseScoreValue(r[scoreIdx]);
        const isSubmitted = status ? (status.includes('已完成') || status.includes('待订正') || status.includes('已订正') || (status.includes('批改中') && rowScore !== null)) : true;
        if (!isSubmitted) return { score: null, index: i };
        return { score: rowScore, index: i };
    }).filter(x => x.score !== null);
    const scores = scoresWithIdx.map(x => x.score);
    const totalStudents = scores.length;
    const rawMax = scores.length > 0 ? Math.max(...scores) : 0;
    const maxScore = shouldForceIntegerScores() ? Math.round(rawMax) : rawMax;
    const nonZero = scores.filter(s => s > 0);
    const rawAvg = nonZero.length > 0 ? (nonZero.reduce((a, b) => a + b, 0) / nonZero.length) : 0;
    const avgScore = roundAvgScore(rawAvg);
    const rankFormat = sessionPayload.rankFormat || 'exact';
    const isWenjuanxing = getPhysicsPreviewSource() === 'wenjuanxing';
    const previewMetricMode = isWenjuanxing ? 'score_rank' : resolvePreviewMetricMode(sessionPayload);
    const previewTotalQuestions = sessionPayload.previewTotalQuestions || 0;

    // Build preview model - use wenjuanxing parser if source is wenjuanxing
    let previewModel = null;
    if (previewData) {
        if (isWenjuanxing) {
            // Collect homework student names (without IDs) for matching
            const hwStudentNames = hwRows.map(r => {
                const fullName = r[nameIdx] || '';
                const nameMatch = fullName.match(/\d+(.+)/);
                return nameMatch ? nameMatch[1] : fullName;
            });
            previewModel = buildWenjuanxingPreviewMetrics(previewData, hwStudentNames);
        } else {
            previewModel = buildPreviewMetrics(previewData, previewMetricMode, previewTotalQuestions);
        }
    }
    const previewMap = previewModel?.map || {};
    const previewStats = previewModel?.stats || {
        submittedCount: 0,
        displayMax: '-',
        displayAvg: '-',
        displayExtra: '0',
        maxLabel: '最高正确数',
        avgLabel: '平均正确数',
        extraLabel: '总题数',
        rankEnabled: false,
        rankEntries: [],
        rankTitle: '预习作业排名',
        rankColLabel: '分值'
    };

    // Report data processing (same as original)
    onlineStudents = {};
    let focusStats = { max: 0, avg: 0, total: 0, scores: [] };
    if (reportData) {
        const rptHeader = reportData[0];
        const rptRows = reportData.slice(1);
        const rptNameIdx = rptHeader.findIndex(h => h.includes('学生姓名') || h.includes('姓名'));
        const classIdx = rptHeader.findIndex(h => h.includes('班级'));
        const rewardIdx = rptHeader.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
        const attIdx = rptHeader.findIndex(h => 
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
            !h.includes('时长') && !h.includes('率')
        );
        rptRows.forEach(row => {
            if (row[rptNameIdx]) {
                const rawName = row[rptNameIdx].trim();
                const nm = rawName.match(/\d+(.+)/);
                const nameKey = nm ? nm[1] : rawName;
                const className = row[classIdx] || '';
                let isOnline = className.includes('β1');
                const override = onlineOverrides[nameKey];
                if (override === 'online') isOnline = true;
                else if (override === 'offline') isOnline = false;

                // 出勤与积分判定（双重保险：是否有效出勤列 + 积分是否为'-'）
                const rawAtt = attIdx >= 0 ? String(row[attIdx] || '').trim() : '';
                const reward = row[rewardIdx];
                const isDashOrEmpty = (reward === '-' || reward === '' || reward === null || reward === undefined);

                let isAbsent = false;
                if (attIdx >= 0 && rawAtt.includes('缺勤')) {
                    isAbsent = true;
                } else if (isDashOrEmpty) {
                    isAbsent = true;
                }

                const rewardValue = isAbsent ? null : parseScoreValue(reward);
                onlineStudents[nameKey] = { isOnline, reward: rewardValue, isAbsent, className, attendance: rawAtt };
                if (isOnline && rewardValue !== null && !isAbsent) {
                    focusStats.scores.push({ name: nameKey, score: rewardValue });
                }
            }
        });
        if (focusStats.scores.length > 0) {
            focusStats.total = focusStats.scores.length;
            focusStats.max = Math.max(...focusStats.scores.map(s => s.score));
            focusStats.avg = Math.round(focusStats.scores.reduce((a, b) => a + b.score, 0) / focusStats.total * 10) / 10;
            focusStats.scores.sort((a, b) => b.score - a.score);
            let cr = 1, ps = null;
            focusStats.scores.forEach((item, idx) => {
                if (ps !== null && item.score < ps) cr = idx + 1;
                if (onlineStudents[item.name]) onlineStudents[item.name].focusRank = cr;
                ps = item.score;
            });
            
            // Check if adjusted max focus score is not 6, force custom comments
            const adjustedMax = getAdjustedFocusScore(focusStats.max);
            if (adjustedMax !== 6 && getFocusCommentSource() === 'default') {
                sessionPayload.focusCommentSource = 'custom';
                sessionPayload.focusMaxScore = adjustedMax;
                const defaultComments = {
                    7: '专注度很好，给你点赞，请继续保持！',
                    6: '专注度很好，给你点赞，请继续保持！',
                    5: '专注度尚可，但未全神贯注，下次争取全心投入，拿满分！',
                    4: '专注度一般，请及时作出调整；',
                    3: '专注度一般，请及时作出调整；',
                    2: '专注度较差，请私聊老师说明情况',
                    1: '专注度较差，请私聊老师说明情况',
                    0: '未获得课堂积分，请及时调整状态！'
                };
                const customComments = {};
                for (let s = adjustedMax; s >= 0; s--) {
                    customComments[s] = defaultComments[s] || '';
                }
                sessionPayload.focusComments = customComments;
            }
        }
    }

    const lessonNums = sessionPayload.lessonNumbers || {};
    const feedbackSubject = sessionPayload.subject || '数学';
    const hwLesson = lessonNums.homework || extractLessonNumber(homeworkFileName, 'homework');
    const pvLesson = previewData ? (lessonNums.preview || extractLessonNumber(previewFileName, 'preview')) : null;
    const rptLesson = reportData ? (lessonNums.report || extractLessonNumber(reportFileName, 'report')) : null;
    const noteLesson = noteData ? (lessonNums.note || extractLessonNumber(noteFileName, 'note')) : null;
    const classTestLesson = classTestData ? (lessonNums.classTest || extractLessonNumber(classTestFileName, 'class_test')) : null;
    const onlineCount = Object.values(onlineStudents).filter(s => s.isOnline).length;

    // Populate consolidation stats
    if (document.getElementById('hw-stat-total')) document.getElementById('hw-stat-total').textContent = totalStudents;
    if (document.getElementById('hw-stat-max')) document.getElementById('hw-stat-max').textContent = maxScore;
    if (document.getElementById('hw-stat-avg')) document.getElementById('hw-stat-avg').textContent = avgScore;
    if (document.getElementById('hw-stat-online')) document.getElementById('hw-stat-online').textContent = onlineCount;
    if (hwStatsSection) hwStatsSection.style.display = 'grid';
    const homeworkReminderBtn = document.getElementById('homework-reminder-btn');
    const homeworkRankBtn = document.getElementById('homework-rank-btn');
    const noteReminderBtn = document.getElementById('note-reminder-btn');
    const classTestReminderBtn = document.getElementById('class-test-reminder-btn');
    if (homeworkReminderBtn) homeworkReminderBtn.style.display = '';
    if (homeworkRankBtn) homeworkRankBtn.style.display = '';
    if (noteReminderBtn) noteReminderBtn.style.display = (feedbackSubject === '英语' && noteData) ? '' : 'none';
    if (classTestReminderBtn) classTestReminderBtn.style.display = (feedbackSubject === '英语' && classTestData) ? '' : 'none';

    applyPreviewStatsUI(previewStats, !!previewData);

    // Cache for export functions
    cachedPreviewMap = previewMap;
    cachedPreviewStats = previewStats;
    cachedPlusData = sessionPayload.plusData;
    cachedPlusErrorStats = {};

    // Build note submission map for English subject
    const noteMap = {};
    if (noteData && feedbackSubject === '英语') {
        const noteHeader = noteData[0];
        const noteRows = noteData.slice(1);
        const noteNameIdx = noteHeader.findIndex(h => h.includes('姓名'));
        const noteStatusIdx = noteHeader.findIndex(h => h.includes('作业状态'));
        noteRows.forEach(r => {
            const fullName = r[noteNameIdx] || '';
            const nameMatch = fullName.match(/\d+(.+)/);
            const name = nameMatch ? nameMatch[1] : fullName;
            const status = noteStatusIdx >= 0 ? (r[noteStatusIdx] || '') : '';
            const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正');
            noteMap[name] = { isSubmitted, status };
        });
    }

    // Build class test submission map for English subject
    const classTestMap = {};
    if (classTestData && feedbackSubject === '英语') {
        const ctHeader = classTestData[0];
        const ctRows = classTestData.slice(1);
        const ctNameIdx = ctHeader.findIndex(h => h.includes('姓名'));
        const ctStatusIdx = ctHeader.findIndex(h => h.includes('作业状态'));
        ctRows.forEach(r => {
            const fullName = r[ctNameIdx] || '';
            const nameMatch = fullName.match(/\d+(.+)/);
            const name = nameMatch ? nameMatch[1] : fullName;
            const status = ctStatusIdx >= 0 ? (r[ctStatusIdx] || '') : '';
            const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正');
            classTestMap[name] = { isSubmitted, status };
        });
    }

    resultBody.innerHTML = '';

    const tableContainer = document.createElement('div');
    tableContainer.className = 'table-container';
    const table = document.createElement('table');
    table.className = 'result-table';
    table.id = 'result-table';

    const tbody = document.createElement('tbody');
    tbody.id = 'result-tbody';
    tbody.addEventListener('click', function (e) {
        const tr = e.target.closest('tr');
        if (tr && tr.classList.contains('copied-row')) {
            if (typeof focusedRowIndex !== 'undefined' && focusedRowIndex >= 0) {
                showToast('请先退出专注模式');
            } else {
                tr.classList.remove('copied-row');
            }
        }
    });

    // Plus feature: Batch encrypt retest tokens
    let plusTokens = {};
    // 错题本身份 Key：学号_姓名_年级_学科（与服务端 build_student_key 保持一致）
    // 注意：这两个 helper 在无错题本（plusData 关闭）时也要可用于生成学生行 Key。
    const plusGradeForKey = sessionPayload.plusData?.grade || '';
    const plusSubjectForKey = sessionPayload.subject || '数学';
    const buildPlusStudentKey = (studentId, studentName, fullName, index) => {
        if (!studentId) return fullName || `${studentName}_${index}`;
        if (!plusGradeForKey || !plusSubjectForKey) return `${studentId}_${studentName}`;
        return `${studentId}_${studentName}_${plusGradeForKey}_${plusSubjectForKey}`;
    };
    const buildLegacyStudentKey = (studentId, studentName) => studentId ? `${studentId}_${studentName}` : studentName;

    if (sessionPayload.plusData && sessionPayload.plusData.enabled) {
        const idIdx = hwHeader.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('卡号'));
        const uploadedFileNames = [];
        if (sessionPayload.homeworkFiles) {
            sessionPayload.homeworkFiles.forEach(f => { if (f.name && !uploadedFileNames.includes(f.name)) uploadedFileNames.push(f.name); });
        }
        if (sessionPayload.previewFiles) {
            sessionPayload.previewFiles.forEach(f => { if (f.name && !uploadedFileNames.includes(f.name)) uploadedFileNames.push(f.name); });
        }
        if (sessionPayload.noteFiles) {
            sessionPayload.noteFiles.forEach(f => { if (f.name && !uploadedFileNames.includes(f.name)) uploadedFileNames.push(f.name); });
        }
        if (sessionPayload.classTestFiles) {
            sessionPayload.classTestFiles.forEach(f => { if (f.name && !uploadedFileNames.includes(f.name)) uploadedFileNames.push(f.name); });
        }
        if (sessionPayload.reportFile?.name && !uploadedFileNames.includes(sessionPayload.reportFile.name)) {
            uploadedFileNames.push(sessionPayload.reportFile.name);
        }
        if (sessionPayload.rosterFileName && !uploadedFileNames.includes(sessionPayload.rosterFileName)) {
            uploadedFileNames.push(sessionPayload.rosterFileName);
        }
        if (Array.isArray(sessionPayload.sourceFileNames)) {
            sessionPayload.sourceFileNames.forEach(name => {
                if (name && !uploadedFileNames.includes(name)) uploadedFileNames.push(name);
            });
        }

        const batchPayload = {
            year: window.semesterYear || 2026,
            season: window.defaultSeason || 'spring',
            subject: sessionPayload.subject || '数学',
            grade: sessionPayload.plusData.grade,
            tier: sessionPayload.plusData.tier,
            week: sessionPayload.plusData.week,
            preview_week: sessionPayload.plusData.previewWeek || pvLesson || sessionPayload.plusData.week,
            has_preview_data: !!previewData,
            has_homework_data: true,
            source_files: uploadedFileNames,
            students: []
        };

        hwRows.forEach((row, index) => {
            const fullName = (row[nameIdx] || '').trim();
            const nameMatch = fullName.match(/\d+(.+)/);
            const studentName = nameMatch ? nameMatch[1] : fullName;
            if (allDroppedSet.has(studentName)) return;
            if (exclusionSet.has(fullName)) return;

            const studentIdMatch = fullName.match(/^(\d+)/);
            let studentId = '';
            if (idIdx >= 0 && row[idIdx]) {
                studentId = String(row[idIdx]).trim();
            } else if (studentIdMatch) {
                studentId = studentIdMatch[1];
            }
            const studentKey = buildPlusStudentKey(studentId, studentName, fullName, index);
            
            const rawScore = parseScoreValue(row[scoreIdx]);
            const homeworkScore = rawScore !== null ? rawScore : 0;
            const pvInfo = cachedPreviewMap ? cachedPreviewMap[studentName] : null;
            const previewScore = (pvInfo && pvInfo.isSubmitted) ? (pvInfo.score ?? pvInfo.metricValue ?? null) : null;

            const originalCommentForPlus = commentIdx >= 0 ? String(row[commentIdx] || '') : '';
            const fileCommentForPlus = getEffectiveComment(row, commentIdx, correctionCommentIdx);
            const studentTot = (totalScoreIdx >= 0) ? parseScoreValue(row[totalScoreIdx]) : batchTotalScore;
            const commentForPlus = parseCommentForPlus(originalCommentForPlus, fileCommentForPlus, {
                homeworkScore: homeworkScore,
                maxScore: studentTot || batchTotalScore || 100,
                questions: sessionPayload?.plusData?.questions
            });
            const previewCommentForPlus = pvInfo?.comment ? String(pvInfo.comment) : '';
            const previewParsedForPlus = previewCommentForPlus
                ? parseErrorQuestionsFromComment(previewCommentForPlus)
                : null;
            batchPayload.students.push({
                id: studentId,
                name: studentName,
                fullName: fullName,
                key: studentKey,
                errors: commentForPlus.errorNums,
                previewErrors: previewParsedForPlus?.errorNums || [],
                previewComment: previewCommentForPlus,
                previewWeek: sessionPayload.plusData.previewWeek || pvLesson || sessionPayload.plusData.week,
                homeworkScore: homeworkScore,
                previewScore: previewScore,
                totalScore: studentTot || batchTotalScore || 100,
                comment: fileCommentForPlus
            });
        });
        
        if (batchPayload.students.length > 0) {
            batchPayload.teacher_username = window.currentUser?.username || '';
            batchPayload.teacher_name = window.currentUser?.real_name || '';
            try {
                const reqFn = typeof requestWithTimeout === 'function' ? requestWithTimeout : fetch;
                const resp = await reqFn('api/retest.php?action=encrypt_batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batchPayload)
                }, 4000);
                const result = await resp.json();
                if (result.success && result.tokens) {
                    plusTokens = result.tokens;
                }
            } catch (e) {
                console.warn('获取专属错题本Token跳过或超时 (弱网优雅降级):', e);
            }
        }
    }

    hwRows.forEach((row, index) => {
        const fullName = (row[nameIdx] || '').trim();
        const nameMatch = fullName.match(/\d+(.+)/);
        const studentName = nameMatch ? nameMatch[1].trim() : fullName;

        // Skip dropped students and excluded students
        if (allDroppedSet.has(studentName)) return;
        if (exclusionSet.has(fullName)) return;

        const idIdx = hwHeader.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('卡号'));
        const studentIdMatch = fullName.match(/^(\d+)/);
        let studentId = '';
        if (idIdx >= 0 && row[idIdx]) {
            studentId = String(row[idIdx]).trim();
        } else if (studentIdMatch) {
            studentId = studentIdMatch[1];
        }
        const studentKey = buildPlusStudentKey(studentId, studentName, fullName, index);
        const legacyStudentKey = buildLegacyStudentKey(studentId, studentName);
        const rawScore = parseScoreValue(row[scoreIdx]);
        const score = rawScore !== null ? rawScore : 0;
        const rank = scores.filter(s => s > score).length + 1;
        let rankText;
        if (rankFormat === 'exact') {
            rankText = `排名${rank}/${totalStudents}`;
        } else {
            const rawPercentile = (rank / totalStudents) * 100;
            const lowerBound = Math.floor((rank - 1) / totalStudents * 100 / 10) * 10;
            const upperBound = Math.min(Math.ceil(rawPercentile / 10) * 10, 100);
            rankText = `排名${lowerBound}%~${upperBound}%`;
        }

        const commentSummary = getCommentSummary();
        let summaryPart = commentSummary ? `本节课总结：\n${commentSummary.trim()}\n` : '';
        let comment = '';
        const originalCommentForPlus = commentIdx >= 0 ? String(row[commentIdx] || '') : '';
        let fileCommentForPlus = getEffectiveComment(row, commentIdx, correctionCommentIdx);
        const homeworkSource = getHomeworkCommentSource();
        if (homeworkSource === 'file') {
            comment = fileCommentForPlus;
        } else if (homeworkSource === 'manual') {
            comment = getCommentByScore(score, maxScore, avgScore, rank, totalStudents);
        } else if (homeworkSource === 'merge') {
            // Merge mode: file comment first, then manual comment
            const parts = [];
            if (fileCommentForPlus) {
                parts.push(fileCommentForPlus.trim());
            }
            const manualComment = getCommentByScore(score, maxScore, avgScore, rank, totalStudents);
            if (manualComment) {
                parts.push(manualComment);
            }
            comment = parts.join('\n');
        }

        const onlineInfo = onlineStudents[studentName] || null;
        const isOnline = onlineInfo?.isOnline || false;
        const focusScore = onlineInfo?.reward ?? -1;

        // ===== Build feedback text =====
        let feedback = `${studentName}家长您好，\n`;
        if (summaryPart) {
            feedback += summaryPart;
        }
        feedback += `以下是${getStudentDisplayName(studentName)}${feedbackSubject}作业情况反馈：\n`;

        // --- Preview homework section ---
        let previewParsed = null;
        let previewTopics = [];
        if (previewData && pvLesson) {
            const pvInfo = previewMap[studentName];
            previewParsed = pvInfo?.comment ? parseErrorQuestionsFromComment(String(pvInfo.comment)) : null;
            const previewDisplayInfo = (sessionPayload.plusData?.enabled && previewParsed && previewParsed.errorNums.length > 0)
                ? { ...pvInfo, comment: previewParsed.cleanComment }
                : pvInfo;
            if (isWenjuanxing) {
                feedback += buildWenjuanxingFeedbackSection(previewDisplayInfo, pvLesson, previewStats, rankFormat);
            } else {
                feedback += buildPreviewFeedbackSection(previewDisplayInfo, pvLesson, previewStats, previewMetricMode, rankFormat);
            }

            // 预习作业个人薄弱点展示
            if (sessionPayload.plusData?.enabled && previewParsed && previewParsed.errorNums.length > 0) {
                const previewQuestions = sessionPayload.plusData.previewQuestions || sessionPayload.plusData.questions || [];
                if (previewQuestions.length > 0) {
                    const previewQuestionMap = {};
                    previewQuestions.forEach(q => {
                        const ids = String(q.id || q.question_num || '').split(/[,、，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                        const cleanT = typeof cleanTopicTrailingPunctuation === 'function' 
                            ? cleanTopicTrailingPunctuation(q.topic) 
                            : (q.topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
                        ids.forEach(id => { previewQuestionMap[id] = cleanT; });
                    });
                    previewTopics = [...new Set(previewParsed.errorNums.map(num => previewQuestionMap[num] || `第${num}题`).filter(Boolean))];
                    if (previewTopics.length > 0) {
                        feedback += `【预习薄弱点】：${previewTopics.join('、')}\n`;
                    }
                }
            }
        }

        // --- Consolidation homework section ---
        const hwInfo = homeworkMap[studentName];
        const hwSubmitted = hwInfo?.isSubmitted ?? true;

        if (!hwSubmitted) {
            feedback += `-------------------------\n`;
            feedback += `第${hwLesson}${getLessonUnit()}${getHomeworkLabelFull()}未提交。\n`;
        } else {
            feedback += `-------------------------\n`;
            feedback += `第${hwLesson}${getLessonUnit()}${getHomeworkLabelFull()}得分为${score}，\n`;
            if (score === 0) {
                feedback += `最高${maxScore}，平均${avgScore}。\n`;
            } else {
                feedback += `最高${maxScore}，平均${avgScore}，${rankText}。\n`;
            }
        }

        // Plus feature: parse error question numbers from comment (only if submitted)
        let plusFeedbackPart = '';
        if (hwSubmitted) {
            const plusData = sessionPayload.plusData;
            let actualComment = comment;
            let errorQuestionNums = [];

            if (plusData && plusData.enabled && plusData.questions && plusData.questions.length > 0 && fileCommentForPlus) {
                const commentForPlus = parseCommentForPlus(originalCommentForPlus, fileCommentForPlus, {
                    homeworkScore: score,
                    maxScore: maxScore || 100,
                    questions: plusData.questions
                });
                errorQuestionNums = commentForPlus.errorNums;
                const homeworkSource = getHomeworkCommentSource();
                if (homeworkSource === 'file') {
                    actualComment = commentForPlus.displayComment;
                } else if (homeworkSource === 'merge') {
                    // In merge mode, use parsed file comment + manual comment
                    const manualComment = getCommentByScore(score, maxScore, avgScore, rank, totalStudents);
                    const parts = [];
                    if (commentForPlus.displayComment) {
                        parts.push(commentForPlus.displayComment.trim());
                    }
                    if (manualComment) {
                        parts.push(manualComment);
                    }
                    actualComment = parts.join('\n');
                }
            }

            if (actualComment) {
                feedback += `${actualComment.trim()}\n`;
            }

            // Plus: add targeted consolidation suggestions
            if (plusData && plusData.enabled) {
                const hasHomeworkErrors = errorQuestionNums.length > 0;
                const hasPreviewErrors = previewTopics.length > 0 || Boolean(previewParsed && previewParsed.errorNums && previewParsed.errorNums.length > 0);
                const hasAnyErrors = hasHomeworkErrors || hasPreviewErrors;

                let homeworkTopics = [];
                if (hasHomeworkErrors && plusData.questions) {
                    const questionMap = {};
                    plusData.questions.forEach(q => {
                        const ids = String(q.id || q.question_num || '').split(/[,、，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                        const cleanT = typeof cleanTopicTrailingPunctuation === 'function' 
                            ? cleanTopicTrailingPunctuation(q.topic) 
                            : (q.topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
                        ids.forEach(id => { questionMap[id] = cleanT; });
                    });
                    
                    homeworkTopics = [...new Set(errorQuestionNums.map(num => questionMap[num] || `第${num}题`).filter(Boolean))];
                    
                    errorQuestionNums.forEach(num => {
                        const topic = questionMap[num];
                        if (!cachedPlusErrorStats[num]) {
                            cachedPlusErrorStats[num] = { count: 0, topic: topic || '无知识点', students: [] };
                        }
                        cachedPlusErrorStats[num].count++;
                        const studentDisplayName = fullName || studentName;
                        if (!cachedPlusErrorStats[num].students.includes(studentDisplayName)) {
                            cachedPlusErrorStats[num].students.push(studentDisplayName);
                        }
                    });
                }

                if (homeworkTopics.length > 0) {
                    const hwLabel = (previewTopics.length > 0 || (previewData && pvLesson)) ? '【巩固薄弱点】' : '【个人薄弱点】';
                    plusFeedbackPart += `${hwLabel}：${homeworkTopics.join('、')}\n`;
                }

                if (previewTopics.length > 0) {
                    plusFeedbackPart += `【预习薄弱点】：${previewTopics.join('、')}\n`;
                }

                if (hasAnyErrors) {
                    plusFeedbackPart += `【错题本】：点击链接查看本专题的错题\n`;
                    const token = plusTokens[studentKey]
                        || plusTokens[legacyStudentKey]
                        || (!studentId ? (plusTokens[fullName] || plusTokens[studentName]) : '');
                    if (token) {
                        const retestBase = getRetestBaseUrl();
                        const previewSuffix = hasPreviewErrors ? '（预习错题请切换到对应专题查看）' : '';
                        plusFeedbackPart += `${retestBase}?token=${token}${previewSuffix}\n`;
                    } else {
                        plusFeedbackPart += `(生成链接失败，请联系老师)\n`;
                    }
                } else {
                    // 严格校验：结合分数、正确率、推算满分以及评语多维判定是否真正满分
                    const studentAcc = (accIdx >= 0) ? parsePercentValue(row[accIdx]) : null;
                    const studentTot = (totalScoreIdx >= 0) ? parseScoreValue(row[totalScoreIdx]) : batchTotalScore;
                    const isFullScore = (typeof checkStudentFullScore === 'function')
                        ? checkStudentFullScore({ score, accuracy: studentAcc, totalScore: studentTot, comment: [originalCommentForPlus, fileCommentForPlus].filter(Boolean).join('\n') || comment || '' })
                        : ((score >= 100 || (studentTot && score >= studentTot && score > 0)) || /(?:全对|全部正确|零失误|无错题|免除加练|错题(?:题号)?(?:为|是)?\s*[:：]\s*(?:无|0|零))/i.test([originalCommentForPlus, fileCommentForPlus].filter(Boolean).join('\n') || comment || ''));

                    if (isFullScore) {
                        plusFeedbackPart += `【错题本】：本次作业满分，暂无错题需要重练，表现优异，继续加油！\n`;
                    } else {
                        plusFeedbackPart += `【课后复习建议】：本次作业得分为${score}分，请${studentName}同学针对课堂疑难点与错题认真完成错题整理与订正，及时查漏补缺！\n`;
                    }
                }
            }
        } else {
            const plusData = sessionPayload.plusData;
            if (plusData && plusData.enabled) {
                const hasPreviewErrors = previewTopics.length > 0 || Boolean(previewParsed && previewParsed.errorNums && previewParsed.errorNums.length > 0);
                if (hasPreviewErrors) {
                    plusFeedbackPart = `第${hwLesson}${getLessonUnit()}${getHomeworkLabelFull()}未提交。\n`;
                    if (previewTopics.length > 0) {
                        plusFeedbackPart += `【预习薄弱点】：${previewTopics.join('、')}\n`;
                    }
                    plusFeedbackPart += `【错题本】：点击链接查看本专题的错题\n`;
                    const token = plusTokens[studentKey]
                        || plusTokens[legacyStudentKey]
                        || (!studentId ? (plusTokens[fullName] || plusTokens[studentName]) : '');
                    if (token) {
                        const retestBase = getRetestBaseUrl();
                        const previewSuffix = '（预习错题请切换到对应专题查看）';
                        plusFeedbackPart += `${retestBase}?token=${token}${previewSuffix}\n`;
                    } else {
                        plusFeedbackPart += `(生成链接失败，请联系老师)\n`;
                    }
                } else {
                    plusFeedbackPart = `第${hwLesson}${getLessonUnit()}${getHomeworkLabelFull()}未提交，暂无错题加练数据。\n`;
                }
            }
        }

        // --- Note homework section (English only) ---
        if (noteData) {
            const noteHeader = noteData[0];
            const noteRows = noteData.slice(1);
            const noteNameIdx = noteHeader.findIndex(h => h.includes('姓名'));
            const noteScoreIdx = noteHeader.findIndex(h => h.includes('得分'));
            const noteCommentIdx = findCommentColumnIndex(noteHeader, '批改评语');
            const noteCorrectionCommentIdx = findCommentColumnIndex(noteHeader, '订正评语');
            const noteStatusIdx = noteHeader.findIndex(h => h.includes('作业状态'));
            
            // Find note data for this student
            const noteRow = noteRows.find(r => {
                const fullName = r[noteNameIdx] || '';
                const nameMatch = fullName.match(/\d+(.+)/);
                const name = nameMatch ? nameMatch[1] : fullName;
                return name === studentName;
            });
            
            if (noteRow) {
                const rawNoteScore = noteScoreIdx >= 0 ? parseScoreValue(noteRow[noteScoreIdx]) : null;
                const noteScore = rawNoteScore !== null ? rawNoteScore : 0;
                const noteComment = getEffectiveComment(noteRow, noteCommentIdx, noteCorrectionCommentIdx);
                const noteStatus = noteStatusIdx >= 0 ? (noteRow[noteStatusIdx] || '') : '';
                const noteSubmitted = noteStatus.includes('已完成') || noteStatus.includes('待订正') || noteStatus.includes('已订正');
                
                // Calculate note stats
                const noteScoresWithIdx = noteRows.map((r, i) => {
                    const st = noteStatusIdx >= 0 ? (r[noteStatusIdx] || '') : '';
                    const isSub = st ? (st.includes('已完成') || st.includes('待订正') || st.includes('已订正')) : true;
                    if (!isSub) return { score: null, index: i };
                    return { score: parseScoreValue(r[noteScoreIdx]), index: i };
                }).filter(x => x.score !== null);
                const noteScores = noteScoresWithIdx.map(x => x.score);
                const rawNoteMax = noteScores.length > 0 ? Math.max(...noteScores) : 0;
                const noteMaxScore = shouldForceIntegerScores() ? Math.round(rawNoteMax) : rawNoteMax;
                const noteNonZero = noteScores.filter(s => s > 0);
                const rawNoteAvg = noteNonZero.length > 0 ? (noteNonZero.reduce((a, b) => a + b, 0) / noteNonZero.length) : 0;
                const noteAvgScore = roundAvgScore(rawNoteAvg);
                const noteRank = noteScores.filter(s => s > noteScore).length + 1;
                const noteTotalStudents = noteScores.length;
                
                feedback += `-------------------------\n`;
                if (!noteSubmitted) {
                    feedback += `第${noteLesson}${getLessonUnit()}笔记作业未提交。\n`;
                } else {
                    feedback += `第${noteLesson}${getLessonUnit()}笔记作业得分为${noteScore}，\n`;
                    if (noteScore === 0) {
                        feedback += `最高${noteMaxScore}，平均${noteAvgScore}。\n`;
                    } else {
                        let noteRankText;
                        if (rankFormat === 'exact') {
                            noteRankText = `排名${noteRank}/${noteTotalStudents}`;
                        } else {
                            const noteRawPercentile = (noteRank / noteTotalStudents) * 100;
                            const noteLowerBound = Math.floor((noteRank - 1) / noteTotalStudents * 100 / 10) * 10;
                            const noteUpperBound = Math.min(Math.ceil(noteRawPercentile / 10) * 10, 100);
                            noteRankText = `排名${noteLowerBound}%~${noteUpperBound}%`;
                        }
                        feedback += `最高${noteMaxScore}，平均${noteAvgScore}，${noteRankText}。\n`;
                    }
                    if (noteComment) {
                        feedback += `${noteComment.trim()}\n`;
                    }
                }
            }
        }

        // --- Classroom test homework section (English only) ---
        if (classTestData) {
            const ctHeader = classTestData[0];
            const ctRows = classTestData.slice(1);
            const ctNameIdx = ctHeader.findIndex(h => h.includes('姓名'));
            const ctScoreIdx = ctHeader.findIndex(h => h.includes('得分'));
            const ctCommentIdx = findCommentColumnIndex(ctHeader, '批改评语');
            const ctCorrectionCommentIdx = findCommentColumnIndex(ctHeader, '订正评语');
            const ctStatusIdx = ctHeader.findIndex(h => h.includes('作业状态'));

            // Find class test data for this student
            const ctRow = ctRows.find(r => {
                const fullName = r[ctNameIdx] || '';
                const nameMatch = fullName.match(/\d+(.+)/);
                const name = nameMatch ? nameMatch[1] : fullName;
                return name === studentName;
            });

            if (ctRow) {
                const rawCtScore = ctScoreIdx >= 0 ? parseScoreValue(ctRow[ctScoreIdx]) : null;
                const ctScore = rawCtScore !== null ? rawCtScore : 0;
                const ctComment = getEffectiveComment(ctRow, ctCommentIdx, ctCorrectionCommentIdx);
                const ctStatus = ctStatusIdx >= 0 ? (ctRow[ctStatusIdx] || '') : '';
                const ctSubmitted = ctStatus.includes('已完成') || ctStatus.includes('待订正') || ctStatus.includes('已订正');

                // Calculate class test stats
                const ctScoresWithIdx = ctRows.map((r, i) => {
                    const st = ctStatusIdx >= 0 ? (r[ctStatusIdx] || '') : '';
                    const isSub = st ? (st.includes('已完成') || st.includes('待订正') || st.includes('已订正')) : true;
                    if (!isSub) return { score: null, index: i };
                    return { score: parseScoreValue(r[ctScoreIdx]), index: i };
                }).filter(x => x.score !== null);
                const ctScores = ctScoresWithIdx.map(x => x.score);
                const rawCtMax = ctScores.length > 0 ? Math.max(...ctScores) : 0;
                const ctMaxScore = shouldForceIntegerScores() ? Math.round(rawCtMax) : rawCtMax;
                const ctNonZero = ctScores.filter(s => s > 0);
                const rawCtAvg = ctNonZero.length > 0 ? (ctNonZero.reduce((a, b) => a + b, 0) / ctNonZero.length) : 0;
                const ctAvgScore = roundAvgScore(rawCtAvg);
                const ctRank = ctScores.filter(s => s > ctScore).length + 1;
                const ctTotalStudents = ctScores.length;

                feedback += `-------------------------\n`;
                if (!ctSubmitted) {
                    feedback += `第${classTestLesson}${getLessonUnit()}课堂测试作业未提交。\n`;
                } else {
                    feedback += `第${classTestLesson}${getLessonUnit()}课堂测试作业得分为${ctScore}，\n`;
                    if (ctScore === 0) {
                        feedback += `最高${ctMaxScore}，平均${ctAvgScore}。\n`;
                    } else {
                        let ctRankText;
                        if (rankFormat === 'exact') {
                            ctRankText = `排名${ctRank}/${ctTotalStudents}`;
                        } else {
                            const ctRawPercentile = (ctRank / ctTotalStudents) * 100;
                            const ctLowerBound = Math.floor((ctRank - 1) / ctTotalStudents * 100 / 10) * 10;
                            const ctUpperBound = Math.min(Math.ceil(ctRawPercentile / 10) * 10, 100);
                            ctRankText = `排名${ctLowerBound}%~${ctUpperBound}%`;
                        }
                        feedback += `最高${ctMaxScore}，平均${ctAvgScore}，${ctRankText}。\n`;
                    }
                    if (ctComment) {
                        feedback += `${ctComment.trim()}\n`;
                    }
                }
            }
        }

        // --- Focus/participation section ---
        if (isOnline && rptLesson) {
            feedback += `-------------------------\n`;
            feedback += `第${rptLesson}${getLessonUnit()}线上参与度情况\n`;
            const reward = onlineInfo?.reward;
            const isAbsent = onlineInfo ? (onlineInfo.isAbsent || reward === null || reward === undefined) : true;
            const focusRank = onlineInfo?.focusRank;
            const adjustedReward = getAdjustedFocusScore(reward || 0);
            const adjustedMax = getAdjustedFocusScore(focusStats.max);
            const adjustedAvg = getAdjustedFocusAvg(focusStats.avg);
            if (isAbsent) {
                feedback += `课堂参与度积分为：0，\n`;
                if (focusStats.total > 0) feedback += `最高${adjustedMax}，平均${adjustedAvg}。\n`;
                feedback += `本节课缺课，请及时进行补课，以免对后续课堂产生影响。若已经请假，请忽略。`;
            } else if (reward === 0) {
                feedback += `课堂参与度积分为：0，\n`;
                if (focusStats.total > 0) feedback += `最高${adjustedMax}，平均${adjustedAvg}。\n`;
                feedback += getFocusComment(adjustedReward);
            } else {
                feedback += `课堂参与度积分为：${adjustedReward}，\n`;
                if (focusStats.total > 0) {
                    let focusRankText;
                    if (rankFormat === 'exact') {
                        focusRankText = `排名${focusRank}/${focusStats.total}`;
                    } else {
                        const focusRawPercentile = (focusRank / focusStats.total) * 100;
                        const focusLowerBound = Math.floor((focusRank - 1) / focusStats.total * 100 / 10) * 10;
                        const focusUpperBound = Math.min(Math.ceil(focusRawPercentile / 10) * 10, 100);
                        focusRankText = `排名${focusLowerBound}%~${focusUpperBound}%`;
                    }
                    feedback += `最高${adjustedMax}，平均${adjustedAvg}，${focusRankText}。\n`;
                }
                feedback += getFocusComment(adjustedReward);
            }
        }

        // Build separated versions for mode switching
        const academicFeedback = feedback.trim().replace(/\n{2,}/g, '\n');
        let fullFeedback = academicFeedback;
        // 【课后复习建议】、个人薄弱点、错题本链接等统一放置在最末尾
        if (plusFeedbackPart && plusFeedbackPart.trim()) {
            let fullPlusPart = plusFeedbackPart;
            // 若学术反馈正文中已单独列出【预习薄弱点】，完整模式下末尾避免重复展示该行
            if (academicFeedback.includes('【预习薄弱点】：') && fullPlusPart.includes('【预习薄弱点】：')) {
                fullPlusPart = fullPlusPart.replace(/【预习薄弱点】：[^\n]*\n?/, '').trim();
            }
            if (fullPlusPart) {
                fullFeedback += `\n${fullPlusPart}`;
            }
        }
        fullFeedback = fullFeedback.replace(/\n{2,}/g, '\n');
        const plusFeedbackWithName = (plusFeedbackPart.trim() ? `${studentName}家长您好，\n${plusFeedbackPart.trim()}` : fullFeedback).replace(/\n{2,}/g, '\n');
        const plusFeedbackPure = (plusFeedbackPart.trim() || fullFeedback).replace(/\n{2,}/g, '\n');

        let currentDisplayFeedback = fullFeedback;
        if (currentFeedbackViewMode === 'plus-with-name') {
            currentDisplayFeedback = plusFeedbackWithName;
        } else if (currentFeedbackViewMode === 'plus-pure') {
            currentDisplayFeedback = plusFeedbackPure;
        } else if (currentFeedbackViewMode === 'academic-only') {
            currentDisplayFeedback = academicFeedback;
        }

        // Build table row
        const tr = document.createElement('tr');
        tr.setAttribute('data-row-index', index.toString());
        tr.setAttribute('data-student-id', studentId.toString());
        tr.setAttribute('data-score', score.toString());
        tr.setAttribute('data-online', isOnline ? '1' : '0');
        tr.setAttribute('data-focus', focusScore.toString());
        const pvInfo = previewMap[studentName];
        tr.setAttribute('data-preview-submitted', pvInfo?.isSubmitted ? '1' : '0');
        // 已在上方定义 hwInfo，无需重复声明
        tr.setAttribute('data-homework-submitted', hwInfo?.isSubmitted ? '1' : '0');
        const noteInfo = noteMap[studentName];
        tr.setAttribute('data-note-submitted', noteInfo?.isSubmitted ? '1' : '0');
        const ctInfo = classTestMap[studentName];
        tr.setAttribute('data-class-test-submitted', ctInfo?.isSubmitted ? '1' : '0');

        // Store full and split feedbacks on tr
        tr.setAttribute('data-full-feedback', fullFeedback);
        tr.setAttribute('data-plus-name-feedback', plusFeedbackWithName);
        tr.setAttribute('data-plus-pure-feedback', plusFeedbackPure);
        tr.setAttribute('data-academic-feedback', academicFeedback);

        // 防 XSS：姓名与评语均来自 CSV/教师输入，渲染前必须转义；onclick 字符串参数单独做 JS 转义
        const escFullName = escapeHtml(String(fullName ?? ''));
        const escStudentName = escapeHtml(String(studentName ?? ''));
        const jsFullName = escapeJsString(fullName);
        const jsStudentName = escapeJsString(studentName);
        const escDisplayFeedback = escapeHtml(String(currentDisplayFeedback ?? ''));

        const nameTd = document.createElement('td');
        nameTd.className = 'name-td';
        nameTd.innerHTML = `<div class="name-cell"><div class="name-main" onclick="copyText('${jsFullName}', this)"><span class="student-name">${escFullName}</span><svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></div><span class="student-tag ${isOnline ? 'online' : 'offline'}" onclick="toggleStudentOnlineStatus('${jsStudentName}', this)">${isOnline ? '线上' : '线下'}</span></div>`;

        const feedbackTd = document.createElement('td');
        feedbackTd.className = 'feedback-cell';
        feedbackTd.innerHTML = `<div class="feedback-wrapper"><div class="feedback-content" onclick="copyToNext(this.innerText, this)">${escDisplayFeedback}</div></div><textarea class="feedback-editor" style="display:none;">${escDisplayFeedback}</textarea><div class="editor-actions" style="display:none;"><button class="editor-btn cancel-edit-btn" onclick="cancelEdit(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>取消</span></button><button class="editor-btn save-btn" onclick="saveEdit(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>确认</span></button></div><div class="feedback-toolbar"><button class="toolbar-btn copy-btn" onclick="copyToNext(this.closest('.feedback-cell').querySelector('.feedback-content').innerText, this.closest('.feedback-cell').querySelector('.feedback-content'))" title="复制内容"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>复制</span></button><button class="toolbar-btn edit-toolbar-btn" onclick="toggleEdit(this)" title="编辑内容"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg><span>编辑</span></button></div>`;

        tr.appendChild(nameTd);
        tr.appendChild(feedbackTd);
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    resultBody.appendChild(tableContainer);
    
    // Apply global append and reminder texts
    if (globalAppendText && currentFeedbackViewMode !== 'plus-pure') {
        applyGlobalAppend(globalAppendText);
    }
    if (previewReminderText) {
        applyPreviewReminder(previewReminderText);
    }
    if (homeworkReminderText) {
        applyHomeworkReminder(homeworkReminderText);
    }
    if (noteReminderText) {
        applyNoteReminder(noteReminderText);
    }
    if (classTestReminderText) {
        applyClassTestReminder(classTestReminderText);
    }
    
    // Check for unsubmitted students and show suggestion (only on initial generation)
    if (!skipUnsubmittedCheck) {
        checkUnsubmittedStudents(previewMap, homeworkMap, pvLesson, hwLesson, noteMap, noteLesson, classTestMap, classTestLesson);
    }
    
    const plusStatsBtn = document.getElementById('plus-stats-btn');
    const plusPieDataBtn = document.getElementById('plus-pie-data-btn');
    const splitPlusBtn = document.getElementById('split-plus-btn');
    const hasPlusConfig = Boolean(cachedPlusData && cachedPlusData.enabled);
    const hasPlusStats = hasPlusConfig && Object.keys(cachedPlusErrorStats).length > 0;
    if (plusStatsBtn) {
        plusStatsBtn.style.display = hasPlusStats ? '' : 'none';
    }
    if (plusPieDataBtn) plusPieDataBtn.style.display = hasPlusStats ? '' : 'none';
    if (splitPlusBtn) splitPlusBtn.style.display = hasPlusConfig ? '' : 'none';

    if (currentFeedbackViewMode !== 'full') {
        applyFeedbackViewMode(currentFeedbackViewMode, true);
    }

    resultSection.style.display = 'flex';
    emptyState.style.display = 'none';

    const countBadge = document.getElementById('result-count');
    if (countBadge) {
        countBadge.textContent = `共 ${tbody.querySelectorAll('tr').length} 位同学`;
    }

    updateReminderBadges();

    // Notify about dropped students if any
    if (!skipUnsubmittedCheck && allDroppedSet.size > 0) {
        showToast(`已排除 ${allDroppedSet.size} 名退课学生的反馈`);
    }

    Logger.action('feedback_generated', { totalStudents: hwRows.length, hasHomework: !!homeworkData, skipped: allDroppedSet.size });
}

async function doGeneratePreviewOnlyFeedback() {
    const isWenjuanxing = getPhysicsPreviewSource() === 'wenjuanxing';
    const previewMetricMode = isWenjuanxing ? 'score_rank' : resolvePreviewMetricMode(sessionPayload);
    const rankFormat = sessionPayload.rankFormat || 'exact';
    const previewTotalQuestions = sessionPayload.previewTotalQuestions || 0;
    
    let previewModel;
    let pvNameIdx;
    if (isWenjuanxing) {
        previewModel = buildWenjuanxingPreviewMetrics(previewData, []);
        const header = previewData[0].map(h => String(h).trim());
        pvNameIdx = header.findIndex(h => h.includes('您的姓名'));
    } else {
        pvNameIdx = previewData[0].findIndex(h => h.includes('姓名'));
        previewModel = buildPreviewMetrics(previewData, previewMetricMode, previewTotalQuestions);
    }
    const previewMap = previewModel.map;
    const previewStats = previewModel.stats;
    const pvRows = previewModel.rows;

    // Build dropped students set from payload (preview-only path)
    const droppedStudents = sessionPayload.droppedStudents || null;
    const droppedPvSet = new Set(droppedStudents?.preview || []);

    const exclusionListText = sessionPayload.exclusionList || '';
    const exclusionSet = new Set(
        exclusionListText.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
    );

    onlineStudents = {};
    let focusStats = { max: 0, avg: 0, total: 0, scores: [] };
    if (reportData) {
        const rptHeader = reportData[0];
        const rptRows = reportData.slice(1);
        const rptNameIdx = rptHeader.findIndex(h => h.includes('学生姓名') || h.includes('姓名'));
        const classIdx = rptHeader.findIndex(h => h.includes('班级'));
        const rewardIdx = rptHeader.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
        const attIdx = rptHeader.findIndex(h => 
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
            !h.includes('时长') && !h.includes('率')
        );
        rptRows.forEach(row => {
            if (row[rptNameIdx]) {
                const rawName = row[rptNameIdx].trim();
                const nm = rawName.match(/\d+(.+)/);
                const nameKey = nm ? nm[1] : rawName;
                const className = row[classIdx] || '';
                let isOnline = className.includes('β1');
                const override = onlineOverrides[nameKey];
                if (override === 'online') isOnline = true;
                else if (override === 'offline') isOnline = false;

                // 出勤与积分判定（双重保险：是否有效出勤列 + 积分是否为'-'）
                const rawAtt = attIdx >= 0 ? String(row[attIdx] || '').trim() : '';
                const reward = row[rewardIdx];
                const isDashOrEmpty = (reward === '-' || reward === '' || reward === null || reward === undefined);

                let isAbsent = false;
                if (attIdx >= 0 && rawAtt.includes('缺勤')) {
                    isAbsent = true;
                } else if (isDashOrEmpty) {
                    isAbsent = true;
                }

                const rewardValue = isAbsent ? null : parseScoreValue(reward);
                onlineStudents[nameKey] = { isOnline, reward: rewardValue, isAbsent, className, attendance: rawAtt };
                if (isOnline && rewardValue !== null && !isAbsent) focusStats.scores.push({ name: nameKey, score: rewardValue });
            }
        });
        if (focusStats.scores.length > 0) {
            focusStats.total = focusStats.scores.length;
            focusStats.max = Math.max(...focusStats.scores.map(s => s.score));
            focusStats.avg = Math.round(focusStats.scores.reduce((a, b) => a + b.score, 0) / focusStats.total * 10) / 10;
            focusStats.scores.sort((a, b) => b.score - a.score);
            let cr = 1, ps = null;
            focusStats.scores.forEach((item, idx) => {
                if (ps !== null && item.score < ps) cr = idx + 1;
                if (onlineStudents[item.name]) onlineStudents[item.name].focusRank = cr;
                ps = item.score;
            });
            
            // Check if adjusted max focus score is not 6, force custom comments
            const adjustedMax2 = getAdjustedFocusScore(focusStats.max);
            if (adjustedMax2 !== 6 && getFocusCommentSource() === 'default') {
                sessionPayload.focusCommentSource = 'custom';
                sessionPayload.focusMaxScore = adjustedMax2;
                const defaultComments = {
                    7: '专注度很好，给你点赞，请继续保持！',
                    6: '专注度很好，给你点赞，请继续保持！',
                    5: '专注度尚可，但未全神贯注，下次争取全心投入，拿满分！',
                    4: '专注度一般，请及时作出调整；',
                    3: '专注度一般，请及时作出调整；',
                    2: '专注度较差，请私聊老师说明情况',
                    1: '专注度较差，请私聊老师说明情况',
                    0: '未获得课堂积分，请及时调整状态！'
                };
                const customComments = {};
                for (let s = adjustedMax2; s >= 0; s--) {
                    customComments[s] = defaultComments[s] || '';
                }
                sessionPayload.focusComments = customComments;
            }
        }
    }

    const lessonNums = sessionPayload.lessonNumbers || {};
    const feedbackSubject = sessionPayload.subject || '数学';
    const pvLesson = lessonNums.preview || extractLessonNumber(previewFileName, 'preview');
    const rptLesson = reportData ? (lessonNums.report || extractLessonNumber(reportFileName, 'report')) : null;
    const noteLesson = noteData ? (lessonNums.note || extractLessonNumber(noteFileName, 'note')) : null;
    const classTestLesson = classTestData ? (lessonNums.classTest || extractLessonNumber(classTestFileName, 'class_test')) : null;

    // Build note submission map for English subject
    const noteMap = {};
    if (noteData && feedbackSubject === '英语') {
        const noteHeader = noteData[0];
        const noteRows = noteData.slice(1);
        const noteNameIdx = noteHeader.findIndex(h => h.includes('姓名'));
        const noteStatusIdx = noteHeader.findIndex(h => h.includes('作业状态'));
        noteRows.forEach(r => {
            const fullName = r[noteNameIdx] || '';
            const nameMatch = fullName.match(/\d+(.+)/);
            const name = nameMatch ? nameMatch[1] : fullName;
            const status = noteStatusIdx >= 0 ? (r[noteStatusIdx] || '') : '';
            const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正');
            noteMap[name] = { isSubmitted, status };
        });
    }

    // Build class test submission map for English subject
    const classTestMap = {};
    if (classTestData && feedbackSubject === '英语') {
        const ctHeader = classTestData[0];
        const ctRows = classTestData.slice(1);
        const ctNameIdx = ctHeader.findIndex(h => h.includes('姓名'));
        const ctStatusIdx = ctHeader.findIndex(h => h.includes('作业状态'));
        ctRows.forEach(r => {
            const fullName = r[ctNameIdx] || '';
            const nameMatch = fullName.match(/\d+(.+)/);
            const name = nameMatch ? nameMatch[1] : fullName;
            const status = ctStatusIdx >= 0 ? (r[ctStatusIdx] || '') : '';
            const isSubmitted = status.includes('已完成') || status.includes('待订正') || status.includes('已订正');
            classTestMap[name] = { isSubmitted, status };
        });
    }

    if (hwStatsSection) hwStatsSection.style.display = 'none';
    const homeworkReminderBtn = document.getElementById('homework-reminder-btn');
    const homeworkRankBtn = document.getElementById('homework-rank-btn');
    const noteReminderBtn = document.getElementById('note-reminder-btn');
    const classTestReminderBtn = document.getElementById('class-test-reminder-btn');
    if (homeworkReminderBtn) homeworkReminderBtn.style.display = 'none';
    if (homeworkRankBtn) homeworkRankBtn.style.display = 'none';
    if (noteReminderBtn) noteReminderBtn.style.display = (feedbackSubject === '英语' && noteData) ? '' : 'none';
    if (classTestReminderBtn) classTestReminderBtn.style.display = (feedbackSubject === '英语' && classTestData) ? '' : 'none';

    applyPreviewStatsUI(previewStats, true);

    cachedPreviewMap = previewMap;
    cachedPreviewStats = previewStats;
    cachedPlusData = sessionPayload.plusData;
    cachedPlusErrorStats = {};

    // 仅上传预习作业时也生成错题本 Token；与课后巩固共用同一身份 Key 与 token_map。
    let previewOnlyPlusTokens = {};
    const previewOnlyPlusData = sessionPayload.plusData;
    if (previewOnlyPlusData?.enabled) {
        const tokenGrade = previewOnlyPlusData.grade || '';
        const tokenSubject = sessionPayload.subject || '数学';
        const previewFileNameList = [];
        if (sessionPayload.previewFiles) {
            sessionPayload.previewFiles.forEach(f => {
                if (f.name && !previewFileNameList.includes(f.name)) previewFileNameList.push(f.name);
            });
        }
        const batchPayload = {
            year: window.semesterYear || 2026,
            season: window.defaultSeason || 'spring',
            subject: tokenSubject,
            grade: tokenGrade,
            tier: previewOnlyPlusData.tier || '',
            week: previewOnlyPlusData.week || pvLesson || 1,
            preview_week: previewOnlyPlusData.previewWeek || pvLesson || previewOnlyPlusData.week || 1,
            has_preview_data: true,
            has_homework_data: false,
            source_files: previewFileNameList,
            students: []
        };
        pvRows.forEach(row => {
            const fullName = String(row[pvNameIdx] || '').trim();
            if (!fullName) return;
            const nameMatch = fullName.match(/\d+(.+)/);
            const studentName = (nameMatch ? nameMatch[1] : fullName).trim();
            if (droppedPvSet.has(studentName) || exclusionSet.has(fullName)) return;
            const idMatch = fullName.match(/^(\d+)/);
            const studentId = idMatch ? idMatch[1] : '';
            const studentKey = studentId
                ? `${studentId}_${studentName}${tokenGrade && tokenSubject ? `_${tokenGrade}_${tokenSubject}` : ''}`
                : studentName;
            const pvInfo = previewMap[studentName];
            const previewComment = pvInfo?.comment ? String(pvInfo.comment) : '';
            const parsed = previewComment ? parseErrorQuestionsFromComment(previewComment) : null;
            batchPayload.students.push({
                id: studentId,
                name: studentName,
                fullName,
                key: studentKey,
                errors: [],
                previewErrors: parsed?.errorNums || [],
                previewComment,
                previewWeek: previewOnlyPlusData.previewWeek || pvLesson || previewOnlyPlusData.week || 1,
                homeworkScore: null,
                previewScore: pvInfo?.score ?? null,
                totalScore: 100,
                comment: ''
            });
        });
        if (batchPayload.students.length > 0) {
            batchPayload.teacher_username = window.currentUser?.username || '';
            batchPayload.teacher_name = window.currentUser?.real_name || '';
            try {
                const reqFn = typeof requestWithTimeout === 'function' ? requestWithTimeout : fetch;
                const resp = await reqFn('api/retest.php?action=encrypt_batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batchPayload)
                }, 4000);
                const result = await resp.json();
                if (result.success && result.tokens) {
                    previewOnlyPlusTokens = result.tokens;
                }
            } catch (e) {
                console.warn('获取预习专属错题本Token跳过或超时 (弱网优雅降级):', e);
            }
        }
    }

    resultBody.innerHTML = '';
    const tableContainer = document.createElement('div');
    tableContainer.className = 'table-container';
    const table = document.createElement('table');
    table.className = 'result-table';
    table.id = 'result-table';

    const tbody = document.createElement('tbody');
    tbody.id = 'result-tbody';
    tbody.addEventListener('click', function (e) {
        const tr = e.target.closest('tr');
        if (tr && tr.classList.contains('copied-row')) {
            if (typeof focusedRowIndex !== 'undefined' && focusedRowIndex >= 0) {
                showToast('请先退出专注模式');
            } else {
                tr.classList.remove('copied-row');
            }
        }
    });

    pvRows.forEach((row, index) => {
        const fullName = row[pvNameIdx] || '';
        const nameMatch = fullName.match(/\d+(.+)/);
        const studentName = nameMatch ? nameMatch[1] : fullName;

        // Skip dropped students and excluded students
        if (droppedPvSet.has(studentName)) return;
        if (exclusionSet.has(fullName)) return;

        const studentIdMatch = fullName.match(/^(\d+)/);
        const studentId = studentIdMatch ? parseInt(studentIdMatch[1]) : index;
        const pvInfo = previewMap[studentName];
        const onlineInfo = onlineStudents[studentName] || null;
        const isOnline = onlineInfo?.isOnline || false;
        const focusScore = onlineInfo?.reward ?? -1;

        const commentSummary = getCommentSummary();
        let summaryPart = commentSummary ? `本节课总结：\n${commentSummary.trim()}\n` : '';
        let feedback = `${studentName}家长您好，\n`;
        if (summaryPart) feedback += summaryPart;
        feedback += `以下是${getStudentDisplayName(studentName)}${feedbackSubject}作业情况反馈：\n`;

        const previewParsed = pvInfo?.comment ? parseErrorQuestionsFromComment(String(pvInfo.comment)) : null;
        const previewDisplayInfo = (sessionPayload.plusData?.enabled && previewParsed && previewParsed.errorNums.length > 0)
            ? { ...pvInfo, comment: previewParsed.cleanComment }
            : pvInfo;
        if (isWenjuanxing) {
            feedback += buildWenjuanxingFeedbackSection(previewDisplayInfo, pvLesson, previewStats, rankFormat);
        } else {
            feedback += buildPreviewFeedbackSection(previewDisplayInfo, pvLesson, previewStats, previewMetricMode, rankFormat);
        }

        let previewOnlyPlusPart = '';
        if (sessionPayload.plusData?.enabled && previewParsed && previewParsed.errorNums.length > 0) {
            const previewQuestions = sessionPayload.plusData.previewQuestions || sessionPayload.plusData.questions || [];
            if (previewQuestions.length > 0) {
                const previewQuestionMap = {};
                previewQuestions.forEach(q => {
                    const ids = String(q.id || q.question_num || '').split(/[,、，]/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                    const cleanT = typeof cleanTopicTrailingPunctuation === 'function' 
                        ? cleanTopicTrailingPunctuation(q.topic) 
                        : (q.topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
                    ids.forEach(id => { previewQuestionMap[id] = cleanT; });
                });
                const previewTopics = [...new Set(previewParsed.errorNums.map(num => previewQuestionMap[num] || `第${num}题`).filter(Boolean))];
                if (previewTopics.length > 0) {
                    feedback += `【预习薄弱点】：${previewTopics.join('、')}\n`;
                    previewOnlyPlusPart += `【预习薄弱点】：${previewTopics.join('、')}\n`;
                }
            }
            const tokenIdMatch = fullName.match(/^(\d+)/);
            const tokenStudentId = tokenIdMatch ? tokenIdMatch[1] : '';
            const tokenGrade = sessionPayload.plusData?.grade || '';
            const tokenSubject = feedbackSubject;
            const tokenStudentKey = tokenStudentId
                ? `${tokenStudentId}_${studentName}${tokenGrade && tokenSubject ? `_${tokenGrade}_${tokenSubject}` : ''}`
                : studentName;
            const tokenLegacyKey = tokenStudentId ? `${tokenStudentId}_${studentName}` : studentName;
            const token = previewOnlyPlusTokens[tokenStudentKey] || previewOnlyPlusTokens[tokenLegacyKey] || '';
            previewOnlyPlusPart += `【错题本】：点击链接查看本专题的错题\n`;
            if (token) {
                const retestBase = getRetestBaseUrl();
                const previewSuffix = '（预习错题请切换到对应专题查看）';
                previewOnlyPlusPart += `${retestBase}?token=${token}${previewSuffix}\n`;
            } else {
                previewOnlyPlusPart += `(生成链接失败，请联系老师)\n`;
            }
        }

        // --- Note homework section (English only) ---
        if (noteData) {
            const noteHeader = noteData[0];
            const noteRows = noteData.slice(1);
            const noteNameIdx = noteHeader.findIndex(h => h.includes('姓名'));
            const noteScoreIdx = noteHeader.findIndex(h => h.includes('得分'));
            const noteCommentIdx = findCommentColumnIndex(noteHeader, '批改评语');
            const noteCorrectionCommentIdx = findCommentColumnIndex(noteHeader, '订正评语');
            const noteStatusIdx = noteHeader.findIndex(h => h.includes('作业状态'));
            
            // Find note data for this student
            const noteRow = noteRows.find(r => {
                const fullName = r[noteNameIdx] || '';
                const nameMatch = fullName.match(/\d+(.+)/);
                const name = nameMatch ? nameMatch[1] : fullName;
                return name === studentName;
            });
            
            if (noteRow) {
                const rawNoteScore = noteScoreIdx >= 0 ? parseScoreValue(noteRow[noteScoreIdx]) : null;
                const noteScore = rawNoteScore !== null ? rawNoteScore : 0;
                const noteComment = getEffectiveComment(noteRow, noteCommentIdx, noteCorrectionCommentIdx);
                const noteStatus = noteStatusIdx >= 0 ? (noteRow[noteStatusIdx] || '') : '';
                const noteSubmitted = noteStatus.includes('已完成') || noteStatus.includes('待订正') || noteStatus.includes('已订正');
                
                // Calculate note stats
                const noteScoresWithIdx = noteRows.map((r, i) => {
                    const st = noteStatusIdx >= 0 ? (r[noteStatusIdx] || '') : '';
                    const isSub = st ? (st.includes('已完成') || st.includes('待订正') || st.includes('已订正')) : true;
                    if (!isSub) return { score: null, index: i };
                    return { score: parseScoreValue(r[noteScoreIdx]), index: i };
                }).filter(x => x.score !== null);
                const noteScores = noteScoresWithIdx.map(x => x.score);
                const rawNoteMax = noteScores.length > 0 ? Math.max(...noteScores) : 0;
                const noteMaxScore = shouldForceIntegerScores() ? Math.round(rawNoteMax) : rawNoteMax;
                const noteNonZero = noteScores.filter(s => s > 0);
                const rawNoteAvg = noteNonZero.length > 0 ? (noteNonZero.reduce((a, b) => a + b, 0) / noteNonZero.length) : 0;
                const noteAvgScore = roundAvgScore(rawNoteAvg);
                const noteRank = noteScores.filter(s => s > noteScore).length + 1;
                const noteTotalStudents = noteScores.length;
                
                feedback += `-------------------------\n`;
                if (!noteSubmitted) {
                    feedback += `第${noteLesson}${getLessonUnit()}笔记作业未提交。\n`;
                } else {
                    feedback += `第${noteLesson}${getLessonUnit()}笔记作业得分为${noteScore}，\n`;
                    if (noteScore === 0) {
                        feedback += `最高${noteMaxScore}，平均${noteAvgScore}。\n`;
                    } else {
                        let noteRankText;
                        if (rankFormat === 'exact') {
                            noteRankText = `排名${noteRank}/${noteTotalStudents}`;
                        } else {
                            const noteRawPercentile = (noteRank / noteTotalStudents) * 100;
                            const noteLowerBound = Math.floor((noteRank - 1) / noteTotalStudents * 100 / 10) * 10;
                            const noteUpperBound = Math.min(Math.ceil(noteRawPercentile / 10) * 10, 100);
                            noteRankText = `排名${noteLowerBound}%~${noteUpperBound}%`;
                        }
                        feedback += `最高${noteMaxScore}，平均${noteAvgScore}，${noteRankText}。\n`;
                    }
                    if (noteComment) {
                        feedback += `${noteComment.trim()}\n`;
                    }
                }
            }
        }

        // --- Classroom test homework section (English only) ---
        if (classTestData) {
            const ctHeader = classTestData[0];
            const ctRows = classTestData.slice(1);
            const ctNameIdx = ctHeader.findIndex(h => h.includes('姓名'));
            const ctScoreIdx = ctHeader.findIndex(h => h.includes('得分'));
            const ctCommentIdx = findCommentColumnIndex(ctHeader, '批改评语');
            const ctCorrectionCommentIdx = findCommentColumnIndex(ctHeader, '订正评语');
            const ctStatusIdx = ctHeader.findIndex(h => h.includes('作业状态'));

            // Find class test data for this student
            const ctRow = ctRows.find(r => {
                const fullName = r[ctNameIdx] || '';
                const nameMatch = fullName.match(/\d+(.+)/);
                const name = nameMatch ? nameMatch[1] : fullName;
                return name === studentName;
            });

            if (ctRow) {
                const rawCtScore = ctScoreIdx >= 0 ? parseScoreValue(ctRow[ctScoreIdx]) : null;
                const ctScore = rawCtScore !== null ? rawCtScore : 0;
                const ctComment = getEffectiveComment(ctRow, ctCommentIdx, ctCorrectionCommentIdx);
                const ctStatus = ctStatusIdx >= 0 ? (ctRow[ctStatusIdx] || '') : '';
                const ctSubmitted = ctStatus.includes('已完成') || ctStatus.includes('待订正') || ctStatus.includes('已订正');

                // Calculate class test stats
                const ctScoresWithIdx = ctRows.map((r, i) => {
                    const st = ctStatusIdx >= 0 ? (r[ctStatusIdx] || '') : '';
                    const isSub = st ? (st.includes('已完成') || st.includes('待订正') || st.includes('已订正')) : true;
                    if (!isSub) return { score: null, index: i };
                    return { score: parseScoreValue(r[ctScoreIdx]), index: i };
                }).filter(x => x.score !== null);
                const ctScores = ctScoresWithIdx.map(x => x.score);
                const rawCtMax = ctScores.length > 0 ? Math.max(...ctScores) : 0;
                const ctMaxScore = shouldForceIntegerScores() ? Math.round(rawCtMax) : rawCtMax;
                const ctNonZero = ctScores.filter(s => s > 0);
                const rawCtAvg = ctNonZero.length > 0 ? (ctNonZero.reduce((a, b) => a + b, 0) / ctNonZero.length) : 0;
                const ctAvgScore = roundAvgScore(rawCtAvg);
                const ctRank = ctScores.filter(s => s > ctScore).length + 1;
                const ctTotalStudents = ctScores.length;

                feedback += `-------------------------\n`;
                if (!ctSubmitted) {
                    feedback += `第${classTestLesson}${getLessonUnit()}课堂测试作业未提交。\n`;
                } else {
                    feedback += `第${classTestLesson}${getLessonUnit()}课堂测试作业得分为${ctScore}，\n`;
                    if (ctScore === 0) {
                        feedback += `最高${ctMaxScore}，平均${ctAvgScore}。\n`;
                    } else {
                        let ctRankText;
                        if (rankFormat === 'exact') {
                            ctRankText = `排名${ctRank}/${ctTotalStudents}`;
                        } else {
                            const ctRawPercentile = (ctRank / ctTotalStudents) * 100;
                            const ctLowerBound = Math.floor((ctRank - 1) / ctTotalStudents * 100 / 10) * 10;
                            const ctUpperBound = Math.min(Math.ceil(ctRawPercentile / 10) * 10, 100);
                            ctRankText = `排名${ctLowerBound}%~${ctUpperBound}%`;
                        }
                        feedback += `最高${ctMaxScore}，平均${ctAvgScore}，${ctRankText}。\n`;
                    }
                    if (ctComment) {
                        feedback += `${ctComment.trim()}\n`;
                    }
                }
            }
        }

        if (isOnline && rptLesson) {
            feedback += `-------------------------\n`;
            feedback += `第${rptLesson}${getLessonUnit()}线上参与度情况\n`;
            const reward = onlineInfo?.reward;
            const isAbsent = onlineInfo ? (onlineInfo.isAbsent || reward === null || reward === undefined) : true;
            const focusRank = onlineInfo?.focusRank;
            const adjustedReward2 = getAdjustedFocusScore(reward || 0);
            const adjustedMax3 = getAdjustedFocusScore(focusStats.max);
            const adjustedAvg2 = getAdjustedFocusAvg(focusStats.avg);
            if (isAbsent) {
                feedback += `课堂参与度积分为：0，\n`;
                if (focusStats.total > 0) feedback += `最高${adjustedMax3}，平均${adjustedAvg2}。\n`;
                feedback += `本节课缺课，请及时进行补课，以免对后续课堂产生影响。若已经请假，请忽略。`;
            } else if (reward === 0) {
                feedback += `课堂参与度积分为：0，\n`;
                if (focusStats.total > 0) feedback += `最高${adjustedMax3}，平均${adjustedAvg2}。\n`;
                feedback += `本节课课堂表现欠佳，未获得课堂积分，请及时调整状态！`;
            } else {
                feedback += `课堂参与度积分为：${adjustedReward2}，\n`;
                if (focusStats.total > 0) {
                    let focusRankText;
                    if (rankFormat === 'exact') {
                        focusRankText = `排名${focusRank}/${focusStats.total}`;
                    } else {
                        const rawPercentile = (focusRank / focusStats.total) * 100;
                        const lowerBound = Math.floor((focusRank - 1) / focusStats.total * 100 / 10) * 10;
                        const upperBound = Math.min(Math.ceil(rawPercentile / 10) * 10, 100);
                        focusRankText = `排名${lowerBound}%~${upperBound}%`;
                    }
                    feedback += `最高${adjustedMax3}，平均${adjustedAvg2}，${focusRankText}。\n`;
                }
                feedback += getFocusComment(adjustedReward2);
            }
        }

        const previewAcademicFeedback = feedback.trim().replace(/\n{2,}/g, '\n');
        let previewFullFeedback = previewAcademicFeedback;
        if (previewOnlyPlusPart && previewOnlyPlusPart.trim()) {
            let fullPlus = previewOnlyPlusPart.trim();
            if (previewAcademicFeedback.includes('【预习薄弱点】：') && fullPlus.includes('【预习薄弱点】：')) {
                fullPlus = fullPlus.replace(/【预习薄弱点】：[^\n]*\n?/, '').trim();
            }
            if (fullPlus) {
                previewFullFeedback = (previewFullFeedback + '\n' + fullPlus).replace(/\n{2,}/g, '\n');
            }
        }
        const previewPlusWithName = (previewOnlyPlusPart.trim() ? `${studentName}家长您好，\n${previewOnlyPlusPart.trim()}` : previewFullFeedback).replace(/\n{2,}/g, '\n');
        const previewPlusPure = (previewOnlyPlusPart.trim() || previewFullFeedback).replace(/\n{2,}/g, '\n');

        let currentDisplayFeedback2 = previewFullFeedback;
        if (currentFeedbackViewMode === 'plus-with-name') {
            currentDisplayFeedback2 = previewPlusWithName;
        } else if (currentFeedbackViewMode === 'plus-pure') {
            currentDisplayFeedback2 = previewPlusPure;
        } else if (currentFeedbackViewMode === 'academic-only') {
            currentDisplayFeedback2 = previewAcademicFeedback;
        }

        const tr = document.createElement('tr');
        tr.setAttribute('data-row-index', index.toString());
        tr.setAttribute('data-student-id', studentId.toString());
        const previewScoreVal = pvInfo?.score ?? pvInfo?.accuracy ?? pvInfo?.correctCount ?? pvInfo?.errorCount ?? 0;
        tr.setAttribute('data-score', previewScoreVal.toString());
        tr.setAttribute('data-online', isOnline ? '1' : '0');
        tr.setAttribute('data-focus', focusScore.toString());
        tr.setAttribute('data-preview-submitted', pvInfo?.isSubmitted ? '1' : '0');
        const noteInfo = noteMap[studentName];
        tr.setAttribute('data-note-submitted', noteInfo?.isSubmitted ? '1' : '0');
        const ctInfo = classTestMap[studentName];
        tr.setAttribute('data-class-test-submitted', ctInfo?.isSubmitted ? '1' : '0');
        tr.setAttribute('data-full-feedback', previewFullFeedback);
        tr.setAttribute('data-plus-name-feedback', previewPlusWithName);
        tr.setAttribute('data-plus-pure-feedback', previewPlusPure);
        tr.setAttribute('data-academic-feedback', previewAcademicFeedback);

        // 防 XSS：姓名与评语均来自 CSV/教师输入，渲染前必须转义；onclick 字符串参数单独做 JS 转义
        const escFullName2 = escapeHtml(String(fullName ?? ''));
        const escStudentName2 = escapeHtml(String(studentName ?? ''));
        const jsFullName2 = escapeJsString(fullName);
        const jsStudentName2 = escapeJsString(studentName);
        const escFeedback2 = escapeHtml(String(currentDisplayFeedback2 ?? ''));

        const nameTd = document.createElement('td');
        nameTd.className = 'name-td';
        nameTd.innerHTML = `<div class="name-cell"><div class="name-main" onclick="copyText('${jsFullName2}', this)"><span class="student-name">${escFullName2}</span><svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></div><span class="student-tag ${isOnline ? 'online' : 'offline'}" onclick="toggleStudentOnlineStatus('${jsStudentName2}', this)">${isOnline ? '线上' : '线下'}</span></div>`;

        const feedbackTd = document.createElement('td');
        feedbackTd.className = 'feedback-cell';
        feedbackTd.innerHTML = `<div class="feedback-wrapper"><div class="feedback-content" onclick="copyToNext(this.innerText, this)">${escFeedback2}</div></div><textarea class="feedback-editor" style="display:none;">${escFeedback2}</textarea><div class="editor-actions" style="display:none;"><button class="editor-btn cancel-edit-btn" onclick="cancelEdit(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>取消</span></button><button class="editor-btn save-btn" onclick="saveEdit(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>确认</span></button></div><div class="feedback-toolbar"><button class="toolbar-btn copy-btn" onclick="copyToNext(this.closest('.feedback-cell').querySelector('.feedback-content').innerText, this.closest('.feedback-cell').querySelector('.feedback-content'))" title="复制内容"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>复制</span></button><button class="toolbar-btn edit-toolbar-btn" onclick="toggleEdit(this)" title="编辑内容"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg><span>编辑</span></button></div>`;

        tr.appendChild(nameTd);
        tr.appendChild(feedbackTd);
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
    resultBody.appendChild(tableContainer);

    // Apply global append and reminder texts
    if (globalAppendText) {
        applyGlobalAppend(globalAppendText);
    }
    if (previewReminderText) {
        applyPreviewReminder(previewReminderText);
    }
    if (homeworkReminderText) {
        applyHomeworkReminder(homeworkReminderText);
    }
    if (noteReminderText) {
        applyNoteReminder(noteReminderText);
    }
    if (classTestReminderText) {
        applyClassTestReminder(classTestReminderText);
    }

    const plusStatsBtn = document.getElementById('plus-stats-btn');
    const plusPieDataBtn = document.getElementById('plus-pie-data-btn');
    const splitPlusBtn = document.getElementById('split-plus-btn');
    if (plusStatsBtn) plusStatsBtn.style.display = 'none';
    if (plusPieDataBtn) plusPieDataBtn.style.display = 'none';
    if (splitPlusBtn) splitPlusBtn.style.display = 'none';

    resultSection.style.display = 'flex';
    emptyState.style.display = 'none';

    const countBadge = document.getElementById('result-count');
    if (countBadge) {
        countBadge.textContent = `共 ${tbody.querySelectorAll('tr').length} 位同学`;
    }

    updateReminderBadges();

    Logger.action('feedback_generated', { totalStudents: pvRows.length, hasHomework: false, skipped: droppedPvSet.size });
}

// ========== Utility functions (same as viewer.js) ==========
function fallbackCopy(text) {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;";
        document.body.appendChild(ta);
        ta.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(ta);
        return successful;
    } catch (err) {
        return false;
    }
}

function copyText(text, element) {
    const onSuccess = () => {
        showToast('已复制姓名，请复制右侧评语');
        if (element) { element.style.transform = 'scale(0.98)'; setTimeout(() => { element.style.transform = ''; }, 150); }
        const currentRow = element ? element.closest('tr') : null;
        if (currentRow) enterFocusMode(parseInt(currentRow.getAttribute('data-row-index')));
    };
    const onError = () => { showToast('复制失败，请手动复制'); };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
            if (fallbackCopy(text)) setTimeout(onSuccess, 0); else onError();
        });
    } else {
        if (fallbackCopy(text)) setTimeout(onSuccess, 0); else onError();
    }
}

function enterFocusMode(rowIndex) {
    focusedRowIndex = rowIndex;
    const tbody = document.getElementById('result-tbody');
    if (!tbody) return;
    tbody.classList.add('focus-mode');
    tbody.querySelectorAll('tr').forEach(row => {
        const idx = parseInt(row.getAttribute('data-row-index'));
        row.classList.remove('focused-row', 'masked-row');
        if (idx === rowIndex) { row.classList.add('focused-row'); row.classList.remove('copied-row'); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        else row.classList.add('masked-row');
    });
    const old = document.querySelector('.focus-indicator');
    if (old) old.remove();
    const focusedRow = tbody.querySelector('tr[data-row-index="' + rowIndex + '"]');
    if (focusedRow) {
        const nameEl = focusedRow.querySelector('.student-name');
        const sn = nameEl ? nameEl.innerText : '';
        const indicator = document.createElement('div');
        indicator.className = 'focus-indicator';
        indicator.innerHTML = '<div class="focus-indicator-content"><span class="focus-indicator-dot"></span><span class="focus-indicator-name">' + sn + '</span><span class="focus-indicator-hint">点击评语复制</span><button class="focus-exit-btn" onclick="clearFocusMode()" title="退出专注模式"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>';
        document.body.appendChild(indicator);
    }
}

function clearFocusMode() {
    focusedRowIndex = -1;
    const tbody = document.getElementById('result-tbody');
    if (!tbody) return;
    tbody.classList.remove('focus-mode');
    tbody.querySelectorAll('tr').forEach(row => row.classList.remove('focused-row', 'masked-row'));
    const indicator = document.querySelector('.focus-indicator');
    if (indicator) { indicator.classList.add('focus-indicator-exit'); setTimeout(() => indicator.remove(), 300); }
}

function copyToNext(text, element) {
    Logger.action('content_copied', { length: text.length });
    const onSuccess = () => {
        const currentRow = element.closest('tr');
        if (currentRow) {
            const nameEl = currentRow.querySelector('.student-name');
            showToast('已复制"' + (nameEl ? nameEl.innerText : '') + '"的评语');
            if (focusedRowIndex >= 0) {
                currentRow.classList.add('copied-row');
                setTimeout(() => {
                    const tbody = document.getElementById('result-tbody');
                    if (!tbody) return;
                    const allRows = Array.from(tbody.querySelectorAll('tr'));
                    const ci = allRows.indexOf(currentRow);
                    const nextRow = allRows[ci + 1];
                    if (nextRow) enterFocusMode(parseInt(nextRow.getAttribute('data-row-index')));
                    else { clearFocusMode(); showToast('全部复制完成！'); }
                }, 50);
            } else {
                currentRow.classList.add('copied-row');
                const nextRow = currentRow.nextElementSibling;
                if (nextRow) { nextRow.scrollIntoView({ behavior: 'smooth', block: 'center' }); nextRow.classList.add('highlight-row'); setTimeout(() => nextRow.classList.remove('highlight-row'), 2000); }
            }
        } else { showToast('已复制'); }
        if (element) { element.style.transform = 'scale(0.98)'; setTimeout(() => { element.style.transform = ''; }, 150); }
    };
    const onError = () => { showToast('复制失败，请手动复制'); };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
            if (fallbackCopy(text)) setTimeout(onSuccess, 0); else onError();
        });
    } else {
        if (fallbackCopy(text)) setTimeout(onSuccess, 0); else onError();
    }
}

function toggleStudentOnlineStatus(studentKey, tagElement) {
    if (!studentKey) return;
    const cur = tagElement?.classList.contains('online');
    const tgt = cur ? '线下' : '线上';
    const studentInfo = onlineStudents[studentKey];
    if (!cur && !studentInfo) {
        showToast(`错误：${studentKey} 不在专注度积分名单中，无法切换为线上`);
        return;
    }
    showCustomDialog({ title: '切换上课方式', body: `将 <strong>${studentKey}</strong> 修改为 <strong>「${tgt}」</strong>？`, confirmText: `切换为${tgt}`,
        onConfirm: () => {
            onlineOverrides[studentKey] = cur ? 'offline' : 'online';
            updateRuntimeState({ onlineOverrides });
            Logger.action('toggle_online_status', { studentKey: studentKey.charAt(0) + '*', from: cur ? 'online' : 'offline', to: cur ? 'offline' : 'online' });
            showToast(`已将 ${studentKey} 设置为${tgt}`);
            doGenerateFeedback(true);
        }
    });
}

function checkUnsubmittedStudents(previewMap, homeworkMap, pvLesson, hwLesson, noteMap, noteLesson, classTestMap, classTestLesson) {
    const previewUnsubmitted = [];
    const homeworkUnsubmitted = [];
    const noteUnsubmitted = [];
    const classTestUnsubmitted = [];
    
    // Retrieve dropped from payload or define empty set if not
    const ds = sessionPayload.droppedStudents || null;
    const droppedSet = new Set([...(ds?.homework || []), ...(ds?.preview || [])]);

    // Check preview homework
    if (previewData && pvLesson) {
        for (const [studentName, pvInfo] of Object.entries(previewMap)) {
            if (!pvInfo.isSubmitted && !droppedSet.has(studentName)) {
                previewUnsubmitted.push(studentName);
            }
        }
    }
    
    // Check consolidation homework
    if (homeworkData && hwLesson) {
        for (const [studentName, hwInfo] of Object.entries(homeworkMap)) {
            if (!hwInfo.isSubmitted && !droppedSet.has(studentName)) {
                homeworkUnsubmitted.push(studentName);
            }
        }
    }
    
    // Check note homework (English only)
    if (noteData && noteLesson && noteMap) {
        for (const [studentName, noteInfo] of Object.entries(noteMap)) {
            if (!noteInfo.isSubmitted && !droppedSet.has(studentName)) {
                noteUnsubmitted.push(studentName);
            }
        }
    }

    // Check class test homework (English only)
    if (classTestData && classTestLesson && classTestMap) {
        for (const [studentName, ctInfo] of Object.entries(classTestMap)) {
            if (!ctInfo.isSubmitted && !droppedSet.has(studentName)) {
                classTestUnsubmitted.push(studentName);
            }
        }
    }
    
    // Show suggestion if there are unsubmitted students
    if (previewUnsubmitted.length > 0 || homeworkUnsubmitted.length > 0 || noteUnsubmitted.length > 0 || classTestUnsubmitted.length > 0) {
        window.openReminderFromWarning = function(type) {
            const d = document.getElementById('custom-dialog');
            if (d) d.classList.remove('active');
            openReminderModal(type);
        };

        let suggestionHTML = `
            <div style="text-align: left;">
                <div class="unsubmitted-cards-wrap">
        `;
        
        if (previewUnsubmitted.length > 0) {
            suggestionHTML += `
                <div class="unsubmitted-category-card">
                    <div class="unsubmitted-card-header">
                        <div class="unsubmitted-card-title">
                            <span>课前预习未提交</span>
                            <span class="unsubmitted-card-badge">${previewUnsubmitted.length} 人</span>
                        </div>
                        <button type="button" class="unsubmitted-set-btn" onclick="openReminderFromWarning('preview')">
                            去设置补交提示
                        </button>
                    </div>
                    <div class="unsubmitted-card-names">
                        ${previewUnsubmitted.join('、')}
                    </div>
                </div>
            `;
        }
        
        if (homeworkUnsubmitted.length > 0) {
            suggestionHTML += `
                <div class="unsubmitted-category-card">
                    <div class="unsubmitted-card-header">
                        <div class="unsubmitted-card-title">
                            <span>${getHomeworkLabelFull()}未提交</span>
                            <span class="unsubmitted-card-badge">${homeworkUnsubmitted.length} 人</span>
                        </div>
                        <button type="button" class="unsubmitted-set-btn" onclick="openReminderFromWarning('homework')">
                            去设置补交提示
                        </button>
                    </div>
                    <div class="unsubmitted-card-names">
                        ${homeworkUnsubmitted.join('、')}
                    </div>
                </div>
            `;
        }
        
        if (noteUnsubmitted.length > 0) {
            suggestionHTML += `
                <div class="unsubmitted-category-card">
                    <div class="unsubmitted-card-header">
                        <div class="unsubmitted-card-title">
                            <span>笔记作业未提交</span>
                            <span class="unsubmitted-card-badge">${noteUnsubmitted.length} 人</span>
                        </div>
                        <button type="button" class="unsubmitted-set-btn" onclick="openReminderFromWarning('note')">
                            去设置补交提示
                        </button>
                    </div>
                    <div class="unsubmitted-card-names">
                        ${noteUnsubmitted.join('、')}
                    </div>
                </div>
            `;
        }

        if (classTestUnsubmitted.length > 0) {
            suggestionHTML += `
                <div class="unsubmitted-category-card">
                    <div class="unsubmitted-card-header">
                        <div class="unsubmitted-card-title">
                            <span>课堂测试作业未提交</span>
                            <span class="unsubmitted-card-badge purple">${classTestUnsubmitted.length} 人</span>
                        </div>
                        <button type="button" class="unsubmitted-set-btn" onclick="openReminderFromWarning('class_test')">
                            去设置补交提示
                        </button>
                    </div>
                    <div class="unsubmitted-card-names">
                        ${classTestUnsubmitted.join('、')}
                    </div>
                </div>
            `;
        }
        
        suggestionHTML += `</div></div>`;
        
        showCustomDialog({
            title: '未提交作业提示',
            body: suggestionHTML,
            confirmText: '确定',
            onConfirm: () => {}
        });
    }
}

function toggleEdit(btn) {
    const cell = btn.closest('.feedback-cell');
    const w = cell.querySelector('.feedback-wrapper');
    const e = cell.querySelector('.feedback-editor');
    const c = cell.querySelector('.feedback-content');
    const t = cell.querySelector('.feedback-toolbar');
    const a = cell.querySelector('.editor-actions');
    
    w.style.display = 'none';
    if (t) t.style.display = 'none';
    e.style.display = 'block';
    if (a) a.style.display = 'flex';
    if (!e.value) e.value = c.innerText;
    
    e.focus();
    e.style.height = 'auto';
    e.style.height = Math.max(e.scrollHeight, 150) + 'px';
    
    if (!e.dataset.autoSaveBound) {
        e.dataset.autoSaveBound = '1';
        e.addEventListener('blur', () => {
            // Delay slightly so that if the user clicked "Cancel", it has time to hide the editor
            setTimeout(() => {
                if (e.style.display !== 'none') {
                    saveEdit(e);
                }
            }, 150);
        });
    }
}
function cancelEdit(btn) {
    const cell = btn.closest('.feedback-cell');
    if (!cell) return;
    const w = cell.querySelector('.feedback-wrapper'),
          c = cell.querySelector('.feedback-content'),
          e = cell.querySelector('.feedback-editor'),
          t = cell.querySelector('.feedback-toolbar'),
          a = cell.querySelector('.editor-actions');
    if (e && c) e.value = c.innerText;
    if (e) e.style.display = 'none';
    if (a) a.style.display = 'none';
    if (w) w.style.display = 'block';
    if (t) t.style.display = 'flex';
}

function saveEdit(btn) {
    const cell = btn.closest('.feedback-cell');
    if (!cell) return;
    const w = cell.querySelector('.feedback-wrapper'),
          c = cell.querySelector('.feedback-content'),
          e = cell.querySelector('.feedback-editor'),
          t = cell.querySelector('.feedback-toolbar'),
          a = cell.querySelector('.editor-actions');
    c.innerText = e.value;
    e.style.display = 'none';
    if (a) a.style.display = 'none';
    w.style.display = 'block';
    if (t) t.style.display = 'flex';

    const row = cell.closest('tr');
    if (row) {
        if (currentFeedbackViewMode === 'plus-with-name') {
            row.setAttribute('data-plus-name-feedback', e.value);
        } else if (currentFeedbackViewMode === 'plus-pure') {
            row.setAttribute('data-plus-pure-feedback', e.value);
        } else if (currentFeedbackViewMode === 'academic-only') {
            row.setAttribute('data-academic-feedback', e.value);
        } else {
            row.setAttribute('data-full-feedback', e.value);
        }
    }

    Logger.action('edit_saved', { length: e.value.length });
    showToast('已保存');
}

function updateSplitCards(cardEl) {
    if (!cardEl) return;
    const radio = cardEl.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    document.querySelectorAll('.split-mode-card').forEach(c => c.classList.remove('selected'));
    cardEl.classList.add('selected');
}
window.updateSplitCards = updateSplitCards;

function showSplitPlusDialog() {
    const isName = currentFeedbackViewMode === 'plus-with-name';
    const isPure = currentFeedbackViewMode === 'plus-pure';
    const isFull = currentFeedbackViewMode === 'full';
    const isAcademic = currentFeedbackViewMode === 'academic-only';

    const bodyHtml = `
        <div class="split-mode-options" style="display: flex; flex-direction: column; gap: 8px; margin: 4px 0;">
            <label class="split-mode-card ${isName ? 'selected' : ''}" onclick="updateSplitCards(this)">
                <input type="radio" name="split-plus-radio" value="plus-with-name" ${isName ? 'checked' : ''}>
                <span class="split-card-title">错题与知识点（带称呼）</span>
            </label>
            <label class="split-mode-card ${isPure ? 'selected' : ''}" onclick="updateSplitCards(this)">
                <input type="radio" name="split-plus-radio" value="plus-pure" ${isPure ? 'checked' : ''}>
                <span class="split-card-title">纯错题与知识点（无称呼）</span>
            </label>
            <label class="split-mode-card ${isFull ? 'selected' : ''}" onclick="updateSplitCards(this)">
                <input type="radio" name="split-plus-radio" value="full" ${isFull ? 'checked' : ''}>
                <span class="split-card-title">完整反馈（默认）</span>
            </label>
            <label class="split-mode-card ${isAcademic ? 'selected' : ''}" onclick="updateSplitCards(this)">
                <input type="radio" name="split-plus-radio" value="academic-only" ${isAcademic ? 'checked' : ''}>
                <span class="split-card-title">仅学情成绩（无错题本）</span>
            </label>
        </div>
    `;

    showCustomDialog({
        title: '切分反馈内容',
        body: bodyHtml,
        confirmText: '确认',
        onConfirm: () => {
            const selected = document.querySelector('input[name="split-plus-radio"]:checked');
            if (selected) {
                applyFeedbackViewMode(selected.value);
            }
        }
    });
}

function applyFeedbackViewMode(mode, silent = false) {
    currentFeedbackViewMode = mode;
    const btn = document.getElementById('split-plus-btn');
    const btnText = document.getElementById('split-plus-btn-text');

    if (mode === 'plus-with-name') {
        if (btn) btn.classList.add('active-mode-btn');
        if (btnText) btnText.textContent = '仅错题本(带称呼)';
        if (!silent) showToast('已切换为【仅错题本与知识点(带称呼)】模式');
    } else if (mode === 'plus-pure') {
        if (btn) btn.classList.add('active-mode-btn');
        if (btnText) btnText.textContent = '纯错题本(无称呼)';
        if (!silent) showToast('已切换为【纯错题本与知识点】模式');
    } else if (mode === 'academic-only') {
        if (btn) btn.classList.add('active-mode-btn');
        if (btnText) btnText.textContent = '仅学情成绩';
        if (!silent) showToast('已切换为【仅学情成绩】模式');
    } else {
        if (btn) btn.classList.remove('active-mode-btn');
        if (btnText) btnText.textContent = '切分错题本';
        if (!silent) showToast('已恢复为【完整学情反馈】模式');
    }

    const tbody = document.getElementById('result-tbody');
    if (!tbody) return;

    // If any editors are currently open, close them cleanly
    tbody.querySelectorAll('.feedback-editor').forEach(ed => {
        if (ed.style.display !== 'none') {
            const cell = ed.closest('.feedback-cell');
            if (cell) {
                const w = cell.querySelector('.feedback-wrapper');
                const a = cell.querySelector('.editor-actions');
                const t = cell.querySelector('.feedback-toolbar');
                ed.style.display = 'none';
                if (a) a.style.display = 'none';
                if (w) w.style.display = 'block';
                if (t) t.style.display = 'flex';
            }
        }
    });

    tbody.querySelectorAll('tr').forEach(tr => {
        let targetText = '';
        if (mode === 'plus-with-name') {
            targetText = tr.getAttribute('data-plus-name-feedback') || '';
        } else if (mode === 'plus-pure') {
            targetText = tr.getAttribute('data-plus-pure-feedback') || '';
        } else if (mode === 'academic-only') {
            targetText = tr.getAttribute('data-academic-feedback') || '';
        } else {
            targetText = tr.getAttribute('data-full-feedback') || '';
        }

        if (targetText !== null && targetText !== undefined) {
            let finalTargetText = targetText;
            if (globalAppendText && mode !== 'plus-pure' && !targetText.endsWith(globalAppendText)) {
                finalTargetText = (finalTargetText + '\n' + globalAppendText).replace(/\n{2,}/g, '\n');
            }
            const fc = tr.querySelector('.feedback-content');
            if (fc) fc.textContent = finalTargetText;
            const ed = tr.querySelector('.feedback-editor');
            if (ed) ed.value = finalTargetText;
        }
    });
}

function showGlobalAppendDialog() {
    showCustomDialog({ 
        title: '全局追加文本', 
        body: '输入要追加到所有反馈末尾的文本：', 
        showInput: true, 
        inputDefault: globalAppendText, 
        confirmText: globalAppendText ? '修改' : '追加到全部',
        onConfirm: (userInput) => {
            const txt = userInput.trim(); 
            if (!txt) { 
                // Clear if empty
                globalAppendText = '';
                showToast('已清除全局追加文本');
                doGenerateFeedback(true);
                return; 
            }
            globalAppendText = txt;
            showToast('已保存全局追加文本');
            doGenerateFeedback(true);
        }
    });
}

function applyGlobalAppend(txt) {
    let count = 0;
    document.querySelectorAll('#result-body tr').forEach(row => {
        const fc = row.querySelector('.feedback-content');
        if (fc && !fc.textContent.endsWith(txt)) { 
            const nt = (fc.textContent + '\n' + txt).replace(/\n{2,}/g, '\n'); 
            fc.textContent = nt; 
            const ed = row.querySelector('.feedback-editor'); 
            if(ed) ed.value = nt; 
            count++; 
        }
    });
}

let currentReminderModalType = 'homework';

function addZeroScoreReminder(type) {
    openReminderModal(type);
}

function getReminderTemplates(type) {
    const isPreview = type === 'preview';
    const isNote = type === 'note';
    const isClassTest = type === 'class_test';
    const label = isClassTest ? '课堂测试' : (isNote ? '笔记' : (isPreview ? '课前预习' : (typeof getHomeworkLabelFull === 'function' ? getHomeworkLabelFull() : '巩固作业')));
    return {
        default: `本次${label}未提交，请补交（如果请假，请忽略）`,
        gentle: `请尽快完成${label}补交并上传，有疑问可随时联系老师`,
        weekend: `本次${label}尚未提交，请利用周末时间及时补交打卡`
    };
}

function openReminderModal(type) {
    currentReminderModalType = type || 'homework';
    const modal = document.getElementById('reminder-modal');
    if (!modal) return;
    
    const isPreview = currentReminderModalType === 'preview';
    const isNote = currentReminderModalType === 'note';
    const isClassTest = currentReminderModalType === 'class_test';
    
    const titleEl = document.getElementById('reminder-modal-title');
    
    let title = '巩固作业补交提示';
    const hwLabel = (typeof getHomeworkLabelFull === 'function') ? getHomeworkLabelFull() : '巩固作业';
    if (isClassTest) {
        title = '课堂测试补交提示';
    } else if (isNote) {
        title = '笔记作业补交提示';
    } else if (isPreview) {
        title = '预习作业补交提示';
    } else {
        title = `${hwLabel}补交提示`;
    }
    
    if (titleEl) titleEl.textContent = title;
    
    // Check unsubmitted students for this type - always display fully
    const unsubmitted = getUnsubmittedStudentsForType(currentReminderModalType);
    const countEl = document.getElementById('reminder-target-count');
    const collapseEl = document.getElementById('reminder-names-collapse');
    const listEl = document.getElementById('reminder-names-list');
    
    if (unsubmitted.length > 0) {
        if (countEl) countEl.textContent = `共 ${unsubmitted.length} 位同学未提交：`;
        if (collapseEl) collapseEl.style.display = 'block';
        if (listEl) {
            listEl.innerHTML = unsubmitted.map(name => `<span class="reminder-name-pill">${name}</span>`).join('');
        }
    } else {
        if (countEl) countEl.textContent = `暂无未提交学生（全部已提交）`;
        if (collapseEl) collapseEl.style.display = 'none';
        if (listEl) listEl.innerHTML = '';
    }
    
    // Current text
    let currentText = '';
    if (isClassTest) currentText = classTestReminderText;
    else if (isNote) currentText = noteReminderText;
    else if (isPreview) currentText = previewReminderText;
    else currentText = homeworkReminderText;

    // 读取本地上次保存的补交话术（优先当前作业类型，次选全局记录）
    let lastSavedText = '';
    try {
        lastSavedText = localStorage.getItem('jf_last_reminder_' + currentReminderModalType)
            || localStorage.getItem('jf_last_reminder_general')
            || '';
    } catch (e) { }

    const lastSavedChip = document.getElementById('reminder-last-saved-chip');
    const quickSection = document.querySelector('.reminder-quick-section');
    if (lastSavedChip) {
        lastSavedChip.style.display = lastSavedText ? 'inline-flex' : 'none';
        if (lastSavedText) lastSavedChip.title = lastSavedText;
    }
    if (quickSection) {
        quickSection.style.display = lastSavedText ? 'block' : 'none';
    }
    
    const textarea = document.getElementById('reminder-textarea');
    const templates = getReminderTemplates(currentReminderModalType);
    if (textarea) {
        // 优先级：当前会话设置 > 本地记忆上次输入 > 默认模板
        textarea.value = currentText || lastSavedText || templates.default;
        updateReminderCharCount(textarea);
    }
    
    // Clear button visibility
    const clearBtn = document.getElementById('reminder-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = currentText ? 'inline-flex' : 'none';
    }
    
    modal.style.display = 'flex';
    setTimeout(() => {
        if (textarea) textarea.focus();
    }, 100);
}

function closeReminderModal() {
    const modal = document.getElementById('reminder-modal');
    if (modal) modal.style.display = 'none';
}

function toggleReminderNamesList() {
    const collapseEl = document.getElementById('reminder-names-collapse');
    const toggleBtn = document.getElementById('reminder-toggle-names-btn');
    const textSpan = document.getElementById('reminder-toggle-text');
    if (!collapseEl) return;
    const isHidden = collapseEl.style.display === 'none';
    if (isHidden) {
        collapseEl.style.display = 'block';
        if (toggleBtn) toggleBtn.classList.add('open');
        if (textSpan) textSpan.textContent = '收起名单';
    } else {
        collapseEl.style.display = 'none';
        if (toggleBtn) toggleBtn.classList.remove('open');
        if (textSpan) textSpan.textContent = '查看名单';
    }
}

function applyReminderTemplate(templateKey) {
    const textarea = document.getElementById('reminder-textarea');
    if (!textarea) return;
    if (templateKey === 'last') {
        let lastSavedText = '';
        try {
            lastSavedText = localStorage.getItem('jf_last_reminder_' + currentReminderModalType)
                || localStorage.getItem('jf_last_reminder_general')
                || '';
        } catch (e) { }
        if (lastSavedText) {
            textarea.value = lastSavedText;
            updateReminderCharCount(textarea);
            textarea.focus();
            showToast('已载入上次输入的补交话术');
        }
        return;
    }
    const tmpls = getReminderTemplates(currentReminderModalType);
    if (tmpls[templateKey]) {
        textarea.value = tmpls[templateKey];
        updateReminderCharCount(textarea);
        textarea.focus();
    }
}

function updateReminderCharCount(el) {
    const countEl = document.getElementById('reminder-char-count');
    if (!countEl || !el) return;
    const len = el.value.length;
    countEl.textContent = `${len} 字`;
}

function saveReminderModal() {
    const textarea = document.getElementById('reminder-textarea');
    const text = (textarea ? textarea.value : '').trim();
    const type = currentReminderModalType;
    
    if (type === 'class_test') {
        classTestReminderText = text;
    } else if (type === 'note') {
        noteReminderText = text;
    } else if (type === 'preview') {
        previewReminderText = text;
    } else {
        homeworkReminderText = text;
    }

    // 本地持久化保存该用户上次输入的补交话术
    if (text) {
        try {
            localStorage.setItem('jf_last_reminder_' + type, text);
            localStorage.setItem('jf_last_reminder_general', text);
        } catch (e) { }
    }
    
    closeReminderModal();
    if (!text) {
        showToast('已清除补交提示');
    } else {
        showToast('已保存补交提示并生效');
    }
    updateReminderBadges();
    doGenerateFeedback(true);
}

function clearCurrentReminder() {
    const type = currentReminderModalType;
    if (type === 'class_test') {
        classTestReminderText = '';
    } else if (type === 'note') {
        noteReminderText = '';
    } else if (type === 'preview') {
        previewReminderText = '';
    } else {
        homeworkReminderText = '';
    }
    
    closeReminderModal();
    showToast('已清除补交提示');
    updateReminderBadges();
    doGenerateFeedback(true);
}

function getUnsubmittedStudentsForType(type) {
    const list = [];
    const rows = document.querySelectorAll('#result-body tr');
    let attr = 'data-homework-submitted';
    if (type === 'preview') attr = 'data-preview-submitted';
    else if (type === 'note') attr = 'data-note-submitted';
    else if (type === 'class_test') attr = 'data-class-test-submitted';
    
    rows.forEach(r => {
        if (r.getAttribute(attr) === '0') {
            const nameEl = r.querySelector('.student-name');
            if (nameEl) list.push(nameEl.textContent.trim());
        }
    });
    return list;
}

function updateReminderBadges() {
    const items = [
        { id: 'homework-reminder-btn', text: homeworkReminderText },
        { id: 'preview-reminder-btn', text: previewReminderText },
        { id: 'note-reminder-btn', text: noteReminderText },
        { id: 'class-test-reminder-btn', text: classTestReminderText }
    ];
    let anyActive = false;
    items.forEach(item => {
        const btn = document.getElementById(item.id);
        if (!btn) return;
        const oldTag = btn.querySelector('.reminder-active-tag');
        if (oldTag) oldTag.remove();
        if (item.text && item.text.trim()) {
            anyActive = true;
            const tag = document.createElement('span');
            tag.className = 'reminder-active-tag';
            tag.textContent = '已生效';
            btn.appendChild(tag);
        }
    });

    const hwBtn = document.getElementById('homework-reminder-btn');
    const triggerBtn = hwBtn ? hwBtn.closest('.vw-dropdown-trigger') : null;
    if (triggerBtn) {
        if (anyActive) {
            triggerBtn.classList.add('has-active-reminder');
        } else {
            triggerBtn.classList.remove('has-active-reminder');
        }
    }
}


function applyPreviewReminder(rt) {
    let count = 0;
    const marker = '课前预习作业未提交';
    document.querySelectorAll('#result-body tr').forEach(row => {
        const fc = row.querySelector('.feedback-content');
        if (!fc) return;
        const fb = fc.textContent;
        
        // Check data-preview-submitted attribute
        const isSubmitted = row.getAttribute('data-preview-submitted');
        if (isSubmitted === '1') return; // Already submitted
        if (fb.includes(rt)) return;
        
        // Find the position after "课前预习作业未提交"
        const idx = fb.indexOf(marker);
        if (idx < 0) return;
        
        let insertPos = idx + marker.length + 1; // +1 to skip the period
        // Skip newline if present
        if (fb[insertPos] === '\n') insertPos++;
        const newText = fb.substring(0, insertPos) + rt + '\n' + fb.substring(insertPos);
        
        fc.textContent = newText;
        const ed = row.querySelector('.feedback-editor'); 
        if (ed) ed.value = newText;

        // Sync to dataset attributes so mode switching preserves reminders
        ['data-full-feedback', 'data-academic-feedback'].forEach(attr => {
            const raw = row.getAttribute(attr);
            if (raw && raw.includes(marker) && !raw.includes(rt)) {
                let p = raw.indexOf(marker) + marker.length + 1;
                if (raw[p] === '\n') p++;
                row.setAttribute(attr, raw.substring(0, p) + rt + '\n' + raw.substring(p));
            }
        });
        count++;
    });
}

function applyHomeworkReminder(rt) {
    let count = 0;
    const marker = `${getHomeworkLabelFull()}未提交`;
    document.querySelectorAll('#result-body tr').forEach(row => {
        const fc = row.querySelector('.feedback-content');
        if (!fc) return;
        const fb = fc.textContent;
        
        // Check data-homework-submitted attribute
        const isSubmitted = row.getAttribute('data-homework-submitted');
        if (isSubmitted === '1') return; // Already submitted
        if (fb.includes(rt)) return;
        
        // Find the position after homework unsubmitted marker
        const idx = fb.indexOf(marker);
        if (idx < 0) return;
        
        let insertPos = idx + marker.length + 1; // +1 to skip the period
        // Skip newline if present
        if (fb[insertPos] === '\n') insertPos++;
        const newText = fb.substring(0, insertPos) + rt + '\n' + fb.substring(insertPos);
        
        fc.textContent = newText;
        const ed = row.querySelector('.feedback-editor'); 
        if (ed) ed.value = newText;

        // Sync to dataset attributes so mode switching preserves reminders
        ['data-full-feedback', 'data-academic-feedback'].forEach(attr => {
            const raw = row.getAttribute(attr);
            if (raw && raw.includes(marker) && !raw.includes(rt)) {
                let p = raw.indexOf(marker) + marker.length + 1;
                if (raw[p] === '\n') p++;
                row.setAttribute(attr, raw.substring(0, p) + rt + '\n' + raw.substring(p));
            }
        });
        count++;
    });
}

function applyNoteReminder(rt) {
    let count = 0;
    const marker = '笔记作业未提交';
    document.querySelectorAll('#result-body tr').forEach(row => {
        const fc = row.querySelector('.feedback-content');
        if (!fc) return;
        const fb = fc.textContent;
        
        // Check data-note-submitted attribute
        const isSubmitted = row.getAttribute('data-note-submitted');
        if (isSubmitted === '1') return; // Already submitted
        if (fb.includes(rt)) return;
        
        // Find the position after "笔记作业未提交"
        const idx = fb.indexOf(marker);
        if (idx < 0) return;
        
        let insertPos = idx + marker.length + 1; // +1 to skip the period
        // Skip newline if present
        if (fb[insertPos] === '\n') insertPos++;
        const newText = fb.substring(0, insertPos) + rt + '\n' + fb.substring(insertPos);
        
        fc.textContent = newText;
        const ed = row.querySelector('.feedback-editor'); 
        if (ed) ed.value = newText;

        // Sync to dataset attributes so mode switching preserves reminders
        ['data-full-feedback', 'data-academic-feedback'].forEach(attr => {
            const raw = row.getAttribute(attr);
            if (raw && raw.includes(marker) && !raw.includes(rt)) {
                let p = raw.indexOf(marker) + marker.length + 1;
                if (raw[p] === '\n') p++;
                row.setAttribute(attr, raw.substring(0, p) + rt + '\n' + raw.substring(p));
            }
        });
        count++;
    });
}

function applyClassTestReminder(rt) {
    let count = 0;
    const marker = '课堂测试作业未提交';
    document.querySelectorAll('#result-body tr').forEach(row => {
        const fc = row.querySelector('.feedback-content');
        if (!fc) return;
        const fb = fc.textContent;
        
        // Check data-class-test-submitted attribute
        const isSubmitted = row.getAttribute('data-class-test-submitted');
        if (isSubmitted === '1') return; // Already submitted
        if (fb.includes(rt)) return;
        
        // Find the position after "课堂测试作业未提交"
        const idx = fb.indexOf(marker);
        if (idx < 0) return;
        
        let insertPos = idx + marker.length + 1; // +1 to skip the period
        // Skip newline if present
        if (fb[insertPos] === '\n') insertPos++;
        const newText = fb.substring(0, insertPos) + rt + '\n' + fb.substring(insertPos);
        
        fc.textContent = newText;
        const ed = row.querySelector('.feedback-editor'); 
        if (ed) ed.value = newText;

        // Sync to dataset attributes so mode switching preserves reminders
        ['data-full-feedback', 'data-academic-feedback'].forEach(attr => {
            const raw = row.getAttribute(attr);
            if (raw && raw.includes(marker) && !raw.includes(rt)) {
                let p = raw.indexOf(marker) + marker.length + 1;
                if (raw[p] === '\n') p++;
                row.setAttribute(attr, raw.substring(0, p) + rt + '\n' + raw.substring(p));
            }
        });
        count++;
    });
}

async function exportRankImage(type) {
    const isPreview = type === 'preview';
    let students = [];
    let titleText = '';
    let col2Label = '';

    const dsObj = typeof sessionPayload !== 'undefined' ? (sessionPayload?.droppedStudents || null) : null;
    const droppedSet = new Set([...(dsObj?.homework || []), ...(dsObj?.preview || [])]);

    if (isPreview) {
        if (!cachedPreviewStats.rankEnabled || !cachedPreviewStats.rankEntries || cachedPreviewStats.rankEntries.length === 0) {
            showToast('当前预习展示模式不支持排名图');
            return;
        }
        
        const submittedMap = new Map();
        cachedPreviewStats.rankEntries.forEach(s => {
            submittedMap.set(s.name, { name: s.name, score: s.score, isSubmitted: true });
        });
        
        students = Array.from(submittedMap.values());
        titleText = cachedPreviewStats.rankTitle || '预习作业排名';
        col2Label = cachedPreviewStats.rankColLabel || '得分';
    } else {
        if (!homeworkData) { showToast('请先上传作业数据'); return; }
        const h = homeworkData[0];
        const ni = h.findIndex(x=>x.includes('姓名')), si = h.findIndex(x=>x.includes('得分')), stIdx = h.findIndex(x=>x.includes('状态'));
        if (ni===-1||si===-1) { showToast('无法找到姓名或得分列'); return; }
        
        homeworkData.slice(1).forEach(r => {
            if (!r[ni] || !r[ni].trim()) return;
            const fullName = r[ni].trim();
            const nm = fullName.match(/\d+(.+)/);
            const name = nm ? nm[1] : fullName;
            if (droppedSet.has(name)) return;
            const status = stIdx >= 0 ? (r[stIdx] || '') : '';
            const isSubmitted = status ? (status.includes('已完成') || status.includes('待订正') || status.includes('已订正')) : true;
            if (!isSubmitted) return;
            const rawScore = parseScoreValue(r[si]);
            if (rawScore === null) return;
            students.push({ name: fullName, score: rawScore, status });
        });
        
        titleText = '课后巩固作业排名';
        col2Label = '得分';
    }
    
    if (students.length === 0) { showToast('没有可显示的学生数据'); return; }
    
    students.sort((a, b) => b.score - a.score);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const padding = 40;
    const rowHeight = 36;
    const col1Width = 200;
    const col2Width = 80;
    const col3Width = 80;
    const headerHeight = 60;
    const titleHeight = 50;
    const totalWidth = padding * 2 + col1Width + col2Width + col3Width;
    const totalHeight = titleHeight + headerHeight + students.length * rowHeight + padding * 2;
    
    canvas.width = totalWidth;
    canvas.height = Math.max(totalHeight, 300);
    
    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Title
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 18px "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(titleText, canvas.width / 2, titleHeight);
    
    // Header
    const headerY = titleHeight + padding;
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(padding, headerY, col1Width, headerHeight);
    ctx.fillRect(padding + col1Width, headerY, col2Width, headerHeight);
    ctx.fillRect(padding + col1Width + col2Width, headerY, col3Width, headerHeight);
    
    ctx.fillStyle = '#374151';
    ctx.font = 'bold 14px "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    const headerTextY = headerY + headerHeight / 2 + 5;
    ctx.fillText('姓名', padding + col1Width / 2, headerTextY);
    ctx.fillText(col2Label, padding + col1Width + col2Width / 2, headerTextY);
    ctx.fillText('排名', padding + col1Width + col2Width + col3Width / 2, headerTextY);
    
    // Rows
    students.forEach((s, i) => {
        const y = headerY + headerHeight + i * rowHeight;
        if (i % 2 === 0) {
            ctx.fillStyle = '#f9fafb';
            ctx.fillRect(padding, y, col1Width + col2Width + col3Width, rowHeight);
        }
        
        ctx.fillStyle = '#1f2937';
        ctx.font = '13px "Noto Sans SC", sans-serif';
        ctx.textAlign = 'left';
        const displayName = (() => {
            const fm = s.name.match(/\d+(.+)/);
            return fm ? fm[1] : s.name;
        })();
        ctx.fillText(displayName, padding + 10, y + rowHeight / 2 + 5);
        
        ctx.textAlign = 'center';
        ctx.fillText(String(s.score), padding + col1Width + col2Width / 2, y + rowHeight / 2 + 5);
        ctx.fillText(`${i + 1}/${students.length}`, padding + col1Width + col2Width + col3Width / 2, y + rowHeight / 2 + 5);
    });
    
    // Border
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.strokeRect(padding, headerY, col1Width + col2Width + col3Width, headerHeight + students.length * rowHeight);
    
    const baseFilename = (typeof generateDefaultExportFilename === 'function' ? generateDefaultExportFilename() : null) || (isPreview ? '预习排名' : '作业排名');
    canvas.toBlob(async (blob) => {
        if (!blob) { showToast('图片生成失败'); return; }
        if (typeof saveFileWithDialog === 'function') {
            const saved = await saveFileWithDialog(blob, `${baseFilename}.png`, 'PNG Image', 'png', 'image/png');
            if (saved) showToast('排名图已导出');
        } else {
            const link = document.createElement('a'); link.download = `${baseFilename}.png`; link.href = URL.createObjectURL(blob); link.click(); showToast('排名图已导出');
        }
    }, 'image/png');
}

function exportPlusStats() {
    const keys = Object.keys(cachedPlusErrorStats);
    if (keys.length === 0) { showToast('没有错题统计数据'); return; }
    
    const total = keys.reduce((sum, k) => sum + cachedPlusErrorStats[k].count, 0);
    const sorted = keys.map(k => ({ key: k, ...cachedPlusErrorStats[k] })).sort((a, b) => b.count - a.count);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const size = 600;
    const legendWidth = 300;
    const chartSize = 300;
    const padding = 40;
    canvas.width = size + legendWidth + padding * 2;
    canvas.height = Math.max(size, padding * 2 + sorted.length * 22 + 60);
    
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Title
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 18px "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('错题统计分布', canvas.width / 2, 35);
    
    const colors = ['#3b82f6','#ef4444','#f59e0b','#10b981','#8b5cf6','#ec4899','#06b6d4','#f97316','#6366f1','#14b8a6','#e11d48','#84cc16','#a855f7','#0ea5e9','#d946ef'];
    const cx = padding + chartSize / 2;
    const cy = padding + chartSize / 2 + 40;
    const radius = chartSize / 2 - 10;
    
    const displayKeys = sorted.slice(0, 15);
    let startAngle = -Math.PI / 2;
    
    displayKeys.forEach((item, idx) => {
        const sliceAngle = (item.count / total) * 2 * Math.PI;
        const color = colors[idx % colors.length];
        
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        startAngle += sliceAngle;
    });
    
    // Legend
    const legendX = padding + size + 20;
    const legendStartY = 60;
    const legendRowHeight = 22;
    
    displayKeys.forEach((item, idx) => {
        const y = legendStartY + idx * legendRowHeight;
        const color = colors[idx % colors.length];
        const percent = Math.round((item.count / total) * 100);
        const topicShow = item.topic || `题号 ${item.key}`;
        
        ctx.fillStyle = color;
        ctx.fillRect(legendX, y, 14, 14);
        
        ctx.fillStyle = '#374151';
        ctx.font = '12px "Noto Sans SC", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${topicShow}`, legendX + 22, y + 12);
        ctx.fillStyle = '#6b7280';
        ctx.fillText(`${item.count}次 (${percent}%)`, legendX + 22, y + 26);
    });
    
    if (keys.length > displayKeys.length) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px "Noto Sans SC", sans-serif';
        ctx.fillText(`其余 ${keys.length - displayKeys.length} 道题请导出"错题统计"查看`, legendX, legendStartY + displayKeys.length * legendRowHeight + 10);
    }
    
    const link = document.createElement('a');
    link.download = `错题饼图_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('饼图图片已导出');
}

function showExportDialog() {
    showCustomDialog({ 
        title: '导出反馈数据', 
        body: '<div style="margin-bottom:12px;"><label style="display:block;font-size:0.82rem;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">选择导出格式</label><select id="export-format-select" class="custom-select" style="width:100%;cursor:pointer;"><option value="json">JSON (企微发送工具格式)</option><option value="html">HTML快照 (网页快照 / 企微发送通用格式)</option><option value="xlsx">Excel (.xlsx)</option><option value="docx">Word (.doc)</option></select></div>',
        confirmText: '确认导出',
        onConfirm: () => { executeExport((document.getElementById('export-format-select')||{value:'json'}).value); }
    });
}

function generateDefaultExportFilename() {
    const d = new Date();
    const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`;

    let clsName = '';
    if (typeof onlineStudents !== 'undefined' && Object.keys(onlineStudents).length > 0) {
        const first = Object.values(onlineStudents).find(s => s && s.className);
        if (first && first.className) {
            clsName = first.className.trim();
            // Remove leading 6 digits (e.g. 202504)
            clsName = clsName.replace(/^\d{6}/, '');
            // Remove leading like 25秋, 2025春, 26寒, 26暑
            clsName = clsName.replace(/^\d{2,4}[春夏秋冬寒暑]假?/, '');
            // Remove trailing greek letters + optional digits (e.g. β1)
            clsName = clsName.replace(/[α-ωΑ-Ω].*$/i, '');
        }
    }

    const homeworkFileName = sessionPayload?.homeworkFiles?.[0]?.name || '';
    const hwLesson = (sessionPayload?.lessonNums?.homework) || extractLessonNumber(homeworkFileName, 'homework');
    let lessonStr = '';
    if (hwLesson) {
        lessonStr = `第${hwLesson}${getLessonUnit()}`;
    }

    return `${dateStr}${clsName}${lessonStr}`;
}

async function saveFileWithDialog(blob, defaultFilename, typeDesc, ext, mimeType) {
    try {
        if (window.showSaveFilePicker) {
            const handle = await window.showSaveFilePicker({
                suggestedName: defaultFilename,
                types: [{
                    description: typeDesc,
                    accept: { [mimeType]: ['.' + ext] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return true;
        }
    } catch (e) {
        if (e.name === 'AbortError') return false; // user cancelled
        console.error("SaveFilePicker Error:", e);
    }
    // Fallback
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
}

async function executeExport(format) {
    if (format === 'html') {
        saveSnapshot();
        return;
    }

    const tbody = document.getElementById('result-tbody'); if (!tbody) return;
    const exportData = [];
    tbody.querySelectorAll('tr').forEach(row => {
        const nc = row.querySelector('.student-name'), fc = row.querySelector('.feedback-content');
        if (nc && fc) exportData.push({ studentName: nc.innerText, message: fc.innerText });
    });
    if (!exportData.length) { showToast('没有可导出的数据'); return; }
    Logger.action('export_data', { format, count: exportData.length });
    
    const baseFilename = generateDefaultExportFilename() || '反馈数据';

    if (format === 'json') {
        const blob = new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'});
        const saved = await saveFileWithDialog(blob, `${baseFilename}.json`, 'JSON Document', 'json', 'application/json');
        if (saved) showToast(`已导出${exportData.length}条数据`);
    } else if (format === 'xlsx') {
        if (typeof XLSX==='undefined') { showToast('Excel模块未加载'); return; }
        const ws=XLSX.utils.aoa_to_sheet(exportData.map(i=>[i.studentName,i.message])), wb=XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb,ws,"反馈数据");
        const wbout = XLSX.write(wb, {bookType:'xlsx', type:'array'});
        const blob = new Blob([wbout], {type: "application/octet-stream"});
        const saved = await saveFileWithDialog(blob, `${baseFilename}.xlsx`, 'Excel Document', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (saved) showToast(`已导出${exportData.length}条Excel数据`);
    } else if (format === 'docx') {
        let html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>反馈数据</title></head><body><table border="1" style="border-collapse:collapse;width:100%;"><tbody>`;
        exportData.forEach(i => { html += `<tr><td style="padding:8px;vertical-align:top;">${i.studentName}</td><td style="padding:8px;vertical-align:top;"><p style="white-space:pre-wrap;margin:0;">${i.message.replace(/\n/g,'<br>')}</p></td></tr>`; });
        html += '</tbody></table></body></html>';
        const blob = new Blob(['\ufeff',html],{type:'application/msword'});
        const saved = await saveFileWithDialog(blob, `${baseFilename}.doc`, 'Word Document', 'doc', 'application/msword');
        if (saved) showToast(`已导出${exportData.length}个学生的Word文档`);
    }
}

function applySorting() {
    const tbody = document.getElementById('result-tbody'); if (!tbody) return;
    const sv = (document.getElementById('sort-field')||{value:'id-asc'}).value;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
        switch (sv) {
            case 'id-asc': return parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0);
            case 'id-desc': return parseInt(b.dataset.studentId||0)-parseInt(a.dataset.studentId||0);
            case 'score-desc': return parseFloat(b.dataset.score||0)-parseFloat(a.dataset.score||0);
            case 'score-asc': return parseFloat(a.dataset.score||0)-parseFloat(b.dataset.score||0);
            case 'online': { const ao=parseInt(a.dataset.online||0),bo=parseInt(b.dataset.online||0); return ao!==bo?bo-ao:parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0); }
            case 'offline': { const ao=parseInt(a.dataset.online||0),bo=parseInt(b.dataset.online||0); return ao!==bo?ao-bo:parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0); }
            case 'focus-desc': { const af=parseFloat(a.dataset.focus||-1),bf=parseFloat(b.dataset.focus||-1); return af!==bf?bf-af:parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0); }
            case 'focus-asc': { const af=parseFloat(a.dataset.focus||-1),bf=parseFloat(b.dataset.focus||-1); return af!==bf?af-bf:parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0); }
            default: return 0;
        }
    });
    rows.forEach(row => tbody.appendChild(row));
    if (typeof applyFiltering === 'function') applyFiltering();
}

function applyFiltering() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;
    const term = searchInput.value.toLowerCase().trim();
    const tbody = document.getElementById('result-tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    let visibleCount = 0;
    rows.forEach(row => {
        const nameEl = row.querySelector('.student-name');
        const idEl = row.querySelector('.student-id');
        const name = nameEl ? nameEl.textContent.toLowerCase() : '';
        const studentId = idEl ? idEl.textContent.toLowerCase() : '';
        if (name.includes(term) || studentId.includes(term)) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });

    const countBadge = document.getElementById('result-count');
    if (countBadge) {
        if (term) {
            countBadge.textContent = `筛选: ${visibleCount} / ${rows.length} 人`;
        } else {
            countBadge.textContent = `共 ${rows.length} 位同学`;
        }
    }
}

// ========== Plus Feature: Parse Error Questions ==========
/**
 * 智能解析老师评语中的错题题号与清洗后评语
 * 五重识别与过滤机制：
 * 1. 显式无错题/全对拦截（"错题为：无"、"全对"、"零失误"等）
 * 2. 错题前缀模糊容错提取（兼容错别字/多字/漏字如"本次的作业的错题为："、"错题为："、"做错："等）
 * 3. 纯数字序列判定（"1, 2, 5"、"第1题、第3题"等纯题号行）
 * 4. 自然语言非题号数字拦截（中文普通评语句子绝不误抓"98分"、"第1名"、"第1次"等）
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
        // 例如 "1, 2, 3。公式理解还要巩固"
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

// ========== Snapshot: Save as self-contained offline HTML ==========

/**
 * 从已加载的 document.styleSheets 中提取所有同源 CSS 规则文本。
 * 跨域样式表（如 Google Fonts）会被跳过，由 \<link\> 标签在快照中加载。
 */
function collectInlineCSS() {
    const parts = [];
    for (const sheet of document.styleSheets) {
        try {
            const rules = sheet.cssRules || sheet.rules;
            if (!rules) continue;
            for (const rule of rules) {
                parts.push(rule.cssText);
            }
        } catch (e) {
            // Cross-origin sheets (Google Fonts etc.) — skip silently
        }
    }
    return parts.join('\n');
}

/**
 * 在 CSS/JS 文本插入 <style>/<script> 前，
 * 把可能导致 HTML 解析器提前关闭标签的 </style 和 </script 序列破坏掉。
 */
function safeCSSForStyle(css) {
    return css.replace(/<\/style/gi, '<\\/style');
}
function safeJSForScript(js) {
    return js.replace(/<\/script/gi, '<\\/script');
}

async function saveSnapshot() {
    const tbody = document.getElementById('result-tbody');
    if (!tbody || tbody.querySelectorAll('tr').length === 0) {
        showToast('没有可保存的数据');
        return;
    }

    showToast('正在生成快照…');

    try {
        // 1. Collect CSS from already-loaded stylesheets (no fetch needed)
        const allCSS = collectInlineCSS();

        // 2. Capture current state
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        const brandTitle = document.querySelector('.brand-text h1')?.textContent || '教学反馈系统';
        const ds = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
        const ts = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        
        const baseFilename = generateDefaultExportFilename() || '反馈快照';
        const snapshotFileName = `${baseFilename}.html`;
        
        const checkedAttr = currentTheme === 'light' ? ' checked' : '';

        // 3. Build table rows HTML from current DOM (preserves manual edits)
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const rowParts = [];
        rows.forEach(function (row) {
            const nameEl = row.querySelector('.student-name');
            const tagEl = row.querySelector('.student-tag');
            const contentEl = row.querySelector('.feedback-content');
            if (!nameEl || !contentEl) return;

            var fullName = nameEl.textContent;
            var isOnline = tagEl ? tagEl.classList.contains('online') : false;
            var tagText = tagEl ? tagEl.textContent : '';
            var feedbackText = contentEl.innerText;

            var safeName = escapeHtml(fullName);
            var safeTag = escapeHtml(tagText);
            var safeFeedback = escapeHtml(feedbackText);
            var safeNameAttr = fullName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            var studentId = row.getAttribute('data-student-id') || '0';
            var score = row.getAttribute('data-score') || '0';
            var online = row.getAttribute('data-online') || '0';
            var focus = row.getAttribute('data-focus') || '-1';

            rowParts.push(
                '<tr data-student-id="' + studentId + '" data-score="' + score + '" data-online="' + online + '" data-focus="' + focus + '">' +
                '<td class="name-td"><div class="name-cell">' +
                '<div class="name-main" onclick="copyText(\'' + safeNameAttr + '\', this)">' +
                '<span class="student-name">' + safeName + '</span>' +
                '<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                '</div>' +
                '<span class="student-tag ' + (isOnline ? 'online' : 'offline') + '">' + safeTag + '</span>' +
                '</div></td>' +
                '<td class="feedback-cell">' +
                '<div class="feedback-wrapper"><div class="feedback-content" onclick="copyFeedback(this)">' + safeFeedback + '</div></div>' +
                '<div class="feedback-toolbar"><button class="toolbar-btn copy-btn" onclick="copyFeedback(this.closest(\'.feedback-cell\').querySelector(\'.feedback-content\'))" title="复制内容">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                '<span>复制</span></button></div>' +
                '</td></tr>'
            );
        });
        var tableRowsHtml = rowParts.join('\n');

        // 4. Inline JS for snapshot (plain string, no template literals)
        var snapshotJS = [
            'function toggleTheme(cb){document.documentElement.setAttribute("data-theme",cb.checked?"light":"dark");}',
            'function showToast(m){var t=document.getElementById("toast");if(!t)return;t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show");},2000);}',
            'function copyText(text){if(navigator.clipboard && window.isSecureContext){navigator.clipboard.writeText(text).then(function(){showToast("已复制: "+text);}).catch(function(){fallbackCopy(text);});}else{fallbackCopy(text);}}',
            'function copyFeedback(el){var text=el.innerText;var tr=el.closest("tr");if(navigator.clipboard && window.isSecureContext){navigator.clipboard.writeText(text).then(function(){afterCopy(tr);}).catch(function(){fallbackCopy(text);setTimeout(function(){afterCopy(tr);},0);});}else{fallbackCopy(text);setTimeout(function(){afterCopy(tr);},0);}}',
            'function afterCopy(tr){if(!tr)return;var ne=tr.querySelector(".student-name");showToast("已复制\\"" + (ne?ne.textContent:"") + "\\"的评语");tr.classList.add("copied-row");setTimeout(function(){focusNextRow(tr);},80);}',
            'function focusNextRow(currentTr){var tbody=document.getElementById("result-tbody");if(!tbody)return;var rows=Array.from(tbody.querySelectorAll("tr"));var ci=rows.indexOf(currentTr);for(var i=ci+1;i<rows.length;i++){var r=rows[i];if(r.style.display!=="none"&&!r.classList.contains("copied-row")){r.scrollIntoView({behavior:"smooth",block:"center"});r.classList.add("highlight-row");setTimeout(function(){r.classList.remove("highlight-row");},2000);return;}}showToast("全部复制完成！");}',
            'function fallbackCopy(text){var ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;left:-9999px;";document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);showToast("已复制");}',
            'function applySorting(){var tbody=document.getElementById("result-tbody");if(!tbody)return;var sv=(document.getElementById("sort-field")||{value:"id-asc"}).value;var rows=Array.from(tbody.querySelectorAll("tr"));rows.sort(function(a,b){switch(sv){case"id-asc":return parseInt(a.dataset.studentId||0)-parseInt(b.dataset.studentId||0);case"id-desc":return parseInt(b.dataset.studentId||0)-parseInt(a.dataset.studentId||0);case"score-desc":return parseFloat(b.dataset.score||0)-parseFloat(a.dataset.score||0);case"score-asc":return parseFloat(a.dataset.score||0)-parseFloat(b.dataset.score||0);default:return 0;}});rows.forEach(function(r){tbody.appendChild(r);});applyFiltering();}',
            'function applyFiltering(){var si=document.getElementById("search-input");if(!si)return;var term=si.value.toLowerCase().trim();var tbody=document.getElementById("result-tbody");if(!tbody)return;var rows=tbody.querySelectorAll("tr");var vc=0;rows.forEach(function(row){var ne=row.querySelector(".student-name");var name=ne?ne.textContent.toLowerCase():"";var match=name.indexOf(term)>=0;row.style.display=match?"":"none";if(match)vc++;});var cb=document.getElementById("result-count");if(cb)cb.textContent=term?("筛选: "+vc+" / "+rows.length+" 人"):("共 "+rows.length+" 位同学");}',
            'document.addEventListener("click",function(e){var tr=e.target.closest("tr");if(tr&&tr.classList.contains("copied-row"))tr.classList.remove("copied-row");});',
            'requestAnimationFrame(function(){document.body.classList.add("page-ready");});'
        ].join('\n');

        // 5. Assemble the HTML in safe parts
        var html = [];
        html.push('<!DOCTYPE html>');
        html.push('<html lang="zh-CN" data-theme="' + currentTheme + '">');
        html.push('<head>');
        html.push('<meta charset="UTF-8">');
        html.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
        html.push('<title>' + escapeHtml(brandTitle) + ' - 快照 ' + ds + '</title>');
        html.push('<meta name="description" content="反馈快照 - 生成于 ' + ds + ' ' + ts + '">');
        html.push('<style>' + safeCSSForStyle(allCSS) + '</style>');
        html.push('<style>');
        html.push('.snapshot-banner{display:flex;align-items:center;gap:8px;padding:6px 16px;background:rgba(var(--warning-rgb),0.1);border:1px solid rgba(var(--warning-rgb),0.2);border-radius:10px;font-size:0.72rem;color:var(--text-secondary);margin-left:auto;}');
        html.push('.snapshot-banner svg{width:14px;height:14px;color:var(--warning);flex-shrink:0;}');
        html.push('.snapshot-banner strong{color:var(--text-primary);}');
        html.push('.feedback-editor,.editor-actions,.edit-toolbar-btn{display:none!important;}');
        html.push('</style>');
        html.push('</head>');
        html.push('<body class="viewer-page">');
        html.push('<div class="viewer-shell">');

        // --- Toolbar ---
        html.push('<nav class="viewer-toolbar">');
        html.push('<div class="toolbar-left">');
        html.push('<div class="nav-brand">');
        html.push('<div class="brand-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg></div>');
        html.push('<div class="brand-text"><h1>' + escapeHtml(brandTitle) + '</h1></div>');
        html.push('</div></div>');
        html.push('<div class="toolbar-right">');
        html.push('<div class="toolbar-actions">');
        html.push('<div class="snapshot-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>离线快照 · <strong>' + ds + ' ' + ts + '</strong></span></div>');
        html.push('</div>');
        html.push('<div class="toolbar-divider"></div>');
        html.push('<label class="theme-slider-switch" title="切换主题">');
        html.push('<input type="checkbox" id="theme-toggle-input" onchange="toggleTheme(this)"' + checkedAttr + '>');
        html.push('<span class="theme-slider-track"><span class="theme-slider-thumb">');
        html.push('<svg class="thumb-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>');
        html.push('<svg class="thumb-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>');
        html.push('</span></span></label>');
        html.push('</div>');
        html.push('</nav>');

        // --- Content ---
        html.push('<div class="viewer-content">');
        html.push('<div class="result-section" id="result-section" style="display:flex;">');
        html.push('<div class="result-header">');
        html.push('<div class="result-header-left"><span class="result-count-badge" id="result-count">共 ' + rows.length + ' 位同学</span></div>');
        html.push('<div class="header-controls">');
        html.push('<div class="ui-search">');
        html.push('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>');
        html.push('<input type="text" id="search-input" placeholder="搜索姓名..." oninput="applyFiltering()">');
        html.push('</div>');
        html.push('<div class="sort-controls">');
        html.push('<svg class="sort-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="8" y2="18"></line></svg>');
        html.push('<select id="sort-field" class="sort-select" onchange="applySorting()">');
        html.push('<option value="id-asc">学号 ↑</option><option value="id-desc">学号 ↓</option><option value="score-desc">分数 ↓</option><option value="score-asc">分数 ↑</option>');
        html.push('</select></div></div></div>');

        // --- Table ---
        html.push('<div class="result-body" id="result-body"><div class="table-container"><table class="result-table" id="result-table"><tbody id="result-tbody">');
        html.push(tableRowsHtml);
        html.push('</tbody></table></div></div></div></div></div>');

        // --- Toast ---
        html.push('<div class="toast" id="toast"></div>');

        // --- Script ---
        html.push('<script>' + safeJSForScript(snapshotJS) + '<' + '/script>');

        // --- Embedded Structured Feedback Data (供批量发送工具秒级高保真读取) ---
        const snapshotStructuredData = [];
        rows.forEach(function (row) {
            const nameEl = row.querySelector('.student-name');
            const contentEl = row.querySelector('.feedback-content');
            if (nameEl && contentEl) {
                snapshotStructuredData.push({
                    studentName: nameEl.textContent.trim(),
                    message: contentEl.innerText
                });
            }
        });
        if (snapshotStructuredData.length > 0) {
            html.push('<script type="application/json" id="feedback-data">' + safeJSForScript(JSON.stringify(snapshotStructuredData)) + '<' + '/script>');
        }

        html.push('</body></html>');

        var snapshotHtml = html.join('\n');

        // 6. Download
        var blob = new Blob([snapshotHtml], { type: 'text/html;charset=utf-8' });
        const saved = await saveFileWithDialog(blob, snapshotFileName, 'HTML Snapshot', 'html', 'text/html');

        if (saved) {
            Logger.action('snapshot_saved', { students: rows.length, theme: currentTheme, fileName: snapshotFileName });
            showToast('快照已保存 (' + rows.length + '条数据)');
        }
    } catch (error) {
        console.error('快照生成失败:', error);
        Logger.error('snapshot_error', { error: error?.message || String(error) });
        showToast('快照生成失败: ' + (error?.message || '未知错误'));
    }
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 将任意字符串转义为可安全嵌入单引号 JS 字符串字面量的形式（用于 onclick="fn('...')" 参数）
function escapeJsString(text) {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/</g, '\\x3c');
}

// Expose to window
window.copyText = copyText;
window.copyToNext = copyToNext;
window.toggleStudentOnlineStatus = toggleStudentOnlineStatus;
window.toggleEdit = toggleEdit;
window.saveEdit = saveEdit;
window.cancelEdit = cancelEdit;
window.applySorting = applySorting;
window.applyFiltering = applyFiltering;
window.showGlobalAppendDialog = showGlobalAppendDialog;
window.showSplitPlusDialog = showSplitPlusDialog;
window.applyFeedbackViewMode = applyFeedbackViewMode;

window.addZeroScoreReminder = addZeroScoreReminder;
window.openReminderModal = openReminderModal;
window.closeReminderModal = closeReminderModal;
window.toggleReminderNamesList = toggleReminderNamesList;
window.applyReminderTemplate = applyReminderTemplate;
window.updateReminderCharCount = updateReminderCharCount;
window.saveReminderModal = saveReminderModal;
window.clearCurrentReminder = clearCurrentReminder;
window.exportRankImage = exportRankImage;
window.exportPlusStats = exportPlusStats;
window.exportPlusPieImage = exportPlusStats;
window.showExportDialog = showExportDialog;
window.executeExport = executeExport;
window.saveSnapshot = saveSnapshot;
window.clearFocusMode = clearFocusMode;
window.doGenerateFeedback = doGenerateFeedback;
window.showExcludedStudents = function() {
    const listEl = document.getElementById('excluded-students-list');
    const modal = document.getElementById('excluded-modal');
    if (!listEl || !modal) return;
    
    const exclusionListText = sessionPayload?.exclusionList || '';
    const exclusionSet = new Set(
        exclusionListText.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
    );
    
    // Collect all submitted students across homework, preview, note
    const submittedNames = new Set();
    if (typeof homeworkData !== 'undefined' && homeworkData && homeworkData.length > 1) {
        const hwHeader = homeworkData[0];
        const nameIdx = hwHeader.findIndex(h => h.includes('姓名'));
        if (nameIdx >= 0) {
            homeworkData.slice(1).forEach(r => {
                if (r[nameIdx]) submittedNames.add(String(r[nameIdx]).trim());
            });
        }
    }
    if (typeof previewData !== 'undefined' && previewData && previewData.length > 1) {
        const isWenjuanxing = typeof getPhysicsPreviewSource === 'function' ? getPhysicsPreviewSource() === 'wenjuanxing' : false;
        const pvHeader = previewData[0].map(h => String(h).trim());
        const pvNameIdx = isWenjuanxing ? pvHeader.findIndex(h => h.includes('您的姓名')) : pvHeader.findIndex(h => h.includes('姓名'));
        if (pvNameIdx >= 0) {
            previewData.slice(1).forEach(r => {
                if (r[pvNameIdx]) submittedNames.add(String(r[pvNameIdx]).trim());
            });
        }
    }
    if (typeof noteData !== 'undefined' && noteData && noteData.length > 1) {
        const ntHeader = noteData[0];
        const nameIdx = ntHeader.findIndex(h => h.includes('姓名'));
        if (nameIdx >= 0) {
            noteData.slice(1).forEach(r => {
                if (r[nameIdx]) submittedNames.add(String(r[nameIdx]).trim());
            });
        }
    }
    if (typeof classTestData !== 'undefined' && classTestData && classTestData.length > 1) {
        const ctHeader = classTestData[0];
        const nameIdx = ctHeader.findIndex(h => h.includes('姓名'));
        if (nameIdx >= 0) {
            classTestData.slice(1).forEach(r => {
                if (r[nameIdx]) submittedNames.add(String(r[nameIdx]).trim());
            });
        }
    }

    const checkPresent = (tag) => {
        if (submittedNames.has(tag)) return true;
        const match = tag.match(/\d+(.+)/);
        const namePart = match ? match[1] : tag;
        return submittedNames.has(namePart);
    };

    const presentList = [];
    const absentList = [];
    
    Array.from(exclusionSet).forEach(tag => {
        if (checkPresent(tag)) {
            presentList.push(tag);
        } else {
            absentList.push(tag);
        }
    });

    listEl.innerHTML = '';
    if (exclusionSet.size === 0) {
        listEl.innerHTML = '<div style="padding: 10px; color: var(--text-tertiary); text-align: center;">暂无排除学生</div>';
    } else {
        if (presentList.length > 0) {
            const h4 = document.createElement('div');
            h4.textContent = '● 属于本次作业：';
            h4.style.cssText = 'font-weight: 600; font-size: 0.85rem; color: var(--success); margin: 6px 0; border-bottom: 1px solid var(--border-light); padding-bottom: 4px;';
            listEl.appendChild(h4);
            
            const pUl = document.createElement('div');
            pUl.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;';
            presentList.forEach(name => {
                const li = document.createElement('div');
                li.style.cssText = 'padding: 4px 10px; background: rgba(48,209,88,0.1); border: 1px solid rgba(48,209,88,0.2); border-radius: 6px; font-size: 0.85rem; color: var(--success);';
                li.textContent = name;
                pUl.appendChild(li);
            });
            listEl.appendChild(pUl);
        }
        
        if (absentList.length > 0) {
            const h4 = document.createElement('div');
            h4.textContent = '○ 不属于本次作业：';
            h4.style.cssText = 'font-weight: 600; font-size: 0.85rem; color: var(--text-tertiary); margin: 6px 0; border-bottom: 1px solid var(--border-light); padding-bottom: 4px;';
            listEl.appendChild(h4);
            
            const aUl = document.createElement('div');
            aUl.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;';
            absentList.forEach(name => {
                const li = document.createElement('div');
                li.style.cssText = 'padding: 4px 10px; background: var(--ui-fill-weak); border: 1px solid var(--border-light); border-radius: 6px; font-size: 0.85rem; color: var(--text-secondary);';
                li.textContent = name;
                aUl.appendChild(li);
            });
            listEl.appendChild(aUl);
        }
    }
    
    modal.style.display = 'flex';
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const excludedModal = document.getElementById('excluded-modal');
        if (excludedModal && excludedModal.style.display !== 'none') {
            excludedModal.style.display = 'none';
        }
    }
});
