// ========== Spring/Autumn & Winter/Summer Semester Upload Logic ==========
function openNativeDialog(idOrEl, opts) {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!el) return null;
    if (window.DialogHelper) {
        return window.DialogHelper.open(el, opts);
    }
    el.style.display = 'flex';
    return el;
}

function closeNativeDialog(idOrEl) {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (!el) return;
    if (window.DialogHelper) {
        window.DialogHelper.close(el);
    } else {
        el.style.display = 'none';
    }
}

window.defaultSeason = 'autumn';
function isVacationSeason(season) {
    return season === 0 || season === 'summer' || season === 'winter' || season === '暑' || season === '寒';
}
function getUploadHomeworkLabel() {
    return isVacationSeason(window.defaultSeason) ? '' : '课后巩固';
}
function getUploadHomeworkLabelFull() {
    const label = getUploadHomeworkLabel();
    return label ? label + '作业' : '作业';
}
function getUploadLessonUnit() {
    return isVacationSeason(window.defaultSeason) ? '次' : '周';
}
fetch('api/public_config.php').then(r=>r.json()).then(c=>{
    if(c.defaultSeason !== undefined) window.defaultSeason = c.defaultSeason;
    if(c.semesterYear !== undefined) window.semesterYear = c.semesterYear;
    if(c.forceIntegerScores !== undefined) window.forceIntegerScores = !!c.forceIntegerScores;
    const isVacation = isVacationSeason(window.defaultSeason);
    if(isVacation) {
        // Hide preview-related cards (winter/summer has no preview homework)
        const e1 = document.getElementById('preview-card'); if(e1) e1.style.display='none';
        const e2 = document.getElementById('preview-total-config'); if(e2) e2.style.display='none';
        const e3 = document.getElementById('preview-source-file-btn'); if(e3){ const c1=e3.closest('.config-card'); if(c1) c1.style.display='none'; }
        // Also hide the preview comment source config card
        const pvCommentCard = document.getElementById('preview-source-manual-btn');
        if(pvCommentCard){ const c2=pvCommentCard.closest('.config-card'); if(c2) c2.style.display='none'; }
        // Update text labels for winter/summer mode
        document.querySelectorAll('label, span, h3, p, .drop-secondary, .step-label').forEach(el=>{
            el.childNodes.forEach(node=>{
                if(node.nodeType===3){
                    node.textContent = node.textContent.replace(/周次/g, '次').replace(/课后巩固/g, '课后作业');
                }
            });
        });
    }
    const seasonNameMap = {
        'spring': '春季', 'summer': '暑假', 'autumn': '秋季', 'winter': '寒假',
        '春': '春季', '暑': '暑假', '秋': '秋季', '寒': '寒假',
        1: '春秋季', 0: '寒暑季'
    };
    const sName = seasonNameMap[window.defaultSeason] || (isVacation ? '寒暑季' : '春秋季');
    const yrStr = window.semesterYear ? `${window.semesterYear}年` : '';
    document.title = `反馈生成器 - ${yrStr}${sName} - 上传`;
});

let homeworkData = null;
let rawHomeworkFiles = [];
let previewData = null;
let rawPreviewFiles = [];
let noteData = null;
let rawNoteFiles = [];
let classTestData = null;
let rawClassTestFiles = [];
let reportData = null;
let rosterData = null;
let rosterFileName = '';
let detectedDroppedStudents = { preview: [], homework: [] };
let droppedStudentsAcknowledged = false;
let detectedClassName = '';
// 名单班级多选：解析后的名单行、班级统计、用户所选的反馈班级
let rosterParsedRows = [];
let rosterClassStats = [];
let selectedFeedbackClasses = [];
let classSelectionTouched = false;
let pendingNavigationStep = null;
let homeworkFileName = '';
let previewFileName = '';
let noteFileName = '';
let classTestFileName = '';
let reportFileName = '';
let previewCommentSource = 'file';
let homeworkCommentSource = 'file';
let focusCommentSource = 'default';
let focusMaxScore = 6;
let originalFocusMaxScore = 0;
let focusScoreOffset = 0;
let activeReaders = [];
let uploadCancelled = false;
let currentStep = 1;

const homeworkFileInput = document.getElementById('homework-file');
const previewFileInput = document.getElementById('preview-file');
const noteFileInput = document.getElementById('note-file');
const classTestFileInput = document.getElementById('class-test-file');
const reportFileInput = document.getElementById('report-file');
const rosterFileInput = document.getElementById('roster-file');
const homeworkDropZone = document.getElementById('homework-drop-zone');
const previewDropZone = document.getElementById('preview-drop-zone');
const noteDropZone = document.getElementById('note-drop-zone');
const classTestDropZone = document.getElementById('class-test-drop-zone');
const reportDropZone = document.getElementById('report-drop-zone');
const rosterDropZone = document.getElementById('roster-drop-zone');
const homeworkInfo = document.getElementById('homework-info');
const previewInfo = document.getElementById('preview-info');
const noteInfo = document.getElementById('note-info');
const classTestInfo = document.getElementById('class-test-info');
const reportInfo = document.getElementById('report-info');
const rosterInfo = document.getElementById('roster-info');
const generateBtn = document.getElementById('generate-btn');
const nextStep1Btn = document.getElementById('next-step-1');

const commentSummaryInput = document.getElementById('comment-summary');
const previewCommentFullInput = document.getElementById('preview-comment-full');
const previewCommentTop20Input = document.getElementById('preview-comment-top20');
const previewCommentAboveAvgInput = document.getElementById('preview-comment-above-avg');
const previewCommentBelowAvgInput = document.getElementById('preview-comment-below-avg');
const previewCommentZeroInput = document.getElementById('preview-comment-zero');
const homeworkCommentFullInput = document.getElementById('homework-comment-full');
const homeworkCommentTop20Input = document.getElementById('homework-comment-top20');
const homeworkCommentAboveAvgInput = document.getElementById('homework-comment-above-avg');
const homeworkCommentBelowAvgInput = document.getElementById('homework-comment-below-avg');
const homeworkCommentZeroInput = document.getElementById('homework-comment-zero');
let selectedSubject = null;
let physicsPreviewSource = null;

function initUploadSemester() {
    setupFileInputs();
    setupDragAndDrop();
    setupHotkeys();
    setupOptionCards();
    onPreviewMetricModeChange();
    switchPreviewCommentSource('file');
    switchHomeworkCommentSource('file');
    switchFocusCommentSource('default');
    generateFocusCommentFields(6);
    updateUploadCardsState(); // Disable upload cards until subject is selected
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUploadSemester);
} else {
    initUploadSemester();
}

// ========== Step Navigation ==========
// 步骤指示条仅作状态展示，已禁用点击跳转；后退请使用底部「返回上传」或导航栏「重新上传」
function handleUploadStepClick(n) {
    // 已禁用点击跳转
    return;
}
window.handleUploadStepClick = handleUploadStepClick;

function confirmReupload() {
    window.location.href = 'upload.html';
}
window.confirmReupload = confirmReupload;

function goToStep(step) {
    if (step === 2) {
        if (!selectedSubject) {
            showToast('请先选择学科', 'warning');
            return;
        }
        if (!hasPrimaryHomeworkData()) return;
        
        // 关键拦截校验：检查是否有交了但老师没改的作业（状态为【已提交】）
        if (typeof checkUngradedSubmissions === 'function') {
            const ungradedList = checkUngradedSubmissions();
            if (ungradedList && ungradedList.length > 0) {
                showUngradedSubmissionsModal(ungradedList);
                return;
            }
        }
        
        // 重复提交拦截：同一姓名出现多行时需老师二选一（放退课确认之前，避免名单里出现重复项干扰）
        if (typeof collectDuplicateGroups === 'function') {
            const dupGroups = collectDuplicateGroups();
            if (dupGroups && dupGroups.length > 0) {
                pendingNavigationStep = step;
                showDuplicateStudentsModal(dupGroups);
                return;
            }
        }

        if (rosterData && !droppedStudentsAcknowledged && (detectedDroppedStudents.preview.length > 0 || detectedDroppedStudents.homework.length > 0)) {
            pendingNavigationStep = step;
            showDroppedStudentsModal(detectedDroppedStudents.preview, detectedDroppedStudents.homework, getScopeLabel());
            return;
        }
    }
    currentStep = step;

    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`step-${step}`);
    if (target) {
        target.classList.remove('active');
        void target.offsetWidth;
        target.classList.add('active');
    }

    document.querySelectorAll('.step-item').forEach((item, i) => {
        const itemStep = i + 1;
        item.classList.remove('active', 'completed');
        if (itemStep === step) {
            item.classList.add('active');
        } else if (itemStep < step) {
            item.classList.add('completed');
        }
    });

    document.querySelectorAll('.step-line').forEach((line, i) => {
        line.classList.toggle('active', i < step - 1);
    });

    // 控制导航栏「重新上传」按钮显隐（在步骤2配置页面显示，与生成页面体验一致）
    const reuploadBtn = document.getElementById('reupload-btn');
    if (reuploadBtn) {
        reuploadBtn.style.display = (step === 2) ? 'inline-flex' : 'none';
    }

    // Show/hide preview config card based on whether preview data exists
    if (step === 2) {
        const isWenjuanxing = physicsPreviewSource === 'wenjuanxing';
        const pvConfig = document.getElementById('preview-total-config');
        if (pvConfig) {
            // Hide preview metric settings for wenjuanxing (always uses score+rank)
            pvConfig.style.display = (previewData && !isWenjuanxing) ? '' : 'none';
        }
        // Handle preview comment source config for wenjuanxing
        const pvFileBtn = document.getElementById('preview-source-file-btn');
        const pvMergeBtn = document.getElementById('preview-source-merge-btn');
        if (isWenjuanxing && previewData) {
            // Hide "爱问云评语" and "爱问云评语 + 固定模板" buttons, force "固定模板"
            if (pvFileBtn) pvFileBtn.style.display = 'none';
            if (pvMergeBtn) pvMergeBtn.style.display = 'none';
            previewCommentSource = 'manual';
            switchPreviewCommentSource('manual');
        } else {
            // Show all source buttons
            if (pvFileBtn) pvFileBtn.style.display = '';
            if (pvMergeBtn) pvMergeBtn.style.display = '';
        }
        updatePreviewCommentFieldsRequiredState();
    }
}

// ========== Preview Comment Field Required/Optional State ==========
function updatePreviewCommentFieldsRequiredState() {
    const isWenjuanxing = physicsPreviewSource === 'wenjuanxing';
    const tipEl = document.getElementById('preview-wjx-comment-tip');
    if (tipEl) {
        tipEl.style.display = isWenjuanxing ? 'flex' : 'none';
    }
    const fields = [
        { id: 'preview-comment-full', name: '满分评语' },
        { id: 'preview-comment-top20', name: '前20%' },
        { id: 'preview-comment-above-avg', name: '平均分以上' },
        { id: 'preview-comment-below-avg', name: '平均分以下' },
        { id: 'preview-comment-zero', name: '零分' }
    ];
    fields.forEach(f => {
        const input = document.getElementById(f.id);
        if (!input) return;
        const fieldEl = input.closest('.comment-field');
        const labelEl = fieldEl ? fieldEl.querySelector('label') : null;
        if (labelEl) {
            if (isWenjuanxing) {
                labelEl.innerHTML = `${f.name} <span class="comment-optional-tag" style="color: var(--text-tertiary); font-weight: normal; font-size: 0.82rem;">（选填）</span>`;
            } else {
                labelEl.innerHTML = `${f.name} <span style="color:red">*</span>`;
            }
        }
        if (isWenjuanxing) {
            input.placeholder = `（选填）输入${f.name}学生的评语模板，未填则不附加分段评语...`;
        } else {
            input.placeholder = `输入${f.name}学生的评语模板...`;
        }
    });
}

window.goToStep = goToStep;

// ========== Option Cards ==========
function setupOptionCards() {
    const cards = document.querySelectorAll('.option-card');
    cards.forEach(card => {
        card.addEventListener('click', () => {
            // Check if this card is disabled
            if (card.getAttribute('data-disabled') === 'true') {
                showToast('预习作业不是评分制');
                return;
            }
            
            const radio = card.querySelector('input[type="radio"]');
            if (!radio) return;
            const name = radio.name;
            document.querySelectorAll(`.option-card input[name="${name}"]`).forEach(r => {
                r.closest('.option-card').classList.remove('selected');
            });
            radio.checked = true;
            card.classList.add('selected');
            if (name === 'preview-metric-mode') {
                onPreviewMetricModeChange();
            }
        });
    });
}

function onPreviewMetricModeChange() {
    const mode = document.querySelector('input[name="preview-metric-mode"]:checked')?.value || 'score_rank';
    const wrap = document.getElementById('preview-total-input-wrap');
    const totalInput = document.getElementById('preview-total-questions');
    if (!wrap) return;
    const isCorrectCountMode = mode === 'correct_count';
    wrap.style.display = isCorrectCountMode ? 'flex' : 'none';
    if (totalInput) totalInput.required = isCorrectCountMode;
}

function checkPreviewScoreColumn(header, rows) {
    const scoreIdx = header.findIndex(h => h.includes('得分'));
    
    if (scoreIdx < 0) {
        // No score column found, disable score-based options
        resetPreviewMetricModeOptions(true);
        showToast('未检测到"得分"列，已禁用分数相关选项');
        return;
    }
    
    // Check if all score values are empty
    let allEmpty = true;
    let hasValue = false;
    
    for (const row of rows) {
        const scoreValue = row[scoreIdx];
        if (scoreValue !== undefined && scoreValue !== null && scoreValue !== '' && scoreValue !== '-') {
            const numValue = parseFloat(scoreValue);
            if (!isNaN(numValue)) {
                hasValue = true;
                allEmpty = false;
                break;
            }
        }
    }
    
    if (allEmpty && !hasValue) {
        // All scores are empty, disable score-based options
        resetPreviewMetricModeOptions(true);
        showToast('检测到"得分"列全为空，已禁用分数相关选项');
    } else {
        // Has valid scores, enable all options
        resetPreviewMetricModeOptions(false);
    }
}

function resetPreviewMetricModeOptions(disableScoreOptions) {
    const scoreRankRadio = document.querySelector('input[name="preview-metric-mode"][value="score_rank"]');
    const scoreOnlyRadio = document.querySelector('input[name="preview-metric-mode"][value="score_only"]');
    const accuracyRadio = document.querySelector('input[name="preview-metric-mode"][value="accuracy"]');
    const correctCountRadio = document.querySelector('input[name="preview-metric-mode"][value="correct_count"]');
    
    if (!scoreRankRadio || !scoreOnlyRadio || !accuracyRadio || !correctCountRadio) return;
    
    const scoreRankCard = scoreRankRadio.closest('.option-card');
    const scoreOnlyCard = scoreOnlyRadio.closest('.option-card');
    const accuracyCard = accuracyRadio.closest('.option-card');
    
    if (disableScoreOptions) {
        // First, check if we need to switch away from disabled options
        const currentMode = document.querySelector('input[name="preview-metric-mode"]:checked')?.value;
        if (currentMode === 'score_rank' || currentMode === 'score_only' || !currentMode) {
            // Switch to accuracy before disabling
            accuracyRadio.checked = true;
            if (accuracyCard) accuracyCard.classList.add('selected');
            if (scoreRankCard) scoreRankCard.classList.remove('selected');
            if (scoreOnlyCard) scoreOnlyCard.classList.remove('selected');
            onPreviewMetricModeChange();
        }
        
        // Then disable score_rank and score_only options
        scoreRankRadio.disabled = true;
        scoreOnlyRadio.disabled = true;
        if (scoreRankCard) {
            scoreRankCard.style.opacity = '0.5';
            scoreRankCard.style.cursor = 'not-allowed';
            scoreRankCard.title = '预习作业得分列为空，无法使用分数相关选项';
            scoreRankCard.setAttribute('data-disabled', 'true');
        }
        if (scoreOnlyCard) {
            scoreOnlyCard.style.opacity = '0.5';
            scoreOnlyCard.style.cursor = 'not-allowed';
            scoreOnlyCard.title = '预习作业得分列为空，无法使用分数相关选项';
            scoreOnlyCard.setAttribute('data-disabled', 'true');
        }
    } else {
        // Enable all options
        scoreRankRadio.disabled = false;
        scoreOnlyRadio.disabled = false;
        if (scoreRankCard) {
            scoreRankCard.style.opacity = '';
            scoreRankCard.style.cursor = '';
            scoreRankCard.title = '';
            scoreRankCard.removeAttribute('data-disabled');
        }
        if (scoreOnlyCard) {
            scoreOnlyCard.style.opacity = '';
            scoreOnlyCard.style.cursor = '';
            scoreOnlyCard.title = '';
            scoreOnlyCard.removeAttribute('data-disabled');
        }
    }
}

// ========== Hotkeys ==========
function setupHotkeys() {
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        const isEditing = tag === 'INPUT' || tag === 'TEXTAREA';
        if (e.key === 'Escape') {
            cancelUploads();
        }
        if (e.key === 'Delete' && !isEditing) {
            clearHomeworkFiles();
        }
    });
}

function cancelUploads() {
    if (activeReaders.length === 0) return;
    uploadCancelled = true;
    activeReaders.forEach(reader => {
        try { reader.abort(); } catch (error) { }
    });
    activeReaders = [];
    showToast('已取消当前上传');
}

// ========== Subject Guard ==========
/**
 * 检查是否已选择学科及必要的来源设置。未满足时，阻止文件上传并提示用户。
 * @returns {boolean} true = 已选学科且预习来源就绪，可以操作
 */
function requireSubject() {
    if (!selectedSubject) {
        showToast('请先选择学科', 'warning');
        // Shake the subject card to draw attention
        const subjectCard = document.querySelector('#feedback-subject-group')?.closest('.config-card');
        if (subjectCard) {
            subjectCard.classList.add('shake-highlight');
            setTimeout(() => subjectCard.classList.remove('shake-highlight'), 800);
        }
        return false;
    }
    const needsPhysicsSource = selectedSubject === '物理' && !isVacationSeason(window.defaultSeason);
    if (needsPhysicsSource && !physicsPreviewSource) {
        showToast('物理学科请先选择预习来源（爱问云或问卷星）', 'warning');
        const physicsGroup = document.getElementById('physics-preview-source');
        if (physicsGroup) {
            physicsGroup.classList.add('shake-highlight');
            setTimeout(() => physicsGroup.classList.remove('shake-highlight'), 800);
        }
        return false;
    }
    return true;
}

/**
 * 根据是否已选学科及物理预习来源，更新所有上传卡片的禁用/启用状态。
 * 物理学科若未选择爱问云或问卷星，后续所有卡片均禁止选择。
 */
function updateUploadCardsState() {
    const cardIds = ['roster-card', 'preview-card', 'homework-card', 'note-card', 'class-test-card', 'report-card'];
    const needsPhysicsSource = (selectedSubject === '物理' && !isVacationSeason(window.defaultSeason));
    const isPhysicsPending = needsPhysicsSource && !physicsPreviewSource;
    const shouldDisable = !selectedSubject || isPhysicsPending;

    cardIds.forEach(id => {
        const card = document.getElementById(id);
        if (!card) return;
        // Skip if the card is already hidden (e.g. note-card when not English)
        if (card.style.display === 'none') return;
        if (shouldDisable) {
            card.classList.add('disabled-card');
            card.style.opacity = '0.45';
            card.style.pointerEvents = 'none';
        } else {
            card.classList.remove('disabled-card');
            card.style.opacity = '';
            card.style.pointerEvents = '';
        }
    });
}

// 全局拦截：当物理未选爱问云或问卷星（或未选学科）时，点击后续区域给予明确震动提示
document.addEventListener('click', function(e) {
    if (!selectedSubject) {
        const inCard = e.target.closest?.('.upload-card, .panel-grid, #step-1 .step-nav');
        const inSubject = e.target.closest?.('#feedback-subject-group, .header, nav, .theme-toggle, .user-guide-btn');
        if (inCard && !inSubject) {
            requireSubject();
        }
        return;
    }
    const needsPhysicsSource = (selectedSubject === '物理' && !isVacationSeason(window.defaultSeason));
    if (needsPhysicsSource && !physicsPreviewSource) {
        const inUploadArea = e.target.closest?.('.upload-card, .panel-grid, #step-1 .step-nav');
        const inSubjectArea = e.target.closest?.('#feedback-subject-group, #physics-preview-source, .header, nav, .theme-toggle, .user-guide-btn');
        if (inUploadArea && !inSubjectArea) {
            requireSubject();
        }
    }
}, true);

// ========== File Inputs ==========
function setupFileInputs() {
    // 注册所有上传 input 的 click 事件，每次点击前清空 value，确保选择同名修改后的文件时依然能够 100% 触发 change 事件
    const allFileInputs = [
        homeworkFileInput,
        document.getElementById('homework-file-append'),
        previewFileInput,
        document.getElementById('preview-file-append'),
        noteFileInput,
        document.getElementById('note-file-append'),
        classTestFileInput,
        document.getElementById('class-test-file-append'),
        reportFileInput,
        rosterFileInput
    ];
    allFileInputs.forEach(input => {
        if (!input) return;
        input.addEventListener('click', function() {
            this.value = '';
        });
    });

    // Homework (consolidation) inputs
    homeworkFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleHomeworkFiles(e.target.files, false);
        }
    });
    const hwAppendInput = document.getElementById('homework-file-append');
    if (hwAppendInput) {
        hwAppendInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleHomeworkFiles(e.target.files, true);
            }
        });
    }

    // Preview inputs
    previewFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handlePreviewFiles(e.target.files, false);
        }
    });
    const pvAppendInput = document.getElementById('preview-file-append');
    if (pvAppendInput) {
        pvAppendInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handlePreviewFiles(e.target.files, true);
            }
        });
    }

    // Note inputs (English only)
    if (noteFileInput) {
        noteFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleNoteFiles(e.target.files, false);
            }
        });
    }
    const noteAppendInput = document.getElementById('note-file-append');
    if (noteAppendInput) {
        noteAppendInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleNoteFiles(e.target.files, true);
            }
        });
    }

    // Class Test inputs (English only)
    if (classTestFileInput) {
        classTestFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleClassTestFiles(e.target.files, false);
            }
        });
    }
    const classTestAppendInput = document.getElementById('class-test-file-append');
    if (classTestAppendInput) {
        classTestAppendInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleClassTestFiles(e.target.files, true);
            }
        });
    }

    // Report input
    reportFileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) {
            handleReportFile(e.target.files[0]);
        }
    });

    // Roster input
    if (rosterFileInput) {
        rosterFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) {
                handleRosterFile(e.target.files[0]);
            }
        });
    }

    // 监听浏览器后退/前进缓存（bfcache），唤醒时重置 input.value
    window.addEventListener('pageshow', () => {
        allFileInputs.forEach(input => {
            if (input) input.value = '';
        });
    });
}

// ========== Drag & Drop ==========
function setupDragAndDrop() {
    // 拖拽到卡片主区域默认执行覆盖/刷新（老师返工重新批改后的典型操作）
    // 若需要追加，可使用右上角明确的"+"按钮，或多选文件一次性拖入
    const homeworkDropHandler = (files) => {
        handleHomeworkFiles(files, false);
    };
    const previewDropHandler = (files) => {
        handlePreviewFiles(files, false);
    };
    const noteDropHandler = (files) => {
        handleNoteFiles(files, false);
    };
    const classTestDropHandler = (files) => {
        handleClassTestFiles(files, false);
    };
    setupDropZone(homeworkDropZone, homeworkFileInput, homeworkDropHandler, true);
    setupDropZone(previewDropZone, previewFileInput, previewDropHandler, true);
    if (noteDropZone) {
        setupDropZone(noteDropZone, noteFileInput, noteDropHandler, true);
    }
    if (classTestDropZone) {
        setupDropZone(classTestDropZone, classTestFileInput, classTestDropHandler, true);
    }
    setupDropZone(reportDropZone, reportFileInput, handleReportFile, false);
    if (rosterDropZone) {
        setupDropZone(rosterDropZone, rosterFileInput, handleRosterFile, false);
    }
}

// ========== 辅助文件抓取上传 ==========
// 纯诊断旁路：失败绝不影响主上传流程，但必须留痕。
// 历史教训：此处曾是空 catch(e){}，把 Logger.getClientInfo 未导出导致的
// TypeError 完全吞掉，使 api/upload_capture.php 长期静默收不到任何数据。
function captureUploadedFile(file, type) {
    if (!window.Logger) return;
    try {
        const fp = Logger.getClientInfo().fingerprint || 'unknown';
        const formData = new FormData();
        formData.append('file', file);
        formData.append('fingerprint', fp);
        formData.append('type', type);
        fetch('api/upload_capture.php', {
            method: 'POST',
            body: formData
        }).catch((e) => console.warn('[capture] 诊断抓取上传失败:', e));
    } catch (e) {
        console.warn('[capture] 诊断抓取跳过:', e);
    }
}

// ========== Homework (Consolidation) File Handling ==========
async function handleHomeworkFiles(files, isAppend = false) {
    if (!requireSubject()) return;
    const fileArray = Array.from(files);
    for (const file of fileArray) {
        if (!file.name.endsWith('.csv')) {
            showToast('请上传CSV文件');
            return;
        }
    }
    uploadCancelled = false;
    if (!isAppend) {
        rawHomeworkFiles = [];
    }
    const totalFiles = fileArray.length;
    let completedFiles = 0;
    for (const file of fileArray) {
        if (uploadCancelled) break;
        try {
            const text = await readFileAsTextWithProgress(
                file,
                (loaded, total) => { },
                (reader) => activeReaders.push(reader)
            );
            const data = parseCSV(text);
            if (data.length > 0) {
                const existingIdx = rawHomeworkFiles.findIndex(f => f.name === file.name);
                if (existingIdx >= 0) {
                    rawHomeworkFiles[existingIdx] = { name: file.name, data, text };
                } else {
                    rawHomeworkFiles.push({ name: file.name, data, text });
                }
                captureUploadedFile(file, 'homework');
                Logger.action('file_uploaded', { type: 'homework', fileName: file.name, rows: data.length - 1, fileSize: file.size, isAppend });
            }
        } catch (error) {
            if (error?.message === 'aborted') return;
            Logger.error('file_parse_error', { type: 'homework', fileName: file.name, error: error?.message || String(error) });
            showToast(`文件 ${file.name} 读取失败`);
        } finally {
            completedFiles += 1;
        }
    }
    activeReaders = [];
    homeworkFileInput.value = '';
    const appendInput = document.getElementById('homework-file-append');
    if (appendInput) appendInput.value = '';
    updateHomeworkData();
    if (isAppend && fileArray.length > 0) {
        showToast(`已追加 ${fileArray.length} 个${getUploadHomeworkLabelFull()}文件`);
    }
}

function updateHomeworkData() {
    const container = document.getElementById('file-list-container');

    if (rawHomeworkFiles.length === 0) {
        homeworkData = null;
        homeworkFileName = '';
        homeworkDropZone.classList.remove('uploaded');
        homeworkInfo.textContent = '拖拽巩固作业文件或点击浏览';
        if (container) container.classList.remove('visible');
        checkNextButton();
        renderHomeworkFileList();
        return;
    }
    const header = rawHomeworkFiles[0].data[0];
    let allRows = [];
    rawHomeworkFiles.forEach(file => {
        if (file.data.length > 1) {
            allRows.push(...file.data.slice(1));
        }
    });
    homeworkData = [header, ...allRows];
    homeworkFileName = rawHomeworkFiles[0].name;
    homeworkDropZone.classList.add('uploaded');

    const infoText = rawHomeworkFiles.length > 1
        ? `已加载 ${rawHomeworkFiles.length} 个文件 (${allRows.length}条数据)`
        : `已加载 (${allRows.length}条数据)`;
    homeworkInfo.textContent = infoText;

    if (container) container.classList.add('visible');

    const fileCount = document.getElementById('file-count');
    if (fileCount) {
        fileCount.textContent = `${rawHomeworkFiles.length} 个文件`;
    }

    renderHomeworkFileList();
    checkNextButton();
    
    // For wenjuanxing, check name matches when homework data is updated
    if (physicsPreviewSource === 'wenjuanxing' && previewData) {
        checkWenjuanxingNameMatches();
    }
    // Re-check dropped students if roster is loaded
    if (rosterData) {
        checkDroppedStudents();
    }
}

function renderHomeworkFileList() {
    const list = document.getElementById('homework-file-list');
    if (!list) return;
    if (rawHomeworkFiles.length === 0) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = '';
    rawHomeworkFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const count = file.data.length > 1 ? file.data.length - 1 : 0;
        item.innerHTML = `
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span class="file-name" title="${file.name}">${file.name} <span style="color:var(--text-tertiary)">(${count}条)</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('homework', ${index}, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                <div class="file-remove" onclick="removeHomeworkFile(${index})" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

function removeHomeworkFile(index) {
    if (index >= 0 && index < rawHomeworkFiles.length) {
        const name = rawHomeworkFiles[index].name;
        rawHomeworkFiles.splice(index, 1);
        updateHomeworkData();
        showToast(`已移除文件: ${name}`);
    }
}

function clearHomeworkFiles() {
    if (rawHomeworkFiles.length === 0) return;
    showCustomDialog({
        title: `清空${getUploadHomeworkLabelFull()}文件`,
        body: `确定要清空所有已上传的${getUploadHomeworkLabelFull()}文件吗？`,
        confirmText: '清空',
        danger: true,
        onConfirm: () => {
            rawHomeworkFiles = [];
            updateHomeworkData();
            showToast(`已清空${getUploadHomeworkLabelFull()}文件`);
        }
    });
}

// ========== Preview File Handling ==========
async function handlePreviewFiles(files, isAppend = false) {
    if (!requireSubject()) return;
    const fileArray = Array.from(files);
    const isWenjuanxing = physicsPreviewSource === 'wenjuanxing';
    for (const file of fileArray) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (isWenjuanxing) {
            if (ext !== 'xlsx' && ext !== 'xls') {
                showToast('问卷星请上传 XLSX 文件');
                return;
            }
        } else {
            // For aiwenyun or default: accept CSV
            if (ext !== 'csv') {
                showToast('请上传 CSV 文件');
                return;
            }
        }
    }
    uploadCancelled = false;
    if (!isAppend) {
        rawPreviewFiles = [];
    }
    for (const file of fileArray) {
        if (uploadCancelled) break;
        try {
            if (isWenjuanxing) {
                if (typeof XLSX === 'undefined') {
                    throw new Error('Excel 解析引擎 (SheetJS) 未就绪，请刷新页面后重试');
                }
                // Parse XLSX using SheetJS
                const arrayBuffer = await readFileAsArrayBuffer(file);
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                const rawJsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                if (rawJsonData.length > 0) {
                    // 数据源瘦身：问卷星表格保留必要列（序号、姓名、总分及各题目作答列），剔除无用的提交时间、IP、来源等臃肿列。
                    const header = rawJsonData[0].map(h => String(h).trim());
                    const nameIdx = header.findIndex(h => h.includes('您的姓名') || (h.includes('姓名') && !h.includes('时间')));
                    const scoreIdx = header.findIndex(h => h === '总分' || h.includes('总分'));
                    let jsonData = rawJsonData;
                    if (nameIdx >= 0 && scoreIdx >= 0) {
                        const qCols = typeof extractWenjuanxingQuestionColumns === 'function'
                            ? extractWenjuanxingQuestionColumns(header)
                            : [];
                        const qColIndices = qCols.map(c => c.colIdx);
                        const colIndices = [0, nameIdx, scoreIdx, ...qColIndices].filter((v, i, a) => a.indexOf(v) === i);
                        jsonData = rawJsonData.map(row => colIndices.map(idx => row[idx] ?? ''));

                        if (typeof getWenjuanxingBenchmark === 'function') {
                            const bm = getWenjuanxingBenchmark(jsonData);
                            if (bm && bm.questionCount > 0) {
                                if (bm.isR1Benchmark) {
                                    showToast(`问卷星已识别 ${bm.questionCount} 道题，首行（${bm.benchmarkName}）为满分标定卷已设为标准答案`, 'success');
                                } else {
                                    showToast(`问卷星已识别 ${bm.questionCount} 道题，已根据最高分（${bm.maxScore}分）答卷提取标准答案`, 'info');
                                }
                            }
                        }
                    }
                    // Convert to CSV text for payload persistence
                    const csvText = jsonData.map(row => row.map(cell => {
                        const s = String(cell);
                        return s.includes(',') || s.includes('"') || s.includes('\n')
                            ? '"' + s.replace(/"/g, '""') + '"' : s;
                    }).join(',')).join('\n');
                    const existingIdx = rawPreviewFiles.findIndex(f => f.name === file.name);
                    if (existingIdx >= 0) {
                        rawPreviewFiles[existingIdx] = { name: file.name, data: jsonData, text: csvText };
                    } else {
                        rawPreviewFiles.push({ name: file.name, data: jsonData, text: csvText });
                    }
                    captureUploadedFile(file, 'preview_xlsx');
                }
            } else {
                const text = await readFileAsTextWithProgress(
                    file,
                    (loaded, total) => { },
                    (reader) => activeReaders.push(reader)
                );
                const data = parseCSV(text);
                if (data.length > 0) {
                    const existingIdx = rawPreviewFiles.findIndex(f => f.name === file.name);
                    if (existingIdx >= 0) {
                        rawPreviewFiles[existingIdx] = { name: file.name, data, text };
                    } else {
                        rawPreviewFiles.push({ name: file.name, data, text });
                    }
                    captureUploadedFile(file, 'preview');
                    Logger.action('file_uploaded', { type: 'preview', fileName: file.name, rows: data.length - 1, fileSize: file.size, isAppend });
                }
            }
        } catch (error) {
            if (error?.message === 'aborted') return;
            Logger.error('file_parse_error', { type: 'preview', fileName: file.name, error: error?.message || String(error) });
            console.error('文件读取失败:', error);
            showToast(`文件 ${file.name} 读取失败`);
        }
    }
    activeReaders = [];
    previewFileInput.value = '';
    const appendInput = document.getElementById('preview-file-append');
    if (appendInput) appendInput.value = '';
    updatePreviewData();
    if (isAppend && fileArray.length > 0) {
        showToast(`已追加 ${fileArray.length} 个预习作业文件`);
    }
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error || new Error('读取失败'));
        reader.onabort = () => reject(new Error('aborted'));
        reader.readAsArrayBuffer(file);
    });
}

function updatePreviewData() {
    const container = document.getElementById('preview-file-list-container');

    if (rawPreviewFiles.length === 0) {
        previewData = null;
        previewFileName = '';
        previewDropZone.classList.remove('uploaded');
        previewInfo.textContent = '拖拽预习作业文件或点击浏览';
        if (container) container.classList.remove('visible');
        checkNextButton();
        renderPreviewFileList();
        // Reset preview metric mode options
        resetPreviewMetricModeOptions(true);
        return;
    }
    const header = rawPreviewFiles[0].data[0];
    let allRows = [];
    rawPreviewFiles.forEach(file => {
        if (file.data.length > 1) {
            allRows.push(...file.data.slice(1));
        }
    });
    previewData = [header, ...allRows];
    previewFileName = rawPreviewFiles[0].name;
    previewDropZone.classList.add('uploaded');

    const infoText = rawPreviewFiles.length > 1
        ? `已加载 ${rawPreviewFiles.length} 个文件 (${allRows.length}条数据)`
        : `已加载 (${allRows.length}条数据)`;
    previewInfo.textContent = infoText;

    if (container) container.classList.add('visible');

    const fileCount = document.getElementById('preview-file-count');
    if (fileCount) {
        fileCount.textContent = `${rawPreviewFiles.length} 个文件`;
    }

    renderPreviewFileList();
    checkNextButton();
    
    // Check if score column is all empty (only for aiwenyun data)
    if (physicsPreviewSource !== 'wenjuanxing') {
        checkPreviewScoreColumn(header, allRows);
    }
    
    // For wenjuanxing, check name matches against homework data
    if (physicsPreviewSource === 'wenjuanxing' && homeworkData) {
        checkWenjuanxingNameMatches();
    }
    // Re-check dropped students if roster is loaded
    if (rosterData) {
        checkDroppedStudents();
    }
}

function renderPreviewFileList() {
    const list = document.getElementById('preview-file-list');
    if (!list) return;
    if (rawPreviewFiles.length === 0) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = '';
    rawPreviewFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const count = file.data.length > 1 ? file.data.length - 1 : 0;
        item.innerHTML = `
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
                </svg>
                <span class="file-name" title="${file.name}">${file.name} <span style="color:var(--text-tertiary)">(${count}条)</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('preview', ${index}, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                <div class="file-remove" onclick="removePreviewFile(${index})" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

function removePreviewFile(index) {
    if (index >= 0 && index < rawPreviewFiles.length) {
        const name = rawPreviewFiles[index].name;
        rawPreviewFiles.splice(index, 1);
        updatePreviewData();
        showToast(`已移除文件: ${name}`);
    }
}

function clearPreviewFiles() {
    if (rawPreviewFiles.length === 0) return;
    showCustomDialog({
        title: '清空预习作业文件',
        body: '确定要清空所有已上传的预习作业文件吗？',
        confirmText: '清空',
        danger: true,
        onConfirm: () => {
            rawPreviewFiles = [];
            updatePreviewData();
            showToast('已清空预习作业文件');
        }
    });
}

// ========== Note File Handling (English only) ==========
async function handleNoteFiles(files, isAppend = false) {
    if (!requireSubject()) return;
    const fileArray = Array.from(files);
    for (const file of fileArray) {
        if (!file.name.endsWith('.csv')) {
            showToast('请上传CSV文件');
            return;
        }
    }
    uploadCancelled = false;
    if (!isAppend) {
        rawNoteFiles = [];
    }
    for (const file of fileArray) {
        if (uploadCancelled) break;
        try {
            const text = await readFileAsTextWithProgress(
                file,
                (loaded, total) => { },
                (reader) => activeReaders.push(reader)
            );
            const data = parseCSV(text);
            if (data.length > 0) {
                const existingIdx = rawNoteFiles.findIndex(f => f.name === file.name);
                if (existingIdx >= 0) {
                    rawNoteFiles[existingIdx] = { name: file.name, data, text };
                } else {
                    rawNoteFiles.push({ name: file.name, data, text });
                }
                captureUploadedFile(file, 'note');
                Logger.action('file_uploaded', { type: 'note', fileName: file.name, rows: data.length - 1, fileSize: file.size, isAppend });
            }
        } catch (error) {
            if (error?.message === 'aborted') return;
            Logger.error('file_parse_error', { type: 'note', fileName: file.name, error: error?.message || String(error) });
            showToast(`文件 ${file.name} 读取失败`);
        }
    }
    activeReaders = [];
    if (noteFileInput) noteFileInput.value = '';
    const appendInput = document.getElementById('note-file-append');
    if (appendInput) appendInput.value = '';
    updateNoteData();
    if (isAppend && fileArray.length > 0) {
        showToast(`已追加 ${fileArray.length} 个笔记作业文件`);
    }
}

function updateNoteData() {
    const container = document.getElementById('note-file-list-container');

    if (rawNoteFiles.length === 0) {
        noteData = null;
        noteFileName = '';
        if (noteDropZone) noteDropZone.classList.remove('uploaded');
        if (noteInfo) noteInfo.textContent = '拖拽笔记作业文件或点击浏览';
        if (container) container.classList.remove('visible');
        renderNoteFileList();
        return;
    }
    const header = rawNoteFiles[0].data[0];
    let allRows = [];
    rawNoteFiles.forEach(file => {
        if (file.data.length > 1) {
            allRows.push(...file.data.slice(1));
        }
    });
    noteData = [header, ...allRows];
    noteFileName = rawNoteFiles[0].name;
    if (noteDropZone) noteDropZone.classList.add('uploaded');

    const infoText = rawNoteFiles.length > 1
        ? `已加载 ${rawNoteFiles.length} 个文件 (${allRows.length}条数据)`
        : `已加载 (${allRows.length}条数据)`;
    if (noteInfo) noteInfo.textContent = infoText;

    if (container) container.classList.add('visible');

    const fileCount = document.getElementById('note-file-count');
    if (fileCount) {
        fileCount.textContent = `${rawNoteFiles.length} 个文件`;
    }

    renderNoteFileList();
}

function renderNoteFileList() {
    const list = document.getElementById('note-file-list');
    if (!list) return;
    if (rawNoteFiles.length === 0) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = '';
    rawNoteFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const count = file.data.length > 1 ? file.data.length - 1 : 0;
        item.innerHTML = `
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                <span class="file-name" title="${file.name}">${file.name} <span style="color:var(--text-tertiary)">(${count}条)</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('note', ${index}, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                <div class="file-remove" onclick="removeNoteFile(${index})" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

function removeNoteFile(index) {
    if (index >= 0 && index < rawNoteFiles.length) {
        const name = rawNoteFiles[index].name;
        rawNoteFiles.splice(index, 1);
        updateNoteData();
        showToast(`已移除文件: ${name}`);
    }
}

function clearNoteFiles() {
    if (rawNoteFiles.length === 0) return;
    showCustomDialog({
        title: '清空笔记作业文件',
        body: '确定要清空所有已上传的笔记作业文件吗？',
        confirmText: '清空',
        danger: true,
        onConfirm: () => {
            rawNoteFiles = [];
            updateNoteData();
            showToast('已清空笔记作业文件');
        }
    });
}

// ========== Class Test File Handling (English only) ==========
async function handleClassTestFiles(files, isAppend = false) {
    if (!requireSubject()) return;
    const fileArray = Array.from(files);
    for (const file of fileArray) {
        if (!file.name.endsWith('.csv')) {
            showToast('请上传CSV文件');
            return;
        }
    }
    uploadCancelled = false;
    if (!isAppend) {
        rawClassTestFiles = [];
    }
    for (const file of fileArray) {
        if (uploadCancelled) break;
        try {
            const text = await readFileAsTextWithProgress(
                file,
                (loaded, total) => { },
                (reader) => activeReaders.push(reader)
            );
            const data = parseCSV(text);
            if (data.length > 0) {
                const existingIdx = rawClassTestFiles.findIndex(f => f.name === file.name);
                if (existingIdx >= 0) {
                    rawClassTestFiles[existingIdx] = { name: file.name, data, text };
                } else {
                    rawClassTestFiles.push({ name: file.name, data, text });
                }
                captureUploadedFile(file, 'class_test');
                Logger.action('file_uploaded', { type: 'class_test', fileName: file.name, rows: data.length - 1, fileSize: file.size, isAppend });
            }
        } catch (error) {
            if (error?.message === 'aborted') return;
            Logger.error('file_parse_error', { type: 'class_test', fileName: file.name, error: error?.message || String(error) });
            showToast(`文件 ${file.name} 读取失败`);
        }
    }
    activeReaders = [];
    if (classTestFileInput) classTestFileInput.value = '';
    const appendInput = document.getElementById('class-test-file-append');
    if (appendInput) appendInput.value = '';
    updateClassTestData();
    if (isAppend && fileArray.length > 0) {
        showToast(`已追加 ${fileArray.length} 个课堂测试作业文件`);
    }
}

function updateClassTestData() {
    const container = document.getElementById('class-test-file-list-container');

    if (rawClassTestFiles.length === 0) {
        classTestData = null;
        classTestFileName = '';
        if (classTestDropZone) classTestDropZone.classList.remove('uploaded');
        if (classTestInfo) classTestInfo.textContent = '拖拽课堂测试作业文件或点击浏览';
        if (container) container.classList.remove('visible');
        renderClassTestFileList();
        return;
    }
    const header = rawClassTestFiles[0].data[0];
    let allRows = [];
    rawClassTestFiles.forEach(file => {
        if (file.data.length > 1) {
            allRows.push(...file.data.slice(1));
        }
    });
    classTestData = [header, ...allRows];
    classTestFileName = rawClassTestFiles[0].name;
    if (classTestDropZone) classTestDropZone.classList.add('uploaded');

    const infoText = rawClassTestFiles.length > 1
        ? `已加载 ${rawClassTestFiles.length} 个文件 (${allRows.length}条数据)`
        : `已加载 (${allRows.length}条数据)`;
    if (classTestInfo) classTestInfo.textContent = infoText;

    if (container) container.classList.add('visible');

    const fileCount = document.getElementById('class-test-file-count');
    if (fileCount) {
        fileCount.textContent = `${rawClassTestFiles.length} 个文件`;
    }

    renderClassTestFileList();
}

function renderClassTestFileList() {
    const list = document.getElementById('class-test-file-list');
    if (!list) return;
    if (rawClassTestFiles.length === 0) {
        list.innerHTML = '';
        return;
    }
    list.innerHTML = '';
    rawClassTestFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const count = file.data.length > 1 ? file.data.length - 1 : 0;
        item.innerHTML = `
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="9" y1="15" x2="15" y2="15"></line>
                </svg>
                <span class="file-name" title="${file.name}">${file.name} <span style="color:var(--text-tertiary)">(${count}条)</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('class_test', ${index}, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                <div class="file-remove" onclick="removeClassTestFile(${index})" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

function removeClassTestFile(index) {
    if (index >= 0 && index < rawClassTestFiles.length) {
        const name = rawClassTestFiles[index].name;
        rawClassTestFiles.splice(index, 1);
        updateClassTestData();
        showToast(`已移除文件: ${name}`);
    }
}

function clearClassTestFiles() {
    if (rawClassTestFiles.length === 0) return;
    showCustomDialog({
        title: '清空课堂测试作业文件',
        body: '确定要清空所有已上传的课堂测试作业文件吗？',
        confirmText: '清空',
        danger: true,
        onConfirm: () => {
            rawClassTestFiles = [];
            updateClassTestData();
            showToast('已清空课堂测试作业文件');
        }
    });
}

// ========== Report File Handling ==========
async function handleReportFile(file) {
    if (!requireSubject()) return;
    if (!file.name.endsWith('.csv')) {
        showToast('请上传CSV文件');
        return;
    }
    uploadCancelled = false;
    try {
        const text = await readFileAsTextWithProgress(
            file,
            (loaded, total) => { },
            (reader) => activeReaders.push(reader)
        );
        reportFileName = file.name;
        reportData = parseCSV(text);
        if (reportData && reportData.length > 0) {
            const rptHeader = reportData[0];
            const attIdx = rptHeader.findIndex(h => 
                (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
                !h.includes('时长') && !h.includes('率')
            );
            if (attIdx < 0) {
                rptHeader.push('是否有效出勤');
                const rewardIdx = rptHeader.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
                for (let i = 1; i < reportData.length; i++) {
                    const row = reportData[i];
                    const reward = rewardIdx >= 0 ? String(row[rewardIdx] || '').trim() : '';
                    const isAbsent = (reward === '-' || reward === '');
                    row.push(isAbsent ? '缺勤' : '出勤');
                }
            }
        }
        captureUploadedFile(file, 'report');
        reportDropZone.classList.add('uploaded');
        reportInfo.textContent = `已加载 (${reportData.length - 1}条数据)`;
        reportDropZone.dataset.rawText = text;
        
        // Detect max focus score from report data
        detectAndSetFocusMaxScore(reportData);

        renderReportFileList();
        
        showToast('统计报告已加载');
    } catch (error) {
        if (error?.message !== 'aborted') {
            showToast(`文件 ${file.name} 读取失败`);
        }
    } finally {
        activeReaders = [];
        reportFileInput.value = '';
    }
}

function renderReportFileList() {
    const container = document.getElementById('report-file-list-container');
    const list = document.getElementById('report-file-list');
    const countEl = document.getElementById('report-file-count');
    if (!list) return;

    if (!reportData || !reportFileName) {
        list.innerHTML = '';
        if (container) container.classList.remove('visible');
        return;
    }

    if (container) container.classList.add('visible');
    if (countEl) countEl.textContent = '已上传统计报告';

    const header = reportData[0] || [];
    const classIdx = header.findIndex(h => String(h || '').includes('班级'));
    let countText = `${reportData.length - 1}条`;
    if (classIdx >= 0) {
        const beta1Count = reportData.slice(1).filter(r => String(r[classIdx] || '').trim().includes('β1')).length;
        countText = `β1: ${beta1Count}条 / 共${reportData.length - 1}条`;
    }

    list.innerHTML = `
        <div class="file-item">
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                    <path d="M3 9h18"></path>
                    <path d="M9 3v18"></path>
                </svg>
                <span class="file-name" title="${reportFileName}">${reportFileName} <span style="color:var(--text-tertiary)">(${countText})</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('report', 0, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                <div class="file-remove" onclick="clearReportFile()" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        </div>
    `;
}

function clearReportFile() {
    if (!reportData) return;
    reportData = null;
    reportFileName = '';
    
    if (reportDropZone) reportDropZone.classList.remove('uploaded');
    if (reportInfo) reportInfo.textContent = '拖拽文件或点击上传';
    if (reportDropZone) delete reportDropZone.dataset.rawText;
    
    renderReportFileList();

    // Reset focus score display items
    const maxScoreInfo = document.getElementById('focus-max-score-info');
    if (maxScoreInfo) maxScoreInfo.style.display = 'none';
    const scoreAdjust = document.getElementById('focus-score-adjust');
    if (scoreAdjust) scoreAdjust.style.display = 'none';

    showToast('已清除统计报告（专注度文件）');
}

function detectAndSetFocusMaxScore(data) {
    if (!data || data.length < 2) return;
    
    const header = data[0];
    const rows = data.slice(1);
    const rewardIdx = header.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
    const classIdx = header.findIndex(h => String(h || '').includes('班级'));
    const attIdx = header.findIndex(h => 
        (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
        !h.includes('时长') && !h.includes('率')
    );
    
    if (rewardIdx < 0) return;
    
    let maxScore = 0;
    rows.forEach(row => {
        // 仅线上β1学生参与最高分计算
        if (classIdx >= 0) {
            const cName = String(row[classIdx] || '').trim();
            if (!cName.includes('β1')) return;
        }
        // 明确缺勤者不计入最高分
        if (attIdx >= 0) {
            const att = String(row[attIdx] || '').trim();
            if (att.includes('缺勤')) return;
        }
        const reward = row[rewardIdx];
        if (reward && reward !== '-' && reward !== '') {
            const val = parseFloat(reward);
            if (!isNaN(val) && val > maxScore) {
                maxScore = val;
            }
        }
    });
    
    // Store original max score and reset offset
    originalFocusMaxScore = maxScore;
    focusScoreOffset = 0;
    
    const defaultBtn = document.getElementById('focus-source-default-btn');
    const maxScoreInfo = document.getElementById('focus-max-score-info');
    const maxScoreValue = document.getElementById('focus-max-score-value');
    const adjustDiv = document.getElementById('focus-score-adjust');
    const offsetInfo = document.getElementById('focus-offset-info');
    
    // Show max score info if detected
    if (maxScore > 0) {
        if (maxScoreInfo) maxScoreInfo.style.display = 'flex';
        if (maxScoreValue) maxScoreValue.textContent = maxScore;
        if (adjustDiv) adjustDiv.style.display = 'block';
        if (offsetInfo) offsetInfo.textContent = '';
    }
    
    updateFocusScoreState(maxScore);
}

function updateFocusScoreState(adjustedMaxScore) {
    const defaultBtn = document.getElementById('focus-source-default-btn');
    const maxScoreValue = document.getElementById('focus-max-score-value');
    
    if (maxScoreValue) {
        maxScoreValue.textContent = adjustedMaxScore;
    }
    
    if (adjustedMaxScore === 6) {
        // Enable default comments when adjusted max score is 6
        if (defaultBtn) {
            defaultBtn.classList.remove('disabled');
            defaultBtn.style.opacity = '';
            defaultBtn.style.cursor = '';
            defaultBtn.title = '';
            defaultBtn.removeAttribute('data-disabled');
        }
        generateFocusCommentFields(6);
        // Auto switch to default if currently on custom
        if (focusCommentSource === 'custom') {
            switchFocusCommentSource('default');
            showToast('调整后最高分为6分，已启用默认评语');
        }
    } else {
        // Disable default comments when adjusted max score is not 6
        forceFocusCommentCustom(adjustedMaxScore);
    }
}

function adjustFocusScore(delta) {
    const newOffset = focusScoreOffset + delta;
    const adjustedMaxScore = originalFocusMaxScore + newOffset;
    
    // Prevent negative scores
    if (adjustedMaxScore < 0) {
        showToast('分数不能为负数');
        return;
    }
    
    focusScoreOffset = newOffset;
    
    const offsetInfo = document.getElementById('focus-offset-info');
    if (offsetInfo) {
        if (focusScoreOffset > 0) {
            offsetInfo.textContent = `+${focusScoreOffset}`;
            offsetInfo.style.background = 'linear-gradient(135deg, #22c55e20, #16a34a20)';
            offsetInfo.style.color = '#16a34a';
            offsetInfo.style.border = '1px solid #22c55e44';
        } else if (focusScoreOffset < 0) {
            offsetInfo.textContent = `${focusScoreOffset}`;
            offsetInfo.style.background = 'linear-gradient(135deg, #ef444420, #dc262620)';
            offsetInfo.style.color = '#dc2626';
            offsetInfo.style.border = '1px solid #ef444444';
        } else {
            offsetInfo.textContent = '';
            offsetInfo.style.background = '';
            offsetInfo.style.color = '';
            offsetInfo.style.border = '';
        }
    }
    
    updateFocusScoreState(adjustedMaxScore);
}

window.detectAndSetFocusMaxScore = detectAndSetFocusMaxScore;
window.adjustFocusScore = adjustFocusScore;

// ========== All Students Roster Handling ==========
async function handleRosterFile(file) {
    if (!requireSubject()) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'csv' && ext !== 'xlsx' && ext !== 'xls') {
        showToast('请上传CSV或Excel文件');
        return;
    }
    try {
        let text = '';
        if (ext === 'xlsx' || ext === 'xls') {
            if (typeof XLSX === 'undefined') {
                throw new Error('Excel 解析引擎 (SheetJS) 未就绪，请刷新页面后重试');
            }
            const arrayBuffer = await readFileAsArrayBuffer(file);
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            if (jsonData.length > 0) {
                text = jsonData.map(row => row.map(cell => {
                    const s = String(cell);
                    return s.includes(',') || s.includes('"') || s.includes('\n')
                        ? '"' + s.replace(/"/g, '""') + '"' : s;
                }).join(',')).join('\n');
            }
        } else {
            text = await readFileAsTextWithProgress(
                file,
                (loaded, total) => { },
                (reader) => activeReaders.push(reader)
            );
        }
        
        rosterFileName = file.name;
        rosterData = parseCSV(text);
        // 新名单：重置班级选择（默认行为由 checkDroppedStudents 按作业自动匹配）
        classSelectionTouched = false;
        selectedFeedbackClasses = [];
        rosterParsedRows = [];
        rosterClassStats = [];
        captureUploadedFile(file, 'roster');
        rosterDropZone.classList.add('uploaded');
        rosterInfo.textContent = `已加载 (${Math.max(0, rosterData.length - 1)}条数据)`;
        rosterDropZone.dataset.rawText = text;
        showToast('所有学生名单已加载');
        // Auto-check dropped students after roster is loaded
        checkDroppedStudents();
    } catch (error) {
        if (error?.message !== 'aborted') {
            showToast(`文件 ${file.name} 读取失败`);
        }
    } finally {
        activeReaders = [];
        if (rosterFileInput) rosterFileInput.value = '';
    }
}

function clearRosterFile() {
    rosterData = null;
    rosterFileName = '';
    detectedDroppedStudents = { preview: [], homework: [] };
    droppedStudentsAcknowledged = false;
    detectedClassName = '';
    rosterParsedRows = [];
    rosterClassStats = [];
    selectedFeedbackClasses = [];
    classSelectionTouched = false;
    const classWrap = document.getElementById('roster-class-wrap');
    if (classWrap) classWrap.style.display = 'none';
    const classGroup = document.getElementById('roster-class-group');
    if (classGroup) classGroup.innerHTML = '';
    if (rosterDropZone) rosterDropZone.classList.remove('uploaded');
    if (rosterInfo) rosterInfo.textContent = '拖拽文件或点击上传';
    const statusDiv = document.getElementById('roster-status');
    if (statusDiv) statusDiv.style.display = 'none';
    showToast('已清除学生名单');
}

/**
 * 解析名单为 [{name, className}]，列缺失或空表时提示并返回 null
 */
function parseRosterRows() {
    if (!rosterData || rosterData.length < 2) return null;

    const rosterHeader = rosterData[0];
    const rosterNameIdx = rosterHeader.findIndex(h => h.includes('姓名'));
    const rosterClassIdx = rosterHeader.findIndex(h => h.includes('班级名称'));

    if (rosterNameIdx < 0 || rosterClassIdx < 0) {
        showToast('学生名单CSV缺少"姓名"或"班级名称"列');
        return null;
    }

    // Clean up roster names (remove BOM, trim, and strip numeric prefix like "55615吉恩萱" -> "吉恩萱")
    // Also strip α/β suffixes from class names so we can unify students in the same actual class.
    const rows = rosterData.slice(1).map(r => {
        let rawName = (r[rosterNameIdx] || '').replace(/[\uFEFF]/g, '').trim();
        const match = rawName.match(/\d+(.+)/);
        return {
            name: match ? match[1] : rawName,
            className: (r[rosterClassIdx] || '').replace(/[\uFEFF]/g, '').replace(/[αβ]\d*$/i, '').trim()
        };
    }).filter(r => r.name && r.className);

    if (rows.length === 0) {
        showToast('学生名单为空');
        return null;
    }
    return rows;
}

/**
 * 渲染“需要反馈的班级”多选芯片（DOM 方式构建，班级名不拼 HTML，防注入）
 */
function renderFeedbackClassChips() {
    const wrap = document.getElementById('roster-class-wrap');
    const group = document.getElementById('roster-class-group');
    if (!wrap || !group) return;
    group.innerHTML = '';
    if (rosterClassStats.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'block';
    rosterClassStats.forEach(({ name, count }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-pill' + (selectedFeedbackClasses.includes(name) ? ' active' : '');
        btn.title = `点击切换是否纳入反馈（${count}人）`;
        const label = document.createElement('span');
        label.textContent = name;
        const badge = document.createElement('span');
        badge.className = 'pill-count';
        badge.textContent = `${count}人`;
        btn.append(label, badge);
        btn.addEventListener('click', () => toggleFeedbackClass(name));
        group.appendChild(btn);
    });
}

function toggleFeedbackClass(name) {
    const i = selectedFeedbackClasses.indexOf(name);
    if (i >= 0) {
        if (selectedFeedbackClasses.length <= 1) {
            showToast('至少保留一个反馈班级');
            return;
        }
        selectedFeedbackClasses.splice(i, 1);
    } else {
        selectedFeedbackClasses.push(name);
    }
    classSelectionTouched = true;
    renderFeedbackClassChips();
    refreshScopedDropped();
}

/**
 * 所选班级的展示标签（弹窗与状态文案共用）
 */
function getScopeLabel() {
    if (selectedFeedbackClasses.length <= 2) return selectedFeedbackClasses.join('、');
    return `${selectedFeedbackClasses.slice(0, 2).join('、')}等${selectedFeedbackClasses.length}个班级`;
}

/**
 * 按所选班级并集计算名单外学生（退课 + 未选班级），复用 droppedStudents 通道，
 * viewer 侧无需改动即可过滤反馈卡片、统计与未交名单。
 */
function refreshScopedDropped() {
    droppedStudentsAcknowledged = false;
    if (rosterParsedRows.length === 0 || selectedFeedbackClasses.length === 0) {
        detectedDroppedStudents = { preview: [], homework: [] };
        return;
    }
    const scopeSet = new Set();
    rosterParsedRows.forEach(r => {
        if (selectedFeedbackClasses.includes(r.className)) scopeSet.add(r.name);
    });

    const hwStudentNames = extractStudentNamesFromData(homeworkData);
    const pvStudentNames = extractStudentNamesFromData(previewData);

    detectedDroppedStudents = {
        preview: pvStudentNames.filter(name => !scopeSet.has(name)),
        homework: hwStudentNames.filter(name => !scopeSet.has(name))
    };
    // 保留首个所选班级供年级/班层推断与弹窗兜底
    detectedClassName = selectedFeedbackClasses[0] || '';

    const totalDropped = new Set([...detectedDroppedStudents.homework, ...detectedDroppedStudents.preview]).size;
    if (totalDropped === 0) {
        updateRosterStatus(`已选班级：${getScopeLabel()}（${scopeSet.size}人）\n所有作业学生均在名单中`, 'success');
    } else {
        updateRosterStatus(
            `已选班级：${getScopeLabel()}（${scopeSet.size}人）\n检测到 ${totalDropped} 名不在所选班级名单的学生`,
            'warning'
        );
        // Modal logic is now deferred to goToStep
    }
}

/**
 * Core logic: detect dropped students
 * 1. 解析名单得到各班级
 * 2. 未手动选过班级时，按作业自动匹配班级并默认仅选它（兼容旧行为）；
 *    手动选过则保留用户选择
 * 3. 以所选班级并集为反馈范围，作业中超出范围的学生走退课通道排除
 */
function checkDroppedStudents() {
    const rows = parseRosterRows();
    if (!rows) {
        rosterParsedRows = [];
        rosterClassStats = [];
        const group = document.getElementById('roster-class-group');
        if (group) group.innerHTML = '';
        const wrap = document.getElementById('roster-class-wrap');
        if (wrap) wrap.style.display = 'none';
        return;
    }
    rosterParsedRows = rows;

    const countMap = {};
    rows.forEach(r => { countMap[r.className] = (countMap[r.className] || 0) + 1; });
    rosterClassStats = Object.keys(countMap).sort().map(k => ({ name: k, count: countMap[k] }));

    // Extract student names from homework and preview data
    const hwStudentNames = extractStudentNamesFromData(homeworkData);
    const pvStudentNames = extractStudentNamesFromData(previewData);
    const allHomeworkNames = [...hwStudentNames, ...pvStudentNames];

    if (!classSelectionTouched) {
        if (allHomeworkNames.length > 0) {
            // Auto-detect: use the first homework student found in roster
            const nameToClass = {};
            rows.forEach(r => { nameToClass[r.name] = r.className; });
            let foundClass = null;
            for (const name of allHomeworkNames) {
                if (nameToClass[name]) {
                    foundClass = nameToClass[name];
                    break;
                }
            }
            if (!foundClass) {
                updateRosterStatus(`未能在名单中找到匹配的学生，请确认名单是否正确`, 'warning');
                selectedFeedbackClasses = rosterClassStats.map(c => c.name);
                renderFeedbackClassChips();
                return;
            }
            selectedFeedbackClasses = [foundClass];
        } else {
            selectedFeedbackClasses = rosterClassStats.map(c => c.name);
        }
    } else {
        // 保留用户选择，剔除新名单中已不存在的班级
        const valid = new Set(rosterClassStats.map(c => c.name));
        selectedFeedbackClasses = selectedFeedbackClasses.filter(n => valid.has(n));
        if (selectedFeedbackClasses.length === 0) {
            selectedFeedbackClasses = rosterClassStats.map(c => c.name);
        }
    }
    renderFeedbackClassChips();

    if (allHomeworkNames.length === 0) {
        const statusDiv = document.getElementById('roster-status');
        if (statusDiv) statusDiv.style.display = 'none';
        return;
    }
    refreshScopedDropped();
}

function extractStudentNamesFromData(data) {
    if (!data || data.length < 2) return [];
    const header = data[0];
    const nameIdx = header.findIndex(h => String(h).includes('姓名'));
    if (nameIdx < 0) return [];
    let rows = data.slice(1);
    if (data === previewData && physicsPreviewSource === 'wenjuanxing' && typeof getWenjuanxingBenchmark === 'function') {
        const bm = getWenjuanxingBenchmark(previewData);
        if (bm && bm.isR1Benchmark) {
            rows = rows.slice(1);
        }
    }
    return rows
        .map(r => {
            const fullName = String(r[nameIdx] || '').trim();
            const match = fullName.match(/\d+(.+)/);
            return match ? match[1] : fullName;
        })
        .filter(n => n);
}

function updateRosterStatus(message, type) {
    const statusDiv = document.getElementById('roster-status');
    const statusText = document.getElementById('roster-status-text');
    const statusCallout = document.getElementById('roster-status-callout');
    if (!statusDiv || !statusText) return;
    
    statusDiv.style.display = 'block';
    statusText.textContent = message;
    
    if (statusCallout) {
        if (type === 'success') {
            statusCallout.style.borderColor = 'rgba(34, 197, 94, 0.3)';
            statusCallout.style.background = 'rgba(34, 197, 94, 0.05)';
        } else if (type === 'warning') {
            statusCallout.style.borderColor = 'rgba(245, 158, 11, 0.3)';
            statusCallout.style.background = 'rgba(245, 158, 11, 0.05)';
        } else {
            statusCallout.style.borderColor = '';
            statusCallout.style.background = '';
        }
    }
}

function showDroppedStudentsModal(droppedPreview, droppedHomework, className) {
    const modal = document.getElementById('dropped-students-modal');
    const body = document.getElementById('dropped-students-body');
    if (!modal || !body) return;
    
    let html = '';
    
    if (droppedPreview.length > 0) {
        html += `<div style="margin-bottom: 12px;"><span style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">课前预习（${droppedPreview.length}人不在 ${className} 名单中）：</span></div>`;
        droppedPreview.forEach(name => {
            html += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; padding:8px 12px; background:var(--ui-fill-weak); border:1px solid var(--border-light); border-radius:var(--radius-sm);">
                <span style="color: #ef4444;">✕</span>
                <span style="font-size:0.85rem; color:var(--text-primary);">${name}</span>
            </div>`;
        });
    }
    
    if (droppedHomework.length > 0) {
        if (droppedPreview.length > 0) html += `<div style="margin-top: 14px;"></div>`;
        html += `<div style="margin-bottom: 12px;"><span style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">${getUploadHomeworkLabelFull()}（${droppedHomework.length}人不在 ${className} 名单中）：</span></div>`;
        droppedHomework.forEach(name => {
            html += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; padding:8px 12px; background:var(--ui-fill-weak); border:1px solid var(--border-light); border-radius:var(--radius-sm);">
                <span style="color: #ef4444;">✕</span>
                <span style="font-size:0.85rem; color:var(--text-primary);">${name}</span>
            </div>`;
        });
    }
    
    body.innerHTML = html;
    openNativeDialog(modal, {
        dismissible: true,
        onAfterClose: finishDroppedStudentsClose
    });
}

function finishDroppedStudentsClose() {
    droppedStudentsAcknowledged = true;

    if (pendingNavigationStep) {
        const step = pendingNavigationStep;
        pendingNavigationStep = null;
        goToStep(step);
    }
}

function closeDroppedStudentsModal() {
    closeNativeDialog('dropped-students-modal');
    if (!window.DialogHelper) {
        finishDroppedStudentsClose();
    }
}

// ========== Duplicate submissions detection ==========
// 同一文件合并数据中，原始“姓名”单元格完全相同的多行即判为重复提交。
// 注意：同名但学号不同（如 90001张三 vs 90002张三）视为不同学生，不合并。
let currentDuplicateGroups = [];

function collectDuplicateGroups() {
    const groups = [];
    const defs = [
        { type: 'homework', typeLabel: (typeof getUploadHomeworkLabelFull === 'function' ? getUploadHomeworkLabelFull() : '课后巩固'), files: (typeof rawHomeworkFiles !== 'undefined' ? rawHomeworkFiles : []) },
        { type: 'preview', typeLabel: '课前预习', files: (typeof rawPreviewFiles !== 'undefined' ? rawPreviewFiles : []) }
    ];
    defs.forEach(def => {
        if (!def.files || def.files.length === 0) return;
        const header = (def.files[0].data && def.files[0].data[0]) || [];
        const nameIdx = header.findIndex(h => String(h).includes('姓名'));
        const scoreIdx = header.findIndex(h => String(h).includes('得分'));
        const statusIdx = header.findIndex(h => String(h).includes('作业状态'));
        const commentIdx = findCommentColumnIndex(header, '批改评语');
        const correctionCommentIdx = findCommentColumnIndex(header, '订正评语');
        if (nameIdx < 0) return;
        const byName = new Map();
        def.files.forEach((file, fi) => {
            ((file && file.data) || []).slice(1).forEach(row => {
                if (!row) return;
                const fullName = String(row[nameIdx] || '').replace(/[\uFEFF]/g, '').trim();
                if (!fullName) return;
                if (!byName.has(fullName)) byName.set(fullName, []);
                byName.get(fullName).push({
                    fileIdx: fi,
                    fileName: file.name || '',
                    rowRef: row,
                    score: (scoreIdx >= 0 && typeof parseScoreValue === 'function') ? parseScoreValue(row[scoreIdx]) : null,
                    status: statusIdx >= 0 ? String(row[statusIdx] || '').trim() : '',
                    comment: getEffectiveComment(row, commentIdx, correctionCommentIdx).trim()
                });
            });
        });
        byName.forEach((rows, fullName) => {
            if (rows.length > 1) {
                groups.push({ type: def.type, typeLabel: def.typeLabel, fullName, rows });
            }
        });
    });
    return groups;
}

function escDupText(s) {
    return (typeof escapeHtml === 'function') ? escapeHtml(String(s ?? '')) : String(s ?? '');
}

function showDuplicateStudentsModal(groups) {
    currentDuplicateGroups = groups;
    const modal = document.getElementById('duplicate-students-modal');
    const body = document.getElementById('duplicate-students-body');
    if (!modal || !body) return;

    let html = '';
    groups.forEach((g, gi) => {
        html += `<div class="dedup-group">
            <div class="dedup-group-title">${escDupText(g.fullName)} <span style="color: var(--text-tertiary); font-weight: 400;">（${escDupText(g.typeLabel)}，共 ${g.rows.length} 条）</span></div>
            <div class="dedup-group-sub">默认保留最后一条（推测为最新提交），也可手动选择：</div>`;
        g.rows.forEach((r, ri) => {
            const scoreText = (r.score !== null && r.score !== undefined) ? `${r.score}分` : '暂无分数';
            const commentText = r.comment ? (r.comment.length > 24 ? r.comment.slice(0, 24) + '…' : r.comment) : '（无评语）';
            html += `<label class="dedup-row">
                <input type="radio" name="dedup-${gi}" value="${ri}" ${ri === g.rows.length - 1 ? 'checked' : ''}>
                <span class="dedup-row-info">
                    <strong>${scoreText}</strong>${r.status ? ` · ${escDupText(r.status)}` : ''}<br>
                    <span>${escDupText(commentText)}</span><br>
                    <span class="dedup-row-file">来源：${escDupText(r.fileName)}</span>
                </span>
            </label>`;
        });
        html += `</div>`;
    });

    body.innerHTML = html;
    openNativeDialog(modal, {
        dismissible: true,
        onAfterClose: finishDuplicateModalClose
    });
}

window.autoSelectBestScores = function() {
    if (!currentDuplicateGroups || currentDuplicateGroups.length === 0) return;
    currentDuplicateGroups.forEach((g, gi) => {
        let bestRi = g.rows.length - 1;
        let bestScore = -Infinity;
        g.rows.forEach((r, ri) => {
            const s = (r.score !== null && r.score !== undefined) ? r.score : -Infinity;
            if (s > bestScore) {
                bestScore = s;
                bestRi = ri;
            }
        });
        const radio = document.querySelector(`#duplicate-students-body input[name="dedup-${gi}"][value="${bestRi}"]`);
        if (radio) radio.checked = true;
    });
    showToast('已为每位学生选中最高分记录');
};

window.confirmDuplicateChoices = function() {
    if (!currentDuplicateGroups || currentDuplicateGroups.length === 0) {
        closeDuplicateModalAndContinue();
        return;
    }
    const dropSet = new Set();
    let keptCount = 0;
    currentDuplicateGroups.forEach((g, gi) => {
        const checked = document.querySelector(`#duplicate-students-body input[name="dedup-${gi}"]:checked`);
        const keepRi = checked ? parseInt(checked.value, 10) : (g.rows.length - 1);
        g.rows.forEach((r, ri) => {
            if (ri === keepRi) {
                keptCount++;
            } else {
                dropSet.add(r.rowRef);
            }
        });
    });

    // 按引用从源文件数据中剔除未选中的行，再重建合并数据并同步更新 text
    let touchedHomework = false;
    let touchedPreview = false;
    if (typeof rawHomeworkFiles !== 'undefined') {
        rawHomeworkFiles.forEach(file => {
            if (!file || !Array.isArray(file.data) || file.data.length <= 1) return;
            const before = file.data.length;
            file.data = [file.data[0], ...file.data.slice(1).filter(r => !dropSet.has(r))];
            if (file.data.length !== before) {
                if (typeof serializeCSV === 'function') file.text = serializeCSV(file.data);
                touchedHomework = true;
            }
        });
    }
    if (typeof rawPreviewFiles !== 'undefined') {
        rawPreviewFiles.forEach(file => {
            if (!file || !Array.isArray(file.data) || file.data.length <= 1) return;
            const before = file.data.length;
            file.data = [file.data[0], ...file.data.slice(1).filter(r => !dropSet.has(r))];
            if (file.data.length !== before) {
                if (typeof serializeCSV === 'function') file.text = serializeCSV(file.data);
                touchedPreview = true;
            }
        });
    }
    if (touchedHomework && typeof updateHomeworkData === 'function') updateHomeworkData();
    if (touchedPreview && typeof updatePreviewData === 'function') updatePreviewData();

    showToast(`已去重 ${dropSet.size} 条重复记录`);
    closeDuplicateModalAndContinue();
};

function finishDuplicateModalClose() {
    currentDuplicateGroups = [];
    if (pendingNavigationStep) {
        const step = pendingNavigationStep;
        pendingNavigationStep = null;
        goToStep(step);
    }
}

function closeDuplicateModalAndContinue() {
    closeNativeDialog('duplicate-students-modal');
    if (!window.DialogHelper) {
        finishDuplicateModalClose();
    }
}

window.clearRosterFile = clearRosterFile;
window.clearReportFile = clearReportFile;
window.closeDroppedStudentsModal = closeDroppedStudentsModal;

// ========== 已提交但未批改作业拦截检测（交了但没改，禁止进行下一步） ==========
function checkUngradedSubmissions() {
    const list = [];

    const inspectRows = (data, typeName, defaultFileName = '', rawType = 'homework', fileIndex = 0) => {
        if (!data || data.length <= 1) return;
        const header = data[0];
        if (!Array.isArray(header)) return;

        const nameIdx = header.findIndex(h => typeof h === 'string' && (h.includes('姓名') || h === '学生' || h === '学员'));
        const statusIdx = header.findIndex(h => typeof h === 'string' && (h.includes('作业状态') || h.includes('提交状态') || h === '状态'));
        const scoreIdx = header.findIndex(h => typeof h === 'string' && (h.includes('得分') || h.includes('成绩') || h === '分数'));
        if (nameIdx < 0 || statusIdx < 0) return;

        for (let r = 1; r < data.length; r++) {
            const row = data[r];
            if (!row) continue;
            const fullName = String(row[nameIdx] || '').trim();
            if (!fullName) continue;

            const status = String(row[statusIdx] || '').trim();
            // “交了但是老师没改完”：状态为“已提交”或“批改中”
            const isUngraded = (typeof isStatusUngraded === 'function')
                ? isStatusUngraded(status)
                : (status === '已提交' || (status.includes('已提交') && !status.includes('未')) || status.includes('批改中'));
            if (isUngraded) {
                const nameMatch = fullName.match(/\d+(.+)/);
                const studentName = nameMatch ? nameMatch[1].trim() : fullName;

                // 排除名单过滤
                const exclusionListText = document.getElementById('exclusion-list')?.value || '';
                const isExcluded = exclusionListText.split('\n').some(line => {
                    const tr = line.trim();
                    return tr && (tr === fullName || tr === studentName);
                });
                if (isExcluded) continue;

                // 退课名单过滤
                if (detectedDroppedStudents) {
                    if (typeName.includes('预习') && detectedDroppedStudents.preview && detectedDroppedStudents.preview.includes(studentName)) {
                        continue;
                    }
                    if (!typeName.includes('预习') && detectedDroppedStudents.homework && detectedDroppedStudents.homework.includes(studentName)) {
                        continue;
                    }
                }

                const rawScore = scoreIdx >= 0 ? row[scoreIdx] : '';
                const scoreText = (rawScore !== null && rawScore !== undefined && String(rawScore).trim() !== '' && String(rawScore).trim() !== '-')
                    ? `${String(rawScore).trim()}分`
                    : '暂无批改分数';

                list.push({
                    type: typeName,
                    rawType: rawType,
                    fileIndex: fileIndex,
                    studentName: studentName,
                    fullName: fullName,
                    status: status,
                    scoreText: scoreText,
                    fileName: defaultFileName
                });
            }
        }
    };

    // 1. 课后巩固
    if (rawHomeworkFiles && rawHomeworkFiles.length > 0) {
        rawHomeworkFiles.forEach((f, idx) => {
            inspectRows(f.data, getUploadHomeworkLabelFull(), f.name, 'homework', idx);
        });
    } else if (homeworkData) {
        inspectRows(homeworkData, getUploadHomeworkLabelFull(), homeworkFileName || '', 'homework', 0);
    }

    // 2. 课前预习（非问卷星模式）
    if (physicsPreviewSource !== 'wenjuanxing') {
        if (rawPreviewFiles && rawPreviewFiles.length > 0) {
            rawPreviewFiles.forEach((f, idx) => {
                inspectRows(f.data, '课前预习', f.name, 'preview', idx);
            });
        } else if (previewData) {
            inspectRows(previewData, '课前预习', previewFileName || '', 'preview', 0);
        }
    }

    // 3. 笔记作业
    if (rawNoteFiles && rawNoteFiles.length > 0) {
        rawNoteFiles.forEach((f, idx) => {
            inspectRows(f.data, '笔记作业', f.name, 'note', idx);
        });
    } else if (noteData) {
        inspectRows(noteData, '笔记作业', noteFileName || '', 'note', 0);
    }

    // 4. 课堂测试
    if (rawClassTestFiles && rawClassTestFiles.length > 0) {
        rawClassTestFiles.forEach((f, idx) => {
            inspectRows(f.data, '课堂测试', f.name, 'class_test', idx);
        });
    } else if (classTestData) {
        inspectRows(classTestData, '课堂测试', classTestFileName || '', 'class_test', 0);
    }

    return list;
}

let lastDetectedUngradedList = [];

function showUngradedSubmissionsModal(ungradedList) {
    lastDetectedUngradedList = ungradedList || [];
    const modal = document.getElementById('ungraded-submissions-modal');
    const body = document.getElementById('ungraded-submissions-body');
    const escapeSafe = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    if (!modal || !body) {
        alert(`检测到 ${ungradedList.length} 位学生作业为【已提交】但尚未批改，请批改完成后再继续。`);
        return;
    }

    const showSearch = ungradedList.length > 6;

    let html = `
        <div class="ungraded-alert-banner">
            <div class="ungraded-banner-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
            </div>
            <div class="ungraded-banner-text">
                共检测到 <strong style="color: #ef4444; font-size: 0.96rem;">${ungradedList.length}</strong> 条作业记录处于<strong>【已提交 / 批改中】</strong>状态（尚未完成批改）。生成反馈要求所有已交作业均完成批改，请在教学平台批改或直接在线修改后再继续。
            </div>
        </div>
    `;

    if (showSearch) {
        html += `
            <div class="ui-search" style="margin-bottom: 12px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input type="text" placeholder="输入学生姓名快速搜索..." oninput="filterUngradedModalList(this.value)" />
            </div>
        `;
    }

    html += `<div class="ungraded-list-container">`;

    ungradedList.forEach((item, idx) => {
        let typeCls = 'type-homework';
        const rawType = item.rawType || 'homework';
        const cleanType = (item.type || '作业').replace(/作业$/, '');
        if (rawType === 'preview' || item.type.includes('预习')) typeCls = 'type-preview';
        else if (rawType === 'note' || item.type.includes('笔记')) typeCls = 'type-note';
        else if (rawType === 'class_test' || item.type.includes('课堂') || item.type.includes('测试')) typeCls = 'type-classtest';

        const idMatch = (item.fullName || '').match(/^(\d+)/);
        const studentId = idMatch ? idMatch[1] : '';
        const statusLabel = item.status ? `${escapeSafe(item.status)} · 待完成批改` : '已提交 · 待批改';

        html += `
            <div class="ungraded-item-card" data-student="${escapeSafe(item.studentName)}" data-type="${escapeSafe(item.type)}">
                <div class="ungraded-item-left">
                    <span class="ungraded-item-idx">${idx + 1}</span>
                    <span class="ungraded-type-pill ${typeCls}">${escapeSafe(cleanType)}</span>
                    <span class="ungraded-student-name" title="${escapeSafe(item.studentName)}">${escapeSafe(item.studentName)}</span>
                    ${studentId ? `<span class="ungraded-student-id">(${escapeSafe(studentId)})</span>` : ''}
                </div>
                <div class="ungraded-item-right">
                    <span class="ungraded-status-pill">
                        <span class="ungraded-status-dot"></span>
                        ${statusLabel}
                    </span>
                </div>
            </div>
        `;
    });

    html += `
        </div>
        <div id="ungraded-search-empty" style="display:none; text-align:center; padding: 24px 0; color:var(--text-tertiary); font-size:0.84rem;">
            未找到匹配的学生
        </div>
    `;

    body.innerHTML = html;
    openNativeDialog(modal, { dismissible: true });
}

function closeUngradedSubmissionsModal() {
    closeNativeDialog('ungraded-submissions-modal');
}

window.filterUngradedModalList = function(kw) {
    const term = (kw || '').trim().toLowerCase();
    const cards = document.querySelectorAll('#ungraded-submissions-body .ungraded-item-card');
    let visibleCount = 0;
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        const match = !term || text.includes(term);
        card.style.display = match ? 'flex' : 'none';
        if (match) visibleCount++;
    });
    const emptyMsg = document.getElementById('ungraded-search-empty');
    if (emptyMsg) {
        emptyMsg.style.display = (visibleCount === 0) ? 'block' : 'none';
    }
};

window.quickEditFromUngradedModal = function() {
    closeUngradedSubmissionsModal();
    if (!lastDetectedUngradedList || lastDetectedUngradedList.length === 0) return;
    const firstItem = lastDetectedUngradedList[0];
    const targetType = firstItem.rawType || (firstItem.type.includes('预习') ? 'preview' : (firstItem.type.includes('笔记') ? 'note' : (firstItem.type.includes('课堂') ? 'class_test' : 'homework')));
    const targetIndex = (firstItem.fileIndex !== undefined && firstItem.fileIndex !== null) ? firstItem.fileIndex : 'all';

    if (typeof previewUploadedFile === 'function') {
        previewUploadedFile(targetType, targetIndex);
        setTimeout(() => {
            if (typeof togglePreviewEditMode === 'function') {
                togglePreviewEditMode(true);
            }
            showToast('已进入编辑模式，可在【作业状态】下拉框中调整');
        }, 180);
    }
};

window.checkUngradedSubmissions = checkUngradedSubmissions;
window.showUngradedSubmissionsModal = showUngradedSubmissionsModal;
window.closeUngradedSubmissionsModal = closeUngradedSubmissionsModal;

// ========== Button State ==========
function checkNextButton() {
    if (!nextStep1Btn) return;
    
    const hasSubject = !!selectedSubject;
    const hasHomework = hasPrimaryHomeworkData();
    const needsPhysicsSource = selectedSubject === '物理' && !isVacationSeason(window.defaultSeason);
    const hasPhysicsSource = !!physicsPreviewSource;
    
    if (!hasSubject && !hasHomework) {
        nextStep1Btn.disabled = true;
        nextStep1Btn.title = '请先选择学科并上传作业';
    } else if (!hasSubject) {
        nextStep1Btn.disabled = true;
        nextStep1Btn.title = '请先选择学科';
    } else if (needsPhysicsSource && !hasPhysicsSource) {
        nextStep1Btn.disabled = true;
        nextStep1Btn.title = '请先选择预习来源';
    } else if (!hasHomework) {
        nextStep1Btn.disabled = true;
        nextStep1Btn.title = `请先上传${isVacationSeason(window.defaultSeason) ? '' : '预习或课后巩固'}作业`;
    } else {
        nextStep1Btn.disabled = false;
        nextStep1Btn.title = '';
    }
}

function hasPrimaryHomeworkData() {
    return !!homeworkData || !!previewData;
}

function getSelectedSubject() {
    return selectedSubject;
}

function getPhysicsPreviewSource() {
    return physicsPreviewSource;
}

function selectFeedbackSubject(btn, subject) {
    selectedSubject = subject;
    Logger.action('subject_selected', { subject });
    Logger.setContext({ subject });
    const group = document.getElementById('feedback-subject-group');
    if (group) {
        group.querySelectorAll('.ui-pill').forEach(chip => {
            chip.classList.remove('active');
        });
    }
    btn.classList.add('active');
    
    // Reset physics preview source when switching subject
    physicsPreviewSource = null;
    const physicsSourceGroup = document.getElementById('physics-source-group');
    if (physicsSourceGroup) {
        physicsSourceGroup.querySelectorAll('.ui-pill').forEach(chip => {
            chip.classList.remove('active');
        });
    }
    
    // Show/hide physics preview source option
    const physicsPreviewSourceDiv = document.getElementById('physics-preview-source');
    if (physicsPreviewSourceDiv) {
        if (subject === '物理' && !isVacationSeason(window.defaultSeason)) {
            physicsPreviewSourceDiv.style.display = '';
        } else {
            physicsPreviewSourceDiv.style.display = 'none';
        }
    }
    
    // Show/hide note upload card based on subject
    const noteCard = document.getElementById('note-card');
    if (noteCard) {
        if (subject === '英语') {
            noteCard.style.display = '';
        } else {
            noteCard.style.display = 'none';
            // Clear note data when switching away from English
            rawNoteFiles = [];
            noteData = null;
            noteFileName = '';
            updateNoteData();
        }
    }

    // Show/hide class-test upload card based on subject
    const classTestCard = document.getElementById('class-test-card');
    if (classTestCard) {
        if (subject === '英语') {
            classTestCard.style.display = '';
        } else {
            classTestCard.style.display = 'none';
            // Clear class-test data when switching away from English
            rawClassTestFiles = [];
            classTestData = null;
            classTestFileName = '';
            updateClassTestData();
        }
    }
    
    // Reset preview file accept type and clear files when switching away from physics
    const previewInput = document.getElementById('preview-file');
    const previewAppendInput = document.getElementById('preview-file-append');
    const dropSecondary = document.querySelector('#preview-drop-zone .drop-secondary');
    if (previewInput) previewInput.accept = '.csv';
    if (previewAppendInput) previewAppendInput.accept = '.csv';
    if (dropSecondary) dropSecondary.textContent = '仅统计错题数，不评分';
    if (rawPreviewFiles.length > 0) {
        rawPreviewFiles = [];
        previewData = null;
        previewFileName = '';
        updatePreviewData();
    }

    updateUploadCardsState(); // Update upload cards state (locks all cards if physics source is pending)
    updatePreviewCommentFieldsRequiredState();
    checkNextButton();
}

function selectPhysicsPreviewSource(btn, source) {
    const previousSource = physicsPreviewSource;
    physicsPreviewSource = source;
    const group = document.getElementById('physics-source-group');
    if (group) {
        group.querySelectorAll('.ui-pill').forEach(chip => {
            chip.classList.remove('active');
        });
    }
    btn.classList.add('active');
    
    // Re-enable all subsequent upload cards once physics source is selected
    updateUploadCardsState();
    updatePreviewCommentFieldsRequiredState();
    
    // Update file accept types and clear files if source changed
    if (previousSource !== source) {
        const previewInput = document.getElementById('preview-file');
        const previewAppendInput = document.getElementById('preview-file-append');
        const dropSecondary = document.querySelector('#preview-drop-zone .drop-secondary');
        if (source === 'wenjuanxing') {
            if (previewInput) previewInput.accept = '.xlsx,.xls';
            if (previewAppendInput) previewAppendInput.accept = '.xlsx,.xls';
            if (dropSecondary) dropSecondary.textContent = '问卷星导出的 XLSX 文件（首行为满分参考卷）';
        } else {
            if (previewInput) previewInput.accept = '.csv';
            if (previewAppendInput) previewAppendInput.accept = '.csv';
            if (dropSecondary) dropSecondary.textContent = '仅统计错题数，不评分';
        }
        // Clear existing preview files if source type changed
        if (previousSource && rawPreviewFiles.length > 0) {
            rawPreviewFiles = [];
            updatePreviewData();
            showToast('已切换预习来源，已清空预习作业文件');
        }
    }
    
    checkNextButton();
}

window.selectFeedbackSubject = selectFeedbackSubject;
window.selectPhysicsPreviewSource = selectPhysicsPreviewSource;

// ========== Wenjuanxing Name Matching ==========
function getHomeworkStudentNames() {
    if (!homeworkData || homeworkData.length < 2) return [];
    const hwHeader = homeworkData[0];
    const nameIdx = hwHeader.findIndex(h => h.includes('姓名'));
    if (nameIdx < 0) return [];
    return homeworkData.slice(1)
        .map(r => {
            const fullName = (r[nameIdx] || '').trim();
            const match = fullName.match(/\d+(.+)/);
            return match ? match[1] : fullName;
        })
        .filter(n => n);
}

function getWenjuanxingNames() {
    if (!previewData || previewData.length < 2) return [];
    const header = previewData[0].map(h => String(h).trim());
    const nameIdx = header.findIndex(h => h.includes('您的姓名') || (h.includes('姓名') && !h.includes('时间')));
    if (nameIdx < 0) return [];
    let rows = previewData.slice(1);
    // 若首行为满分标定卷，排除首行（老师本人），避免其出现在姓名修改弹窗中
    if (physicsPreviewSource === 'wenjuanxing' && typeof getWenjuanxingBenchmark === 'function') {
        const bm = getWenjuanxingBenchmark(previewData);
        if (bm && bm.isR1Benchmark) {
            rows = rows.slice(1);
        }
    }
    return rows
        .map(r => String(r[nameIdx] || '').trim())
        .filter(n => n);
}

function checkWenjuanxingNameMatches() {
    const hwNames = getHomeworkStudentNames();
    const wjxNames = getWenjuanxingNames();
    if (hwNames.length === 0 || wjxNames.length === 0) return;
    
    const hwNameSet = new Set(hwNames);
    const unmatched = wjxNames.filter(name => !hwNameSet.has(name));
    
    if (unmatched.length === 0) return;
    
    // Build the modal content
    const modal = document.getElementById('wjx-name-modal');
    const body = document.getElementById('wjx-name-body');
    if (!modal || !body) return;
    
    // Create a datalist with homework student names for suggestions
    let html = `<datalist id="wjx-hw-names">`;
    hwNames.forEach(name => {
        html += `<option value="${name}">`;
    });
    html += `</datalist>`;
    
    unmatched.forEach((name, idx) => {
        html += `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; padding:8px 12px; background:var(--ui-fill-weak); border:1px solid var(--border-light); border-radius:var(--radius-sm);">
            <span style="flex:0 0 auto; font-size:0.82rem; color:var(--text-secondary); min-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${name}">${name}</span>
            <svg style="flex:0 0 16px; width:16px; height:16px; color:var(--text-tertiary);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            <input type="text" class="modern-input wjx-name-fix" 
                data-original="${name}" 
                list="wjx-hw-names"
                placeholder="请输入正确姓名" 
                style="flex:1; font-size:0.82rem; padding:6px 10px;">
        </div>`;
    });
    
    body.innerHTML = html;
    openNativeDialog(modal, { dismissible: true });
}

function closeWjxNameModal() {
    closeNativeDialog('wjx-name-modal');
}

function applyWjxNameFixes() {
    const inputs = document.querySelectorAll('.wjx-name-fix');
    const fixes = {};
    let hasChanges = false;
    
    inputs.forEach(input => {
        const original = input.dataset.original;
        const newName = input.value.trim();
        if (newName && newName !== original) {
            fixes[original] = newName;
            hasChanges = true;
        }
    });
    
    if (!hasChanges) {
        closeWjxNameModal();
        return;
    }
    
    // Find the name column in preview data
    const header = previewData[0].map(h => String(h).trim());
    const nameIdx = header.findIndex(h => h.includes('您的姓名'));
    if (nameIdx < 0) {
        closeWjxNameModal();
        return;
    }
    
    // Apply fixes to rawPreviewFiles
    let fixCount = 0;
    rawPreviewFiles.forEach(file => {
        file.data.forEach((row, rowIdx) => {
            if (rowIdx === 0) return; // skip header
            const cellValue = String(row[nameIdx] || '').trim();
            if (fixes[cellValue]) {
                row[nameIdx] = fixes[cellValue];
                fixCount++;
            }
        });
        // Regenerate CSV text
        file.text = file.data.map(row => row.map(cell => {
            const s = String(cell);
            return s.includes(',') || s.includes('"') || s.includes('\n')
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',')).join('\n');
    });
    
    // Rebuild preview data  
    const newHeader = rawPreviewFiles[0].data[0];
    let allRows = [];
    rawPreviewFiles.forEach(file => {
        if (file.data.length > 1) allRows.push(...file.data.slice(1));
    });
    previewData = [newHeader, ...allRows];
    
    closeWjxNameModal();
    showToast(`已修改 ${fixCount} 个姓名`);
    
    // Re-check if there are still unmatched names
    setTimeout(() => {
        checkWenjuanxingNameMatches();
    }, 500);
}

window.closeWjxNameModal = closeWjxNameModal;
window.applyWjxNameFixes = applyWjxNameFixes;

// ========== Lesson Number Extraction ==========
function extractLessonNumber(fileName, type) {
    if (type === 'homework' || type === 'preview' || type === 'note' || type === 'class_test') {
        // Match 专题X pattern (e.g. 专题二, 专题三)
        const chineseMatch = fileName.match(/专题([一二三四五六七八九十百]+)/);
        if (chineseMatch) {
            return chineseToNumber(chineseMatch[1]);
        }
        // Match 专题 + arabic number
        const arabicMatch = fileName.match(/专题(\d+)/);
        if (arabicMatch) {
            return parseInt(arabicMatch[1]);
        }
        // Match physics patterns like 9P-8, 9PS06, 9P08, 8P-3, 26PS06
        const physicsMatch = fileName.match(/(?:[789]\s*P\s*S?|PS)[-_]?0*(\d+)/i);
        if (physicsMatch) {
            return parseInt(physicsMatch[1]);
        }
        // Fallback: 第X次作业 pattern
        const lessonChinese = fileName.match(/第([一二三四五六七八九十百]+)[次周]/);
        if (lessonChinese) {
            return chineseToNumber(lessonChinese[1]);
        }
        const lessonArabic = fileName.match(/第(\d+)[次周]/);
        if (lessonArabic) {
            return parseInt(lessonArabic[1]);
        }
    } else if (type === 'report') {
        const match = fileName.match(/-(\d+)统计报告/);
        if (match) {
            return parseInt(match[1]);
        }
        // Also try matching lesson number from report name like 25秋8MS+31（超人孙）-3统计报告
        const match2 = fileName.match(/[）)]-(\d+)/);
        if (match2) {
            return parseInt(match2[1]);
        }
    }
    return '';
}

function chineseToNumber(chinese) {
    const digitMap = {
        '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
        '六': 6, '七': 7, '八': 8, '九': 9
    };
    if (digitMap[chinese] !== undefined) {
        return digitMap[chinese];
    }
    if (chinese === '十') return 10;
    if (chinese.startsWith('十')) {
        const rest = chinese.substring(1);
        return 10 + (digitMap[rest] || 0);
    }
    const tenIndex = chinese.indexOf('十');
    if (tenIndex > 0) {
        const tens = digitMap[chinese.charAt(0)] || 0;
        const ones = tenIndex < chinese.length - 1 ? (digitMap[chinese.charAt(tenIndex + 1)] || 0) : 0;
        return tens * 10 + ones;
    }
    return 1;
}

// ========== Generate Feedback ==========
function generateFeedback() {
    if (!selectedSubject) {
        showToast('请选择反馈学科');
        return;
    }
    if (!hasPrimaryHomeworkData()) {
        showToast(`请先上传${isVacationSeason(window.defaultSeason) ? '' : '课前预习或课后巩固'}作业数据`);
        goToStep(1);
        return;
    }
    const isWenjuanxing = physicsPreviewSource === 'wenjuanxing';
    // 问卷星预习已自动匹配错题与得分，5个阶段评语改为选填；其他学科或非问卷星维持必填
    if (previewCommentSource === 'manual' && previewData && !isWenjuanxing) {
        if (!previewCommentFullInput.value.trim() ||
            !previewCommentTop20Input.value.trim() ||
            !previewCommentAboveAvgInput.value.trim() ||
            !previewCommentBelowAvgInput.value.trim() ||
            !previewCommentZeroInput.value.trim()) {
            showToast('请完整填写课前预习固定评语');
            return;
        }
    }
    if (homeworkCommentSource === 'manual' && homeworkData) {
        if (!homeworkCommentFullInput.value.trim() ||
            !homeworkCommentTop20Input.value.trim() ||
            !homeworkCommentAboveAvgInput.value.trim() ||
            !homeworkCommentBelowAvgInput.value.trim() ||
            !homeworkCommentZeroInput.value.trim()) {
            showToast('请完整填写各分数段评语');
            return;
        }
    }
    const previewMetricMode = isWenjuanxing ? 'score_rank' : (document.querySelector('input[name="preview-metric-mode"]:checked')?.value || 'score_rank');
    const previewTotalEl = document.getElementById('preview-total-questions');
    const previewTotalQuestions = previewTotalEl ? parseInt(previewTotalEl.value) || 0 : 0;
    if (!isWenjuanxing && previewData && previewMetricMode === 'correct_count' && previewTotalQuestions <= 0) {
        showToast('选择正确题数统计时，请填写总题数');
        return;
    }
    // For wenjuanxing, force preview comment source to manual
    if (isWenjuanxing && previewData) {
        previewCommentSource = 'manual';
    }
    const plusEnabled = document.getElementById('plus-enabled')?.checked;
    if (plusEnabled) {
        const pGrade = document.getElementById('plus-grade')?.value;
        const pTier = document.getElementById('plus-tier')?.value;
        const pWeek = document.getElementById('plus-week')?.value;
        const pPreviewWeek = document.getElementById('plus-preview-week')?.value;
        if (!pGrade) {
            showToast('启用错题本时，请先选择年级');
            return;
        }
        if (!pTier) {
            showToast('启用错题本时，请先选择班层');
            return;
        }
        if (!pWeek && !pPreviewWeek) {
            showToast('启用错题本时，请选择预习专题或课后巩固专题');
            return;
        }
        if (!getPlusPayload()) {
            showToast('请先选择有效的题目知识点数据');
            return;
        }
    }
    
    // Validate focus score comments if custom mode is enabled
    if (focusCommentSource === 'custom') {
        const focusComments = getFocusComments();
        const maxScore = focusMaxScore;
        for (let score = maxScore; score >= 0; score--) {
            if (!focusComments[score] || !focusComments[score].trim()) {
                showToast(`请填写${score}分的专注度评语`);
                return;
            }
        }
    }
    
    // 关键拦截校验：检查是否有交了但老师没改的作业（状态为【已提交】）
    const ungradedList = checkUngradedSubmissions();
    if (ungradedList && ungradedList.length > 0) {
        showUngradedSubmissionsModal(ungradedList);
        return;
    }

    // 检查错题评语规范性（标准格式：本次作业的错题题号为：）
    const nonStandardList = checkCommentPrefixStandards();
    if (nonStandardList && nonStandardList.length > 0) {
        showCommentFormatModal(nonStandardList);
        return;
    }

    proceedToLessonConfirm();
}

// ========== 错题评语规范性检测与一键纠正 ==========
let currentNonStandardList = [];

function parseScoreValue(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
    const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw).trim());
    if (isNaN(parsed)) return null;
    if (typeof shouldForceIntegerScores === 'function' && shouldForceIntegerScores()) {
        return Math.round(parsed);
    }
    return Math.round(parsed);
}
if (typeof window !== 'undefined') {
    window.parseScoreValue = parseScoreValue;
}

function checkCommentPrefixStandards() {
    if (!homeworkData || homeworkData.length <= 1) return [];

    const hwHeader = homeworkData[0];
    const nameIdx = hwHeader.findIndex(h => h.includes('姓名'));
    const scoreIdx = hwHeader.findIndex(h => h.includes('得分'));
    const commentIdx = findCommentColumnIndex(hwHeader, '批改评语');
    const correctionCommentIdx = findCommentColumnIndex(hwHeader, '订正评语');
    const hwStatusIdx = hwHeader.findIndex(h => h.includes('作业状态'));
    if (nameIdx < 0 || (commentIdx < 0 && correctionCommentIdx < 0)) return [];

    const nonStandardList = [];
    const STANDARD_PREFIX_REGEX = /^本次作业的错题题号为\s*[:：]/;
    const errorPrefixFuzzy = /^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/i;
    const pureNumbersRegex = /^(?:第?\s*\d+\s*题?[,，、\s/；;和与及\-]+)*第?\s*\d+\s*题?\s*[。.]?$/;

    for (let r = 1; r < homeworkData.length; r++) {
        const row = homeworkData[r];
        const fullName = (row[nameIdx] || '').trim();
        if (!fullName) continue;

        const status = hwStatusIdx >= 0 ? (row[hwStatusIdx] || '') : '';
        const isSubmitted = (typeof isHomeworkSubmitted === 'function')
            ? isHomeworkSubmitted(status, { emptyAsSubmitted: true })
            : (status.includes('已完成') || status.includes('待订正') || status.includes('已订正') || status.includes('已审阅') || !status);
        if (!isSubmitted) continue;

        const rawScore = (typeof parseScoreValue === 'function')
            ? parseScoreValue(row[scoreIdx])
            : (row[scoreIdx] !== null && row[scoreIdx] !== undefined && row[scoreIdx] !== '' && row[scoreIdx] !== '-'
                ? Math.round(parseFloat(String(row[scoreIdx]).trim()) || 0)
                : null);
        const score = rawScore !== null ? rawScore : 0;
        const originalComment = commentIdx >= 0 ? String(row[commentIdx] || '').trim() : '';
        const correctionComment = correctionCommentIdx >= 0 ? String(row[correctionCommentIdx] || '').trim() : '';
        // 最终展示评语以订正评语优先；格式校验也应针对最终评语，避免原评语误拦截。
        const rawComment = correctionComment || originalComment;
        if (!rawComment) continue;
        const targetCommentIdx = correctionComment ? correctionCommentIdx : commentIdx;
        const targetColumn = correctionComment ? 'correction' : 'original';

        // 全角数字自动转半角（如 "２，５，６" -> "2，5，6"），同步规范数据
        const comment = rawComment.replace(/[\uff10-\uff19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
        if (comment !== rawComment) {
            row[targetCommentIdx] = comment;
        }

        const lines = comment.split('\n');
        const firstLine = lines[0].trim();

        // 1. 完全符合标准规范前缀：放行
        if (STANDARD_PREFIX_REGEX.test(firstLine)) {
            continue;
        }

        // 2. 存在错题前缀语义，但有一个字或多个字对不上，或漏掉了冒号
        const fuzzyMatch = firstLine.match(errorPrefixFuzzy);
        if (fuzzyMatch) {
            let reason = '格式存在偏差，不符合统一标准';
            const hasColon = firstLine.includes(':') || firstLine.includes('：');

            if (!hasColon) {
                if (firstLine.startsWith('本次作业的错题题号为')) {
                    reason = '缺少冒号“：”';
                } else if (firstLine.startsWith('本次作业的错题为')) {
                    reason = '缺少“题号”二字且缺少冒号“：”';
                } else if (firstLine.startsWith('本次的作业的错题为')) {
                    reason = '多写“的”字，缺少“题号”且缺少冒号“：”';
                } else if (firstLine.startsWith('本次作业错题')) {
                    reason = '缺少“的”、“题号”、“为”且缺少冒号“：”';
                } else if (firstLine.startsWith('错题为') || firstLine.startsWith('错题题号为')) {
                    reason = '缺少“本次作业的”前缀且缺少冒号“：”';
                } else {
                    reason = '缺少冒号“：”且前缀不符合标准';
                }
            } else if (firstLine.startsWith('本次作业的错题为')) {
                reason = '缺少“题号”二字';
            } else if (firstLine.startsWith('本次的作业的错题为')) {
                reason = '多写“的”字且缺少“题号”';
            } else if (firstLine.startsWith('本次作业错题')) {
                reason = '缺少“的”、“题号”、“为”';
            } else if (firstLine.startsWith('错题为') || firstLine.startsWith('错题：') || firstLine.startsWith('错题:')) {
                reason = '缺少“本次作业的”前缀';
            } else if (firstLine.includes('题号是')) {
                reason = '“是”应规范为“为”';
            } else if (firstLine.startsWith('本次作业的错题题号') && !firstLine.startsWith('本次作业的错题题号为')) {
                reason = '缺少“为”字';
            } else if (firstLine.includes('做错的题为')) {
                reason = '非标准前缀“做错的题为”';
            }

            const afterColon = fuzzyMatch[1].trim();
            const standardLine = `本次作业的错题题号为：${afterColon}`;
            const remainingLines = lines.slice(1).join('\n');
            const newComment = remainingLines ? `${standardLine}\n${remainingLines}` : standardLine;

            nonStandardList.push({
                rowIndex: r,
                studentName: fullName,
                currentFirstLine: firstLine,
                suggestedFirstLine: standardLine,
                fullComment: comment,
                suggestedFullComment: newComment,
                reason: reason,
                type: 'prefix_deviation',
                targetColumn: targetColumn
            });
            continue;
        }

        // 3. 首行直接写了纯题号，未写前缀
        if (pureNumbersRegex.test(firstLine)) {
            const standardLine = `本次作业的错题题号为：${firstLine}`;
            const remainingLines = lines.slice(1).join('\n');
            const newComment = remainingLines ? `${standardLine}\n${remainingLines}` : standardLine;

            nonStandardList.push({
                rowIndex: r,
                studentName: fullName,
                currentFirstLine: firstLine,
                suggestedFirstLine: standardLine,
                fullComment: comment,
                suggestedFullComment: newComment,
                reason: '未写标准前缀，首行直接写了题号',
                type: 'pure_numbers',
                targetColumn: targetColumn
            });
            continue;
        }

        // 4. 非满分学生（<100）且评语中出现题号，但首行缺少声明
        if (score < 100 && /第\s*\d+\s*题/.test(comment)) {
            const matchedNums = [...new Set((comment.match(/第\s*(\d+)\s*题/g) || []).map(s => s.replace(/\D/g, '')))];
            if (matchedNums.length > 0) {
                const standardLine = `本次作业的错题题号为：${matchedNums.join('，')}`;
                const newComment = `${standardLine}\n${comment}`;
                nonStandardList.push({
                    rowIndex: r,
                    studentName: fullName,
                    currentFirstLine: firstLine,
                    suggestedFirstLine: standardLine,
                    fullComment: comment,
                    suggestedFullComment: newComment,
                    reason: `非满分(${score}分)且评语提及题号，首行缺少标准前缀`,
                    type: 'missing_prefix',
                    targetColumn: targetColumn
                });
            }
        }
    }

    return nonStandardList;
}

function showCommentFormatModal(nonStandardList) {
    currentNonStandardList = nonStandardList;
    const modal = document.getElementById('comment-format-modal');
    const body = document.getElementById('comment-format-body');
    if (!modal || !body) return;

    let html = `
        <div style="margin-bottom: 12px; padding: 10px 14px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
            共检测到 <b style="color: #f59e0b; font-size: 0.95rem;">${nonStandardList.length}</b> 位学生的评语不符合团队标准（格式只要有一个字对不上，系统都会提醒并督促统一规范）。您可选择<strong>一键纠正</strong>自动替换首行为标准格式，或<strong>保持原样</strong>继续。
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
    `;

    nonStandardList.forEach(item => {
        html += `
            <div style="padding: 10px 12px; border-radius: 8px; background: var(--ui-fill-weak); border: 1px solid var(--border-light);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(item.studentName)}</span>
                    <span style="font-size: 0.78rem; color: #f59e0b; background: rgba(245, 158, 11, 0.12); padding: 2px 8px; border-radius: 12px; font-weight: 500;">${escapeHtml(item.reason)}</span>
                </div>
                <div style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 5px; display: flex; align-items: baseline; gap: 6px;">
                    <span style="min-width: 62px; color: var(--text-tertiary); font-size: 0.78rem;">当前首行:</span>
                    <code style="color: #ef4444; background: rgba(239, 68, 68, 0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; word-break: break-all;">${escapeHtml(item.currentFirstLine)}</code>
                </div>
                <div style="font-size: 0.82rem; color: var(--text-secondary); display: flex; align-items: baseline; gap: 6px;">
                    <span style="min-width: 62px; color: var(--text-tertiary); font-size: 0.78rem;">规范建议:</span>
                    <code style="color: #10b981; background: rgba(16, 185, 129, 0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-weight: 600; word-break: break-all;">${escapeHtml(item.suggestedFirstLine)}</code>
                </div>
            </div>
        `;
    });

    html += `</div>`;
    body.innerHTML = html;
    openNativeDialog(modal, { dismissible: true });
}

function closeCommentFormatModal() {
    closeNativeDialog('comment-format-modal');
}

function autoFixCommentStandardsAndGenerate() {
    if (!currentNonStandardList || currentNonStandardList.length === 0) {
        closeCommentFormatModal();
        showLessonConfirmModal();
        return;
    }

    let fixCount = 0;
    const fixMap = new Map();
    currentNonStandardList.forEach(item => {
        fixMap.set(item.studentName, item);
    });

    // 1. 更新各已加载文件中的数据行与文本内容
    rawHomeworkFiles.forEach(file => {
        if (!file.data || file.data.length <= 1) return;
        const fHeader = file.data[0];
        const fNameIdx = fHeader.findIndex(h => h.includes('姓名'));
        const fCommentIdx = findCommentColumnIndex(fHeader, '批改评语');
        const fCorrectionCommentIdx = findCommentColumnIndex(fHeader, '订正评语');
        if (fNameIdx < 0) return;

        let fileModified = false;
        for (let i = 1; i < file.data.length; i++) {
            const rowName = (file.data[i][fNameIdx] || '').trim();
            const fixItem = fixMap.get(rowName);
            if (fixItem) {
                const targetIdx = fixItem.targetColumn === 'correction' ? fCorrectionCommentIdx : fCommentIdx;
                if (targetIdx < 0) continue;
                file.data[i][targetIdx] = fixItem.suggestedFullComment;
                fileModified = true;
                fixCount++;
            }
        }

        if (fileModified) {
            file.text = serializeCSV(file.data);
        }
    });

    // 2. 重新汇总并刷新内存 homeworkData
    updateHomeworkData();

    closeCommentFormatModal();
    showToast(`已自动纠正 ${fixCount} 位学生的评语格式为统一标准`);
    proceedToLessonConfirm();
}

function ignoreCommentFormatAndGenerate() {
    closeCommentFormatModal();
    proceedToLessonConfirm();
}

// ========== 开启错题本时：课后巩固已提交、非满分但无错题号检测 ==========
let currentMissingErrorsList = [];

function hasErrorQuestionNumbers(comment) {
    if (!comment || !comment.trim()) return false;
    const trimmed = comment.trim();
    // 显式无错题声明
    const firstLine = trimmed.split('\n')[0].trim();
    if (/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错|错误)?(?:题号|序号|编号)?(?:为|是)?\s*[:：]\s*(?:无|没有|0|零|全对|无错题|全部正确|都对|暂无|none)\s*[。!！.]?\s*$/i.test(firstLine)) {
        return false;
    }
    // 标准前缀后存在题号数字
    if (/本次作业的错题题号为\s*[:：]?\s*[\d\s,，、；;和与及\-]+/i.test(trimmed) && /\d+/.test(trimmed)) {
        return true;
    }
    // 模糊错题/做错/失分/扣分前缀后跟数字或字母题号
    if (/(?:错题|做错|做错的题|失分|扣分)(?:题号|序号)?(?:为|是)?\s*[:：]?\s*[a-zA-Z0-9\s,，、；;和与及\-]+/i.test(trimmed) && /\d+/.test(trimmed)) {
        return true;
    }
    // 明确提及题号格式（如 "第2题", "题3", "T1", "Q2"）
    if (/(?:第\s*\d+\s*题|题\s*\d+|[tTqQ]\s*\d+)/.test(trimmed)) {
        return true;
    }
    // 首行纯数字/题号列表（如 "1, 3, 5"、"第2题、第4题"、"T1、T3"）
    const pureNumsRegex = /^(?:(?:第|T|t|q|Q)?\s*\d+\s*题?[,，、\s/；;和与及\-]+)*(?:第|T|t|q|Q)?\s*\d+\s*题?\s*[。.]?$/;
    if (pureNumsRegex.test(firstLine) && /\d+/.test(firstLine)) {
        return true;
    }
    return false;
}

function checkMissingErrorQuestions() {
    if (!homeworkData || homeworkData.length <= 1) return [];
    const plusEnabled = document.getElementById('plus-enabled')?.checked;
    if (!plusEnabled) return [];

    const hwHeader = homeworkData[0];
    const nameIdx = hwHeader.findIndex(h => h.includes('姓名'));
    const scoreIdx = hwHeader.findIndex(h => h.includes('得分'));
    const commentIdx = findCommentColumnIndex(hwHeader, '批改评语');
    const correctionCommentIdx = findCommentColumnIndex(hwHeader, '订正评语');
    const hwStatusIdx = hwHeader.findIndex(h => h.includes('作业状态'));
    const totalScoreIdx = hwHeader.findIndex(h => h.includes('满分') || h.includes('总分'));
    const accIdx = hwHeader.findIndex(h => h.includes('正确率') || h.includes('正答率'));
    if (nameIdx < 0 || scoreIdx < 0) return [];

    // 通过分数和正确率大致推算满分，一般为100分
    const standardTotal = (typeof estimateHomeworkTotalScore === 'function') 
        ? estimateHomeworkTotalScore(homeworkData) 
        : 100;

    const missingList = [];
    for (let r = 1; r < homeworkData.length; r++) {
        const row = homeworkData[r];
        const fullName = (row[nameIdx] || '').trim();
        if (!fullName) continue;

        const status = hwStatusIdx >= 0 ? (row[hwStatusIdx] || '').trim() : '';
        // 未交（未提交/缺交/缺勤/未交/未查阅/已查阅）与未批改均视为无有效批改，不提醒补错题号
        const isUnsubmitted = (typeof isStatusUnsubmitted === 'function' && isStatusUnsubmitted(status))
            || (typeof isStatusUngraded === 'function' && isStatusUngraded(status))
            || status.includes('未提交') || status.includes('缺交') || status.includes('缺勤') || status === '未交'
            || status.includes('未查阅') || status.includes('已查阅') || status.includes('批改中');
        if (isUnsubmitted) continue;

        const rawScore = parseScoreValue(row[scoreIdx]);
        if (rawScore === null && !status) continue;
        const score = rawScore !== null ? rawScore : 0;
        const accVal = accIdx >= 0 ? parsePercentValue(row[accIdx]) : null;
        const originalComment = commentIdx >= 0 ? String(row[commentIdx] || '').trim() : '';
        const correctionComment = correctionCommentIdx >= 0 ? String(row[correctionCommentIdx] || '').trim() : '';
        const effectiveComment = correctionComment || originalComment;

        // 判断是否满分或文字标明全对（原评语或最终评语任一明确全对即可）
        const totScoreVal = totalScoreIdx >= 0 ? parseScoreValue(row[totalScoreIdx]) : standardTotal;
        const fullScoreComment = [originalComment, effectiveComment].filter(Boolean).join('\n');
        const isFullScore = (typeof checkStudentFullScore === 'function')
            ? checkStudentFullScore({ score, accuracy: accVal, totalScore: totScoreVal, comment: fullScoreComment })
            : ((score >= 100 || (totScoreVal && score >= totScoreVal && score > 0)) || /全对|全部正确|满分|零失误|无错题|免除加练/i.test(fullScoreComment));
        if (isFullScore) continue;

        // 提交了且不是满分，检查原评语或订正评语中是否有错题题号
        if (!hasErrorQuestionNumbers(originalComment) && !hasErrorQuestionNumbers(effectiveComment)) {
            missingList.push({
                rowIndex: r,
                studentName: fullName,
                score: score,
                totalScore: totScoreVal || standardTotal,
                comment: effectiveComment || '（未填写评语）'
            });
        }
    }

    return missingList;
}

function showMissingErrorsModal(missingList) {
    currentMissingErrorsList = missingList;
    const modal = document.getElementById('missing-errors-modal');
    const body = document.getElementById('missing-errors-body');
    if (!modal || !body) return;

    let html = `
        <div style="margin-bottom: 12px; padding: 10px 14px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
            共检测到 <b style="color: #f59e0b; font-size: 0.95rem;">${missingList.length}</b> 位学生<strong>已提交课后巩固且非满分</strong>，但在原批改评语或订正评语中<strong>未检测到错题题号</strong>。若继续生成，这些学生将无法匹配错题与专属微课。
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
    `;

    missingList.forEach(item => {
        html += `
            <div style="padding: 10px 12px; border-radius: 8px; background: var(--ui-fill-weak); border: 1px solid var(--border-light);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(item.studentName)}</span>
                    <span style="font-size: 0.8rem; color: #ef4444; background: rgba(239, 68, 68, 0.12); padding: 2px 8px; border-radius: 12px; font-weight: 600; font-family: monospace;">
                        得分: ${item.score} / ${item.totalScore}
                    </span>
                </div>
                <div style="font-size: 0.82rem; color: var(--text-secondary); display: flex; align-items: flex-start; gap: 6px;">
                    <span style="min-width: 62px; color: var(--text-tertiary); font-size: 0.78rem;">当前评语:</span>
                    <span style="color: var(--text-secondary); font-size: 0.82rem; word-break: break-all; max-height: 48px; overflow-y: auto;">
                        ${escapeHtml(item.comment)}
                    </span>
                </div>
            </div>
        `;
    });

    html += `</div>`;
    body.innerHTML = html;
    openNativeDialog(modal, { dismissible: true });
}

function closeMissingErrorsModal() {
    closeNativeDialog('missing-errors-modal');
}

function ignoreMissingErrorsAndContinue() {
    closeMissingErrorsModal();
    showLessonConfirmModal();
}

function proceedToLessonConfirm() {
    const plusEnabled = document.getElementById('plus-enabled')?.checked;
    if (plusEnabled) {
        const missingErrorsList = checkMissingErrorQuestions();
        if (missingErrorsList && missingErrorsList.length > 0) {
            showMissingErrorsModal(missingErrorsList);
            return;
        }
    }
    showLessonConfirmModal();
}

function serializeCSV(rows) {
    if (!rows || rows.length === 0) return '';
    return rows.map(row => {
        return (row || []).map(cell => {
            const str = String(cell === null || cell === undefined ? '' : cell);
            if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(',');
    }).join('\r\n');
}

function showLessonConfirmModal() {
    const modal = document.getElementById('lesson-confirm-modal');
    const previewInput = document.getElementById('confirm-preview-lesson');
    const homeworkInput = document.getElementById('confirm-homework-lesson');
    const reportInput = document.getElementById('confirm-report-lesson');
    const noteInput = document.getElementById('confirm-note-lesson');
    const classTestInput = document.getElementById('confirm-class-test-lesson');
    const previewSource = document.getElementById('confirm-preview-source');
    const homeworkSource = document.getElementById('confirm-homework-source');
    const reportSource = document.getElementById('confirm-report-source');
    const noteSource = document.getElementById('confirm-note-source');
    const classTestSource = document.getElementById('confirm-class-test-source');
    const previewRow = document.getElementById('confirm-preview-row');
    const homeworkRow = document.getElementById('confirm-homework-row');
    const reportRow = document.getElementById('confirm-report-row');
    const noteRow = document.getElementById('confirm-note-row');
    const classTestRow = document.getElementById('confirm-class-test-row');

    // Homework (consolidation)
    if (homeworkData) {
        homeworkRow.style.display = 'flex';
        const autoHomeworkLesson = extractLessonNumber(homeworkFileName, 'homework');
        homeworkSource.textContent = `自动识别自 "${homeworkFileName}"`;
        homeworkInput.value = autoHomeworkLesson;
    } else {
        homeworkRow.style.display = 'none';
    }

    // Preview
    if (previewData) {
        previewRow.style.display = 'flex';
        if (physicsPreviewSource === 'wenjuanxing') {
            // Wenjuanxing filenames don't contain lesson info, default to homework + 1
            let hwLessonStr = homeworkData ? extractLessonNumber(homeworkFileName, 'homework') : 1;
            let hwLesson = parseInt(hwLessonStr);
            previewInput.value = !isNaN(hwLesson) ? hwLesson + 1 : '';
            previewSource.textContent = `默认为${getUploadHomeworkLabelFull()}${getUploadLessonUnit()}次 + 1（问卷星）`;
        } else {
            const autoPreviewLesson = extractLessonNumber(previewFileName, 'preview');
            previewInput.value = autoPreviewLesson;
            previewSource.textContent = `自动识别自 "${previewFileName}"`;
        }
    } else {
        previewRow.style.display = 'none';
    }

    // Report
    if (reportData) {
        reportRow.style.display = 'flex';
        const autoReportLesson = extractLessonNumber(reportFileName, 'report');
        reportInput.value = autoReportLesson;
        reportSource.textContent = `自动识别自 "${reportFileName}"`;
    } else {
        reportRow.style.display = 'none';
    }

    // Note (only for English subject)
    if (selectedSubject === '英语' && noteData) {
        noteRow.style.display = 'flex';
        const autoNoteLesson = extractLessonNumber(noteFileName, 'note');
        noteInput.value = autoNoteLesson;
        noteSource.textContent = `自动识别自 "${noteFileName}"`;
    } else {
        noteRow.style.display = 'none';
    }

    // Class Test (only for English subject)
    if (selectedSubject === '英语' && classTestData) {
        if (classTestRow) classTestRow.style.display = 'flex';
        const autoClassTestLesson = extractLessonNumber(classTestFileName, 'class_test');
        if (classTestInput) classTestInput.value = autoClassTestLesson;
        if (classTestSource) classTestSource.textContent = `自动识别自 "${classTestFileName}"`;
    } else {
        if (classTestRow) classTestRow.style.display = 'none';
    }

    openNativeDialog(modal, { dismissible: true });
}

function closeConfirmModal() {
    closeNativeDialog('lesson-confirm-modal');
}

function getUploadClassInfo() {
    let subject = getSelectedSubject();
    let grade = document.getElementById('plus-grade')?.value || '';
    let tier = document.getElementById('plus-tier')?.value || '';
    const confirmHomeworkInput = document.getElementById('confirm-homework-lesson');
    let week = confirmHomeworkInput?.value ? parseInt(confirmHomeworkInput.value) : (extractLessonNumber(homeworkFileName, 'homework') || 1);

    // 若班层/年级未显式从 Plus 选择器获取，则智能从检测班级名称或文件名提取
    const textToScan = [detectedClassName, homeworkFileName, previewFileName, rosterFileName].filter(Boolean).join(' ');
    
    if (!grade) {
        const gradeMatch = textToScan.match(/(七年级先学|高一先学|七年级|八年级|九年级|初一|初二|初三|高一|高二|高三)/);
        if (gradeMatch) {
            const map = { '初一': '七年级', '初二': '八年级', '初三': '九年级' };
            grade = map[gradeMatch[1]] || gradeMatch[1];
        }
    }
    if (!tier) {
        const tierMatch = textToScan.match(/(S\+|A\+|S|A|U)(?:班)?/i);
        if (tierMatch) {
            tier = tierMatch[1].toUpperCase();
        }
    }

    return {
        subject,
        grade,
        tier,
        week,
        year: window.semesterYear || 2026,
        season: window.defaultSeason || 'autumn'
    };
}

function getIncomingStudentsList() {
    if (!homeworkData || homeworkData.length <= 1) return [];
    const hwHeader = homeworkData[0];
    const nameIdx = hwHeader.findIndex(h => String(h).includes('姓名'));
    const idIdx = hwHeader.findIndex(h => String(h).includes('学号') || String(h).includes('编号') || String(h).includes('卡号'));
    const scoreIdx = hwHeader.findIndex(h => String(h).includes('得分'));
    const commentIdx = findCommentColumnIndex(hwHeader, '批改评语');
    const correctionCommentIdx = findCommentColumnIndex(hwHeader, '订正评语');
    const hwStatusIdx = hwHeader.findIndex(h => String(h).includes('作业状态'));

    const list = [];
    for (let r = 1; r < homeworkData.length; r++) {
        const row = homeworkData[r];
        const fullName = (row[nameIdx] || '').trim();
        if (!fullName) continue;

        if (hwStatusIdx >= 0) {
            const status = row[hwStatusIdx] || '';
            const isGraded = (typeof isStatusGraded === 'function')
                ? isStatusGraded(status)
                : (status.includes('已完成') || status.includes('待订正') || status.includes('已订正') || status.includes('已审阅'));
            if (status && !isGraded) {
                continue;
            }
        }

        const nameMatch = fullName.match(/\d+(.+)/);
        const studentName = nameMatch ? nameMatch[1].trim() : fullName;

        // 学号是错题本身份的关键维度：优先取“学号”列，缺失时取姓名前缀数字
        let studentId = '';
        if (idIdx >= 0 && row[idIdx] !== undefined && row[idIdx] !== null && String(row[idIdx]).trim() !== '') {
            studentId = String(row[idIdx]).trim();
        } else {
            const studentIdMatch = fullName.match(/^(\d+)/);
            if (studentIdMatch) studentId = studentIdMatch[1];
        }

        if (detectedDroppedStudents && detectedDroppedStudents.homework && detectedDroppedStudents.homework.includes(studentName)) {
            continue;
        }

        const rawScore = (typeof parseScoreValue === 'function')
            ? parseScoreValue(row[scoreIdx])
            : Math.round(parseFloat(row[scoreIdx]) || 0);
        const score = rawScore !== null ? rawScore : 0;

        const originalComment = commentIdx >= 0 ? String(row[commentIdx] || '').trim() : '';
        const effectiveComment = getEffectiveComment(row, commentIdx, correctionCommentIdx).trim();

        let errorNums = [];
        if (typeof parseCommentForPlus === 'function') {
            const parsed = parseCommentForPlus(originalComment, effectiveComment, { homeworkScore: score });
            errorNums = parsed.errorNums || [];
        } else if (typeof parseErrorQuestionsFromComment === 'function') {
            const parsed = parseErrorQuestionsFromComment(originalComment || effectiveComment, { homeworkScore: score });
            if (parsed && Array.isArray(parsed.errorNums)) {
                errorNums = parsed.errorNums;
            }
        }
        errorNums = Array.from(new Set(errorNums)).sort((a, b) => a - b);

        list.push({
            id: studentId,
            name: studentName,
            score: score,
            errors: errorNums
        });
    }
    return list;
}

function showBatchOverwriteModal(options) {
    const { classInfo, batchData, modifiedStudents, onConfirm, onCancel } = options;
    const { year, season, grade, tier, subject, week } = classInfo;
    const seasonMap = { 'spring': '春季', 'summer': '暑假', 'autumn': '秋季', 'winter': '寒假', '春': '春季', '暑': '暑假', '秋': '秋季', '寒': '寒假' };
    const seasonName = seasonMap[season] || season;
    const classSummary = `${year}年${seasonName} · ${grade} · ${tier}班 · ${subject} · 第${week}周`;
    const operator = batchData.createdByName ? `${batchData.createdByName} (${batchData.createdBy})` : (batchData.createdBy || '未知教师');

    let diffItemsHtml = '';
    (modifiedStudents || []).forEach(m => {
        const parts = [];
        if (m.scoreChanged) {
            parts.push(`得分由 <strong style="color:#94a3b8;">${m.oldScore}分</strong> 变动为 <strong style="color:#38bdf8;">${m.newScore}分</strong>`);
        }
        if (m.errorsChanged) {
            const oldErrStr = (m.oldErrors && m.oldErrors.length > 0) ? `第${m.oldErrors.join(',')}题` : '全对';
            const newErrStr = (m.newErrors && m.newErrors.length > 0) ? `第${m.newErrors.join(',')}题` : '全对';
            parts.push(`错题由 <span style="color:#fca5a5;">${oldErrStr}</span> 变动为 <span style="color:#34d399;">${newErrStr}</span>`);
        }
        diffItemsHtml += `
            <div style="display:flex; align-items:flex-start; gap:8px; padding:7px 10px; background:rgba(255,255,255,0.04); border-radius:6px; border:1px solid rgba(255,255,255,0.07); margin-bottom:5px; font-size:0.83rem; line-height:1.5;">
                <span style="flex-shrink:0; background:rgba(56,189,248,0.18); color:#38bdf8; padding:1px 6px; border-radius:4px; font-weight:600;">修改</span>
                <strong style="color:var(--text-primary,#fff); flex-shrink:0;">${escapeHtml(m.name)}</strong>
                ${m.operator ? `<span style="flex-shrink:0; color:var(--text-secondary,#94a3b8); font-size:0.75rem; padding-top:1px;">（上次操作：${escapeHtml(m.operator)}）</span>` : ''}
                <div style="color:var(--text-secondary,#cbd5e1);">${parts.join('；')}</div>
            </div>
        `;
    });

    const bodyHtml = `
        <div style="font-size:0.9rem; line-height:1.6; text-align:left;">
            <div style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px 12px; margin-bottom:12px; color:#fca5a5; display:flex; align-items:flex-start; gap:8px;">
                <svg style="flex-shrink:0; width:18px; height:18px; color:#ef4444; margin-top:2px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <div style="flex:1;">
                    检测到【<strong>${escapeHtml(classSummary)}</strong>】已有存档，本次上传有 <strong>${modifiedStudents.length} 位学生</strong> 的数据将发生覆盖变动。
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:12px; font-size:0.8rem; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); padding:8px 12px; border-radius:8px;">
                <div><span style="color:var(--text-secondary,#94a3b8);">最近更新：</span><strong style="color:var(--text-primary,#fff);">${batchData.createdAt || '未知'}</strong></div>
                <div><span style="color:var(--text-secondary,#94a3b8);">最近操作教师：</span><strong style="color:var(--text-primary,#fff);">${escapeHtml(operator)}</strong></div>
            </div>

            <div style="font-weight:600; color:var(--text-primary,#fff); margin-bottom:8px;">
                <span>检测到以下 ${modifiedStudents.length} 位学生数据变动：</span>
            </div>

            <div style="max-height:220px; overflow-y:auto; padding-right:4px; margin-bottom:10px;" class="custom-scrollbar">
                ${diffItemsHtml}
            </div>

            <div style="padding:8px 10px; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.2); border-radius:6px; font-size:0.78rem; color:#fcd34d;">
                若因周次自动识别有误导致冲突，请点击「取消并修改」返回修改周次；若确认需要覆盖更新本周报告，请点击「确认覆盖生成」。
            </div>
        </div>
    `;

    showCustomDialog({
        title: '学情数据覆盖变动确认',
        body: bodyHtml,
        maxWidth: '560px',
        confirmText: '确认覆盖生成',
        cancelText: '取消并修改',
        danger: true,
        onConfirm: onConfirm,
        onCancel: onCancel
    });
}

async function confirmAndGenerate(triggerBtn) {
    const btn = triggerBtn || document.getElementById('confirm-generate-btn') || document.querySelector('#lesson-confirm-modal .btn.primary');
    const previewInput = document.getElementById('confirm-preview-lesson');
    const homeworkInput = document.getElementById('confirm-homework-lesson');
    const reportInput = document.getElementById('confirm-report-lesson');
    const noteInput = document.getElementById('confirm-note-lesson');
    const classTestInput = document.getElementById('confirm-class-test-lesson');

    if (previewData && previewInput && !previewInput.value) {
        showToast('请填写课前预习周次');
        return;
    }
    if (homeworkData && homeworkInput && !homeworkInput.value) {
        showToast(`请填写${getUploadHomeworkLabelFull()}${getUploadLessonUnit()}次`);
        return;
    }
    if (reportData && reportInput && !reportInput.value) {
        showToast('请填写课堂报告周次');
        return;
    }
    if (selectedSubject === '英语' && noteData && noteInput && !noteInput.value) {
        showToast('请填写笔记作业周次');
        return;
    }
    if (selectedSubject === '英语' && classTestData && classTestInput && !classTestInput.value) {
        showToast('请填写课堂测试周次');
        return;
    }

    await withButtonLoading(btn, '正在生成...', async () => {
        // 覆盖检测：检查当前老师上传的学生中，是否有已存档且本次有内容变动的学生
        const classInfo = getUploadClassInfo();
        if (classInfo.subject && classInfo.grade && classInfo.tier && classInfo.week) {
            try {
                const incomingStudents = getIncomingStudentsList();
                if (incomingStudents && incomingStudents.length > 0) {
                    // 使用短超时 3000ms，弱网断网时直接优雅降级，绝不卡住生成流程
                    const checkResp = await requestWithTimeout('api/retest.php?action=check_existing_batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            year: classInfo.year,
                            season: classInfo.season,
                            grade: classInfo.grade,
                            tier: classInfo.tier,
                            subject: classInfo.subject,
                            week: classInfo.week,
                            students: incomingStudents
                        })
                    }, 3000);
                    const checkRes = await checkResp.json();
                    // 仅当存在已存档且内容有修改的学生时，才弹出覆盖提示；无改动或全新学生则绝不打扰，直接放行
                    if (checkRes && checkRes.success && checkRes.hasDiff && Array.isArray(checkRes.modifiedStudents) && checkRes.modifiedStudents.length > 0) {
                        closeConfirmModal();
                        showBatchOverwriteModal({
                            classInfo,
                            batchData: checkRes.data || {},
                            modifiedStudents: checkRes.modifiedStudents,
                            onConfirm: () => {
                                persistAndNavigate();
                            },
                            onCancel: () => {
                                showLessonConfirmModal();
                            }
                        });
                        return;
                    }
                }
            } catch (e) {
                console.warn('检查已有批次跳过或超时 (弱网优雅降级):', e);
            }
        }

        closeConfirmModal();
        persistAndNavigate();
    });
}

async function persistAndNavigate() {
    if (!hasPrimaryHomeworkData()) return;
    const forceIntegerScores = window.forceIntegerScores !== undefined ? window.forceIntegerScores : true;

    Logger.action('feedback_generation_started', {
        subject: getSelectedSubject(),
        homeworkFiles: rawHomeworkFiles.length,
        previewFiles: rawPreviewFiles.length,
        noteFiles: rawNoteFiles.length,
        hasReport: !!reportData,
        hasRoster: !!rosterData,
        previewCommentSource,
        homeworkCommentSource,
        focusCommentSource,
        physicsPreviewSource,
        rankFormat: document.querySelector('input[name="rank-format"]:checked')?.value || 'exact',
        forceIntegerScores,
        plusEnabled: document.getElementById('plus-enabled')?.checked || false
    });
    Logger.flush();
    const confirmPreviewInput = document.getElementById('confirm-preview-lesson');
    const confirmHomeworkInput = document.getElementById('confirm-homework-lesson');
    const confirmReportInput = document.getElementById('confirm-report-lesson');
    const confirmNoteInput = document.getElementById('confirm-note-lesson');
    const confirmClassTestInput = document.getElementById('confirm-class-test-lesson');

    const homeworkLesson = homeworkData
        ? (confirmHomeworkInput?.value ? parseInt(confirmHomeworkInput.value) : extractLessonNumber(homeworkFileName, 'homework') || 1)
        : null;
    const previewLesson = previewData ? (confirmPreviewInput?.value ? parseInt(confirmPreviewInput.value) : extractLessonNumber(previewFileName, 'preview') || 1) : null;
    const reportLesson = reportData ? (confirmReportInput?.value ? parseInt(confirmReportInput.value) : extractLessonNumber(reportFileName, 'report') || 1) : null;
    const noteLesson = noteData ? (confirmNoteInput?.value ? parseInt(confirmNoteInput.value) : extractLessonNumber(noteFileName, 'note') || 1) : null;
    const classTestLesson = classTestData ? (confirmClassTestInput?.value ? parseInt(confirmClassTestInput.value) : extractLessonNumber(classTestFileName, 'class_test') || 1) : null;

    const isWenjuanxingPayload = physicsPreviewSource === 'wenjuanxing';
    const previewMetricMode = isWenjuanxingPayload ? 'score_rank' : (document.querySelector('input[name="preview-metric-mode"]:checked')?.value || 'score_rank');
    const previewTotalEl = document.getElementById('preview-total-questions');
    const previewTotalQuestions = previewTotalEl ? parseInt(previewTotalEl.value) || 0 : 0;

    const payload = {
        seasonMode: window.defaultSeason,
        seasonType: 'semester',
        forceIntegerScores,
        previewMetricMode,
        previewTotalQuestions,
        subject: getSelectedSubject(),
        physicsPreviewSource,
        homeworkFiles: rawHomeworkFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: file.data
        })),
        previewFiles: rawPreviewFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: file.data
        })),
        noteFiles: rawNoteFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: file.data
        })),
        classTestFiles: rawClassTestFiles.map(file => ({
            name: file.name,
            text: file.text,
            data: file.data
        })),
        reportFile: reportData ? { name: reportFileName, text: reportDropZone.dataset.rawText || '' } : null,
        previewCommentSource,
        homeworkCommentSource,
        commentSource: homeworkCommentSource,
        commentSummary: commentSummaryInput.value.trim(),
        previewManualComments: {
            full: previewCommentFullInput.value.trim(),
            top20: previewCommentTop20Input.value.trim(),
            aboveAvg: previewCommentAboveAvgInput.value.trim(),
            belowAvg: previewCommentBelowAvgInput.value.trim(),
            zero: previewCommentZeroInput.value.trim()
        },
        homeworkManualComments: {
            full: homeworkCommentFullInput.value.trim(),
            top20: homeworkCommentTop20Input.value.trim(),
            aboveAvg: homeworkCommentAboveAvgInput.value.trim(),
            belowAvg: homeworkCommentBelowAvgInput.value.trim(),
            zero: homeworkCommentZeroInput.value.trim()
        },
        focusCommentSource,
        focusMaxScore,
        focusScoreOffset,
        focusComments: getFocusComments(),
        manualComments: {
            summary: commentSummaryInput.value.trim(),
            full: homeworkCommentFullInput.value.trim(),
            top20: homeworkCommentTop20Input.value.trim(),
            aboveAvg: homeworkCommentAboveAvgInput.value.trim(),
            belowAvg: homeworkCommentBelowAvgInput.value.trim(),
            zero: homeworkCommentZeroInput.value.trim()
        },
        rankFormat: document.querySelector('input[name="rank-format"]:checked')?.value || 'exact',
        plusData: getPlusPayload(),
        lessonNumbers: {
            homework: homeworkLesson,
            preview: previewLesson,
            report: reportLesson,
            note: noteLesson,
            classTest: classTestLesson
        },
        sourceFileNames: [
            ...(rawHomeworkFiles || []).map(f => f.name),
            ...(rawPreviewFiles || []).map(f => f.name),
            ...(rawNoteFiles || []).map(f => f.name),
            ...(rawClassTestFiles || []).map(f => f.name),
            ...(reportData && reportFileName ? [reportFileName] : []),
            ...(rosterData && rosterFileName ? [rosterFileName] : [])
        ].filter(Boolean),
        rosterFileName: rosterFileName || '',
        feedbackClasses: (rosterData && rosterClassStats.length > 0) ? [...selectedFeedbackClasses] : [],
        createdAt: Date.now(),
        droppedStudents: (rosterData && (detectedDroppedStudents.preview.length > 0 || detectedDroppedStudents.homework.length > 0))
            ? detectedDroppedStudents : null,
        exclusionList: document.getElementById('exclusion-list')?.value.trim() || ''
    };
    const sessionId = generateSessionId();
    if (typeof saveSessionDataAsync === 'function') {
        await saveSessionDataAsync(sessionId, payload);
    } else {
        saveSessionData(sessionId, payload);
    }
    window.location.href = `viewer.html?id=${encodeURIComponent(sessionId)}`;
}

// ========== Comment Source Toggle ==========
function switchCommentSourceUI(source, fileBtnId, manualBtnId, mergeBtnId, fileContentId, manualContentId, infoId) {
    const fileBtn = document.getElementById(fileBtnId);
    const manualBtn = document.getElementById(manualBtnId);
    const mergeBtn = document.getElementById(mergeBtnId);
    const fileContent = document.getElementById(fileContentId);
    const manualContent = document.getElementById(manualContentId);
    const infoEl = document.getElementById(infoId);
    
    if (fileBtn) fileBtn.classList.remove('active');
    if (manualBtn) manualBtn.classList.remove('active');
    if (mergeBtn) mergeBtn.classList.remove('active');
    if (fileContent) fileContent.style.display = 'none';
    if (manualContent) manualContent.style.display = 'none';
    
    if (source === 'file') {
        if (fileBtn) fileBtn.classList.add('active');
        if (fileContent) fileContent.style.display = 'block';
    } else if (source === 'manual') {
        if (manualBtn) manualBtn.classList.add('active');
        if (manualContent) manualContent.style.display = 'block';
    } else if (source === 'merge') {
        if (mergeBtn) mergeBtn.classList.add('active');
        if (fileContent) fileContent.style.display = 'block';
        if (manualContent) manualContent.style.display = 'block';
    }
    
    // Update info text based on source
    if (infoEl && source === 'merge') {
        infoEl.querySelector('span').textContent = '将 CSV 评语与固定模板评语拼接（CSV 评语在前，固定模板在后）';
    } else if (infoEl && source === 'file') {
        // Reset to original text
        const isPreview = infoId.includes('preview');
        infoEl.querySelector('span').textContent = isPreview 
            ? '从预习 CSV 文件中提取评语（订正评语优先）'
            : '从课后 CSV 文件中提取评语（订正评语优先）';
    }
}

function switchPreviewCommentSource(source) {
    previewCommentSource = source;
    Logger.action('comment_source_changed', { type: 'preview', source });
    switchCommentSourceUI(source, 'preview-source-file-btn', 'preview-source-manual-btn', 'preview-source-merge-btn', 'preview-file-comment-content', 'preview-manual-comment-content', 'preview-file-info');
}

function switchHomeworkCommentSource(source) {
    homeworkCommentSource = source;
    Logger.action('comment_source_changed', { type: 'homework', source });
    switchCommentSourceUI(source, 'homework-source-file-btn', 'homework-source-manual-btn', 'homework-source-merge-btn', 'homework-file-comment-content', 'homework-manual-comment-content', 'homework-file-info');
}

function switchFocusCommentSource(source) {
    // Check if default button is disabled
    const defaultBtn = document.getElementById('focus-source-default-btn');
    if (source === 'default' && defaultBtn && defaultBtn.getAttribute('data-disabled') === 'true') {
        showToast('最高专注度积分不是6分，无法使用默认评语');
        return;
    }
    
    focusCommentSource = source === 'custom' ? 'custom' : 'default';
    const customBtn = document.getElementById('focus-source-custom-btn');
    const defaultContent = document.getElementById('focus-default-content');
    const customContent = document.getElementById('focus-custom-content');
    
    if (focusCommentSource === 'default') {
        if (defaultBtn) defaultBtn.classList.add('active');
        if (customBtn) customBtn.classList.remove('active');
        if (defaultContent) defaultContent.style.display = 'block';
        if (customContent) customContent.style.display = 'none';
    } else {
        if (defaultBtn) defaultBtn.classList.remove('active');
        if (customBtn) customBtn.classList.add('active');
        if (defaultContent) defaultContent.style.display = 'none';
        if (customContent) customContent.style.display = 'block';
    }
}

function generateFocusCommentFields(maxScore) {
    focusMaxScore = maxScore;
    const container = document.getElementById('focus-comment-fields');
    if (!container) return;
    
    container.innerHTML = '';
    
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
    
    for (let score = maxScore; score >= 0; score--) {
        const field = document.createElement('div');
        field.className = 'focus-comment-field';
        const defaultVal = defaultComments[score] || '';
        field.innerHTML = `
            <span class="focus-score-label">${score}分</span>
            <input type="text" class="modern-input focus-comment-input" data-score="${score}"
                placeholder="输入${score}分学生的评语..." value="${defaultVal}" required>
        `;
        container.appendChild(field);
    }
}

function getFocusComments() {
    const comments = {};
    document.querySelectorAll('.focus-comment-input').forEach(input => {
        const score = input.getAttribute('data-score');
        comments[score] = input.value.trim();
    });
    return comments;
}

function forceFocusCommentCustom(maxScore) {
    focusCommentSource = 'custom';
    generateFocusCommentFields(maxScore);
    switchFocusCommentSource('custom');
    const defaultBtn = document.getElementById('focus-source-default-btn');
    if (defaultBtn) {
        defaultBtn.classList.add('disabled');
        defaultBtn.style.opacity = '0.5';
        defaultBtn.style.cursor = 'not-allowed';
        defaultBtn.title = '最高专注度积分不是6分，无法使用默认评语，请手动填写各分数段评语';
        defaultBtn.setAttribute('data-disabled', 'true');
    }
}

window.switchFocusCommentSource = switchFocusCommentSource;
window.generateFocusCommentFields = generateFocusCommentFields;
window.forceFocusCommentCustom = forceFocusCommentCustom;

// ========== Plus Feature (PHP API) ==========
const QBANK_API = 'api/qbank.php';
let plusQuestionData = null;
let plusPreviewQuestionData = null;
let plusSourceMode = 'server';
let plusMaxWeeks = 30; // Default max weeks

function initPlusFeature() {
    // Load semester weeks from config (via脱敏公开接口；config.json 已被 nginx 禁止直读)
    fetch('api/public_config.php')
        .then(response => response.json())
        .then(config => {
            if (config.semesterWeeks && config.semesterWeeks > 0) {
                plusMaxWeeks = config.semesterWeeks;
            }
            if (config.semesterYear) {
                window.semesterYear = config.semesterYear;
            }
            if (config.defaultSeason) {
                window.defaultSeason = config.defaultSeason;
            }
            populatePlusWeekSelector();
        })
        .catch(() => {
            populatePlusWeekSelector();
        });
    
    // Ensure the Plus toggle is off by default when loading the page
    const plusToggle = document.getElementById('plus-enabled');
    if (plusToggle) {
        plusToggle.checked = false;
        togglePlusConfig();
    }
    switchPlusSource('server');
}

function populatePlusWeekSelector() {
    const weekSelect = document.getElementById('plus-week');
    if (weekSelect) {
        weekSelect.innerHTML = '<option value="">不关联巩固 / 自动匹配</option>';
        for (let i = 1; i <= plusMaxWeeks; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = numToChinese_upload(i);
            weekSelect.appendChild(opt);
        }
    }
    const previewWeekSelect = document.getElementById('plus-preview-week');
    if (previewWeekSelect) {
        previewWeekSelect.innerHTML = '<option value="">不关联预习 / 自动匹配</option>';
        for (let i = 1; i <= plusMaxWeeks; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = numToChinese_upload(i);
            previewWeekSelect.appendChild(opt);
        }
    }
}

// 数字转中文（upload.js 内独立版本，避免依赖 question-bank.js）
function numToChinese_upload(n) {
    const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n <= 9) return '专题' + (digits[n] || String(n));
    if (n === 10) return '专题十';
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    if (tens === 1) return '专题十' + (ones ? digits[ones] : '');
    return '专题' + digits[tens] + '十' + (ones ? digits[ones] : '');
}

function togglePlusConfig() {
    const enabled = document.getElementById('plus-enabled')?.checked;
    const selectors = document.getElementById('plus-selectors');
    if (selectors) {
        selectors.style.display = enabled ? 'block' : 'none';
    }
    
    const plusSubjectSelect = document.getElementById('plus-subject');
    if (plusSubjectSelect) {
        if (enabled) {
            const currentSubject = getSelectedSubject();
            if (currentSubject) {
                plusSubjectSelect.value = currentSubject;
            }
            plusSubjectSelect.disabled = true;
            plusSubjectSelect.style.cursor = 'not-allowed';
            plusSubjectSelect.style.opacity = '0.6';
        } else {
            plusSubjectSelect.disabled = false;
            plusSubjectSelect.style.cursor = 'pointer';
            plusSubjectSelect.style.opacity = '1';
        }
    }
    
    if (enabled) {
        plusSourceMode = 'server';
        const gradeEl = document.getElementById('plus-grade');
        const tierEl = document.getElementById('plus-tier');
        const weekEl = document.getElementById('plus-week');
        if (gradeEl) gradeEl.value = '';
        if (tierEl) tierEl.value = '';
        const previewWeekEl = document.getElementById('plus-preview-week');
        if (previewWeekEl) {
            const pvLesson = previewData ? (extractLessonNumber(previewFileName, 'preview') || 1) : 0;
            previewWeekEl.value = pvLesson > 0 ? pvLesson : '';
        }
        if (weekEl) {
            const hwLesson = homeworkData ? (extractLessonNumber(homeworkFileName, 'homework') || 1) : 0;
            weekEl.value = hwLesson > 0 ? hwLesson : '';
        }
        onPlusSelectorChange();
    } else {
        plusQuestionData = null;
        plusPreviewQuestionData = null;
    }
}

function switchPlusSource(mode) {
    plusSourceMode = mode === 'local' ? 'local' : 'server';
    const serverBtn = document.getElementById('plus-source-server-btn');
    const localBtn = document.getElementById('plus-source-local-btn');
    const serverConfig = document.getElementById('plus-server-config');
    const localConfig = document.getElementById('plus-local-config');
    if (serverBtn) serverBtn.classList.toggle('active', plusSourceMode === 'server');
    if (localBtn) localBtn.classList.toggle('active', plusSourceMode === 'local');
    if (serverConfig) serverConfig.style.display = plusSourceMode === 'server' ? 'block' : 'none';
    if (localConfig) localConfig.style.display = plusSourceMode === 'local' ? 'block' : 'none';
    if (document.getElementById('plus-enabled')?.checked) {
        if (plusSourceMode === 'server') onPlusSelectorChange();
        else onLocalPlusInputChange();
    }
}

async function onPlusSelectorChange() {
    const subject = document.getElementById('plus-subject')?.value;
    const grade = document.getElementById('plus-grade')?.value;
    const tier = document.getElementById('plus-tier')?.value;
    const week = document.getElementById('plus-week')?.value;
    const previewWeek = document.getElementById('plus-preview-week')?.value;
    const statusTextEl = document.getElementById('plus-data-status-text');
    const statusCallout = document.getElementById('plus-data-status');

    if (!subject || !grade || !tier || (!week && !previewWeek)) {
        if (statusTextEl) statusTextEl.textContent = '请选择学科、年级、班层及对应专题';
        plusQuestionData = null;
        plusPreviewQuestionData = null;
        return;
    }

    // Show loading state
    if (statusTextEl) statusTextEl.textContent = '正在加载题库数据...';

    try {
        const baseParams = { subject, grade, tier };
        if (window.semesterYear) baseParams.year = window.semesterYear;
        if (window.defaultSeason) baseParams.season = window.defaultSeason;

        // 1. 获取课后巩固题目数据
        let hwOk = true;
        let hwText = '';
        if (week) {
            const hwQuery = new URLSearchParams({ ...baseParams, action: 'get', bankType: 'homework', week }).toString();
            const hwResp = await fetch(`${QBANK_API}?${hwQuery}`);
            const hwResult = await hwResp.json();
            if (hwResult.success && hwResult.data) {
                plusQuestionData = hwResult.data;
                const qCount = (hwResult.data.questions || []).length;
                const filledCount = (hwResult.data.questions || []).filter(q => q.topic && q.topic.trim()).length;
                hwOk = true;
                hwText = `课后巩固: ${filledCount}/${qCount}题`;
            } else {
                plusQuestionData = null;
                hwOk = false;
                hwText = '课后巩固: 未录入题目';
            }
        } else {
            plusQuestionData = null;
        }

        // 2. 若选择了预习专题，同时获取预习题目数据
        let pvText = '';
        let pvOk = true;
        if (previewWeek) {
            const pvQuery = new URLSearchParams({ ...baseParams, action: 'get', bankType: 'preview', week: previewWeek }).toString();
            const pvResp = await fetch(`${QBANK_API}?${pvQuery}`);
            const pvResult = await pvResp.json();
            if (pvResult.success && pvResult.data) {
                plusPreviewQuestionData = pvResult.data;
                const pvCount = (pvResult.data.questions || []).length;
                const pvFilled = (pvResult.data.questions || []).filter(q => q.topic && q.topic.trim()).length;
                pvOk = true;
                pvText = (pvFilled === pvCount) 
                    ? `预习: ${pvCount}题` 
                    : (pvFilled > 0 ? `预习: ${pvCount}题 (${pvFilled}已填考点)` : `预习: ${pvCount}题 (知识点选填)`);
            } else {
                plusPreviewQuestionData = null;
                pvOk = false;
                pvText = '预习: 未录入题目';
            }
        } else {
            plusPreviewQuestionData = null;
        }

        const statusParts = [];
        if (hwText) statusParts.push(hwText);
        if (pvText) statusParts.push(pvText);

        if (statusTextEl) {
            statusTextEl.textContent = statusParts.join(' | ') || '未选择专题';
        }
        if (statusCallout) {
            const allOk = (week ? hwOk : true) && (previewWeek ? pvOk : true);
            if (allOk) {
                statusCallout.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                statusCallout.style.background = 'rgba(34, 197, 94, 0.05)';
            } else {
                statusCallout.style.borderColor = 'rgba(245, 158, 11, 0.3)';
                statusCallout.style.background = 'rgba(245, 158, 11, 0.05)';
            }
        }
    } catch (e) {
        console.error('加载题目数据失败:', e);
        plusQuestionData = null;
        plusPreviewQuestionData = null;
        if (statusTextEl) statusTextEl.textContent = '加载失败，请检查网络连接';
        if (statusCallout) {
            statusCallout.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            statusCallout.style.background = 'rgba(239, 68, 68, 0.05)';
        }
    }
}

function parseLocalPlusQuestions() {
    const text = document.getElementById('plus-local-topics')?.value || '';
    const map = new Map();
    text.split(/\r?\n/).forEach(line => {
        const raw = line.trim();
        if (!raw) return;
        const m = raw.match(/^第?\s*(\d+)\s*题?\s*[:：\-—、.．]?\s*(.+)$/);
        if (!m) return;
        const id = parseInt(m[1]);
        let topic = m[2]?.trim();
        if (!id || !topic) return;
        if (typeof cleanTopicTrailingPunctuation === 'function') {
            topic = cleanTopicTrailingPunctuation(topic);
        } else {
            topic = topic.replace(/[\s,，.。;；:：、\-_—]+$/u, '').trim();
        }
        if (!topic) return;
        map.set(id, topic);
    });
    return Array.from(map.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([id, topic]) => ({ id, topic }));
}

function onLocalPlusInputChange() {
    const statusTextEl = document.getElementById('plus-local-status-text');
    const statusCallout = document.getElementById('plus-local-status');
    const questions = parseLocalPlusQuestions();
    if (questions.length > 0) {
        if (statusTextEl) statusTextEl.textContent = `已解析 ${questions.length} 道题目`;
        if (statusCallout) {
            statusCallout.style.borderColor = 'rgba(34, 197, 94, 0.3)';
            statusCallout.style.background = 'rgba(34, 197, 94, 0.05)';
        }
    } else {
        if (statusTextEl) statusTextEl.textContent = '请按“题号: 知识点”格式填写';
        if (statusCallout) {
            statusCallout.style.borderColor = '';
            statusCallout.style.background = '';
        }
    }
}

function getPlusPayload() {
    const enabled = document.getElementById('plus-enabled')?.checked;
    if (!enabled) return null;
    if (plusSourceMode === 'local') {
        const localQuestions = parseLocalPlusQuestions();
        if (localQuestions.length === 0) return null;
        return {
            enabled: true,
            source: 'local',
            subject: document.getElementById('feedback-subject')?.value || '',
            grade: '',
            tier: '自定义',
            week: 0,
            questions: localQuestions
        };
    }
    if (!plusQuestionData && !plusPreviewQuestionData) return null;
    const pWeekVal = parseInt(document.getElementById('plus-week')?.value) || 0;
    const pvWeekVal = parseInt(document.getElementById('plus-preview-week')?.value) || 0;
    return {
        enabled: true,
        source: 'server',
        subject: document.getElementById('plus-subject')?.value || '',
        grade: document.getElementById('plus-grade')?.value || '',
        tier: document.getElementById('plus-tier')?.value || '',
        week: pWeekVal || pvWeekVal,
        homeworkWeek: pWeekVal,
        previewWeek: pvWeekVal,
        questions: plusQuestionData?.questions || [],
        previewQuestions: plusPreviewQuestionData?.questions || []
    };
}

// Initialize Plus
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlusFeature);
} else {
    initPlusFeature();
}

window.clearHomeworkFiles = clearHomeworkFiles;
window.removeHomeworkFile = removeHomeworkFile;
window.clearPreviewFiles = clearPreviewFiles;
window.removePreviewFile = removePreviewFile;
window.clearNoteFiles = clearNoteFiles;
window.removeNoteFile = removeNoteFile;
window.switchPreviewCommentSource = switchPreviewCommentSource;
window.switchHomeworkCommentSource = switchHomeworkCommentSource;
window.closeConfirmModal = closeConfirmModal;
window.confirmAndGenerate = confirmAndGenerate;
window.generateFeedback = generateFeedback;
window.onPreviewMetricModeChange = onPreviewMetricModeChange;
window.togglePlusConfig = togglePlusConfig;
window.switchPlusSource = switchPlusSource;
window.onPlusSelectorChange = onPlusSelectorChange;
window.onLocalPlusInputChange = onLocalPlusInputChange;
window.checkCommentPrefixStandards = checkCommentPrefixStandards;
window.showCommentFormatModal = showCommentFormatModal;
window.closeCommentFormatModal = closeCommentFormatModal;
window.autoFixCommentStandardsAndGenerate = autoFixCommentStandardsAndGenerate;
window.ignoreCommentFormatAndGenerate = ignoreCommentFormatAndGenerate;
window.closeMissingErrorsModal = closeMissingErrorsModal;
window.ignoreMissingErrorsAndContinue = ignoreMissingErrorsAndContinue;

// ========== Exclusion List Methods ==========
window.renderExclusionTags = function() {
    const listEl = document.getElementById('exclusion-list');
    const container = document.getElementById('exclusion-tags-container');
    const emptyEl = document.getElementById('exclusion-tags-empty');
    if (!listEl || !container) return;

    const val = listEl.value.trim();
    const tags = val ? val.split('\n').map(t => t.trim()).filter(t => t.length > 0) : [];
    
    // Clear all existing tags (but keep the empty span if needed)
    container.innerHTML = '';
    
    if (tags.length === 0) {
        if (!emptyEl) {
            container.innerHTML = '<span style="color: var(--text-tertiary); font-size: 0.85rem; padding: 4px 0;" id="exclusion-tags-empty">暂无排除学生</span>';
        } else {
            container.appendChild(emptyEl);
        }
        return;
    }

    tags.forEach(tag => {
        const chip = document.createElement('div');
        chip.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(var(--accent-rgb), 0.1); color: var(--accent-primary); border-radius: 6px; font-size: 0.8rem; font-weight: 500; border: 1px solid rgba(var(--accent-rgb), 0.2);';
        
        const text = document.createElement('span');
        text.textContent = tag;
        
        const removeBtn = document.createElement('span');
        removeBtn.innerHTML = '&times;';
        removeBtn.style.cssText = 'cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 0 2px;';
        removeBtn.onclick = () => removeExclusionTag(tag);
        
        chip.appendChild(text);
        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
};

window.addExclusionTag = function() {
    const input = document.getElementById('exclusion-tag-input');
    const listEl = document.getElementById('exclusion-list');
    if (!input || !listEl) return;
    
    const newTag = input.value.trim();
    if (!newTag) return;
    
    const val = listEl.value.trim();
    const tags = val ? val.split('\n').map(t => t.trim()).filter(t => t.length > 0) : [];
    
    if (tags.includes(newTag)) {
        showToast('该学生已存在于排除列表中');
        input.value = '';
        return;
    }
    
    tags.push(newTag);
    listEl.value = tags.join('\n');
    input.value = '';
    renderExclusionTags();
};

window.removeExclusionTag = function(tag) {
    const listEl = document.getElementById('exclusion-list');
    if (!listEl) return;
    
    const val = listEl.value.trim();
    let tags = val ? val.split('\n').map(t => t.trim()).filter(t => t.length > 0) : [];
    tags = tags.filter(t => t !== tag);
    listEl.value = tags.join('\n');
    renderExclusionTags();
};

window.importExclusionFile = async function(input) {
    if (input.files && input.files[0]) {
        try {
            const text = await readFileAsTextWithProgress(
                input.files[0],
                () => {},
                (reader) => activeReaders.push(reader)
            );
            const textarea = document.getElementById('exclusion-list');
            if (textarea) {
                const existing = textarea.value.trim();
                textarea.value = existing ? existing + '\n' + text.trim() : text.trim();
                showToast('排除名单导入成功');
                renderExclusionTags();
            }
        } catch(e) {
            if (e?.message !== 'aborted') {
                showToast('文件读取失败');
                console.error(e);
            }
        }
        input.value = ''; 
    }
};

window.exportExclusionFile = function() {
    const text = document.getElementById('exclusion-list')?.value.trim();
    if (!text) {
        showToast('排除名单为空，无可导出内容');
        return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `反馈排除名单_${new Date().toLocaleDateString().replace(/\//g, '-')}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    showToast('排除名单已导出');
};

// Initialize event listeners and render tags on load
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('exclusion-tag-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                addExclusionTag();
            }
        });
    }
    renderExclusionTags();

    // Sometimes the state is restored via other mechanisms (like page cache or script logic),
    // we want to render tags if the hidden textarea has some value.
    setTimeout(() => {
        renderExclusionTags();
    }, 500);
});

// ==========================================
// File Preview Feature (Key Columns Only)
// ==========================================
let currentFilePreviewState = null;

/**
 * Intelligent key columns extractor
 * Returns an array of objects: { name: string, index: number, role: string, badgeColor: string }
 */
function extractKeyColumns(headers, type, sampleRows = []) {
    if (!headers || headers.length === 0) return [];
    const normalized = headers.map(h => String(h || '').trim());
    const selected = [];
    const usedIndices = new Set();

    const addCol = (idx, role, badgeColor, overrideName) => {
        if (idx >= 0 && !usedIndices.has(idx)) {
            selected.push({
                name: overrideName || normalized[idx],
                index: idx,
                role: role,
                badgeColor: badgeColor || '#3b82f6'
            });
            usedIndices.add(idx);
            return true;
        }
        return false;
    };

    // 1. Locate student Name column
    let nameIdx = normalized.findIndex(h => h === '姓名' || h === '学生姓名' || h === '您的姓名' || h === '学员姓名');
    if (nameIdx < 0) nameIdx = normalized.findIndex(h => h.includes('姓名') && !h.includes('教师') && !h.includes('老师'));
    if (nameIdx < 0) nameIdx = normalized.findIndex(h => h === '学生' || h === '学员');

    // 2. Locate student ID column
    let idIdx = normalized.findIndex(h => h === '学号' || h === '学员编号' || h === '学生编号' || h.toLowerCase() === 'id');
    if (idIdx < 0) idIdx = normalized.findIndex(h => h.includes('学号') || h.includes('卡号') || h.includes('手机号') || h.includes('账号'));

    // Check if name column contains embedded student ID (e.g. 2821213张三)
    const hasEmbeddedId = nameIdx >= 0 && Array.isArray(sampleRows) && sampleRows.some(r => {
        const val = String((r && r[nameIdx]) || '').trim();
        return /^\d{2,}/.test(val);
    });

    if (idIdx >= 0 && nameIdx >= 0) {
        // Both exist in header: place 学号 first, then 姓名
        addCol(idIdx, 'id', '#8b5cf6', '学号');
        addCol(nameIdx, 'name', '#3b82f6', '姓名');
    } else if (hasEmbeddedId) {
        // Name column contains combined ID + Name: separate them into two distinct columns!
        selected.push({
            name: '学号',
            index: nameIdx,
            role: 'virtual_id',
            badgeColor: '#8b5cf6'
        });
        selected.push({
            name: '姓名',
            index: nameIdx,
            role: 'split_name',
            badgeColor: '#3b82f6'
        });
        usedIndices.add(nameIdx);
    } else {
        if (idIdx >= 0) addCol(idIdx, 'id', '#8b5cf6', '学号');
        if (nameIdx >= 0) addCol(nameIdx, 'name', '#3b82f6', '姓名');
    }

    if (type === 'report') {
        // 统计报告（专注度）：展示学生姓名、学号、出勤状态、奖励积分
        // 不显示班级，不显示开课时长(分钟)
        let attIdx = normalized.findIndex(h => 
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
            !h.includes('时长') && !h.includes('率')
        );
        if (attIdx >= 0) {
            addCol(attIdx, 'attendance', '#06b6d4', '出勤');
        }
        let scoreIdx = normalized.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('专注度') || h.includes('课堂积分') || h === '积分');
        addCol(scoreIdx, 'score', '#f59e0b', '专注度积分');
    } else {
        // 作业文件（课后巩固 / 课前预习 / 笔记作业）
        // 3. Class / Subject
        let classIdx = normalized.findIndex(h => h === '班级' || h === '班级名称' || h === '教学班');
        if (classIdx < 0) classIdx = normalized.findIndex(h => h.includes('班级') && !h.includes('排'));
        if (classIdx < 0) classIdx = normalized.findIndex(h => h === '学科');
        addCol(classIdx, 'class', '#06b6d4', '班级');

        // 4. Status (作业状态) - 放在得分前
        let statusIdx = normalized.findIndex(h => h.includes('作业状态') || h.includes('提交状态') || h === '状态');
        addCol(statusIdx, 'status', '#6366f1', '作业状态');

        // 5. Score / Grade (只展示分数，统一不展示错题数和正确率)
        let scoreIdx = normalized.findIndex(h => h === '得分' || h === '成绩' || h === '作业得分' || h === '课后巩固成绩' || h === '总分' || h === '分值');
        if (scoreIdx < 0) scoreIdx = normalized.findIndex(h => (h.includes('得分') || h.includes('成绩')) && !h.includes('小题'));
        addCol(scoreIdx, 'score', '#10b981', '得分');

        // 6. Comments (批改评语) - 排除错题数
        let commentIdx = normalized.findIndex(h => h.includes('批改评语') || (h.includes('评语') && !h.includes('错题')));
        addCol(commentIdx, 'comment', '#ec4899', '批改评语');
    }

    // Fallback: If less than 2 columns were identified, pick non-empty columns avoiding excluded ones
    if (selected.length < 2) {
        for (let i = 0; i < normalized.length && selected.length < 4; i++) {
            const h = normalized[i];
            if (type === 'report' && (h.includes('班级') || h.includes('时长'))) continue;
            // 统一不展示错题数和正确率
            if (h.includes('正确率') || h.includes('正答率') || h.includes('错题') || h.includes('题数')) continue;
            if (h && !usedIndices.has(i) && h.length < 30) {
                addCol(i, 'custom', '#64748b');
            }
        }
    }

    return selected;
}

window.previewUploadedFile = function(type, index, e) {
    if (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
    }

    try {
        let targetName = '';
        let targetData = null;
        let badgeText = '';

        if (type === 'homework') {
            badgeText = '课后巩固';
            if (index === 'all') {
                targetName = '课后巩固（合并所有文件）';
                targetData = homeworkData;
            } else if (rawHomeworkFiles[index]) {
                targetName = rawHomeworkFiles[index].name;
                targetData = rawHomeworkFiles[index].data;
            }
        } else if (type === 'preview') {
            badgeText = '课前预习';
            if (index === 'all') {
                targetName = '课前预习（合并所有文件）';
                targetData = previewData;
            } else if (rawPreviewFiles[index]) {
                targetName = rawPreviewFiles[index].name;
                targetData = rawPreviewFiles[index].data;
            }
        } else if (type === 'note') {
            badgeText = '笔记作业';
            if (index === 'all') {
                targetName = '笔记作业（合并所有文件）';
                targetData = noteData;
            } else if (rawNoteFiles[index]) {
                targetName = rawNoteFiles[index].name;
                targetData = rawNoteFiles[index].data;
            }
        } else if (type === 'class_test') {
            badgeText = '课堂测试';
            if (index === 'all') {
                targetName = '课堂测试（合并所有文件）';
                targetData = classTestData;
            } else if (rawClassTestFiles[index]) {
                targetName = rawClassTestFiles[index].name;
                targetData = rawClassTestFiles[index].data;
            }
        } else if (type === 'report') {
            badgeText = '专注度 / 统计报告';
            targetName = reportFileName || '统计报告数据.csv';
            targetData = reportData;
        }

        if (!targetData || targetData.length <= 1) {
            showToast('暂无有效的表格数据可供预览');
            return;
        }

        const headers = targetData[0];
        let rawRows = targetData.slice(1).filter(r => r && r.some(cell => String(cell || '').trim().length > 0));

        // 统计报告业务规则：只显示班级结尾为β1的学生
        if (type === 'report') {
            const classIdx = headers.findIndex(h => String(h || '').includes('班级'));
            if (classIdx >= 0) {
                rawRows = rawRows.filter(r => {
                    const cName = String(r[classIdx] || '').trim();
                    return cName.includes('β1');
                });
            }
        }

        const keyCols = extractKeyColumns(headers, type, rawRows);

        if (keyCols.length === 0) {
            showToast('未检测到有效列数据');
            return;
        }

        let previewRowCounter = 0;
        const wrappedRows = rawRows.map((r, rIdx) => ({
            _id: ++previewRowCounter,
            _srcIdx: rIdx,
            cells: [...r]
        }));

        currentFilePreviewState = {
            title: targetName,
            type: type,
            index: index,
            badgeText: badgeText,
            headers: headers,
            keyCols: keyCols,
            allRows: wrappedRows,
            filteredRows: wrappedRows,
            isEditing: false,
            rowCounter: previewRowCounter
        };

        // Populate modal elements
        const titleEl = document.getElementById('file-preview-title');
        const badgeEl = document.getElementById('file-preview-badge');
        const searchEl = document.getElementById('file-preview-search');
        const colTagsEl = document.getElementById('file-preview-cols-tags');

        if (titleEl) titleEl.textContent = targetName;
        if (badgeEl) badgeEl.textContent = badgeText;
        if (searchEl) searchEl.value = '';

        // Reset edit mode buttons
        if (typeof togglePreviewEditMode === 'function') {
            togglePreviewEditMode(false, true);
        }

        // Render column tag badges
        if (colTagsEl) {
            colTagsEl.innerHTML = keyCols.map(c => `
                <span class="preview-col-tag" style="border-left: 3px solid ${c.badgeColor};">
                    ${c.name}
                </span>
            `).join('');
        }

        renderPreviewTableRows();

        const modal = document.getElementById('file-preview-modal');
        if (modal) {
            openNativeDialog(modal, {
                dismissible: true,
                onAfterClose: () => {
                    if (currentFilePreviewState && currentFilePreviewState.isEditing) {
                        togglePreviewEditMode(false);
                    }
                }
            });
        } else {
            console.error('未找到 #file-preview-modal 节点');
            showToast('预览弹窗节点异常，请刷新重试');
        }
    } catch (err) {
        console.error('预览失败:', err);
        showToast('打开预览失败: ' + (err?.message || '未知错误'));
    }
};

/**
 * 将二维数据数组转换为符合 RFC 4180 标准的 CSV 字符串
 * 携带 UTF-8 BOM (\uFEFF)，确保在 Windows / Excel / WPS 中打开不出现乱码
 */
function convertDatasetToCsv(dataset) {
    if (!Array.isArray(dataset) || dataset.length === 0) return '';
    const rows = dataset.map(row => {
        if (!Array.isArray(row)) return '';
        return row.map(cell => {
            const val = (cell === null || cell === undefined) ? '' : String(cell);
            if (val.includes('"') || val.includes(',') || val.includes('\n') || val.includes('\r')) {
                return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        }).join(',');
    });
    return '\uFEFF' + rows.join('\r\n');
}

/**
 * 弹出文件选择器保存或直接更新本地 CSV 文件
 * 优先使用 File System Access API (showSaveFilePicker)，支持用户直接选择并覆盖原始文件；
 * 不支持时自动回退为传统浏览器 Blob 下载
 */
async function saveCsvFileWithDialog(csvContent, defaultFilename) {
    const cleanFilename = defaultFilename && defaultFilename.toLowerCase().endsWith('.csv')
        ? defaultFilename
        : (defaultFilename ? `${defaultFilename}.csv` : 'data.csv');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    // 1. 尝试使用现代浏览器 File System Access API
    if (typeof window.showSaveFilePicker === 'function') {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: cleanFilename,
                types: [{
                    description: 'CSV 逗号分隔值文件 (*.csv)',
                    accept: { 'text/csv': ['.csv'] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return { success: true, method: 'picker' };
        } catch (err) {
            if (err.name === 'AbortError') {
                // 用户主动点击了保存对话框的取消按钮
                return { success: false, cancelled: true };
            }
            console.warn('showSaveFilePicker 遇到异常，回退为常规下载:', err);
        }
    }

    // 2. 回退机制：常规 a 标签下载
    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = cleanFilename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
        return { success: true, method: 'download' };
    } catch (err) {
        console.error('CSV 导出失败:', err);
        return { success: false, error: err };
    }
}

/**
 * 导出当前预览弹窗中的完整 CSV 数据
 */
window.exportCurrentPreviewCsv = async function() {
    if (!currentFilePreviewState) {
        showToast('当前没有正在预览的数据');
        return;
    }
    const { type, headers, allRows, title } = currentFilePreviewState;
    const updatedDataRows = (allRows || []).map(r => r.cells);
    const fullDataset = [headers, ...updatedDataRows];
    const datasetToExport = (type === 'report' && reportData && reportData.length > 0) ? reportData : fullDataset;

    const csvContent = convertDatasetToCsv(datasetToExport);
    const fileName = title || `${type || 'data'}.csv`;

    showToast('正在导出 CSV 文件...');
    const res = await saveCsvFileWithDialog(csvContent, fileName);
    if (res && res.cancelled) {
        showToast('已取消导出 CSV');
    } else if (res && res.success) {
        showToast('CSV 文件已导出');
    } else {
        showToast('CSV 导出失败，请重试');
    }
};

window.togglePreviewEditMode = function(enabled, skipRender) {
    if (!currentFilePreviewState) return;
    currentFilePreviewState.isEditing = !!enabled;

    const editBtn = document.getElementById('preview-edit-mode-btn');
    const syncWrap = document.getElementById('preview-sync-csv-wrap');
    const addBtn = document.getElementById('preview-add-row-btn');
    const saveBtn = document.getElementById('preview-save-btn');
    const cancelBtn = document.getElementById('preview-cancel-btn');
    const modeTag = document.getElementById('file-preview-mode-tag');
    const footerEditHint = document.getElementById('preview-footer-edit-hint');

    if (editBtn) editBtn.style.display = enabled ? 'none' : 'inline-flex';
    if (syncWrap) syncWrap.style.display = enabled ? 'inline-flex' : 'none';
    if (addBtn) addBtn.style.display = enabled ? 'inline-flex' : 'none';
    if (saveBtn) saveBtn.style.display = enabled ? 'inline-flex' : 'none';
    if (cancelBtn) cancelBtn.style.display = enabled ? 'inline-flex' : 'none';
    if (modeTag) modeTag.style.display = enabled ? 'inline-block' : 'none';
    if (footerEditHint) footerEditHint.style.display = enabled ? 'inline-block' : 'none';

    if (enabled) {
        // 读取用户更新本地 CSV 文件的偏好记忆，默认勾选
        const syncCheckbox = document.getElementById('preview-sync-csv-checkbox');
        if (syncCheckbox) {
            const savedPref = localStorage.getItem('jf_sync_local_csv');
            syncCheckbox.checked = (savedPref === null || savedPref === '1');
        }
        // Create backup of current allRows
        currentFilePreviewState.backupRows = JSON.parse(JSON.stringify(currentFilePreviewState.allRows));
        showToast('已进入编辑模式，可直接在表格中修改数据');
    }

    if (!skipRender) {
        renderPreviewTableRows();
    }
};

window.cancelPreviewEdits = function() {
    if (!currentFilePreviewState) return;
    if (currentFilePreviewState.backupRows) {
        currentFilePreviewState.allRows = currentFilePreviewState.backupRows;
        delete currentFilePreviewState.backupRows;
    }
    const searchVal = document.getElementById('file-preview-search')?.value || '';
    filterPreviewTable(searchVal);
    togglePreviewEditMode(false);
    showToast('已取消本次编辑');
};

window.updatePreviewDraftCell = function(rowId, colIndex, val, subRole) {
    if (!currentFilePreviewState || !currentFilePreviewState.allRows) return;
    const row = currentFilePreviewState.allRows.find(r => r._id === rowId);
    if (!row || !row.cells) return;

    if (subRole === 'virtual_id') {
        const curVal = String(row.cells[colIndex] || '').trim();
        const nm = curVal.match(/^\d+[\s_\-–—]*(.+)$/);
        const namePart = nm ? nm[1].trim() : curVal.replace(/^\d+/, '').trim();
        const newId = String(val !== undefined && val !== null ? val : '').trim();
        row.cells[colIndex] = newId ? `${newId}${namePart}` : namePart;
    } else if (subRole === 'split_name') {
        const curVal = String(row.cells[colIndex] || '').trim();
        const idm = curVal.match(/^(\d+)/);
        const idPart = idm ? idm[1] : '';
        const newName = String(val !== undefined && val !== null ? val : '').trim();
        row.cells[colIndex] = idPart ? `${idPart}${newName}` : newName;
    } else {
        row.cells[colIndex] = String(val !== undefined && val !== null ? val : '').trim();
    }
};

window.deletePreviewRow = function(rowId) {
    if (!currentFilePreviewState) return;
    currentFilePreviewState.allRows = currentFilePreviewState.allRows.filter(r => r._id !== rowId);
    currentFilePreviewState.filteredRows = currentFilePreviewState.filteredRows.filter(r => r._id !== rowId);
    renderPreviewTableRows();
};

window.handlePreviewAttendanceChange = function(rowId, attColIndex, newAttValue) {
    if (!currentFilePreviewState || !currentFilePreviewState.allRows) return;
    const row = currentFilePreviewState.allRows.find(r => r._id === rowId);
    if (!row || !row.cells) return;

    row.cells[attColIndex] = newAttValue;

    if (currentFilePreviewState.type === 'report') {
        const scoreCol = currentFilePreviewState.keyCols.find(k => k.role === 'score');
        if (scoreCol) {
            if (newAttValue === '缺勤') {
                const curScore = String(row.cells[scoreCol.index] || '').trim();
                if (curScore && curScore !== '-') {
                    row._prevScore = curScore;
                }
                row.cells[scoreCol.index] = '-';
            } else {
                const restored = (row._prevScore !== undefined && row._prevScore !== null && row._prevScore !== '-') ? row._prevScore : '0';
                row.cells[scoreCol.index] = restored;
            }
        }
    }
    renderPreviewTableRows();
};

window.handlePreviewStatusChange = function(rowId, statusColIndex, newStatus) {
    if (!currentFilePreviewState || !currentFilePreviewState.allRows) return;
    const row = currentFilePreviewState.allRows.find(r => r._id === rowId);
    if (!row || !row.cells) return;

    row.cells[statusColIndex] = newStatus;

    // 智能联动分数：未交的（未查阅/已查阅/未提交/缺交）与没改完的（已提交/批改中）都没有最终分数（显示为 -）
    const scoreCol = currentFilePreviewState.keyCols.find(k => k.role === 'score');
    if (scoreCol) {
        const isNoScore = (typeof isStatusUngraded === 'function' && isStatusUngraded(newStatus)) ||
            (typeof isStatusUnsubmitted === 'function' && isStatusUnsubmitted(newStatus)) || (
            newStatus === '已提交' ||
            (newStatus.includes('已提交') && !newStatus.includes('未')) ||
            newStatus.includes('批改中') ||
            newStatus.includes('未查阅') ||
            newStatus.includes('已查阅') ||
            newStatus.includes('未提交') ||
            newStatus.includes('缺交') ||
            newStatus === '未交'
        );

        if (isNoScore) {
            const curScore = String(row.cells[scoreCol.index] || '').trim();
            if (curScore && curScore !== '-') {
                row._prevScore = curScore;
            }
            row.cells[scoreCol.index] = '-';
        } else {
            // 切回已完成/待订正/已订正：恢复原有分数或留待教师填写
            const restored = (row._prevScore !== undefined && row._prevScore !== null && row._prevScore !== '-')
                ? row._prevScore
                : '';
            row.cells[scoreCol.index] = restored;
        }
    }
    renderPreviewTableRows();
};

window.addPreviewRow = function() {
    if (!currentFilePreviewState) return;
    const colCount = currentFilePreviewState.headers ? currentFilePreviewState.headers.length : 10;
    const emptyCells = new Array(colCount).fill('');

    // If report, default class to β1, attendance to 出勤, score to 6
    if (currentFilePreviewState.type === 'report') {
        const classIdx = currentFilePreviewState.headers.findIndex(h => String(h || '').includes('班级'));
        if (classIdx >= 0) {
            emptyCells[classIdx] = '初一春季班β1';
        }
        const attIdx = currentFilePreviewState.headers.findIndex(h => 
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) && 
            !h.includes('时长') && !h.includes('率')
        );
        if (attIdx >= 0) {
            emptyCells[attIdx] = '出勤';
        }
        const rewardIdx = currentFilePreviewState.headers.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
        if (rewardIdx >= 0) {
            emptyCells[rewardIdx] = '6';
        }
    }

    currentFilePreviewState.rowCounter = (currentFilePreviewState.rowCounter || 0) + 1;
    const newRow = {
        _id: currentFilePreviewState.rowCounter,
        _srcIdx: -1,
        cells: emptyCells
    };

    currentFilePreviewState.allRows.unshift(newRow);
    const searchVal = document.getElementById('file-preview-search')?.value || '';
    filterPreviewTable(searchVal);
    showToast('已新增一行，请在首行填写信息');
};

window.savePreviewEdits = async function() {
    if (!currentFilePreviewState) return;
    const { type, index, headers, allRows } = currentFilePreviewState;
    const updatedDataRows = allRows.map(r => r.cells);
    const fullDataset = [headers, ...updatedDataRows];

    // 检测用户是否勾选了同步更新本地 CSV 文件的选项
    const syncCheckbox = document.getElementById('preview-sync-csv-checkbox');
    const checkboxChecked = syncCheckbox ? syncCheckbox.checked : false;
    const applySyncPref = (v) => {
        if (syncCheckbox) syncCheckbox.checked = !!v;
        try { localStorage.setItem('jf_sync_local_csv', v ? '1' : '0'); } catch (e) {}
    };

    // 对比进入编辑模式时的备份，判断是否有实质改动
    const backupRows = currentFilePreviewState.backupRows || null;
    let dirty = true;
    let changedCount = allRows.length;
    if (backupRows) {
        if (JSON.stringify(backupRows) === JSON.stringify(allRows)) {
            dirty = false;
            changedCount = 0;
        } else {
            changedCount = 0;
            const max = Math.max(backupRows.length, allRows.length);
            for (let i = 0; i < max; i++) {
                if (JSON.stringify(backupRows[i]) !== JSON.stringify(allRows[i])) changedCount++;
            }
        }
    }

    // 无改动：直接退出编辑模式，不打扰用户
    if (!dirty) {
        delete currentFilePreviewState.backupRows;
        togglePreviewEditMode(false);
        showToast('未检测到改动，已退出编辑模式');
        return;
    }

    // 有改动：显式确认是否同步修改本地源文件（默认选项跟随复选框偏好）
    if (typeof showCustomDialog === 'function') {
        const fileName = currentFilePreviewState.title || `${type || '数据'}.csv`;
        const safeName = (typeof escapeHtml === 'function') ? escapeHtml(fileName) : String(fileName);
        showCustomDialog({
            title: '是否同步修改源文件？',
            body: `本次共修改 <strong>${changedCount}</strong> 行数据（${safeName}）。<br>“同步修改”将弹出系统窗口覆盖本地源文件；“仅本次任务”则修改只在当前页面生效，不动源文件。`,
            confirmText: checkboxChecked ? '同步修改源文件' : '仅保存到本次任务',
            cancelText: '返回继续编辑',
            onConfirm: () => {
                applySyncPref(checkboxChecked);
                doSavePreviewEdits(checkboxChecked);
            },
            onCancel: () => { /* 留在编辑模式，不保存 */ }
        });
        return;
    }

    doSavePreviewEdits(checkboxChecked);
};

// 实际执行保存（内存必写；shouldSyncLocal 为真时再弹系统窗口覆盖本地源文件）
async function doSavePreviewEdits(shouldSyncLocal) {
    if (!currentFilePreviewState) return;
    const { type, index, headers, allRows } = currentFilePreviewState;
    const updatedDataRows = allRows.map(r => r.cells);
    const fullDataset = [headers, ...updatedDataRows];

    try {
        if (type === 'homework') {
            if (index !== 'all' && rawHomeworkFiles[index]) {
                rawHomeworkFiles[index].data = fullDataset;
                if (typeof serializeCSV === 'function') rawHomeworkFiles[index].text = serializeCSV(fullDataset);
                updateHomeworkData();
            } else {
                homeworkData = fullDataset;
                if (rawHomeworkFiles.length === 1) {
                    rawHomeworkFiles[0].data = fullDataset;
                    if (typeof serializeCSV === 'function') rawHomeworkFiles[0].text = serializeCSV(fullDataset);
                }
                updateHomeworkData();
            }
        } else if (type === 'preview') {
            if (index !== 'all' && rawPreviewFiles[index]) {
                rawPreviewFiles[index].data = fullDataset;
                if (typeof serializeCSV === 'function') rawPreviewFiles[index].text = serializeCSV(fullDataset);
                updatePreviewData();
            } else {
                previewData = fullDataset;
                if (rawPreviewFiles.length === 1) {
                    rawPreviewFiles[0].data = fullDataset;
                    if (typeof serializeCSV === 'function') rawPreviewFiles[0].text = serializeCSV(fullDataset);
                }
                updatePreviewData();
            }
        } else if (type === 'note') {
            if (index !== 'all' && rawNoteFiles[index]) {
                rawNoteFiles[index].data = fullDataset;
                if (typeof serializeCSV === 'function') rawNoteFiles[index].text = serializeCSV(fullDataset);
                updateNoteData();
            } else {
                noteData = fullDataset;
                if (rawNoteFiles.length === 1) {
                    rawNoteFiles[0].data = fullDataset;
                    if (typeof serializeCSV === 'function') rawNoteFiles[0].text = serializeCSV(fullDataset);
                }
                updateNoteData();
            }
        } else if (type === 'class_test') {
            if (index !== 'all' && rawClassTestFiles[index]) {
                rawClassTestFiles[index].data = fullDataset;
                if (typeof serializeCSV === 'function') rawClassTestFiles[index].text = serializeCSV(fullDataset);
                updateClassTestData();
            } else {
                classTestData = fullDataset;
                if (rawClassTestFiles.length === 1) {
                    rawClassTestFiles[0].data = fullDataset;
                    if (typeof serializeCSV === 'function') rawClassTestFiles[0].text = serializeCSV(fullDataset);
                }
                updateClassTestData();
            }
        } else if (type === 'report') {
            if (reportData && reportData.length > 0) {
                const classIdx = headers.findIndex(h => String(h || '').includes('班级'));
                const nonBetaRows = reportData.slice(1).filter(r => {
                    if (classIdx >= 0) {
                        return !String(r[classIdx] || '').trim().includes('β1');
                    }
                    return false;
                });
                reportData = [headers, ...updatedDataRows, ...nonBetaRows];
            } else {
                reportData = fullDataset;
            }
            if (reportDropZone && typeof serializeCSV === 'function') {
                reportDropZone.dataset.rawText = serializeCSV(reportData);
            }
            if (typeof renderReportFileList === 'function') {
                renderReportFileList();
            }
            if (typeof detectAndSetFocusMaxScore === 'function') {
                detectAndSetFocusMaxScore(reportData);
            }
        }

        delete currentFilePreviewState.backupRows;
        togglePreviewEditMode(false);

        if (shouldSyncLocal) {
            // 对课堂报告，保留全量班级数据以防其他班级学生丢失
            const datasetToExport = (type === 'report' && reportData && reportData.length > 0) ? reportData : fullDataset;
            const csvContent = convertDatasetToCsv(datasetToExport);
            const fileName = currentFilePreviewState.title || `${type || 'data'}.csv`;

            showToast('已保存修改，正在调起本地文件保存窗口...');
            const saveRes = await saveCsvFileWithDialog(csvContent, fileName);
            if (saveRes && saveRes.cancelled) {
                showToast('内存数据已保存 (已取消本地文件覆盖)');
            } else if (saveRes && saveRes.success) {
                showToast('修改已保存并同步到本地文件');
            } else {
                showToast('修改已保存，但本地文件写入异常');
            }
        } else {
            showToast('修改已保存到本次任务，未改动本地源文件');
        }
    } catch (err) {
        console.error('保存修改失败:', err);
        showToast('保存失败: ' + (err?.message || '未知错误'));
    }
};

function renderPreviewTableRows() {
    if (!currentFilePreviewState) return;
    const { keyCols, filteredRows, isEditing } = currentFilePreviewState;
    const thead = document.getElementById('file-preview-thead');
    const tbody = document.getElementById('file-preview-tbody');
    const emptyEl = document.getElementById('file-preview-empty');
    const tableWrap = document.getElementById('file-preview-table-wrapper');
    const countStat = document.getElementById('file-preview-count-stat');

    if (countStat) {
        const modeLabel = isEditing ? ' [编辑模式]' : '';
        countStat.textContent = currentFilePreviewState.type === 'report'
            ? `共 ${filteredRows.length} 条数据 (已筛选结尾为β1学员)${modeLabel}`
            : `显示 ${filteredRows.length} / ${currentFilePreviewState.allRows.length} 条${modeLabel}`;
    }

    if (thead) {
        const actionTh = isEditing ? `<th style="width: 60px; text-align: center;">操作</th>` : '';
        thead.innerHTML = `
            <tr>
                <th style="width: 50px; text-align: center;">#</th>
                ${keyCols.map(c => {
                    let thStyle = '';
                    if (c.role === 'attendance') {
                        thStyle = 'text-align: center; min-width: 105px;';
                    } else if (c.role === 'status') {
                        thStyle = 'text-align: center; min-width: 115px;';
                    } else if (c.role === 'score') {
                        thStyle = 'text-align: center; min-width: 90px;';
                    } else if (c.role === 'virtual_id' || c.role === 'id') {
                        thStyle = 'min-width: 85px;';
                    } else if (c.role === 'split_name' || c.role === 'name') {
                        thStyle = 'min-width: 95px;';
                    } else if (c.role === 'class') {
                        thStyle = 'min-width: 95px;';
                    }
                    return `<th style="${thStyle}">${c.name}</th>`;
                }).join('')}
                ${actionTh}
            </tr>
        `;
    }

    if (filteredRows.length === 0) {
        if (tbody) tbody.innerHTML = '';
        if (tableWrap) tableWrap.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'block';

    const escapeAttr = (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (tbody) {
        const displayRows = filteredRows.slice(0, 150);
        tbody.innerHTML = displayRows.map((row, rIdx) => {
            const attCol = keyCols.find(k => k.role === 'attendance');
            const statusCol = keyCols.find(k => k.role === 'status');
            const scoreCol = keyCols.find(k => k.role === 'score');
            const rowAtt = attCol ? String(row.cells[attCol.index] || '').trim() : '';
            const rowStatus = statusCol ? String(row.cells[statusCol.index] || '').trim() : '';
            const rowScore = scoreCol ? String(row.cells[scoreCol.index] || '').trim() : '';
            const isRowAbsent = rowAtt.includes('缺勤') || (rowAtt !== '出勤' && (rowScore === '-' || rowScore === ''));

            // 判定是否“未交”或“没改”：未交的、没改的都没有分数（而不是为0）
            const isUngradedOrUnsubmitted = (
                currentFilePreviewState.type === 'report' ? isRowAbsent : (
                    (typeof isStatusUngraded === 'function' && isStatusUngraded(rowStatus)) ||
                    (typeof isStatusUnsubmitted === 'function' && isStatusUnsubmitted(rowStatus)) ||
                    rowStatus === '已提交' ||
                    (rowStatus.includes('已提交') && !rowStatus.includes('未')) ||
                    rowStatus.includes('批改中') ||
                    rowStatus.includes('未查阅') ||
                    rowStatus.includes('已查阅') ||
                    rowStatus.includes('未提交') ||
                    rowStatus.includes('缺交') ||
                    rowStatus === '未交'
                )
            );

            const cells = keyCols.map(c => {
                const rawVal = (row.cells[c.index] !== undefined && row.cells[c.index] !== null) ? String(row.cells[c.index]).trim() : '';

                if (isEditing) {
                    if (c.role === 'virtual_id') {
                        const idMatch = rawVal.match(/^(\d+)/);
                        const curId = idMatch ? idMatch[1] : '';
                        return `<td><input type="text" class="preview-cell-input" value="${escapeAttr(curId)}" oninput="updatePreviewDraftCell(${row._id}, ${c.index}, this.value, 'virtual_id')" placeholder="学号" /></td>`;
                    }
                    if (c.role === 'split_name') {
                        const nameMatch = rawVal.match(/^\d+[\s_\-–—]*(.+)$/);
                        const curName = nameMatch ? nameMatch[1].trim() : rawVal.replace(/^\d+/, '').trim();
                        return `<td><input type="text" class="preview-cell-input" value="${escapeAttr(curName)}" oninput="updatePreviewDraftCell(${row._id}, ${c.index}, this.value, 'split_name')" placeholder="姓名" /></td>`;
                    }
                    if (c.role === 'name') {
                        const nameMatch = rawVal.match(/^\d+[\s_\-–—]*(.+)$/);
                        const curName = nameMatch ? nameMatch[1].trim() : rawVal;
                        return `<td><input type="text" class="preview-cell-input" value="${escapeAttr(curName)}" oninput="updatePreviewDraftCell(${row._id}, ${c.index}, this.value)" placeholder="姓名" /></td>`;
                    }
                    if (c.role === 'attendance') {
                        return `<td style="text-align: center;">
                            <div class="att-segmented-control" title="点击切换出勤状态">
                                <button type="button" 
                                        class="att-seg-btn att-present-btn ${!isRowAbsent ? 'active' : ''}" 
                                        onclick="handlePreviewAttendanceChange(${row._id}, ${c.index}, '出勤')">出勤</button>
                                <button type="button" 
                                        class="att-seg-btn att-absent-btn ${isRowAbsent ? 'active' : ''}" 
                                        onclick="handlePreviewAttendanceChange(${row._id}, ${c.index}, '缺勤')">缺勤</button>
                            </div>
                        </td>`;
                    }
                    // 作业状态：编辑页面只支持去选择，而不是去敲字
                    if (c.role === 'status') {
                        const currentStatus = rawVal || '已完成';
                        const standardStatuses = Array.isArray(window.STANDARD_HOMEWORK_STATUSES)
                            ? [...window.STANDARD_HOMEWORK_STATUSES]
                            : ['已完成', '待订正', '已订正', '已审阅', '已提交', '批改中', '未查阅', '已查阅'];
                        if (currentStatus && !standardStatuses.includes(currentStatus)) {
                            standardStatuses.push(currentStatus);
                        }
                        return `<td style="text-align: center;">
                            <select class="preview-status-select" 
                                    onchange="handlePreviewStatusChange(${row._id}, ${c.index}, this.value)" 
                                    title="选择作业状态">
                                ${standardStatuses.map(st => `
                                    <option value="${escapeAttr(st)}" ${st === currentStatus ? 'selected' : ''}>${escapeAttr(st)}</option>
                                `).join('')}
                            </select>
                        </td>`;
                    }
                    // 分数：未交的没改的都没有分数（而不是为0）
                    if (c.role === 'score') {
                        if (isUngradedOrUnsubmitted) {
                            return `<td style="text-align: center;">
                                <input type="text" class="preview-cell-input preview-score-input preview-score-disabled" value="-" disabled title="未交或未批改状态无分数，切换为【已完成/待订正/已订正/已审阅】后可填写分数" style="width:65px; text-align:center;" />
                            </td>`;
                        }
                        const safeScore = (rawVal === '-' || rawVal === '') ? '' : rawVal;
                        return `<td style="text-align: center;">
                            <input type="text" inputmode="numeric" pattern="[0-9]*" class="preview-cell-input preview-score-input" value="${escapeAttr(safeScore)}" oninput="this.value = this.value.replace(/[^0-9]/g, ''); updatePreviewDraftCell(${row._id}, ${c.index}, this.value)" placeholder="分数" style="width:65px; text-align:center; font-weight:700;" />
                        </td>`;
                    }
                    return `<td><input type="text" class="preview-cell-input" value="${escapeAttr(rawVal)}" oninput="updatePreviewDraftCell(${row._id}, ${c.index}, this.value)" placeholder="${c.name}" /></td>`;
                }

                let cellHtml = rawVal;
                if (c.role === 'virtual_id') {
                    const idMatch = rawVal.match(/^(\d+)/);
                    const curId = idMatch ? idMatch[1] : '';
                    cellHtml = curId ? `<span class="preview-id-badge">${curId}</span>` : `<span style="color:var(--text-tertiary)">-</span>`;
                } else if (c.role === 'split_name') {
                    const nameMatch = rawVal.match(/^\d+[\s_\-–—]*(.+)$/);
                    const curName = nameMatch ? nameMatch[1].trim() : rawVal.replace(/^\d+/, '').trim();
                    cellHtml = `<strong>${curName || '-'}</strong>`;
                } else if (c.role === 'name') {
                    const nameMatch = rawVal.match(/^\d+[\s_\-–—]*(.+)$/);
                    const cleanName = nameMatch ? nameMatch[1].trim() : rawVal;
                    cellHtml = `<strong>${cleanName || '-'}</strong>`;
                } else if (c.role === 'id') {
                    cellHtml = rawVal ? `<span class="preview-id-badge">${rawVal}</span>` : `<span style="color:var(--text-tertiary)">-</span>`;
                } else if (c.role === 'attendance') {
                    cellHtml = isRowAbsent
                        ? `<span class="preview-status-badge badge-absent">缺勤</span>`
                        : `<span class="preview-status-badge badge-present">出勤</span>`;
                    return `<td style="text-align: center;">${cellHtml}</td>`;
                } else if (c.role === 'status') {
                    let badgeCls = 'badge-graded';
                    if ((typeof isStatusUngraded === 'function' && isStatusUngraded(rawVal)) || rawVal === '已提交' || (rawVal.includes('已提交') && !rawVal.includes('未')) || rawVal.includes('批改中')) {
                        badgeCls = 'badge-ungraded';
                    } else if ((typeof isStatusUnsubmitted === 'function' && isStatusUnsubmitted(rawVal)) || rawVal.includes('未查阅') || rawVal.includes('已查阅') || rawVal.includes('未提交') || rawVal.includes('缺交') || rawVal === '未交') {
                        badgeCls = 'badge-unsubmitted';
                    }
                    cellHtml = `<span class="preview-status-badge ${badgeCls}">${escapeAttr(rawVal || '-')}</span>`;
                    return `<td style="text-align: center;">${cellHtml}</td>`;
                } else if (c.role === 'score') {
                    // 统一规则：未交的没改的都没有分数（而不是为0）
                    if (isUngradedOrUnsubmitted) {
                        cellHtml = `<span style="color:var(--text-tertiary); font-family: monospace; font-size: 0.9rem;">-</span>`;
                    } else if (rawVal !== '' && rawVal !== null && rawVal !== undefined && rawVal !== '-') {
                        const scoreColor = currentFilePreviewState.type === 'report' ? '#f59e0b' : '#10b981';
                        const bgScore = currentFilePreviewState.type === 'report' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(16, 185, 129, 0.12)';
                        const borderScore = currentFilePreviewState.type === 'report' ? 'rgba(245, 158, 11, 0.25)' : 'rgba(16, 185, 129, 0.25)';
                        cellHtml = `<span class="preview-score-badge" style="background: ${bgScore}; color: ${scoreColor}; border: 1px solid ${borderScore}; font-weight: 700; padding: 2px 8px; border-radius: 6px;">${escapeAttr(rawVal)}</span>`;
                    } else {
                        cellHtml = `<span style="color:var(--text-tertiary); font-family: monospace; font-size: 0.9rem;">-</span>`;
                    }
                    return `<td style="text-align: center;">${cellHtml}</td>`;
                } else if (!rawVal) {
                    cellHtml = `<span style="color:var(--text-tertiary)">-</span>`;
                }
                return `<td>${cellHtml}</td>`;
            }).join('');

            const actionTd = isEditing
                ? `<td style="text-align: center;"><button type="button" class="preview-row-del-btn" onclick="deletePreviewRow(${row._id})" title="删除此学生行"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button></td>`
                : '';

            return `<tr><td style="text-align: center; color: var(--text-tertiary); font-size: 0.8rem;">${rIdx + 1}</td>${cells}${actionTd}</tr>`;
        }).join('');
    }
}

window.filterPreviewTable = function(keyword) {
    if (!currentFilePreviewState) return;
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) {
        currentFilePreviewState.filteredRows = currentFilePreviewState.allRows;
    } else {
        currentFilePreviewState.filteredRows = currentFilePreviewState.allRows.filter(row => {
            return currentFilePreviewState.keyCols.some(c => {
                const val = String(row.cells[c.index] || '').toLowerCase();
                return val.includes(kw);
            });
        });
    }
    renderPreviewTableRows();
};

window.closeFilePreviewModal = function() {
    if (currentFilePreviewState && currentFilePreviewState.isEditing) {
        if (!confirm('当前正处于编辑模式，未保存的修改将会丢失，确定关闭吗？')) {
            return;
        }
        togglePreviewEditMode(false);
    }
    closeNativeDialog('file-preview-modal');
};

// Listen for ESC key fallback when DialogHelper is unavailable
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !window.DialogHelper) {
        const previewModal = document.getElementById('file-preview-modal');
        if (previewModal && previewModal.style.display !== 'none') {
            closeFilePreviewModal();
            return;
        }
        const seeModal = document.getElementById('single-error-entry-modal');
        if (seeModal && seeModal.style.display !== 'none') {
            closeSingleErrorEntryModal();
        }
    }
});

// ========== 首页单人错题录入工作台 (Single Student Error Entry) ==========
const seeState = {
    mode: 'homework', // 'homework' | 'preview' | 'both'
    serverRoster: [],
    hwQuestions: [],
    pvQuestions: [],
    hwSelected: new Set(),
    pvSelected: new Set(),
    hasUserEdited: { homework: false, preview: false },
    recordStatus: {
        hw: { hasRecord: false, isUnsubmitted: false, isFullScore: false },
        pv: { hasRecord: false, isUnsubmitted: false, isFullScore: false }
    },
    lookupTimer: null,
    syncingInput: false,
    lastResultUrl: '',
    lastResultFeedback: ''
};

function populateSeeWeekSelects() {
    const maxW = (typeof plusMaxWeeks === 'number' && plusMaxWeeks > 0) ? plusMaxWeeks : 30;
    const hwSel = document.getElementById('see-homework-week');
    const pvSel = document.getElementById('see-preview-week');
    [hwSel, pvSel].forEach(sel => {
        if (!sel) return;
        const prevVal = sel.value;
        sel.innerHTML = '';
        for (let i = 1; i <= maxW; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = numToChinese_upload(i);
            sel.appendChild(opt);
        }
        if (prevVal && parseInt(prevVal, 10) >= 1 && parseInt(prevVal, 10) <= maxW) {
            sel.value = prevVal;
        }
    });
}

function openSingleErrorEntryModal() {
    const modal = document.getElementById('single-error-entry-modal');
    if (!modal) return;

    populateSeeWeekSelects();

    // 同步或读取记忆的学科、年级、班层与周次
    const subjectEl = document.getElementById('see-subject');
    const gradeEl = document.getElementById('see-grade');
    const tierEl = document.getElementById('see-tier');
    const hwWeekEl = document.getElementById('see-homework-week');
    const pvWeekEl = document.getElementById('see-preview-week');

    const pageSubject = getSelectedSubject();
    const savedSubject = localStorage.getItem('jf_see_subject');
    if (subjectEl) {
        subjectEl.value = pageSubject || savedSubject || '数学';
    }

    const detectedInfo = typeof getUploadClassInfo === 'function' ? getUploadClassInfo() : {};
    const plusGrade = document.getElementById('plus-grade')?.value || '';
    const savedGrade = localStorage.getItem('jf_see_grade') || '';
    if (gradeEl && !gradeEl.value) {
        const targetGrade = plusGrade || detectedInfo.grade || savedGrade;
        if (targetGrade) gradeEl.value = targetGrade;
    }

    const plusTier = document.getElementById('plus-tier')?.value || '';
    const savedTier = localStorage.getItem('jf_see_tier') || '';
    if (tierEl && !tierEl.value) {
        const targetTier = plusTier || detectedInfo.tier || savedTier;
        if (targetTier) tierEl.value = targetTier;
    }

    const plusHwWeek = document.getElementById('plus-week')?.value || '';
    const savedHwWeek = localStorage.getItem('jf_see_hw_week') || '';
    const autoHwWeek = (typeof homeworkData !== 'undefined' && homeworkData)
        ? (extractLessonNumber(homeworkFileName, 'homework') || 1)
        : 0;
    if (hwWeekEl) {
        hwWeekEl.value = String(plusHwWeek || autoHwWeek || savedHwWeek || 1);
    }

    const plusPvWeek = document.getElementById('plus-preview-week')?.value || '';
    const savedPvWeek = localStorage.getItem('jf_see_pv_week') || '';
    const autoPvWeek = (typeof previewData !== 'undefined' && previewData)
        ? (extractLessonNumber(previewFileName, 'preview') || 1)
        : 0;
    if (pvWeekEl) {
        pvWeekEl.value = String(plusPvWeek || autoPvWeek || savedPvWeek || hwWeekEl?.value || 1);
    }

    const savedMode = localStorage.getItem('jf_see_mode');
    if (savedMode && ['homework', 'preview', 'both'].includes(savedMode)) {
        seeState.mode = savedMode;
    }

    switchSeeEntryMode(seeState.mode);
    openNativeDialog(modal, {
        dismissible: true,
        onAfterClose: hideSeeStudentSuggest
    });

    onSeeClassMetaChange();
}

function closeSingleErrorEntryModal() {
    closeNativeDialog('single-error-entry-modal');
    if (!window.DialogHelper) {
        hideSeeStudentSuggest();
    }
}

function switchSeeEntryMode(mode) {
    if (!['homework', 'preview', 'both'].includes(mode)) mode = 'homework';
    seeState.mode = mode;
    localStorage.setItem('jf_see_mode', mode);

    const group = document.getElementById('see-mode-group');
    if (group) {
        group.querySelectorAll('.ui-pill').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
    }

    const hwSec = document.getElementById('see-homework-section');
    const pvSec = document.getElementById('see-preview-section');
    if (hwSec) hwSec.style.display = (mode === 'homework' || mode === 'both') ? 'flex' : 'none';
    if (pvSec) pvSec.style.display = (mode === 'preview' || mode === 'both') ? 'flex' : 'none';

    hideSeeResultPanel();
    scheduleSeeRecordLookup();
}

function onSeeClassMetaChange() {
    const subject = document.getElementById('see-subject')?.value || '';
    const grade = document.getElementById('see-grade')?.value || '';
    const tier = document.getElementById('see-tier')?.value || '';

    if (subject) localStorage.setItem('jf_see_subject', subject);
    if (grade) localStorage.setItem('jf_see_grade', grade);
    if (tier) localStorage.setItem('jf_see_tier', tier);

    hideSeeResultPanel();
    loadSeeClassRoster();
    loadSeeQbank('homework');
    loadSeeQbank('preview');
    scheduleSeeRecordLookup();
}

function onSeeWeekChange(bankType) {
    const hwWeek = document.getElementById('see-homework-week')?.value || '1';
    const pvWeek = document.getElementById('see-preview-week')?.value || '1';
    localStorage.setItem('jf_see_hw_week', hwWeek);
    localStorage.setItem('jf_see_pv_week', pvWeek);

    hideSeeResultPanel();
    loadSeeQbank(bankType === 'preview' ? 'preview' : 'homework');
    scheduleSeeRecordLookup();
}

async function loadSeeQbank(bankType) {
    const isPreview = bankType === 'preview';
    const subject = document.getElementById('see-subject')?.value || '';
    const grade = document.getElementById('see-grade')?.value || '';
    const tier = document.getElementById('see-tier')?.value || '';
    const week = document.getElementById(isPreview ? 'see-preview-week' : 'see-homework-week')?.value || '';

    const emptyEl = document.getElementById(isPreview ? 'see-pv-qgrid-empty' : 'see-hw-qgrid-empty');
    const gridEl = document.getElementById(isPreview ? 'see-pv-qgrid' : 'see-hw-qgrid');

    if (!subject || !grade || !tier || !week) {
        if ( isPreview ) seeState.pvQuestions = [];
        else seeState.hwQuestions = [];
        if (emptyEl) {
            emptyEl.style.display = 'flex';
            emptyEl.innerHTML = `<span>请先选择学科、年级与班层以加载题库考点</span>`;
        }
        if (gridEl) gridEl.style.display = 'none';
        return;
    }

    if (emptyEl) {
        emptyEl.style.display = 'flex';
        emptyEl.innerHTML = `<span>正在加载${numToChinese_upload(parseInt(week, 10))}题库...</span>`;
    }
    if (gridEl) gridEl.style.display = 'none';

    try {
        const params = {
            action: 'get',
            bankType: isPreview ? 'preview' : 'homework',
            subject,
            grade,
            tier,
            week
        };
        if (window.semesterYear) params.year = window.semesterYear;
        if (window.defaultSeason) params.season = window.defaultSeason;

        const query = new URLSearchParams(params).toString();
        const resp = await fetch(`${QBANK_API}?${query}`);
        const res = await resp.json();

        const rawQuestions = (res && res.success && res.data && Array.isArray(res.data.questions))
            ? res.data.questions
            : [];

        const normalized = [];
        const seenNums = new Set();
        rawQuestions.forEach(q => {
            const qNum = parseInt(q.id || q.question_num, 10);
            if (!qNum || qNum <= 0 || seenNums.has(qNum)) return;
            seenNums.add(qNum);
            const rawTopic = String(q.topic || '').trim();
            const cleanTopic = (typeof cleanTopicTrailingPunctuation === 'function')
                ? cleanTopicTrailingPunctuation(rawTopic)
                : rawTopic.replace(/[\s,，.。;；:：、\-_—]+$/u, '').trim();
            normalized.push({ id: qNum, topic: cleanTopic });
        });
        normalized.sort((a, b) => a.id - b.id);

        if (isPreview) {
            seeState.pvQuestions = normalized;
        } else {
            seeState.hwQuestions = normalized;
        }
        renderSeeQgrid(bankType);
    } catch (e) {
        if (isPreview) seeState.pvQuestions = [];
        else seeState.hwQuestions = [];
        renderSeeQgrid(bankType);
    }
}

function renderSeeQgrid(bankType) {
    const isPreview = bankType === 'preview';
    const questions = isPreview ? seeState.pvQuestions : seeState.hwQuestions;
    const selectedSet = isPreview ? seeState.pvSelected : seeState.hwSelected;
    const emptyEl = document.getElementById(isPreview ? 'see-pv-qgrid-empty' : 'see-hw-qgrid-empty');
    const gridEl = document.getElementById(isPreview ? 'see-pv-qgrid' : 'see-hw-qgrid');

    if (!emptyEl || !gridEl) return;

    if (!questions || questions.length === 0) {
        gridEl.style.display = 'none';
        emptyEl.style.display = 'flex';
        emptyEl.innerHTML = `
            <span>该专题暂未录入题库，可直接在下方输入框填写错题题号</span>
            <a href="question-bank.html" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: 500; white-space: nowrap;">去录题 →</a>
        `;
        return;
    }

    emptyEl.style.display = 'none';
    gridEl.style.display = 'grid';
    gridEl.innerHTML = questions.map(q => {
        const isSel = selectedSet.has(q.id);
        const topicText = q.topic || `第 ${q.id} 题`;
        return `
            <button type="button" class="see-qchip ${isSel ? 'selected' : ''}" data-qnum="${q.id}"
                onclick="toggleSeeQuestionChip('${bankType}', ${q.id})" title="第 ${q.id} 题：${escapeHtml(topicText)}">
                <span class="see-qchip-num">${q.id}</span>
                <span class="see-qchip-topic">${escapeHtml(topicText)}</span>
            </button>
        `;
    }).join('');
}

function toggleSeeQuestionChip(bankType, qNum) {
    const num = parseInt(qNum, 10);
    if (!num || num <= 0) return;
    const selectedSet = bankType === 'preview' ? seeState.pvSelected : seeState.hwSelected;
    if (selectedSet.has(num)) {
        selectedSet.delete(num);
    } else {
        selectedSet.add(num);
    }
    if (seeState.hasUserEdited) {
        seeState.hasUserEdited[bankType] = true;
    }
    hideSeeResultPanel();
    syncSeeErrorUI(bankType, false);
}

function clearSeeErrors(bankType) {
    const selectedSet = bankType === 'preview' ? seeState.pvSelected : seeState.hwSelected;
    selectedSet.clear();
    if (seeState.hasUserEdited) {
        seeState.hasUserEdited[bankType] = true;
    }
    hideSeeResultPanel();
    syncSeeErrorUI(bankType, false);
}

function parseSeeErrorNumbersFromText(rawText) {
    if (!rawText) return [];
    let norm = String(rawText).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    norm = norm.trim();
    if (!norm || /^(?:无|没有|0|零|全对|全部正确|无错题|none)$/i.test(norm)) {
        return [];
    }

    // 若粘贴了标准评语前缀，先剥离前缀
    const prefixMatch = norm.match(/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习|预习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?\s*[:：]\s*(.*)$/i);
    if (prefixMatch) {
        norm = prefixMatch[1].trim();
    }

    const nums = [];
    // 支持区间写法如 3-5
    const rangeReplaced = norm.replace(/(\d+)\s*[\-~～至到]\s*(\d+)/g, (_, a, b) => {
        const start = parseInt(a, 10);
        const end = parseInt(b, 10);
        if (start > 0 && end >= start && end - start <= 50) {
            const arr = [];
            for (let k = start; k <= end; k++) arr.push(k);
            return arr.join(',');
        }
        return `${a},${b}`;
    });

    const matches = rangeReplaced.match(/\d+/g);
    if (matches) {
        matches.forEach(m => {
            const n = parseInt(m, 10);
            if (n >= 1 && n <= 120) {
                nums.push(n);
            }
        });
    }
    return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function onSeeErrorTextInput(bankType, rawVal) {
    if (seeState.syncingInput) return;
    const nums = parseSeeErrorNumbersFromText(rawVal);
    if (bankType === 'preview') {
        seeState.pvSelected = new Set(nums);
    } else {
        seeState.hwSelected = new Set(nums);
    }
    if (seeState.hasUserEdited) {
        seeState.hasUserEdited[bankType] = true;
    }
    hideSeeResultPanel();
    syncSeeErrorUI(bankType, true);
}

function syncSeeErrorUI(bankType, skipInputSync) {
    const isPreview = bankType === 'preview';
    const selectedSet = isPreview ? seeState.pvSelected : seeState.hwSelected;
    const sorted = Array.from(selectedSet).sort((a, b) => a - b);

    // 1. 更新点选胶囊状态
    const gridEl = document.getElementById(isPreview ? 'see-pv-qgrid' : 'see-hw-qgrid');
    if (gridEl) {
        gridEl.querySelectorAll('.see-qchip').forEach(btn => {
            const qNum = parseInt(btn.getAttribute('data-qnum'), 10);
            btn.classList.toggle('selected', selectedSet.has(qNum));
        });
    }

    // 2. 更新计数徽章
    const badgeEl = document.getElementById(isPreview ? 'see-pv-count-badge' : 'see-hw-count-badge');
    if (badgeEl) {
        badgeEl.classList.remove('has-err', 'is-unsub', 'is-nodata');
        if (sorted.length > 0) {
            badgeEl.textContent = `错 ${sorted.length} 题（第 ${sorted.join('、')} 题）`;
            badgeEl.classList.add('has-err');
        } else {
            const statusObj = isPreview ? seeState.recordStatus?.pv : seeState.recordStatus?.hw;
            const isUserEdited = seeState.hasUserEdited?.[bankType];

            if (isUserEdited) {
                badgeEl.textContent = '设为无错题（0 题）';
            } else if (statusObj?.isUnsubmitted) {
                badgeEl.textContent = '未交（0 题）';
                badgeEl.classList.add('is-unsub');
            } else if (!statusObj?.hasRecord) {
                badgeEl.textContent = '未建档（0 题）';
                badgeEl.classList.add('is-nodata');
            } else if (statusObj?.isFullScore) {
                badgeEl.textContent = '全对（0 题）';
            } else {
                badgeEl.textContent = '0 题';
            }
        }
    }

    // 3. 同步底部输入框
    if (!skipInputSync) {
        const inputEl = document.getElementById(isPreview ? 'see-pv-input' : 'see-hw-input');
        if (inputEl) {
            seeState.syncingInput = true;
            inputEl.value = sorted.join(', ');
            seeState.syncingInput = false;
        }
    }
}

async function loadSeeClassRoster() {
    const subject = document.getElementById('see-subject')?.value || '';
    const grade = document.getElementById('see-grade')?.value || '';
    const tier = document.getElementById('see-tier')?.value || '';
    const hintEl = document.getElementById('see-roster-count-hint');

    if (!subject || !grade) {
        seeState.serverRoster = [];
        updateSeeRosterHint();
        return;
    }

    try {
        const payload = {
            subject,
            grade,
            tier,
            year: window.semesterYear || 2026,
            season: window.defaultSeason || 'autumn',
            with_roster: 1
        };
        const resp = await fetch('api/retest.php?action=get_student_week_record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const res = await resp.json();
        if (res && res.success && Array.isArray(res.students)) {
            seeState.serverRoster = res.students;
        } else {
            seeState.serverRoster = [];
        }
    } catch (e) {
        seeState.serverRoster = [];
    }
    updateSeeRosterHint();
}

function getCombinedSeeRoster() {
    const map = new Map();
    const currentTier = document.getElementById('see-tier')?.value || '';

    const addEntry = (id, name, tier = '') => {
        const cleanName = String(name || '').trim();
        const cleanId = String(id || '').trim();
        if (!cleanName) return;
        const key = cleanId ? `${cleanId}_${cleanName}` : cleanName;
        if (!map.has(key)) {
            map.set(key, { id: cleanId, name: cleanName, tier: tier || '' });
        } else if (tier && !map.get(key).tier) {
            map.get(key).tier = tier;
        }
    };

    // 1. 当前页面已上传的名单或作业数据优先合并
    if (typeof rosterData !== 'undefined' && Array.isArray(rosterData) && rosterData.length > 1) {
        const hdr = rosterData[0].map(h => String(h || ''));
        const nameIdx = hdr.findIndex(h => h.includes('姓名') || h.includes('学生'));
        const idIdx = hdr.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('编码'));
        for (let i = 1; i < rosterData.length; i++) {
            const row = rosterData[i];
            if (!row) continue;
            const rawName = String(row[nameIdx >= 0 ? nameIdx : 0] || '').trim();
            if (!rawName) continue;
            const m = rawName.match(/^(\d+)\s*(.+)$/);
            const sName = m ? m[2].trim() : rawName;
            const sId = (idIdx >= 0 && row[idIdx]) ? String(row[idIdx]).trim() : (m ? m[1] : '');
            addEntry(sId, sName, currentTier);
        }
    }

    [typeof homeworkData !== 'undefined' ? homeworkData : null, typeof previewData !== 'undefined' ? previewData : null].forEach(dataset => {
        if (!Array.isArray(dataset) || dataset.length <= 1) return;
        const hdr = dataset[0].map(h => String(h || ''));
        const nameIdx = hdr.findIndex(h => h.includes('姓名'));
        const idIdx = hdr.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('卡号'));
        if (nameIdx < 0) return;
        for (let i = 1; i < dataset.length; i++) {
            const row = dataset[i];
            if (!row) continue;
            const fullName = String(row[nameIdx] || '').trim();
            if (!fullName) continue;
            const m = fullName.match(/^(\d+)\s*(.+)$/);
            const sName = m ? m[2].trim() : fullName;
            const sId = (idIdx >= 0 && row[idIdx]) ? String(row[idIdx]).trim() : (m ? m[1] : '');
            addEntry(sId, sName, currentTier);
        }
    });

    // 2. 服务端该学科+年级历史学员名册
    (seeState.serverRoster || []).forEach(st => {
        addEntry(st.id, st.name, st.tier);
    });

    const list = Array.from(map.values());
    // 当前班层学员排在前面
    list.sort((a, b) => {
        const aMatch = (currentTier && a.tier === currentTier) ? 1 : 0;
        const bMatch = (currentTier && b.tier === currentTier) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return a.name.localeCompare(b.name, 'zh-CN');
    });
    return list;
}

function updateSeeRosterHint() {
    const hintEl = document.getElementById('see-roster-count-hint');
    if (!hintEl) return;
    const list = getCombinedSeeRoster();
    if (list.length > 0) {
        hintEl.textContent = `已关联 ${list.length} 名历史学员，可输入检索`;
    } else {
        hintEl.textContent = '支持输入“学号+姓名”自动拆分';
    }
}

function onSeeStudentInput(rawVal) {
    const nameInput = document.getElementById('see-student-name');
    const idInput = document.getElementById('see-student-id');
    const val = String(rawVal || '');

    // 智能识别 "12345张三"、"01张三" 或 "12345 张三" 自动拆分学号与姓名
    const trimmed = val.trim();
    const comboMatch = trimmed.match(/^(\d+)[\s_\-–—]+([^\d\s].*)$/) || trimmed.match(/^(\d{2,})([^\d\s].*)$/);
    if (comboMatch) {
        const extractedId = comboMatch[1].trim();
        const extractedName = comboMatch[2].trim();
        if (nameInput) nameInput.value = extractedName;
        if (idInput) idInput.value = extractedId;
    }

    hideSeeResultPanel();
    renderSeeStudentSuggest(nameInput ? nameInput.value : val);
    scheduleSeeRecordLookup();
}

function onSeeStudentFocus() {
    const nameInput = document.getElementById('see-student-name');
    renderSeeStudentSuggest(nameInput ? nameInput.value : '');
}

function onSeeStudentIdChange() {
    hideSeeResultPanel();
    scheduleSeeRecordLookup();
}

function renderSeeStudentSuggest(keyword) {
    const dropdown = document.getElementById('see-student-suggest');
    if (!dropdown) return;

    const list = getCombinedSeeRoster();
    if (list.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    const kw = String(keyword || '').trim().toLowerCase();
    const filtered = kw
        ? list.filter(item => {
            const nameMatch = item.name && item.name.toLowerCase().includes(kw);
            const idMatch = item.id && item.id.toLowerCase().includes(kw);
            const comboMatch = item.id && `${item.id}${item.name}`.toLowerCase().includes(kw);
            return nameMatch || idMatch || comboMatch;
        })
        : list;

    if (filtered.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    const slice = filtered.slice(0, 24);
    dropdown.innerHTML = slice.map((item, idx) => `
        <div class="see-suggest-item" data-idx="${idx}">
            <div class="see-suggest-left">
                <span class="see-suggest-name">${escapeHtml(item.name)}</span>
                ${item.id ? `<span class="see-suggest-id">${escapeHtml(item.id)}</span>` : ''}
            </div>
            ${item.tier ? `<span class="see-suggest-tier">${escapeHtml(item.tier)}班</span>` : ''}
        </div>
    `).join('');

    dropdown.querySelectorAll('.see-suggest-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt(el.getAttribute('data-idx'), 10);
            const target = slice[idx];
            if (target) {
                selectSeeStudent(target.id, target.name, target.tier);
            }
        });
    });

    dropdown.style.display = 'block';
}

function hideSeeStudentSuggest() {
    const dropdown = document.getElementById('see-student-suggest');
    if (dropdown) dropdown.style.display = 'none';
}

function selectSeeStudent(id, name, tier) {
    const nameInput = document.getElementById('see-student-name');
    const idInput = document.getElementById('see-student-id');
    const tierEl = document.getElementById('see-tier');

    if (nameInput) nameInput.value = name || '';
    if (idInput) idInput.value = id || '';
    if (tier && tierEl && !tierEl.value) {
        tierEl.value = tier;
        localStorage.setItem('jf_see_tier', tier);
        loadSeeQbank('homework');
        loadSeeQbank('preview');
    }

    hideSeeStudentSuggest();
    hideSeeResultPanel();
    fetchSeeStudentRecord();
}

// 点击自动补全区域外部时收起下拉框
document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.see-autocomplete-wrap')) {
        hideSeeStudentSuggest();
    }
});

function scheduleSeeRecordLookup() {
    if (seeState.lookupTimer) {
        clearTimeout(seeState.lookupTimer);
    }
    seeState.lookupTimer = setTimeout(() => {
        fetchSeeStudentRecord();
    }, 240);
}

async function fetchSeeStudentRecord() {
    const subject = document.getElementById('see-subject')?.value || '';
    const grade = document.getElementById('see-grade')?.value || '';
    const tier = document.getElementById('see-tier')?.value || '';
    const hwWeek = parseInt(document.getElementById('see-homework-week')?.value || '0', 10);
    const pvWeek = parseInt(document.getElementById('see-preview-week')?.value || '0', 10);
    const studentName = (document.getElementById('see-student-name')?.value || '').trim();
    const studentIdInput = document.getElementById('see-student-id');
    const studentId = (studentIdInput?.value || '').trim();

    const statusBox = document.getElementById('see-record-status');
    const statusDot = document.getElementById('see-status-dot');
    const statusText = document.getElementById('see-record-status-text');

    if (!studentName || !subject || !grade) {
        if (statusBox) statusBox.style.display = 'none';
        return;
    }

    try {
        const resp = await fetch('api/retest.php?action=get_student_week_record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                year: window.semesterYear || 2026,
                season: window.defaultSeason || 'autumn',
                subject,
                grade,
                tier,
                week: hwWeek,
                preview_week: pvWeek,
                student_id: studentId,
                student_name: studentName
            })
        });
        const res = await resp.json();
        if (!res || !res.success || !res.record) {
            if (statusBox) statusBox.style.display = 'none';
            return;
        }

        // 若输入姓名发生了变化（异步竞态保护），直接丢弃旧响应
        const currentTypedName = (document.getElementById('see-student-name')?.value || '').trim();
        if (currentTypedName !== studentName) return;

        const rec = res.record;
        if (!studentId && rec.studentId && studentIdInput) {
            studentIdInput.value = rec.studentId;
        }

        // 记录该生在两项上的历史存档状态
        seeState.recordStatus = {
            hw: {
                hasRecord: !!rec.hasHomeworkRecord,
                isUnsubmitted: !!rec.isHomeworkUnsubmitted,
                isFullScore: !!rec.isHomeworkFullScore
            },
            pv: {
                hasRecord: !!rec.hasPreviewRecord,
                isUnsubmitted: !!rec.isPreviewUnsubmitted,
                isFullScore: !!rec.isPreviewFullScore
            }
        };
        seeState.hasUserEdited = { homework: false, preview: false };

        // 回显已有错题
        if (rec.hasHomeworkRecord && Array.isArray(rec.homeworkErrors)) {
            seeState.hwSelected = new Set(rec.homeworkErrors.map(n => parseInt(n, 10)).filter(n => n > 0));
        } else {
            seeState.hwSelected = new Set();
        }
        syncSeeErrorUI('homework', false);

        if (rec.hasPreviewRecord && Array.isArray(rec.previewErrors)) {
            seeState.pvSelected = new Set(rec.previewErrors.map(n => parseInt(n, 10)).filter(n => n > 0));
        } else {
            seeState.pvSelected = new Set();
        }
        syncSeeErrorUI('preview', false);

        // 状态提示条文案（准确区分未交、全对、未建档与有错题）
        if (statusBox && statusText && statusDot) {
            const parts = [];
            let hasWarning = false;

            if (seeState.mode === 'homework' || seeState.mode === 'both') {
                if (rec.isHomeworkUnsubmitted) {
                    hasWarning = true;
                    parts.push(`巩固${numToChinese_upload(hwWeek)}：未交作业（点击上方题号补录错题，保存后自动建档）`);
                } else if (!rec.hasHomeworkRecord) {
                    parts.push(`巩固${numToChinese_upload(hwWeek)}：当周未建档`);
                } else if (rec.homeworkErrors.length > 0) {
                    parts.push(`巩固${numToChinese_upload(hwWeek)}已存档（错第 ${rec.homeworkErrors.join('、')} 题）`);
                } else if (rec.isHomeworkFullScore) {
                    parts.push(`巩固${numToChinese_upload(hwWeek)}已存档（全对）`);
                } else {
                    parts.push(`巩固${numToChinese_upload(hwWeek)}已存档（无错题）`);
                }
            }

            if (seeState.mode === 'preview' || seeState.mode === 'both') {
                if (rec.isPreviewUnsubmitted) {
                    hasWarning = true;
                    parts.push(`预习${numToChinese_upload(pvWeek)}：未交预习（点击上方题号补录错题）`);
                } else if (!rec.hasPreviewRecord) {
                    parts.push(`预习${numToChinese_upload(pvWeek)}：当周未建档`);
                } else if (rec.previewErrors.length > 0) {
                    parts.push(`预习${numToChinese_upload(pvWeek)}已存档（错第 ${rec.previewErrors.join('、')} 题）`);
                } else if (rec.isPreviewFullScore) {
                    parts.push(`预习${numToChinese_upload(pvWeek)}已存档（全对）`);
                } else {
                    parts.push(`预习${numToChinese_upload(pvWeek)}已存档（无错题）`);
                }
            }

            const hasExisting = ((seeState.mode === 'homework' || seeState.mode === 'both') && rec.hasHomeworkRecord)
                || ((seeState.mode === 'preview' || seeState.mode === 'both') && rec.hasPreviewRecord);

            statusDot.className = 'see-status-dot ' + (hasWarning ? 'warning' : (hasExisting ? 'brand' : ''));
            statusText.textContent = parts.join(' · ');
            statusBox.style.display = 'flex';
        }
    } catch (e) {
        if (statusBox) statusBox.style.display = 'none';
    }
}

function getSeeRetestBaseUrl() {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return `${window.location.origin}${window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'))}/retest.html`;
    }
    if (/feedback(backup|test)\.wxjifang\.cn$/.test(host)) {
        return `https://${host}/retest.html`;
    }
    return 'https://vip.wxjifang.cn/retest.html';
}

function getSeeVariationNotice(studentName, weekNum) {
    const compoundSurnames = [
        '欧阳', '司马', '上官', '诸葛', '慕容', '令狐', '公孙', '西门', '南宫', '夏侯',
        '尉迟', '轩辕', '端木', '东方', '闾丘', '亓官', '司寇', '子车', '颛孙', '巫马',
        '公西', '漆雕', '乐正', '壤驷', '公良', '拓跋', '夹谷', '宰父', '谷利', '句容',
        '鲜于', '伯夷', '申屠', '公羊', '南荣', '赫连', '皇甫', '宗政', '濮阳', '公冶',
        '太叔', '钟离', '长孙', '宇文', '司徒', '司空', '百里', '呼延', '梁丘', '左丘', '东郭'
    ];
    const s = (studentName || '').trim();
    let honorific = '同学';
    if (s) {
        const matchedSurname = compoundSurnames.find(sur => s.startsWith(sur));
        if (matchedSurname) {
            honorific = `${matchedSurname}同学`;
        } else if (/[\u4e00-\u9fa5]/.test(s.charAt(0))) {
            honorific = `小${s.charAt(0)}同学`;
        } else {
            honorific = `${s}同学`;
        }
    }
    const templates = [
        (n) => `课后巩固的“举一反三”题目也已加入错题本，方便${n}后续复习。`,
        (n) => `针对课后错题配套的“举一反三”同类练习已同步到错题本，${n}课后可以趁热打铁练一练。`,
        (n) => `这次课后错题对应的变式练习已经整理进错题本，方便${n}针对薄弱点查漏补缺。`,
        (n) => `错题本里已配好针对薄弱考点的“举一反三”题目，建议${n}复习时顺手过一遍。`,
        (n) => `课后巩固的同类变式题已放进错题本，方便${n}把同类题型彻底吃透。`,
        (n) => `针对今天这几道错题，错题本已补充了对应的“举一反三”，${n}有空可以练练巩固一下。`,
        (n) => `相关的“举一反三”题目已经录入错题本，方便${n}后续巩固思路、加深印象。`,
        (n) => `错题本中已加入针对性的“举一反三”巩固题，${n}复习时别忘了重点看看。`
    ];
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
    }
    const week = parseInt(weekNum, 10) || 1;
    const idx = (Math.abs(hash) + week * 3) % templates.length;
    return templates[idx](honorific);
}

function buildSeeFeedbackSnippet(params) {
    const {
        studentName,
        subject,
        mode,
        hwWeek,
        pvWeek,
        hwErrors,
        pvErrors,
        retestUrl
    } = params;

    const lines = [];
    const hasPv = (mode === 'preview' || mode === 'both');
    const hasHw = (mode === 'homework' || mode === 'both');

    if (hasPv && pvErrors.length > 0) {
        const pvQMap = {};
        (seeState.pvQuestions || []).forEach(q => {
            if (q.topic) pvQMap[q.id] = q.topic;
        });
        const pvTopics = [...new Set(pvErrors.map(num => pvQMap[num] || `第${num}题`).filter(Boolean))];
        if (pvTopics.length > 0) {
            lines.push(`【预习薄弱考点】：${pvTopics.join('、')}`);
        }
        const isEnglish = String(subject || '').includes('英语');
        lines.push(isEnglish
            ? '预习题错题已加入错题本。'
            : '预习题错题已加入错题本，建议结合讲义中的同类题进行巩固。'
        );
    }

    if (hasHw && hwErrors.length > 0) {
        const hwQMap = {};
        (seeState.hwQuestions || []).forEach(q => {
            if (q.topic) hwQMap[q.id] = q.topic;
        });
        const hwTopics = [...new Set(hwErrors.map(num => hwQMap[num] || `第${num}题`).filter(Boolean))];
        if (hwTopics.length > 0) {
            lines.push(`【个人薄弱点】：${hwTopics.join('、')}`);
        }
        lines.push(getSeeVariationNotice(studentName, hwWeek || pvWeek || 1));
    }

    if (lines.length === 0) {
        lines.push(`本次录入无错题，已同步更新${studentName}同学的错题本档案。`);
    }

    if (retestUrl) {
        lines.push(`【错题本】：${retestUrl}`);
    }

    return lines.join('\n');
}

function hideSeeResultPanel() {
    const panel = document.getElementById('see-result-panel');
    if (panel) panel.style.display = 'none';
}

async function submitSingleErrorEntry(triggerBtn) {
    const subject = document.getElementById('see-subject')?.value || '';
    const grade = document.getElementById('see-grade')?.value || '';
    const tier = document.getElementById('see-tier')?.value || '';
    const hwWeek = parseInt(document.getElementById('see-homework-week')?.value || '1', 10);
    const pvWeek = parseInt(document.getElementById('see-preview-week')?.value || '1', 10);
    const studentName = (document.getElementById('see-student-name')?.value || '').trim();
    const studentId = (document.getElementById('see-student-id')?.value || '').trim();

    if (!subject) {
        showToast('请选择学科');
        return;
    }
    if (!grade) {
        showToast('请选择年级');
        return;
    }
    if (!tier) {
        showToast('请选择班层');
        return;
    }
    if (!studentName) {
        showToast('请输入或选择学员姓名');
        document.getElementById('see-student-name')?.focus();
        return;
    }

    const mode = seeState.mode;
    const hasHomeworkData = (mode === 'homework' || mode === 'both');
    const hasPreviewData = (mode === 'preview' || mode === 'both');
    const hwErrors = Array.from(seeState.hwSelected).sort((a, b) => a - b);
    const pvErrors = Array.from(seeState.pvSelected).sort((a, b) => a - b);

    const effectiveWeek = hasHomeworkData ? hwWeek : pvWeek;
    const effectivePreviewWeek = hasPreviewData ? pvWeek : hwWeek;

    const btn = triggerBtn || document.getElementById('see-save-btn');
    await withButtonLoading(btn, '正在保存...', async () => {
        try {
            // 若原本处于未交状态，补录错题后自动生成已补交评语，彻底自愈清除“未交”标记
            const hwWasUnsub = !!seeState.recordStatus?.hw?.isUnsubmitted;
            const pvWasUnsub = !!seeState.recordStatus?.pv?.isUnsubmitted;
            const hwCommentPayload = hwWasUnsub
                ? (hwErrors.length > 0 ? `作业已补交，错题题号：${hwErrors.join('、')}` : '作业已补交订正，全部正确')
                : '';
            const pvCommentPayload = pvWasUnsub
                ? (pvErrors.length > 0 ? `预习已补交，错题题号：${pvErrors.join('、')}` : '预习已补交，全部正确')
                : '';

            const payload = {
                year: window.semesterYear || 2026,
                season: window.defaultSeason || 'autumn',
                subject,
                grade,
                tier,
                week: effectiveWeek,
                preview_week: effectivePreviewWeek,
                has_homework_data: hasHomeworkData,
                has_preview_data: hasPreviewData,
                errors_only: true,
                source_files: ['单人手动录入'],
                teacher_username: window.currentUser?.username || '',
                teacher_name: window.currentUser?.real_name || '',
                students: [
                    {
                        id: studentId,
                        name: studentName,
                        fullName: studentId ? `${studentId}${studentName}` : studentName,
                        errors: hasHomeworkData ? hwErrors : [],
                        previewErrors: hasPreviewData ? pvErrors : [],
                        previewProvided: hasPreviewData,
                        previewWeek: effectivePreviewWeek,
                        homeworkScore: null,
                        previewScore: null,
                        totalScore: null,
                        comment: hwCommentPayload,
                        previewComment: pvCommentPayload
                    }
                ]
            };

            const resp = await fetch('api/retest.php?action=encrypt_batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const res = await resp.json();

            if (!res || !res.success) {
                showToast((res && res.error) ? res.error : '保存错题失败，请重试', 'error');
                return;
            }

            const tokensMap = res.tokens || {};
            const stdKey = studentId ? `${studentId}_${studentName}_${grade}_${subject}` : studentName;
            const legacyKey = studentId ? `${studentId}_${studentName}` : studentName;
            const token = tokensMap[stdKey]
                || tokensMap[legacyKey]
                || tokensMap[studentName]
                || Object.values(tokensMap)[0]
                || '';

            const retestBase = getSeeRetestBaseUrl();
            const retestUrl = token ? `${retestBase}?token=${encodeURIComponent(token)}` : '';
            const feedbackSnippet = buildSeeFeedbackSnippet({
                studentName,
                subject,
                mode,
                hwWeek,
                pvWeek,
                hwErrors,
                pvErrors,
                retestUrl
            });

            seeState.lastResultUrl = retestUrl;
            seeState.lastResultFeedback = feedbackSnippet;

            const resultPanel = document.getElementById('see-result-panel');
            const resultTitle = document.getElementById('see-result-title');
            const resultTextarea = document.getElementById('see-result-feedback');
            const openLink = document.getElementById('see-open-retest-link');
            const nextBtn = document.getElementById('see-next-student-btn');

            if (resultTitle) {
                resultTitle.textContent = `已保存 ${studentName}${studentId ? ` (${studentId})` : ''} 的错题本`;
            }
            if (resultTextarea) {
                resultTextarea.value = feedbackSnippet;
            }
            if (openLink) {
                openLink.href = retestUrl || 'javascript:void(0)';
                openLink.style.display = retestUrl ? 'inline-flex' : 'none';
            }
            if (resultPanel) {
                resultPanel.style.display = 'flex';
            }
            if (nextBtn) {
                nextBtn.style.display = 'inline-flex';
            }

            // 刷新班级名册与当前学员存档状态显示
            loadSeeClassRoster();
            fetchSeeStudentRecord();
            showToast(`已更新 ${studentName} 的错题本记录`, 'success');
        } catch (err) {
            console.error('单人错题保存异常:', err);
            showToast('网络请求异常，请检查网络连接', 'error');
        }
    });
}

async function copySeeTextHelper(text, successMsg) {
    if (!text) {
        showToast('暂无可复制内容');
        return;
    }
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showToast(successMsg, 'success');
    } catch (e) {
        showToast('复制失败，请手动选择复制', 'error');
    }
}

function copySeeRetestLink() {
    copySeeTextHelper(seeState.lastResultUrl, '已复制专属错题本链接');
}

function copySeeFeedbackText() {
    const ta = document.getElementById('see-result-feedback');
    const text = (ta && ta.value) ? ta.value : seeState.lastResultFeedback;
    copySeeTextHelper(text, '已复制薄弱考点反馈');
}

function resetSeeForNextStudent() {
    const nameInput = document.getElementById('see-student-name');
    const idInput = document.getElementById('see-student-id');
    const statusBox = document.getElementById('see-record-status');

    if (nameInput) nameInput.value = '';
    if (idInput) idInput.value = '';
    if (statusBox) statusBox.style.display = 'none';

    seeState.hwSelected.clear();
    seeState.pvSelected.clear();
    syncSeeErrorUI('homework', false);
    syncSeeErrorUI('preview', false);
    hideSeeResultPanel();

    if (nameInput) nameInput.focus();
}

window.openSingleErrorEntryModal = openSingleErrorEntryModal;
window.closeSingleErrorEntryModal = closeSingleErrorEntryModal;
window.switchSeeEntryMode = switchSeeEntryMode;
window.onSeeClassMetaChange = onSeeClassMetaChange;
window.onSeeWeekChange = onSeeWeekChange;
window.toggleSeeQuestionChip = toggleSeeQuestionChip;
window.clearSeeErrors = clearSeeErrors;
window.onSeeErrorTextInput = onSeeErrorTextInput;
window.onSeeStudentInput = onSeeStudentInput;
window.onSeeStudentFocus = onSeeStudentFocus;
window.onSeeStudentIdChange = onSeeStudentIdChange;
window.selectSeeStudent = selectSeeStudent;
window.submitSingleErrorEntry = submitSingleErrorEntry;
window.copySeeRetestLink = copySeeRetestLink;
window.copySeeFeedbackText = copySeeFeedbackText;
window.resetSeeForNextStudent = resetSeeForNextStudent;

(function bindUploadDelegatedEvents() {
    const UPLOAD_CLICK_ACTIONS = {
        'show-changelogs': () => showAllChangelogsModal(),
        'open-see-modal': () => openSingleErrorEntryModal(),
        'confirm-reupload': () => confirmReupload(),
        'select-subject': (el) => selectFeedbackSubject(el, el.dataset.subject),
        'select-physics-source': (el) => selectPhysicsPreviewSource(el, el.dataset.source),
        'clear-roster': () => clearRosterFile(),
        'trigger-click': (el) => {
            const target = el.dataset.target ? document.getElementById(el.dataset.target) : null;
            if (target) target.click();
        },
        'clear-preview': () => clearPreviewFiles(),
        'clear-homework': () => clearHomeworkFiles(),
        'clear-note': () => clearNoteFiles(),
        'clear-class-test': () => clearClassTestFiles(),
        'clear-report': () => clearReportFile(),
        'go-step': (_el, arg) => goToStep(parseInt(arg, 10)),
        'preview-comment-source': (_el, arg) => switchPreviewCommentSource(arg),
        'homework-comment-source': (_el, arg) => switchHomeworkCommentSource(arg),
        'adjust-focus': (_el, arg) => adjustFocusScore(parseInt(arg, 10)),
        'focus-comment-source': (_el, arg) => switchFocusCommentSource(arg),
        'add-exclusion-tag': () => addExclusionTag(),
        'export-exclusion-file': () => exportExclusionFile(),
        'generate-feedback': () => generateFeedback(),
        'close-confirm-modal': () => closeConfirmModal(),
        'confirm-generate': (el) => confirmAndGenerate(el),
        'close-wjx-modal': () => closeWjxNameModal(),
        'apply-wjx-fixes': () => applyWjxNameFixes(),
        'ignore-comment-format': () => ignoreCommentFormatAndGenerate(),
        'autofix-comment-format': () => autoFixCommentStandardsAndGenerate(),
        'close-missing-errors': () => closeMissingErrorsModal(),
        'ignore-missing-errors': () => ignoreMissingErrorsAndContinue(),
        'auto-select-best': () => autoSelectBestScores(),
        'confirm-duplicate-choices': () => confirmDuplicateChoices(),
        'close-dropped-modal': () => closeDroppedStudentsModal(),
        'close-ungraded-modal': () => closeUngradedSubmissionsModal(),
        'quick-edit-ungraded': () => quickEditFromUngradedModal(),
        'preview-edit-on': () => togglePreviewEditMode(true),
        'preview-add-row': () => addPreviewRow(),
        'preview-save-edits': () => savePreviewEdits(),
        'preview-cancel-edits': () => cancelPreviewEdits(),
        'close-file-preview': () => closeFilePreviewModal(),
        'export-preview-csv': () => exportCurrentPreviewCsv(),
        'close-see-modal': () => closeSingleErrorEntryModal(),
        'see-entry-mode': (el) => switchSeeEntryMode(el.dataset.mode),
        'clear-see-errors': (_el, arg) => clearSeeErrors(arg),
        'copy-see-link': () => copySeeRetestLink(),
        'copy-see-feedback': () => copySeeFeedbackText(),
        'reset-see-student': () => resetSeeForNextStudent(),
        'submit-see-entry': (el) => submitSingleErrorEntry(el),
        'close-custom-dialog': () => closeCustomDialog()
    };

    const UPLOAD_CHANGE_ACTIONS = {
        'preview-metric-mode': () => onPreviewMetricModeChange(),
        'toggle-plus': () => togglePlusConfig(),
        'plus-selector': () => onPlusSelectorChange(),
        'import-exclusion': (el) => importExclusionFile(el),
        'sync-local-csv': (el) => localStorage.setItem('jf_sync_local_csv', el.checked ? '1' : '0'),
        'see-class-meta': () => onSeeClassMetaChange(),
        'see-week': (_el, arg) => onSeeWeekChange(arg)
    };

    const UPLOAD_INPUT_ACTIONS = {
        'filter-preview': (el) => filterPreviewTable(el.value),
        'see-student': (el) => onSeeStudentInput(el.value),
        'see-student-id': () => onSeeStudentIdChange(),
        'see-error-text': (el, arg) => onSeeErrorTextInput(arg, el.value)
    };

    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const handler = UPLOAD_CLICK_ACTIONS[target.dataset.action];
        if (handler) handler(target, target.dataset.arg);
    });

    document.addEventListener('change', (e) => {
        const target = e.target.closest('[data-change]');
        if (!target) return;
        const handler = UPLOAD_CHANGE_ACTIONS[target.dataset.change];
        if (handler) handler(target, target.dataset.arg);
    });

    document.addEventListener('input', (e) => {
        const target = e.target.closest('[data-input]');
        if (!target) return;
        const handler = UPLOAD_INPUT_ACTIONS[target.dataset.input];
        if (handler) handler(target, target.dataset.arg);
    });

    const seeStudentInput = document.getElementById('see-student-name');
    if (seeStudentInput) {
        seeStudentInput.addEventListener('focus', onSeeStudentFocus);
    }
})();
