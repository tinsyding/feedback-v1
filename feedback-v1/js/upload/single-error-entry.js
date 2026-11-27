/**
 * ============================================================================
 * 首页单人错题录入工作台 (Single Student Error Entry)
 * 依赖：common.js、upload.js（openNativeDialog/closeNativeDialog/QBANK_API 等）
 * ============================================================================
 */
(function () {
    'use strict';

    // ========== 首页单人错题录入工作台 (Single Student Error Entry) ==========
    const seeState = {
        mode: 'homework', // 'homework' | 'preview'
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
            const scope = typeof window.getAllowedSubjects === 'function' ? window.getAllowedSubjects() : { all: true, subjects: ['*'] };
            Array.from(subjectEl.options).forEach(opt => {
                if (!opt.value) return;
                const ok = scope.all || scope.subjects.includes(opt.value);
                opt.hidden = !ok;
                opt.disabled = !ok;
            });
            if (!scope.all && scope.subjects.length === 1) {
                subjectEl.value = scope.subjects[0];
                subjectEl.disabled = true;
                subjectEl.title = `当前账号已锁定学科：${scope.subjects[0]}`;
            } else {
                subjectEl.disabled = false;
                subjectEl.title = '';
                const candidate = pageSubject || savedSubject || (scope.all ? '数学' : (scope.subjects[0] || ''));
                subjectEl.value = (scope.all || scope.subjects.includes(candidate)) ? candidate : (scope.subjects[0] || '');
            }
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
        if (savedMode && ['homework', 'preview'].includes(savedMode)) {
            seeState.mode = savedMode;
        } else {
            seeState.mode = 'homework';
        }

        switchSeeEntryMode(seeState.mode);
        openNativeDialog(modal, {
            dismissible: true
        });

        onSeeClassMetaChange();
    }

    function closeSingleErrorEntryModal() {
        closeNativeDialog('single-error-entry-modal');
    }

    function switchSeeEntryMode(mode) {
        if (!['homework', 'preview'].includes(mode)) mode = 'homework';
        seeState.mode = mode;
        localStorage.setItem('jf_see_mode', mode);

        const modeSel = document.getElementById('see-entry-mode');
        if (modeSel && modeSel.value !== mode) {
            modeSel.value = mode;
        }

        const hwSec = document.getElementById('see-homework-section');
        const pvSec = document.getElementById('see-preview-section');
        if (hwSec) hwSec.style.display = mode === 'homework' ? 'flex' : 'none';
        if (pvSec) pvSec.style.display = mode === 'preview' ? 'flex' : 'none';

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

    function onSeeStudentInput(rawVal) {
        const nameInput = document.getElementById('see-student-name');
        const idInput = document.getElementById('see-student-id');

        // 智能识别 "12345张三"、"01张三" 或 "12345 张三" 自动拆分学号与姓名
        const trimmed = String(rawVal || '').trim();
        const comboMatch = trimmed.match(/^(\d+)[\s_\-–—]+([^\d\s].*)$/) || trimmed.match(/^(\d{2,})([^\d\s].*)$/);
        if (comboMatch) {
            const extractedId = comboMatch[1].trim();
            const extractedName = comboMatch[2].trim();
            if (nameInput) nameInput.value = extractedName;
            if (idInput) idInput.value = extractedId;
        }

        hideSeeResultPanel();
        scheduleSeeRecordLookup();
    }

    function onSeeStudentIdChange() {
        hideSeeResultPanel();
        scheduleSeeRecordLookup();
    }

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

                if (seeState.mode === 'homework') {
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

                if (seeState.mode === 'preview') {
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

                const hasExisting = (seeState.mode === 'homework' && rec.hasHomeworkRecord)
                    || (seeState.mode === 'preview' && rec.hasPreviewRecord);

                statusDot.className = 'see-status-dot ' + (hasWarning ? 'warning' : (hasExisting ? 'brand' : ''));
                statusText.textContent = parts.join(' · ');
                statusBox.style.display = 'flex';
            }
        } catch (e) {
            if (statusBox) statusBox.style.display = 'none';
        }
    }

    function getSeeRetestBaseUrl() {
        return getRetestBaseUrl();
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
        const hasPv = mode === 'preview';
        const hasHw = mode === 'homework';

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
            showToast('请输入学员姓名');
            document.getElementById('see-student-name')?.focus();
            return;
        }

        const mode = seeState.mode;
        const hasHomeworkData = mode === 'homework';
        const hasPreviewData = mode === 'preview';
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
                const hwMarkingMakeUp = hasHomeworkData && /补交/.test(hwCommentPayload);
                const pvMarkingMakeUp = hasPreviewData && /补交/.test(pvCommentPayload);
                const isHwUnsubmittedPayload = hwWasUnsub && !hwMarkingMakeUp;
                const isPvUnsubmittedPayload = pvWasUnsub && !pvMarkingMakeUp;

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
                            previewComment: pvCommentPayload,
                            isUnsubmitted: isHwUnsubmittedPayload,
                            isPreviewUnsubmitted: isPvUnsubmittedPayload
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

                // 刷新当前学员存档状态显示
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
    window.onSeeStudentIdChange = onSeeStudentIdChange;
    window.submitSingleErrorEntry = submitSingleErrorEntry;
    window.copySeeRetestLink = copySeeRetestLink;
    window.copySeeFeedbackText = copySeeFeedbackText;
    window.resetSeeForNextStudent = resetSeeForNextStudent;

})();
