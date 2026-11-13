/**
 * 专属错题本 (Retest) 官方业务交互与高密度智能拼接排版引擎
 */

if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/libs/pdfjs/pdf.worker.min.js';
}
if (window.location && (window.location.search.includes('debug=1') || window.location.hash.includes('debug'))) {
    try { new VConsole(); } catch(e) {}
}

    let retestData = null;
    let defaultSeason = 1;
    let activeWeek = null;
    let currentToken = '';
    let currentTempDownloadUrl = '';
    let currentTempFullUrl = '';
    let currentTempFileName = '';

    let pendingDownloadAllWeeks = false;

    // Detect WeChat Webview Environment
    const isWeChat = /MicroMessenger/i.test(navigator.userAgent);
    if (isWeChat) {
        const wechatBar = document.getElementById('wechat-bar');
        if (wechatBar) wechatBar.style.display = 'flex';
    }

    // Load configuration & Spacing Management
    window.retestQuestionSpacing = 85;
    window.retestQrCodeEnabled = true;
    // 题头考点提示：默认显示，家长可自行隐藏，避免提前给孩子解题提示
    window.retestTopicHintEnabled = true;
    // 错题题目范围选择：'all' (预习+巩固) | 'preview' (仅预习) | 'homework' (仅巩固)
    window.retestDownloadScope = 'all';
    try {
        const savedSpacing = (localStorage.getItem('retest_question_spacing') || localStorage.getItem('retest_beta_spacing'));
        if (savedSpacing) {
            window.retestQuestionSpacing = parseInt(savedSpacing) || 85;
        }
        if (localStorage.getItem('retest_topic_hint_enabled') === '0') {
            window.retestTopicHintEnabled = false;
        }
        const savedScope = localStorage.getItem('retest_download_scope');
        if (savedScope === 'preview' || savedScope === 'homework' || savedScope === 'all') {
            window.retestDownloadScope = savedScope;
        }
    } catch(e) {}

    function ptToCentimetersText(sp) {
        let cm = (sp * 0.035278).toFixed(1);
        if (cm.endsWith('.0')) cm = cm.slice(0, -2);
        return `${cm} 厘米`;
    }

    function updateSpacingUI(val) {
        let sp = parseInt(val);
        if (isNaN(sp)) sp = 85;
        sp = Math.max(8, Math.min(260, sp));
        window.retestQuestionSpacing = sp;

        const sel = document.getElementById('beta-spacing-select');
        if (sel) {
            let found = false;
            for (let i = 0; i < sel.options.length; i++) {
                if (parseInt(sel.options[i].value) === sp) {
                    sel.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const opt = new Option(ptToCentimetersText(sp), String(sp));
                sel.add(opt);
                sel.value = String(sp);
            }
        }
    }

    function onBetaSpacingSelect(val) {
        updateSpacingUI(val);
        try {
            localStorage.setItem('retest_question_spacing', String(window.retestQuestionSpacing)); localStorage.setItem('retest_beta_spacing', String(window.retestQuestionSpacing));
        } catch(e) {}
        const cmText = ptToCentimetersText(window.retestQuestionSpacing);
        showToast(`作答留白已设为 ${cmText}，下载打印时将按此留白排版`);
    }

    // 题头考点提示开关（按家长设备记忆，互不影响）
    function updateTopicHintUI() {
        const enabled = window.retestTopicHintEnabled !== false;
        const btnOn = document.getElementById('btn-topic-hint-on');
        const btnOff = document.getElementById('btn-topic-hint-off');
        const stateText = document.getElementById('topic-hint-state-text');

        if (btnOn) btnOn.classList.toggle('active', enabled);
        if (btnOff) btnOff.classList.toggle('active', !enabled);
        if (stateText) {
            stateText.textContent = enabled ? '显示' : '隐藏';
            stateText.classList.toggle('hidden', !enabled);
        }
    }

    function setTopicHintEnabled(enabled) {
        window.retestTopicHintEnabled = Boolean(enabled);
        try {
            localStorage.setItem('retest_topic_hint_enabled', enabled ? '1' : '0');
        } catch(e) {}
        updateTopicHintUI();
        showToast(enabled ? '已开启考点提示' : '已隐藏考点提示，重练版 PDF 不再显示知识点');
    }

    // 错题题目范围选择（仅预习 / 仅巩固 / 预习+巩固）
    function updateDownloadScopeUI() {
        const scope = window.retestDownloadScope || 'all';
        const btnPreview = document.getElementById('btn-scope-preview');
        const btnHomework = document.getElementById('btn-scope-homework');
        const btnAll = document.getElementById('btn-scope-all');
        const stateText = document.getElementById('scope-state-text');

        if (btnPreview) btnPreview.classList.toggle('active', scope === 'preview');
        if (btnHomework) btnHomework.classList.toggle('active', scope === 'homework');
        if (btnAll) btnAll.classList.toggle('active', scope === 'all');

        if (stateText) {
            stateText.classList.remove('scope-preview', 'scope-homework');
            if (scope === 'preview') {
                stateText.textContent = '仅预习';
                stateText.classList.add('scope-preview');
            } else if (scope === 'homework') {
                stateText.textContent = '仅巩固';
                stateText.classList.add('scope-homework');
            } else {
                stateText.textContent = '预习+巩固';
            }
        }
    }

    function setDownloadScope(scope) {
        window.retestDownloadScope = scope || 'all';
        try {
            localStorage.setItem('retest_download_scope', window.retestDownloadScope);
        } catch(e) {}
        updateDownloadScopeUI();
        const msgMap = {
            preview: '已切换为：仅下载预习错题',
            homework: '已切换为：仅下载课后巩固错题',
            all: '已切换为：下载预习+巩固全部错题'
        };
        showToast(msgMap[scope] || '已更新下载题目范围');
    }
    window.setTopicHintEnabled = setTopicHintEnabled;
    window.setDownloadScope = setDownloadScope;

    // 优先通过无缓存机制载入系统全局配置（经脱敏公开接口）
    fetch('api/public_config.php?v=' + Date.now(), { cache: 'no-store' })
        .then(res => res.json())
        .then(cfg => {
            if (cfg.defaultSeason !== undefined) defaultSeason = cfg.defaultSeason;
            if (cfg.retestQrCodeEnabled !== undefined) {
                window.retestQrCodeEnabled = (cfg.retestQrCodeEnabled !== false);
            }
            const urlParams = new URLSearchParams(window.location.search);
            const hasLocalSpacing = (localStorage.getItem('retest_question_spacing') || localStorage.getItem('retest_beta_spacing'));
            if (!urlParams.has('spacing') && !hasLocalSpacing && cfg.retestQuestionSpacing !== undefined) {
                updateSpacingUI(cfg.retestQuestionSpacing);
            }
        })
        .catch(() => {});

    // Initial page load
    async function initRetestPage() {
        const urlParams = new URLSearchParams(window.location.search);
        currentToken = urlParams.get('token') || '';
        const adminSig = urlParams.get('admin_sig') || '';
        const adminTs = urlParams.get('admin_ts') || '';
        const hasLocalSpacing = (localStorage.getItem('retest_question_spacing') || localStorage.getItem('retest_beta_spacing'));
        if (urlParams.has('spacing')) {
            updateSpacingUI(urlParams.get('spacing'));
        } else if (hasLocalSpacing) {
            updateSpacingUI(hasLocalSpacing);
        }

        if (!currentToken) {
            showError('链接中缺少必要的安全验证信息，请从老师发送的消息中重新打开。');
            return;
        }

        // 允许家长端正常凭证访问与管理员免密直达

        try {
            let reqUrl = 'api/retest.php?action=decrypt&token=' + encodeURIComponent(currentToken);
            if (adminSig) {
                reqUrl += '&admin_sig=' + encodeURIComponent(adminSig);
                if (adminTs) {
                    reqUrl += '&admin_ts=' + encodeURIComponent(adminTs);
                }
            }
            const resp = await fetch(reqUrl);
            const result = await resp.json();

            if (result.success && result.data) {
                // 如果未在 URL 或本地存储指定自定义间距，则采纳服务端实时返回的默认间距
                if (!urlParams.has('spacing') && !hasLocalSpacing && result.retestQuestionSpacing !== undefined) {
                    updateSpacingUI(result.retestQuestionSpacing);
                }
                // 服务端实时返回的二维码讲解开关
                if (result.retestQrCodeEnabled !== undefined) {
                    window.retestQrCodeEnabled = (result.retestQrCodeEnabled !== false);
                }
                retestData = result;
                showContent(result);
            } else if (result.needVerify) {
                showVerify();
            } else {
                showError(result.error || '获取数据失败，请稍后重试');
            }
        } catch (e) {
            console.error('Fetch error:', e);
            showError('网络连接异常，请刷新重试');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initRetestPage);
    } else {
        initRetestPage();
    }

    // Show Verification Gate
    function showVerify() {
        document.getElementById('loading-state').style.display = 'none';
        document.getElementById('error-state').style.display = 'none';
        document.getElementById('content-state').style.display = 'none';
        document.getElementById('verify-state').style.display = 'block';
        refreshCaptcha();
        setTimeout(() => {
            const nameInput = document.getElementById('verify-name');
            if (nameInput) nameInput.focus();
        }, 120);
    }

    // Refresh Captcha Image
    function refreshCaptcha() {
        const img = document.getElementById('captcha-img');
        if (img) {
            img.src = 'api/retest.php?action=captcha&t=' + Date.now();
        }
    }

    // Handle Verification Form Submission
    async function handleVerifySubmit(event) {
        event.preventDefault();
        const nameInput = document.getElementById('verify-name');
        const captchaInput = document.getElementById('verify-captcha');
        const submitBtn = document.getElementById('btn-verify-submit');

        const name = (nameInput.value || '').trim();
        const captcha = (captchaInput.value || '').trim();

        if (!name) {
            showVerifyError('请输入学生姓名');
            nameInput.focus();
            return;
        }
        if (!captcha || captcha.length !== 4) {
            showVerifyError('请输入4位图形验证码');
            captchaInput.focus();
            return;
        }

        document.getElementById('verify-error').style.display = 'none';
        submitBtn.disabled = true;
        const originalBtnHtml = submitBtn.innerHTML;
        submitBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 8px 0 0;border-width:2px;display:inline-block;vertical-align:middle;animation:spin 1s linear infinite;border:2px solid rgba(255,255,255,0.3);border-top:2px solid white;border-radius:50%;"></div> 正在核验...';

        try {
            const resp = await fetch('api/retest.php?action=decrypt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: currentToken,
                    studentName: name,
                    captcha: captcha
                })
            });
            const result = await resp.json();

            if (result.success && result.data) {
                document.getElementById('verify-state').style.display = 'none';
                retestData = result;
                showToast('验证通过');
                showContent(result);
            } else {
                showVerifyError(result.error || '验证失败，请核对姓名与验证码');
                refreshCaptcha();
                captchaInput.value = '';
                if (result.captchaError) {
                    captchaInput.focus();
                } else if (result.nameError) {
                    nameInput.select();
                    nameInput.focus();
                }
            }
        } catch (e) {
            console.error('Verify error:', e);
            showVerifyError('网络连接异常，请重试');
            refreshCaptcha();
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnHtml;
        }
    }

    function showVerifyError(msg) {
        const errorBox = document.getElementById('verify-error');
        const errorText = document.getElementById('verify-error-text');
        errorText.textContent = msg;
        errorBox.style.display = 'flex';
    }

    function showError(msg) {
        document.getElementById('loading-state').style.display = 'none';
        document.getElementById('verify-state').style.display = 'none';
        document.getElementById('content-state').style.display = 'none';
        document.getElementById('error-state').style.display = 'block';
        document.getElementById('error-message').textContent = msg;
    }

    // Render Student Dashboard and Content
    function showContent(result) {
        document.getElementById('loading-state').style.display = 'none';
        document.getElementById('verify-state').style.display = 'none';
        document.getElementById('error-state').style.display = 'none';
        document.getElementById('content-state').style.display = 'block';

        const data = result.data;

        // Compatible with new/old API formats
        if (!result.weeksData) {
            const w = data.w || 1;
            result.weeksData = {
                [String(w)]: {
                    week: w,
                    errors: data.q || [],
                    pdfs: result.pdfs || []
                }
            };
            result.currentWeek = w;
            result.availableWeeks = [w];
        }

        const availableWeeks = result.availableWeeks || [];
        const currentWeek = result.currentWeek || data.w;

        // Student name
        const studentName = data.n || '-';
        const nameEl = document.getElementById('info-name');
        if (nameEl) nameEl.textContent = studentName;

        // Subject info
        const subject = data.s || '数学';
        const subjectEl = document.getElementById('info-subject');
        if (subjectEl) subjectEl.textContent = subject;

        const tabsWrapper = document.getElementById('week-tabs-wrapper');
        const tabsContainer = document.getElementById('week-tabs');
        const gridListContainer = document.getElementById('topic-grid-list');
        const mergeAllSection = document.getElementById('merge-all-section');

        if (availableWeeks.length > 1) {
            tabsWrapper.style.display = 'block';
            tabsContainer.innerHTML = '';
            gridListContainer.innerHTML = '';

            const weeksData = result.weeksData || {};
            const hasAnyPreview = availableWeeks.some(w => getWeekErrorCounts(weeksData[String(w)]).preview > 0);
            const mergeAllLabel = mergeAllSection ? mergeAllSection.querySelector('span') : null;
            if (mergeAllLabel) mergeAllLabel.textContent = hasAnyPreview ? '合并下载全部专题（含预习） (PDF)' : '合并下载全部专题 (PDF)';
            const totalCount = availableWeeks.length;
            const gridBtnText = document.getElementById('topic-grid-btn-text');
            if (gridBtnText) gridBtnText.textContent = '全部 (' + totalCount + ') ▾';
            const gridSubtitle = document.getElementById('topic-grid-subtitle');
            if (gridSubtitle) gridSubtitle.textContent = '共 ' + totalCount + ' 个专题';

            const totalErrors = availableWeeks.reduce((sum, w) => {
                const wd = weeksData[String(w)];
                return sum + getWeekErrorCounts(wd).total;
            }, 0);

            availableWeeks.forEach(w => {
                const isCurrent = (w === currentWeek);
                const wData = weeksData[String(w)];
                const counts = getWeekErrorCounts(wData);
                const errCount = counts.total;
                const label = getTopicLabel(w);

                const cm = (wData && wData.comment) ? String(wData.comment) : '';
                const rawHw = (wData && wData.homeworkScore !== null && wData.homeworkScore !== undefined && wData.homeworkScore !== '')
                    ? Number(wData.homeworkScore) : null;
                const isWeekUnsub = (wData && wData.isUnsubmitted) ||
                    cm.includes('未交') || cm.includes('未提交') || cm.includes('缺交') ||
                    (errCount === 0 && (rawHw === null || rawHw <= 0));

                // 1. Horizontal Scroll Tab
                const tab = document.createElement('button');
                tab.className = 'ui-pill' + (isCurrent ? ' has-badge' : '');
                tab.textContent = label;
                tab.dataset.week = w;
                tab.onclick = () => switchWeek(w);
                tabsContainer.appendChild(tab);

                // 2. Full Grid Tile (Handles 1~20+ cleanly in 4 columns)
                const tile = document.createElement('button');
                tile.className = 'topic-grid-tile';
                tile.dataset.week = w;
                tile.onclick = () => {
                    closeTopicGridModal();
                    switchWeek(w);
                };

                let tileInner = '';
                if (isCurrent) {
                    tileInner += '<span class="topic-tile-badge">最新</span>';
                }
                tileInner += '<span class="topic-tile-name">' + label + '</span>';
                if (isWeekUnsub) {
                    tileInner += '<span class="topic-tile-count unsubmitted">未交作业</span>';
                } else if (errCount === 0) {
                    tileInner += '<span class="topic-tile-count perfect">全对 0 错题</span>';
                } else if (counts.homework > 0 && counts.preview > 0) {
                    tileInner += '<span class="topic-tile-count">巩固' + counts.homework + '道 · 预习' + counts.preview + '道</span>';
                } else if (counts.preview > 0) {
                    tileInner += '<span class="topic-tile-count">预习' + counts.preview + '道错题</span>';
                } else {
                    tileInner += '<span class="topic-tile-count">巩固' + counts.homework + '道错题</span>';
                }
                tile.innerHTML = tileInner;
                gridListContainer.appendChild(tile);
            });

            mergeAllSection.style.display = totalErrors > 0 ? 'block' : 'none';
        } else {
            tabsWrapper.style.display = 'none';
            mergeAllSection.style.display = 'none';
        }

        switchWeek(currentWeek);
    }

    // Number to Chinese representation (Supports 1~99, e.g. 1->一, 10->十, 15->十五, 20->二十)
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
        return '专题' + numToChinese(w);
    }

    function getWeekErrorCounts(wd) {
        const homework = wd && Array.isArray(wd.errors) ? wd.errors.length : 0;
        const preview = wd && Array.isArray(wd.previewErrors) ? wd.previewErrors.length : 0;
        return { homework, preview, total: homework + preview };
    }

    function getWeekPdfLists(wd) {
        return {
            homework: (wd && Array.isArray(wd.pdfs)) ? wd.pdfs : [],
            preview: (wd && Array.isArray(wd.previewPdfs)) ? wd.previewPdfs : []
        };
    }

    // Switch between topics (smooth scroll and grid update)
    function switchWeek(week) {
        activeWeek = week;
        const weeksData = retestData.weeksData || {};
        const weekData = weeksData[String(week)];
        const label = getTopicLabel(week);

        // Update horizontal scroll tab states
        document.querySelectorAll('#week-tabs .ui-pill').forEach(tab => {
            const isMatch = parseInt(tab.dataset.week) === week;
            tab.classList.toggle('active', isMatch);
            if (isMatch && tab.scrollIntoView) {
                tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        });

        // Update grid tile states
        document.querySelectorAll('.topic-grid-tile').forEach(tile => {
            tile.classList.toggle('active', parseInt(tile.dataset.week) === week);
        });

        const weekDisplayEl = document.getElementById('info-week-display');
        if (weekDisplayEl) weekDisplayEl.textContent = label;

        // 待练错题（课后巩固 + 预习合并统计）
        const weekErrorCounts = getWeekErrorCounts(weekData);
        const errorCount = weekErrorCounts.total;
        const countEl = document.getElementById('info-count');
        if (countEl) countEl.textContent = errorCount;

        // 巩固成绩
        const scoreEl = document.getElementById('info-score');
        const scoreUnitEl = document.getElementById('info-score-unit');
        const rawHwScore = (weekData && weekData.homeworkScore !== null && weekData.homeworkScore !== undefined && weekData.homeworkScore !== '')
            ? Number(weekData.homeworkScore)
            : null;
        const commentText = (weekData && weekData.comment) ? String(weekData.comment) : '';
        const isUnsubmitted = (weekData && weekData.isUnsubmitted) ||
            commentText.includes('未交') || commentText.includes('未提交') || commentText.includes('缺交') ||
            (errorCount === 0 && (rawHwScore === null || rawHwScore <= 0));

        if (scoreEl) {
            if (isUnsubmitted) {
                scoreEl.textContent = '未交';
                scoreEl.style.color = '#d97706';
                if (scoreUnitEl) scoreUnitEl.style.display = 'none';
            } else {
                scoreEl.textContent = (rawHwScore !== null) ? rawHwScore : '--';
                scoreEl.style.color = '';
                if (scoreUnitEl) scoreUnitEl.style.display = '';
            }
        }

        // 当次均分（与家长文案口径一致：剔除0分后四舍五入取整，见 viewer.js roundAvgScore）
        const avgEl = document.getElementById('info-avg-score');
        if (avgEl) {
            avgEl.textContent = (weekData && weekData.avgScore !== null && weekData.avgScore !== undefined)
                ? Math.round(weekData.avgScore) : '--';
        }

        // Update button label
        const btnTopicLabel = document.getElementById('btn-topic-label');
        const previewLabelSuffix = weekErrorCounts.preview > 0 ? '（含预习）' : '';
        if (btnTopicLabel) btnTopicLabel.textContent = '下载' + label + '错题本' + previewLabelSuffix + ' (PDF)';

        const weekPdfLists = getWeekPdfLists(weekData);
        const pdfs = weekPdfLists.homework.concat(weekPdfLists.preview);
        const hasPdfs = pdfs.length > 0;
        const noPdfHint = document.getElementById('no-pdf-hint');
        const btnTopicDownload = document.getElementById('btn-topic-download');

        if (isUnsubmitted) {
            if (noPdfHint) {
                noPdfHint.style.display = 'flex';
                noPdfHint.className = 'empty-hint unsubmitted-state';
                noPdfHint.innerHTML = `
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#d97706; flex-shrink:0;">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <div>
                        <strong style="color:#b45309;">本专题巩固作业未提交</strong><br>
                        <span style="color:#92400e; font-size:0.8rem;">暂无本次作业批改与错题记录，如已补交请联系负责老师更新。</span>
                    </div>
                `;
            }
            if (btnTopicDownload) btnTopicDownload.disabled = true;
            if (btnTopicLabel) btnTopicLabel.textContent = '本专题作业未提交';
        } else if (errorCount === 0) {
            if (noPdfHint) {
                noPdfHint.style.display = 'flex';
                noPdfHint.className = 'empty-hint success-state';
                noPdfHint.innerHTML = `
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#059669; flex-shrink:0;">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <div>
                        <strong style="color:#065f46;">太棒了，全部正确！</strong><br>
                        <span style="color:#047857; font-size:0.8rem;">本专题作业全对，暂无错题需要重练，继续保持！</span>
                    </div>
                `;
            }
            if (btnTopicDownload) btnTopicDownload.disabled = true;
            if (btnTopicLabel) btnTopicLabel.textContent = '本专题无错题（无需重练）';
        } else if (!hasPdfs) {
            if (noPdfHint) {
                noPdfHint.style.display = 'flex';
                noPdfHint.className = 'empty-hint';
                noPdfHint.innerHTML = `
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#d97706; flex-shrink:0;">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <div>
                        <strong>题库资料整理中</strong><br>
                        <span style="font-size:0.8rem;">此专题题目文件正在校对中，稍后开放下载。</span>
                    </div>
                `;
            }
            if (btnTopicDownload) btnTopicDownload.disabled = true;
            if (btnTopicLabel) btnTopicLabel.textContent = '下载' + label + '错题本 (PDF)';
        } else {
            if (noPdfHint) noPdfHint.style.display = 'none';
            if (btnTopicDownload) btnTopicDownload.disabled = false;
            if (btnTopicLabel) btnTopicLabel.textContent = '下载' + label + '错题本' + previewLabelSuffix + ' (PDF)';
        }
    }

    // Topic Grid Modal Open/Close
    function openTopicGridModal() {
        document.getElementById('topic-grid-modal').style.display = 'flex';
    }

    function closeTopicGridModal() {
        document.getElementById('topic-grid-modal').style.display = 'none';
    }

    function handleTopicGridOverlayClick(event) {
        if (event.target === document.getElementById('topic-grid-modal')) {
            closeTopicGridModal();
        }
    }

    // Open Download Version Choice Modal
    function openDownloadModal(allWeeks) {
        pendingDownloadAllWeeks = allWeeks;
        const modal = document.getElementById('choice-modal');
        const subtitle = document.getElementById('choice-modal-subtitle');
        if (allWeeks) {
            subtitle.textContent = '当前选择：全部专题汇总合辑';
        } else {
            subtitle.textContent = '当前选择：' + getTopicLabel(activeWeek);
        }
        updateTopicHintUI();
        updateDownloadScopeUI();
        modal.style.display = 'flex';
    }

    // Close Download Version Choice Modal
    function closeDownloadModal() {
        document.getElementById('choice-modal').style.display = 'none';
    }

    function handleChoiceOverlayClick(event) {
        if (event.target === document.getElementById('choice-modal')) {
            closeDownloadModal();
        }
    }

    // Select version from Choice Modal
    function selectDownloadVersion(version) {
        closeDownloadModal();
        downloadMergedPdf(version, pendingDownloadAllWeeks);
    }

    // 题目视频讲解二维码卡片内存缓存
    const qrBadgeCache = {};

    /**
     * 动态生成题目微课讲解二维码卡片（包含二维码及说明文字：第x题视频讲解）
     * 输出高清 PNG DataURL，供 PDFLib.embedPng 直接嵌入
     */
    async function generateQuestionQrBadge(videoUrl, questionNum) {
        if (!videoUrl || typeof QRCode === 'undefined') return null;

        // 格式化题号：如 "第3题" -> "3"，统一拼接为 "第3题视频讲解"
        let qNumStr = String(questionNum || '').trim();
        qNumStr = qNumStr.replace(/^第/, '').replace(/题$/, '');
        const labelText = qNumStr ? `第${qNumStr}题视频讲解` : '视频讲解';
        const cacheKey = videoUrl + '___' + labelText;
        if (qrBadgeCache[cacheKey]) {
            return qrBadgeCache[cacheKey];
        }

        const tempDiv = document.createElement('div');
        tempDiv.style.position = 'absolute';
        tempDiv.style.left = '-9999px';
        tempDiv.style.top = '-9999px';
        document.body.appendChild(tempDiv);

        try {
            const qrSize = 180;
            new QRCode(tempDiv, {
                text: videoUrl,
                width: qrSize,
                height: qrSize,
                colorDark: '#0f172a',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });

            let qrCanvas = tempDiv.querySelector('canvas');
            if (!qrCanvas) {
                const img = tempDiv.querySelector('img');
                if (img && img.src) {
                    const imgEl = new Image();
                    imgEl.src = img.src;
                    await new Promise(r => { imgEl.onload = r; imgEl.onerror = r; });
                    qrCanvas = imgEl;
                }
            }
            if (!qrCanvas) return null;

            // 组合卡片 Canvas：高分辨率 208px × 262px (对应 A4 页面上约 54pt × 68pt)
            const padX = 14;
            const padTop = 14;
            const innerQrSize = 180;
            const cardW = innerQrSize + padX * 2; // 208px
            const textH = 48;
            const cardH = padTop + innerQrSize + 6 + textH; // 262px

            const badgeCanvas = document.createElement('canvas');
            badgeCanvas.width = cardW;
            badgeCanvas.height = cardH;
            const ctx = badgeCanvas.getContext('2d');

            // 纯白圆角卡片底色与微细描边
            const radius = 16;
            ctx.beginPath();
            ctx.moveTo(radius, 0);
            ctx.lineTo(cardW - radius, 0);
            ctx.quadraticCurveTo(cardW, 0, cardW, radius);
            ctx.lineTo(cardW, cardH - radius);
            ctx.quadraticCurveTo(cardW, cardH, cardW - radius, cardH);
            ctx.lineTo(radius, cardH);
            ctx.quadraticCurveTo(0, cardH, 0, cardH - radius);
            ctx.lineTo(0, radius);
            ctx.quadraticCurveTo(0, 0, radius, 0);
            ctx.closePath();

            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = '#cbd5e1';
            ctx.stroke();

            // 绘制二维码
            ctx.drawImage(qrCanvas, padX, padTop, innerQrSize, innerQrSize);

            // 绘制文字说明：「第x题视频讲解」
            ctx.fillStyle = '#1e293b';
            ctx.font = 'bold 21px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, cardW / 2, padTop + innerQrSize + 6 + (textH / 2));

            const dataUrl = badgeCanvas.toDataURL('image/png');
            qrBadgeCache[cacheKey] = dataUrl;
            return dataUrl;
        } catch (err) {
            console.warn('generateQuestionQrBadge failed:', err);
            return null;
        } finally {
            if (tempDiv.parentNode) {
                tempDiv.parentNode.removeChild(tempDiv);
            }
        }
    }

    // 每道题首切片上方的专题/知识点横条缓存（key 含宽度与文字，避免串用）
    const questionTopicBadgeCache = {};

    function questionTopicBadgeRoundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // 智能分词与折行算法（支持中英文混排、避头尾法则与超长安全截断）
    function splitQuestionTopicLines(ctx, text, maxWidth, maxLines = 4) {
        const NO_START_CHARS = new Set([
            ')', ']', '}', '）', '】', '》', '」', '』',
            '、', '，', '。', '；', '：', '？', '！',
            ',', '.', ';', ':', '?', '!', '%', '℃', '”', '’'
        ]);
        const NO_END_CHARS = new Set([
            '(', '[', '{', '（', '【', '《', '「', '『', '“', '‘'
        ]);

        const tokens = [];
        const regex = /([a-zA-Z0-9_\-\.\/]+|\s+|.)/gu;
        let m;
        while ((m = regex.exec(text)) !== null) {
            tokens.push(m[0]);
        }

        const lines = [];
        let lineTokens = [];

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (lineTokens.length === 0 && /^\s+$/.test(token)) {
                continue;
            }

            if (lines.length === maxLines - 1) {
                const testStr = lineTokens.concat(token).join('');
                if (ctx.measureText(testStr).width > maxWidth) {
                    let candidate = lineTokens.join('');
                    while (candidate.length > 0 && ctx.measureText(candidate + '…').width > maxWidth) {
                        candidate = candidate.slice(0, -1);
                    }
                    lines.push((candidate + '…').trimEnd());
                    lineTokens = [];
                    break;
                } else {
                    lineTokens.push(token);
                }
                continue;
            }

            const testStr = lineTokens.concat(token).join('');
            if (ctx.measureText(testStr).width <= maxWidth) {
                lineTokens.push(token);
            } else {
                if (NO_START_CHARS.has(token) && lineTokens.length > 1) {
                    const popped = lineTokens.pop();
                    lines.push(lineTokens.join('').trimEnd());
                    lineTokens = [popped, token];
                } else if (lineTokens.length > 1 && NO_END_CHARS.has(lineTokens[lineTokens.length - 1])) {
                    const popped = lineTokens.pop();
                    lines.push(lineTokens.join('').trimEnd());
                    lineTokens = [popped, token];
                } else {
                    lines.push(lineTokens.join('').trimEnd());
                    lineTokens = /^\s+$/.test(token) ? [] : [token];
                }
            }
        }

        if (lineTokens.length > 0) {
            lines.push(lineTokens.join('').trimEnd());
        }
        return lines.length > 0 ? lines : [text];
    }

    // 题组化排版：把“第几题 / 原题还是变式 / 对应哪道原题 / 考点”一次性写进题头。
    // 题号是主身份，“举一反三/同类题”只是修饰语，避免变式看起来像一道独立新题。
    function buildQuestionBadgeSpec(qItem, week, topic) {
        const item = (qItem && typeof qItem === 'object') ? qItem : {};
        const parentNum = parseInt(item.parentNum || item.errorNum, 10) || 0;
        const subNum = parseInt(item.subNum, 10) || 1;
        const variationTotal = parseInt(item.variationTotal, 10) || 0;
        const rawVariationCount = parseInt(item.variationCount, 10);
        const variationCount = Number.isFinite(rawVariationCount) ? rawVariationCount : variationTotal;
        const isVariation = Boolean(item.isVariation) || item.sourceType === 'variation';
        const isPreview = !isVariation && item.sourceType === 'preview';
        const isGroupMerged = Boolean(item.isGroupMerged);

        const groupNums = Array.isArray(item.groupNums) ? item.groupNums.map(n => parseInt(n, 10)).filter(n => n > 0) : [];
        const errorNums = Array.isArray(item.errorNums) ? item.errorNums.map(n => parseInt(n, 10)).filter(n => n > 0) : (parentNum ? [parentNum] : []);
        const isBigQuestion = !isVariation && (groupNums.length > 1 || errorNums.length > 1);

        let rangeLabel = parentNum ? ('第' + parentNum + '题') : '';
        let errorCalloutText = '';
        if (isBigQuestion) {
            if (groupNums.length > 1) {
                rangeLabel = '第' + groupNums[0] + '~' + groupNums[groupNums.length - 1] + '题';
            } else if (errorNums.length > 1) {
                rangeLabel = '第' + errorNums.join('、') + '题';
            }
            if (errorNums.length > 0) {
                errorCalloutText = '本篇错题：第 ' + errorNums.join('、') + ' 题';
            }
        }

        const weekNum = parseInt(week, 10);
        const weekPart = weekNum > 0 ? ('专题' + numToChinese(weekNum)) : '';
        const topicText = String(topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
        const subjectPart = [weekPart, topicText].filter(Boolean).join(' · ');

        if (isVariation) {
            const subNum = parseInt(item.subNum, 10) || 1;
            const parentNum = parseInt(item.parentNum || item.errorNum, 10) || 0;
            const matchedParentNums = Array.isArray(item.matchedParentNums) && item.matchedParentNums.length > 0
                ? item.matchedParentNums
                : (Array.isArray(item.parentNums) && item.parentNums.length > 0 ? item.parentNums : (parentNum ? [parentNum] : []));
            const parentLabel = matchedParentNums.length > 1
                ? ('第' + matchedParentNums.join('、') + '题')
                : (matchedParentNums.length === 1 ? ('第' + matchedParentNums[0] + '题') : (parentNum ? ('第' + parentNum + '题') : ''));

            const tagText = parentLabel
                ? (parentLabel + '·变式' + subNum + (variationTotal > 0 ? ('/' + variationTotal) : ''))
                : ('变式' + subNum);
            const contentParts = ['举一反三 · 同类题'];
            if (matchedParentNums.length > 1) {
                contentParts.push('综合巩固第' + matchedParentNums.join('、') + '题');
            } else if (parentLabel) {
                contentParts.push('对应' + parentLabel);
            }
            return { tagText, contentText: contentParts.join(' · '), errorCalloutText: '', theme: 'variation' };
        }

        if (isPreview) {
            if (isGroupMerged) {
                return {
                    tagText: rangeLabel ? (rangeLabel + '·预习') : '预习',
                    contentText: '预习错题重练',
                    errorCalloutText,
                    theme: 'preview'
                };
            }
            return {
                tagText: rangeLabel ? (rangeLabel + '·预习') : '预习',
                contentText: subjectPart || '预习',
                errorCalloutText,
                theme: 'preview'
            };
        }

        // 课后巩固原题
        if (isGroupMerged) {
            const contentParts = [];
            contentParts.push(variationCount > 0 ? ('错题重练 · 含 ' + variationCount + ' 道同类变式') : '错题重练');
            return {
                tagText: rangeLabel ? (rangeLabel + '·原题') : '原题',
                contentText: contentParts.join(' · '),
                errorCalloutText,
                theme: 'original'
            };
        }

        const contentParts = [];
        if (subjectPart) contentParts.push(subjectPart);
        if (variationCount > 0) contentParts.push('含 ' + variationCount + ' 道同类变式');
        return {
            tagText: rangeLabel ? (rangeLabel + '·原题') : '原题',
            contentText: contentParts.join(' · ') || '原题',
            errorCalloutText,
            theme: 'original'
        };
    }

    /**
     * 把专题/知识点文字渲染成精致“胶囊考点卡” PNG DataURL（pdf-lib 内置字体无中文，走 canvas）。
     * 左侧为专属分类胶囊药丸（巩固为极方深宝蓝，预习为活力琥珀橙，举一反三为清新翡翠绿），
     * 若为大题合并模式，紧随其后绘制高对比度黑白打印友好的“本篇错题：第 X、Y 题”醒目框，右侧为核心考点正文。
     * 支持超长考点智能换行（单行 25pt，多行自适应撑高），返回 { dataUrl, heightPt, blockPt, widthPt, lineCount }。
     */
    function generateQuestionTopicBadge(labelOrSpec, widthPt) {
        let spec;
        if (labelOrSpec && typeof labelOrSpec === 'object') {
            spec = {
                tagText: String(labelOrSpec.tagText || '').trim().slice(0, 60),
                contentText: String(labelOrSpec.contentText || '').trim().slice(0, 300),
                errorCalloutText: String(labelOrSpec.errorCalloutText || '').trim().slice(0, 80),
                theme: labelOrSpec.theme === 'variation'
                    ? 'variation'
                    : (labelOrSpec.theme === 'preview' ? 'preview' : 'original'),
                prefixContent: false
            };
        } else {
            const label = String(labelOrSpec || '').trim().slice(0, 300);
            if (!label) return null;

            // 兼容旧的字符串调用：拆分为左侧胶囊文本（tagText）与右侧核心考点（contentText）
            const colonIdx = label.indexOf('：') >= 0 ? label.indexOf('：') : label.indexOf(':');
            let tagText = '';
            let contentText = '';
            if (colonIdx > 0) {
                tagText = label.slice(0, colonIdx).trim();
                contentText = label.slice(colonIdx + 1).trim();
            } else {
                tagText = label.includes('举一反三') ? '举一反三' : (label.includes('预习') ? '预习' : (label.includes('巩固') ? '巩固' : '考点'));
                contentText = label.trim();
            }

            // 规范化胶囊文字（避免出现“巩固知识点”或“预习知识点”这样冗长的药丸）
            if (tagText === '巩固知识点') tagText = '巩固·考点';
            if (tagText === '预习知识点') tagText = '预习·考点';
            if (tagText === '举一反三知识点' || tagText === '举一反三·知识点') tagText = '举一反三';
            if (tagText === '知识点') tagText = '考点';

            spec = {
                tagText: tagText || '考点',
                contentText: contentText,
                errorCalloutText: '',
                theme: tagText.includes('举一反三') ? 'variation' : (tagText.includes('预习') ? 'preview' : 'original'),
                prefixContent: true
            };
        }

        if (!spec.tagText && !spec.contentText) return null;
        if (!spec.tagText) spec.tagText = '考点';
        const label = spec.tagText + '｜' + (spec.errorCalloutText || '') + '：' + spec.contentText;
        const wPt = Math.max(120, Math.min(540, Number(widthPt) || 540));
        const cacheKey = spec.theme + '___' + wPt.toFixed(1) + '___' + label;
        if (questionTopicBadgeCache[cacheKey]) {
            return questionTopicBadgeCache[cacheKey];
        }

        try {
            const K = 2; // 2 倍超采样，保证打印清晰
            const wpx = Math.max(240, Math.round(wPt * K));

            const isVariation = spec.theme === 'variation';
            const isPreview = spec.theme === 'preview';

            const testCanvas = document.createElement('canvas');
            const testCtx = testCanvas.getContext('2d');

            // 胶囊字体（粗体紧凑）
            const fontPill = '700 ' + Math.round(10.5 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            const fontCallout = '700 ' + Math.round(10.5 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            // 考点内容字体（清晰典雅）
            const fontContent = '600 ' + Math.round(11 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

            testCtx.font = fontPill;
            const pillTextW = testCtx.measureText(spec.tagText).width;
            const pillPadX = 9 * K;
            const pillWidth = Math.round(pillTextW + pillPadX * 2);
            const pillHeight = Math.round(17 * K);
            const pillRadius = Math.round(pillHeight / 2);

            let calloutWidth = 0;
            const calloutGap = 6 * K;
            if (spec.errorCalloutText) {
                testCtx.font = fontCallout;
                const calloutTextW = testCtx.measureText(spec.errorCalloutText).width;
                calloutWidth = Math.round(calloutTextW + 16 * K);
            }

            // 题头正文准备：新结构化调用直接展示完整说明，旧字符串调用保持“考点：”前缀
            let displayContent = spec.contentText;
            if (spec.prefixContent && displayContent && !displayContent.startsWith('考点') && !displayContent.startsWith('知识点')) {
                displayContent = '考点：' + displayContent;
            }

            const cardPadL = 6 * K;
            const pillToTextGap = 8 * K;
            const cardPadR = 10 * K;
            const totalLeftPillsW = pillWidth + (calloutWidth > 0 ? (calloutGap + calloutWidth) : 0);
            const maxContentW = Math.max(80 * K, wpx - cardPadL - totalLeftPillsW - pillToTextGap - cardPadR);

            testCtx.font = fontContent;
            let lines = [];
            let isSingleLine = false;

            if (!displayContent) {
                isSingleLine = true;
                lines = [];
            } else if (testCtx.measureText(displayContent).width <= maxContentW) {
                lines = [displayContent];
                isSingleLine = true;
            } else {
                lines = splitQuestionTopicLines(testCtx, displayContent, maxContentW, 4);
                if (lines.length <= 1) {
                    isSingleLine = true;
                }
            }

            let heightPt = 25;
            let linePitchPt = 15;
            let padYPt = 5;
            if (!isSingleLine) {
                linePitchPt = 15;
                padYPt = 5.5;
                heightPt = Math.max(25, padYPt * 2 + lines.length * linePitchPt);
            }
            const hpx = Math.round(heightPt * K);

            const badgeCanvas = document.createElement('canvas');
            badgeCanvas.width = wpx;
            badgeCanvas.height = hpx;
            const ctx = badgeCanvas.getContext('2d');

            // 1. 卡片底色与微边框 (Card Background & Hairline Border)
            const cardRadius = 6 * K;
            questionTopicBadgeRoundRect(ctx, 1, 1, wpx - 2, hpx - 2, cardRadius);
            if (isVariation) {
                ctx.fillStyle = '#f0fdf4'; // 雅致清新浅绿底色
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#a7f3d0'; // 精致浅翡翠边框
                ctx.stroke();
            } else if (isPreview) {
                ctx.fillStyle = '#fffdfa'; // 温暖柔和暖白天色
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#fed7aa'; // 浅琥珀色精致微边框
                ctx.stroke();
            } else {
                ctx.fillStyle = '#f8fafc'; // 现代浅蓝灰卡片底色
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#cbd5e1'; // 优雅微灰边框
                ctx.stroke();
            }

            // 2. 左侧胶囊药丸 (Left Capsule Pill)
            const pillX = cardPadL;
            const pillY = isSingleLine ? Math.round((hpx - pillHeight) / 2) : Math.round(padYPt * K + 0.5 * K);

            questionTopicBadgeRoundRect(ctx, pillX, pillY, pillWidth, pillHeight, pillRadius);
            if (isVariation) {
                const pillGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillWidth, pillY + pillHeight);
                pillGrad.addColorStop(0, '#059669'); // 翡翠绿
                pillGrad.addColorStop(1, '#047857'); // 深翡翠绿
                ctx.fillStyle = pillGrad;
            } else if (isPreview) {
                const pillGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillWidth, pillY + pillHeight);
                pillGrad.addColorStop(0, '#f59e0b');
                pillGrad.addColorStop(1, '#d97706');
                ctx.fillStyle = pillGrad;
            } else {
                const pillGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillWidth, pillY + pillHeight);
                pillGrad.addColorStop(0, '#2563eb');
                pillGrad.addColorStop(1, '#1d4ed8');
                ctx.fillStyle = pillGrad;
            }
            ctx.fill();

            // 胶囊内文字（纯白色、居中对齐）
            ctx.font = fontPill;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(spec.tagText, pillX + pillWidth / 2, pillY + pillHeight / 2 + 0.5 * K);

            // 2b. 若为大题合并模式，紧随其后绘制高对比度黑白打印友好的“本篇错题：第 X、Y 题”实线白底黑字标牌
            if (calloutWidth > 0 && spec.errorCalloutText) {
                const calloutX = pillX + pillWidth + calloutGap;
                questionTopicBadgeRoundRect(ctx, calloutX, pillY, calloutWidth, pillHeight, 4 * K);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.lineWidth = 1.6 * K;
                ctx.strokeStyle = '#0f172a';
                ctx.stroke();

                ctx.font = fontCallout;
                ctx.fillStyle = '#0f172a';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(spec.errorCalloutText, calloutX + calloutWidth / 2, pillY + pillHeight / 2 + 0.5 * K);
            }

            // 3. 右侧考点正文 (Right Topic Text)
            if (lines.length > 0) {
                ctx.font = fontContent;
                ctx.fillStyle = isVariation ? '#064e3b' : '#0f172a'; // 考点深色墨感字色
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                const textStartX = pillX + totalLeftPillsW + pillToTextGap;
                if (isSingleLine) {
                    ctx.fillText(lines[0], textStartX, hpx / 2 + 0.5 * K);
                } else {
                    const padYPx = padYPt * K;
                    const linePitchPx = linePitchPt * K;
                    for (let i = 0; i < lines.length; i++) {
                        const textY = padYPx + (i + 0.5) * linePitchPx;
                        ctx.fillText(lines[i], textStartX, textY);
                    }
                }
            }

            const dataUrl = badgeCanvas.toDataURL('image/png');
            const result = {
                dataUrl,
                heightPt,
                blockPt: heightPt + (window.QUESTION_TOPIC_BANNER_GAP || 6),
                widthPt: wPt,
                lineCount: lines.length
            };
            questionTopicBadgeCache[cacheKey] = result;
            return result;
        } catch (err) {
            console.warn('generateQuestionTopicBadge failed:', err);
            return null;
        }
    }

    // 大题小问页内错题角标缓存（高对比黑底白字「错题 X」或紧凑纯数字「X」，专为黑白激光打印优化）
    const errorBoxTagCache = {};
    function generateErrorBoxTagPng(qNum, compact = false) {
        const text = compact ? String(qNum) : ('错题 ' + qNum);
        const cacheKey = (compact ? 'C_' : 'F_') + text;
        if (errorBoxTagCache[cacheKey]) return errorBoxTagCache[cacheKey];
        try {
            const K = 2;
            const testCanvas = document.createElement('canvas');
            const testCtx = testCanvas.getContext('2d');
            const fontSizePt = compact ? 7.5 : 8.5;
            const font = '700 ' + Math.round(fontSizePt * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            testCtx.font = font;
            const tw = testCtx.measureText(text).width;
            const wPt = compact
                ? Math.max(13, Math.ceil((tw / K) + 6))
                : Math.max(28, Math.ceil((tw / K) + 10));
            const hPt = compact ? 11 : 13;
            const wpx = Math.round(wPt * K);
            const hpx = Math.round(hPt * K);

            const canvas = document.createElement('canvas');
            canvas.width = wpx;
            canvas.height = hpx;
            const ctx = canvas.getContext('2d');

            // 白色外描边光晕（防止压在原卷黑色边框线上看不清）+ 纯深黑实心底色
            questionTopicBadgeRoundRect(ctx, 0.5 * K, 0.5 * K, wpx - 1 * K, hpx - 1 * K, (compact ? 2 : 2.5) * K);
            ctx.fillStyle = '#0f172a';
            ctx.fill();
            ctx.lineWidth = 1 * K;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.font = font;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, wpx / 2, hpx / 2 + 0.5 * K);

            const res = {
                dataUrl: canvas.toDataURL('image/png'),
                widthPt: wPt,
                heightPt: hPt
            };
            errorBoxTagCache[cacheKey] = res;
            return res;
        } catch (e) {
            console.warn('generateErrorBoxTagPng failed:', e);
            return null;
        }
    }

    function generateQuestionTopicBadgeDataUrl(labelText, widthPt) {
        const badge = generateQuestionTopicBadge(labelText, widthPt);
        return badge ? badge.dataUrl : null;
    }

    // 考点聚合大导读栏缓存（相同考点与宽度复用）
    const topicGroupBannerCache = {};

    /**
     * 为多道错题共享的同一考点生成专属“考点聚合导读栏” PNG DataURL
     * 视觉呈现：跨栏优雅卡片，左侧竖直主色标条，右侧深色加粗知识点名称及涉及错题小标注（不加冗余“重点考点”字样）
     */
    function generateTopicGroupBanner(spec, widthPt) {
        if (!spec || !spec.topic) return null;
        const topic = String(spec.topic || '').trim().slice(0, 150);
        if (!topic) return null;

        const wPt = Math.max(120, Math.min(540, Number(widthPt) || 540));
        const heightPt = 26;
        const isPreview = spec.theme === 'preview';
        const parentNums = Array.isArray(spec.parentNums) ? spec.parentNums : [];
        const varCount = parseInt(spec.variationCount, 10) || 0;

        const cacheKey = (isPreview ? 'prev_' : 'hw_') + wPt.toFixed(1) + '___' + topic + '___' + parentNums.join(',') + '___' + varCount;
        if (topicGroupBannerCache[cacheKey]) {
            return topicGroupBannerCache[cacheKey];
        }

        try {
            const K = 2; // 2x 超采样保证高清
            const wpx = Math.max(240, Math.round(wPt * K));
            const hpx = Math.round(heightPt * K);

            const canvas = document.createElement('canvas');
            canvas.width = wpx;
            canvas.height = hpx;
            const ctx = canvas.getContext('2d');

            // 1. 卡片底色与微边框 (Card Background & Hairline Border)
            const cardRadius = 6 * K;
            questionTopicBadgeRoundRect(ctx, 1, 1, wpx - 2, hpx - 2, cardRadius);
            if (isPreview) {
                ctx.fillStyle = '#fffdfa'; // 温暖柔和暖白天色
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#fed7aa'; // 浅琥珀色精致边框
                ctx.stroke();
            } else {
                ctx.fillStyle = '#eff6ff'; // 极淡科技蓝背景底色
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#bfdbfe'; // 浅天蓝微边框
                ctx.stroke();
            }

            // 2. 左侧优雅色条标识（不显示“重点考点”等冗余标签，直接聚焦知识点本身）
            const barW = Math.round(3.5 * K);
            const barH = Math.round(14 * K);
            const barX = Math.round(10 * K);
            const barY = Math.round((hpx - barH) / 2);
            questionTopicBadgeRoundRect(ctx, barX, barY, barW, barH, Math.round(barW / 2));
            ctx.fillStyle = isPreview ? '#d97706' : '#2563eb';
            ctx.fill();

            // 3. 正文：知识点名称 + 涉及错题副标
            const textStartX = barX + barW + 8 * K;
            const fontTitle = '600 ' + Math.round(12 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            const fontSubtitle = '500 ' + Math.round(9.5 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

            ctx.font = fontTitle;
            ctx.fillStyle = isPreview ? '#78350f' : '#0f172a';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';

            const topicStr = topic;
            let subInfoParts = [];
            if (parentNums.length > 0) {
                subInfoParts.push('错题：第' + parentNums.join('、') + '题');
            }
            if (varCount > 0) {
                subInfoParts.push('含 ' + varCount + ' 道同类变式');
            }
            const subInfoStr = subInfoParts.length > 0 ? ('(' + subInfoParts.join(' · ') + ')') : '';

            // 测量文字宽度
            const topicW = ctx.measureText(topicStr).width;
            ctx.font = fontSubtitle;
            const subW = subInfoStr ? ctx.measureText('  ' + subInfoStr).width : 0;
            const availW = wpx - textStartX - 10 * K;

            ctx.font = fontTitle;
            if (topicW + subW <= availW) {
                ctx.fillText(topicStr, textStartX, hpx / 2 + 0.5 * K);
                if (subInfoStr) {
                    ctx.font = fontSubtitle;
                    ctx.fillStyle = isPreview ? '#b45309' : '#475569';
                    ctx.fillText('  ' + subInfoStr, textStartX + topicW, hpx / 2 + 0.5 * K);
                }
            } else {
                // 超长时优先保留考点名称并截断
                let fitTopic = topicStr;
                while (fitTopic.length > 0 && ctx.measureText(fitTopic + '…').width > availW) {
                    fitTopic = fitTopic.slice(0, -1);
                }
                ctx.fillText(fitTopic + '…', textStartX, hpx / 2 + 0.5 * K);
            }

            const dataUrl = canvas.toDataURL('image/png');
            const result = {
                dataUrl: dataUrl,
                heightPt: heightPt,
                blockPt: heightPt + 8, // 包含下方 8pt 间距
                widthPt: wPt
            };
            topicGroupBannerCache[cacheKey] = result;
            return result;
        } catch (err) {
            console.warn('generateTopicGroupBanner failed:', err);
            return null;
        }
    }

    // 多页题目的续页抬头（pdf-lib 内置字体无中文，仍走 canvas PNG）
    const questionRunningHeaderCache = {};
    function generateQuestionRunningHeader(text, widthPt, theme) {
        const label = String(text || '').trim().slice(0, 100);
        if (!label) return null;
        const wPt = Math.max(120, Math.min(540, Number(widthPt) || 540));
        const hPt = 14;
        const themeKey = theme === 'variation' ? 'variation' : (theme === 'preview' ? 'preview' : 'original');
        const cacheKey = themeKey + '___' + wPt.toFixed(1) + '___' + label;
        if (questionRunningHeaderCache[cacheKey]) {
            return questionRunningHeaderCache[cacheKey];
        }

        try {
            const K = 2;
            const wpx = Math.max(240, Math.round(wPt * K));
            const hpx = Math.round(hPt * K);
            const canvas = document.createElement('canvas');
            canvas.width = wpx;
            canvas.height = hpx;
            const ctx = canvas.getContext('2d');

            const color = themeKey === 'variation' ? '#047857' : (themeKey === 'preview' ? '#b45309' : '#475569');
            ctx.fillStyle = color;
            ctx.fillRect(0, 2 * K, 2.5 * K, hpx - 4 * K);

            ctx.font = '600 ' + Math.round(9 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = color;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, 7 * K, hpx / 2 + 0.5 * K);

            const result = { dataUrl: canvas.toDataURL('image/png'), heightPt: hPt, widthPt: wPt };
            questionRunningHeaderCache[cacheKey] = result;
            return result;
        } catch (err) {
            console.warn('generateQuestionRunningHeader failed:', err);
            return null;
        }
    }

    /**
     * 生成题目与作答区外层圆角矩形 SVG 路径（供 PDFLib.drawSvgPath 绘制圆角虚线框）
     */
    function getRetestBoxSvgPath(w, h, r) {
        const safeR = Math.max(2, Math.min(r || 8, w / 4, h / 4));
        return `M ${safeR} 0 H ${w - safeR} A ${safeR} ${safeR} 0 0 1 ${w} ${safeR} V ${h - safeR} A ${safeR} ${safeR} 0 0 1 ${w - safeR} ${h} H ${safeR} A ${safeR} ${safeR} 0 0 1 0 ${h - safeR} V ${safeR} A ${safeR} ${safeR} 0 0 1 ${safeR} 0 Z`;
    }

    // Download & Merge PDFs with modal progress feedback
    async function downloadMergedPdf(type, allWeeks) {
        if (!retestData) return;

        const weeksData = retestData.weeksData || {};
        const data = retestData.data;
        const currentScope = window.retestDownloadScope || 'all';
        const typeLabel = type === 'exercise' ? '仅错题题目' : '错题题目+答案';
        let pdfsToMerge = [];
        let fileLabel = '';

        const appendWeekPdfs = (wd, fallbackWeek) => {
            if (!wd) return;
            const appendList = (list, sourceType, headerWeek) => {
                if (!list || !list.length) return;
                const parseQNum = val => {
                    if (typeof val === 'number') return val;
                    const m = String(val || '').match(/\d+/);
                    return m ? parseInt(m[0], 10) : 0;
                };
                const validItems = [];
                list.forEach(p => {
                    const url = type === 'exercise' ? p.exercisePdf : p.answerPdf;
                    if (url) {
                        const actualSourceType = (sourceType === 'preview') ? 'preview' : (p.sourceType || sourceType);
                        const isVar = actualSourceType === 'variation' || Boolean(p.isVariation);

                        let pNums = [];
                        if (Array.isArray(p.matchedParentNums) && p.matchedParentNums.length > 0) {
                            pNums = p.matchedParentNums.map(parseQNum).filter(n => n > 0);
                        } else if (Array.isArray(p.parentNums) && p.parentNums.length > 0) {
                            pNums = p.parentNums.map(parseQNum).filter(n => n > 0);
                        } else if (typeof p.parent_question_nums === 'string' && p.parent_question_nums) {
                            pNums = p.parent_question_nums.split(',').map(parseQNum).filter(n => n > 0);
                        }
                        const pNum = parseQNum(p.parentNum || p.parent_question_num || p.errorNum);
                        if (pNums.length === 0 && pNum > 0) {
                            pNums = [pNum];
                        }

                        const errorNums = Array.isArray(p.errorNums) && p.errorNums.length > 0
                            ? p.errorNums.map(parseQNum).filter(n => n > 0)
                            : (parseQNum(p.errorNum) > 0 ? [parseQNum(p.errorNum)] : []);
                        const groupNums = Array.isArray(p.groupNums) && p.groupNums.length > 0
                            ? p.groupNums.map(parseQNum).filter(n => n > 0)
                            : [];
                        const errorBoxes = Array.isArray(p.errorBoxes) ? p.errorBoxes : [];

                        validItems.push({
                            url: url,
                            errorNum: parseQNum(p.errorNum),
                            errorNums: errorNums,
                            groupNums: groupNums,
                            errorBoxes: errorBoxes,
                            subTopics: p.subTopics || null,
                            parentNum: pNum,
                            parentNums: pNums,
                            matchedParentNums: pNums,
                            subNum: p.subNum || 1,
                            videoUrl: p.videoUrl || p.video_url || '',
                            topic: p.topic || '',
                            week: headerWeek,
                            sourceType: actualSourceType,
                            isVariation: isVar
                        });
                    }
                });
                if (validItems.length === 0) return;

                // 确保原题在前、变式题紧随其后排版
                validItems.sort((a, b) => {
                    const diff = parseQNum(a.errorNum) - parseQNum(b.errorNum);
                    if (diff !== 0) return diff;
                    const rankA = a.isVariation ? (10 + (a.subNum || 1)) : 0;
                    const rankB = b.isVariation ? (10 + (b.subNum || 1)) : 0;
                    return rankA - rankB;
                });

                const cleanTopic = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');

                // 1. 建立 parentNum -> 原题 topic 映射表（供变式题继承考点归属，兼容大题组内任意小问）
                const parentTopicMap = new Map();
                validItems.forEach(item => {
                    if (!item.isVariation && cleanTopic(item.topic)) {
                        const tClean = cleanTopic(item.topic);
                        parentTopicMap.set(item.parentNum, tClean);
                        if (Array.isArray(item.errorNums)) {
                            item.errorNums.forEach(n => parentTopicMap.set(n, tClean));
                        }
                        if (Array.isArray(item.groupNums)) {
                            item.groupNums.forEach(n => parentTopicMap.set(n, tClean));
                        }
                    }
                });

                // 2. 按考点聚合分组：
                // 若考点相同，且属于多道原题（或原题+变式），聚合为同一组；
                // 若考点为空，则按原题 parentNum 独立成组，不合并。
                const groups = [];
                const groupByTopicKey = new Map();

                validItems.forEach(item => {
                    const parentNum = item.parentNum;
                    const itemTopic = cleanTopic(item.topic) || parentTopicMap.get(parentNum) || '';
                    const topicKey = itemTopic ? ('topic:' + itemTopic) : ('orphan_parent:' + parentNum);

                    let group = groupByTopicKey.get(topicKey);
                    if (!group) {
                        group = {
                            topicKey: topicKey,
                            topic: itemTopic,
                            sourceType: item.sourceType,
                            firstOrder: parentNum,
                            parentNumsSet: new Set(),
                            originalItems: [],
                            variationItems: []
                        };
                        groups.push(group);
                        groupByTopicKey.set(topicKey, group);
                    }

                    group.parentNumsSet.add(parentNum);
                    if (!item.isVariation && Array.isArray(item.errorNums)) {
                        item.errorNums.forEach(n => group.parentNumsSet.add(n));
                    }
                    if (parentNum < group.firstOrder) {
                        group.firstOrder = parentNum;
                    }

                    if (!item.isVariation) {
                        group.originalItems.push(item);
                    } else {
                        // 同一考点组内变式按 url 去重并合并关联原题
                        const existingVar = group.variationItems.find(v => v.url === item.url);
                        if (existingVar) {
                            const mergedPNums = Array.from(new Set(
                                (existingVar.parentNums || []).concat(item.parentNums || [])
                            )).sort((a, b) => a - b);
                            existingVar.parentNums = mergedPNums;
                            existingVar.matchedParentNums = mergedPNums;
                        } else {
                            group.variationItems.push(item);
                        }
                    }
                });

                // 3. 组间排序：按组内最小题号升序，确保第1题所在考点排在第5题所在考点前面
                groups.sort((a, b) => a.firstOrder - b.firstOrder);

                // 4. 组内排版展开：
                // 核心规则：同一考点下，所有原题集中排在前面（按题号升序）；
                // 然后所有原题后面跟的是它们的同类题（变式题，按原题号升序、再按变式序号升序）。
                groups.forEach(group => {
                    const parentNums = Array.from(group.parentNumsSet).sort((a, b) => a - b);
                    // 是否为多道原题合并的考点组
                    const isGroupMerged = group.topic !== '' && group.originalItems.length >= 2;

                    // 原题排序
                    group.originalItems.sort((a, b) => a.parentNum - b.parentNum);

                    // 计算组内各变式命中的原题
                    group.variationItems.forEach(v => {
                        const allP = Array.isArray(v.parentNums) && v.parentNums.length > 0 ? v.parentNums : [v.parentNum];
                        const matched = allP.filter(p => parentNums.includes(p));
                        v.matchedParentNums = matched.length > 0 ? matched : (allP.length > 0 ? allP : [v.parentNum]);
                    });

                    // 变式题排序
                    group.variationItems.sort((a, b) => {
                        const pA = Array.isArray(a.matchedParentNums) && a.matchedParentNums.length > 0 ? a.matchedParentNums[0] : a.parentNum;
                        const pB = Array.isArray(b.matchedParentNums) && b.matchedParentNums.length > 0 ? b.matchedParentNums[0] : b.parentNum;
                        const pDiff = pA - pB;
                        if (pDiff !== 0) return pDiff;
                        return (a.subNum || 1) - (b.subNum || 1);
                    });

                    // 计算变式总数（多题共享考点下统一展示该考点的总变式数）
                    const totalVariationsInGroup = group.variationItems.length;

                    // 组内所有条目：原题全部在前，同类题全部在后！
                    const groupItems = group.originalItems.concat(group.variationItems);
                    if (groupItems.length === 0) return;

                    groupItems.forEach((item, idx) => {
                        const pNum = item.parentNum;
                        const varTotal = totalVariationsInGroup;
                        const varCount = totalVariationsInGroup;

                        pdfsToMerge.push({
                            ...item,
                            parentNum: pNum,
                            parentNums: item.parentNums || [pNum],
                            matchedParentNums: item.matchedParentNums || [pNum],
                            clusterTopic: group.topic,
                            variationTotal: varTotal,
                            variationCount: varCount,
                            // 组与考点元数据
                            isGroupMerged: isGroupMerged,
                            groupTopic: group.topic,
                            groupParentNums: parentNums,
                            groupVariationCount: totalVariationsInGroup,
                            isGroupStart: idx === 0,
                            isGroupEnd: idx === groupItems.length - 1,
                            // 单题的开始与结束（供作答区与二维码判断）
                            isClusterStart: idx === 0 || groupItems[idx - 1].url !== item.url || groupItems[idx - 1].isVariation !== item.isVariation,
                            isClusterEnd: idx === groupItems.length - 1 || groupItems[idx + 1].url !== item.url || groupItems[idx + 1].isVariation !== item.isVariation
                        });
                    });
                });
            };
            if (currentScope === 'all' || currentScope === 'preview') {
                appendList(wd.previewPdfs, 'preview', wd.previewWeek || fallbackWeek);
            }
            if (currentScope === 'all' || currentScope === 'homework') {
                appendList(wd.pdfs, 'homework', fallbackWeek);
            }
        };

        let scopeTag = '';
        if (currentScope === 'preview') {
            scopeTag = '_仅预习';
        } else if (currentScope === 'homework') {
            scopeTag = '_仅巩固';
        }

        if (allWeeks) {
            const sortedWeeks = Object.keys(weeksData).map(Number).sort((a, b) => a - b);
            sortedWeeks.forEach(w => {
                const wd = weeksData[String(w)];
                appendWeekPdfs(wd, w);
            });
            if (sortedWeeks.length > 3) {
                fileLabel = getTopicLabel(sortedWeeks[0]) + '至' + getTopicLabel(sortedWeeks[sortedWeeks.length - 1]) + '_全' + sortedWeeks.length + '讲合辑_' + typeLabel + scopeTag;
            } else {
                fileLabel = sortedWeeks.map(w => getTopicLabel(w)).join('+') + '_' + typeLabel + scopeTag;
            }
        } else {
            const weekData = weeksData[String(activeWeek)];
            if (!weekData) return;
            appendWeekPdfs(weekData, activeWeek);
            fileLabel = getTopicLabel(activeWeek) + '_' + typeLabel + scopeTag;
        }

        if (pdfsToMerge.length === 0) {
            let emptyMsg = allWeeks ? '暂无任何错题需要生成合辑' : '该专题暂无错题需要生成';
            if (currentScope === 'preview') {
                emptyMsg = allWeeks ? '暂无任何预习错题需要生成合辑' : '该专题暂无预习错题';
            } else if (currentScope === 'homework') {
                emptyMsg = allWeeks ? '暂无任何课后巩固错题需要生成合辑' : '该专题暂无课后巩固错题';
            }
            showToast(emptyMsg);
            return;
        }

        // Show Progress Modal
        const modal = document.getElementById('progress-modal');
        const modalTitle = document.getElementById('progress-modal-title');
        const modalDesc = document.getElementById('progress-modal-desc');
        modal.style.display = 'flex';
        modalTitle.textContent = '正在生成 PDF...';
        modalDesc.textContent = '准备载入切片 (0/' + pdfsToMerge.length + ')';

        /**
         * 测量 PDF 单页内容的实际视觉范围（裁剪顶部页眉/横线 与 底部留白）
         */
        async function detectPdfContentBounds(pdfBytes, pageNum, pageWidthPt, pageHeightPt) {
            const fallback = {
                topCropPt: 0,
                bottomCutPt: pageHeightPt,
                effectiveHeightPt: pageHeightPt,
                isFullPage: true,
                hasHeaderLine: false
            };

            if (!window.pdfjsLib) {
                return fallback;
            }
            try {
                const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) });
                const pdf = await loadingTask.promise;
                const page = await pdf.getPage(pageNum);

                // 宽 800px 渲染，兼顾速度与检测精度
                const baseVp = page.getViewport({ scale: 1 });
                const scale = 800 / baseVp.width;
                const viewport = page.getViewport({ scale });

                const canvas = document.createElement('canvas');
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                const ctx = canvas.getContext('2d', { willReadFrequently: true });

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({ canvasContext: ctx, viewport }).promise;
                page.cleanup();

                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imgData.data;
                const width = canvas.width;
                const height = canvas.height;

                // 1. 检测顶部区域是否存在贯穿型页眉分割横线（前 14% 区域，约 110pt）
                const headerScanMaxPt = 110;
                const headerScanMaxPx = Math.min(height * 0.15, Math.floor((headerScanMaxPt / pageHeightPt) * height));
                let detectedLineYPx = null;

                for (let y = 10; y < headerScanMaxPx; y++) {
                    const rowOffset = y * width * 4;
                    let darkCount = 0;
                    let maxRun = 0;
                    let currentRun = 0;

                    for (let x = 10; x < width - 10; x++) {
                        const idx = rowOffset + x * 4;
                        const r = data[idx];
                        const g = data[idx + 1];
                        const b = data[idx + 2];
                        if (r < 180 && g < 180 && b < 180) {
                            darkCount++;
                            currentRun++;
                            if (currentRun > maxRun) maxRun = currentRun;
                        } else {
                            currentRun = 0;
                        }
                    }

                    // 水平连续深色像素跨度 > 38% 宽度，且整行深色像素占比 > 45%
                    // （连续实线特征，普通题干文字不会有连续 38% 跨度的横向墨水）
                    if (darkCount > width * 0.45 && maxRun > width * 0.38) {
                        detectedLineYPx = y;
                        break;
                    }
                }

                let topCropPt = 0;
                let hasHeaderLine = false;
                if (detectedLineYPx !== null) {
                    hasHeaderLine = true;
                    let lineBottomYPx = detectedLineYPx;

                    // 1a. 向下精确探测横线的实际下边缘（适应不同线条粗细 1~4px 及双细线）
                    for (let ny = detectedLineYPx + 1; ny < Math.min(height * 0.18, detectedLineYPx + 10); ny++) {
                        const rowOffset = ny * width * 4;
                        let lineDarkCount = 0;
                        for (let x = 15; x < width - 15; x++) {
                            const idx = rowOffset + x * 4;
                            if (data[idx] < 180 && data[idx + 1] < 180 && data[idx + 2] < 180) {
                                lineDarkCount++;
                            }
                        }
                        if (lineDarkCount > width * 0.25) {
                            lineBottomYPx = ny;
                        } else {
                            // 若紧随行无横向深色像素，再探查一行（防止 1px 细微间距的双横线）
                            let nextHasLine = false;
                            if (ny + 1 < detectedLineYPx + 10) {
                                const nextOffset = (ny + 1) * width * 4;
                                let nextDark = 0;
                                for (let x = 15; x < width - 15; x++) {
                                    const nidx = nextOffset + x * 4;
                                    if (data[nidx] < 180 && data[nidx + 1] < 180 && data[nidx + 2] < 180) nextDark++;
                                }
                                if (nextDark > width * 0.35) {
                                    lineBottomYPx = ny + 1;
                                    ny++;
                                    nextHasLine = true;
                                }
                            }
                            if (!nextHasLine) break;
                        }
                    }

                    // 1b. 探测横线下方首行正文题干的出现位置，防止向下延伸过多导致切到文字顶部
                    let firstContentYPx = null;
                    const searchMaxY = Math.min(height * 0.25, lineBottomYPx + 40);
                    for (let ty = lineBottomYPx + 1; ty < searchMaxY; ty++) {
                        const rowOffset = ty * width * 4;
                        let inkCount = 0;
                        for (let x = 12; x < width - 12; x++) {
                            const idx = rowOffset + x * 4;
                            // 题干正文深色墨水
                            if (data[idx] < 160 && data[idx + 1] < 160 && data[idx + 2] < 160) {
                                inkCount++;
                                if (inkCount >= 4) {
                                    firstContentYPx = ty;
                                    break;
                                }
                            }
                        }
                        if (firstContentYPx !== null) break;
                    }

                    // 1c. 换算为 PDF 绝对坐标，精确控制切割线（微余量从原本盲目的 7pt 缩减为 1.0~1.2pt，且严密避开正文）
                    const lineBottomPt = (lineBottomYPx / height) * pageHeightPt;

                    if (firstContentYPx !== null) {
                        const firstContentPt = (firstContentYPx / height) * pageHeightPt;
                        // 既要完全切除横线 (lineBottomPt + 0.8pt)，又要在正文上方留出安全间隙 (firstContentPt - 1.2pt)
                        const desiredCropPt = lineBottomPt + 1.2;
                        const maxSafeCropPt = Math.max(lineBottomPt + 0.4, firstContentPt - 1.2);
                        topCropPt = Math.min(desiredCropPt, maxSafeCropPt);
                    } else {
                        // 正文距离较远时，仅向下保留 1.5pt 微余量即可彻底消融横线残墨，绝不向下伸长切字
                        topCropPt = lineBottomPt + 1.5;
                    }
                }

                // 2. 自底向上逐行扫描题目内容底部结束位置
                // 排除底部页脚区域（缩减至 26pt，约单页 3%，避免误切紧贴下边缘的长大题或大图）
                const footerIgnorePt = 26;
                const footerIgnorePx = Math.max(Math.floor(height * 0.03), Math.floor((footerIgnorePt / pageHeightPt) * height));
                const scanBottom = height - footerIgnorePx;
                const scanTop = Math.max(10, Math.floor((topCropPt / pageHeightPt) * height));

                // 题目内容墨水检测：
                // 几何线条、图表顶点、单字母编号（如 B、C、D、点 M 等）或分式下标极其纤细，单行往往仅 1~4 个像素宽！
                // 针对纯深色墨水 (RGB < 115) 仅需单行出现 >= 2 像素即判定有笔画；抗锯齿过渡墨水 (RGB < 165) 仅需 >= 4 像素
                let lastContentY = scanTop;

                for (let y = scanBottom; y >= scanTop; y--) {
                    let darkCount = 0;
                    let deepDarkCount = 0;
                    const rowOffset = y * width * 4;
                    for (let x = 10; x < width - 10; x++) {
                        const idx = rowOffset + x * 4;
                        const r = data[idx];
                        const g = data[idx + 1];
                        const b = data[idx + 2];
                        if (r < 115 && g < 115 && b < 115) {
                            deepDarkCount++;
                            darkCount++;
                        } else if (r < 165 && g < 165 && b < 165) {
                            darkCount++;
                        }
                    }
                    if (deepDarkCount >= 2 || darkCount >= 4) {
                        lastContentY = y;
                        break;
                    }
                }

                // 换算回 PDF Points
                const rawBottomPt = (lastContentY / height) * pageHeightPt;
                // 预留充分的呼吸余量（由原先极其容易切图切字的 18pt 提升至 35pt，约 1.2cm），严密保护几何图形底部顶点、字母标签、下划线及分式
                const bottomCutPt = Math.min(pageHeightPt, Math.ceil(rawBottomPt + 35));

                // 实际有效高度
                const rawEffectiveH = bottomCutPt - topCropPt;
                const effectiveHeightPt = Math.max(70, rawEffectiveH);
                // 仅当题目实际有效高度超过单页可打印区域的 65% 时，才视为超长大题独占一页
                const isFullPage = (effectiveHeightPt > (pageHeightPt - 54) * 0.65);

                return {
                    topCropPt: topCropPt,
                    bottomCutPt: bottomCutPt,
                    effectiveHeightPt: effectiveHeightPt,
                    isFullPage: isFullPage,
                    hasHeaderLine: hasHeaderLine
                };
            } catch (e) {
                console.warn('PDF 内容范围识别异常，采用整页:', e);
                return fallback;
            }
        }

        try {
            // A4 规格与外框排版参数
            const PAGE_WIDTH = 595.28;
            const PAGE_HEIGHT = 841.89;
            const TOP_MARGIN = 26;
            const BOTTOM_MARGIN = 28;
            const SEPARATOR_HEIGHT = (window.retestQuestionSpacing && window.retestQuestionSpacing >= 8) ? window.retestQuestionSpacing : 85;

            // 题目圆角虚线框规格
            const BOX_MARGIN_X = 26;
            const BOX_WIDTH = PAGE_WIDTH - 2 * BOX_MARGIN_X; // 543.28 pt
            const BOX_PAD_TOP = 8;
            const BOX_PAD_BOTTOM = 8;
            const BOX_GAP_ITEM = 8;       // 题组内（原题→变式、变式→变式、同题续页）间距
            const BOX_GAP_CLUSTER = 22;   // 不同题组之间的间距
            const VARIATION_INDENT = 10;  // 变式框向右缩进，形成明显从属关系

            // 每道题首切片上方的“胶囊题头卡”下间距
            const QUESTION_TOPIC_BANNER_GAP = 6;
            // 多页题目的续页抬头下间距
            const RUNNING_HEADER_GAP = 4;

            const mergedPdf = await PDFLib.PDFDocument.create();
            let currentPage = null;
            let currentY = PAGE_HEIGHT - TOP_MARGIN;

            for (let i = 0; i < pdfsToMerge.length; i++) {
                modalDesc.textContent = '正在排版题目切片 (' + (i + 1) + '/' + pdfsToMerge.length + ')...';
                const qItem = pdfsToMerge[i];
                const targetUrl = typeof qItem === 'string' ? qItem : qItem.url;
                const videoUrl = (typeof qItem === 'object' && qItem.videoUrl) ? String(qItem.videoUrl).trim() : '';
                const qWeek = (typeof qItem === 'object' && qItem.week) ? qItem.week : activeWeek;
                const qTopicRaw = (typeof qItem === 'object' && (qItem.clusterTopic || qItem.topic))
                    ? String(qItem.clusterTopic || qItem.topic).trim()
                    : '';
                // 学生版（重练版）隐藏考点时，仅移除题头中的具体知识点，题号/专题/原题变式关系保持不变；
                // 详解版含答案解析，主要供家长批改复习，仍保留考点，避免误伤复习信息。
                const hideTopicInBadge = (window.retestTopicHintEnabled === false) && type === 'exercise';
                const qTopic = hideTopicInBadge ? '' : qTopicRaw;
                const qSourceType = (typeof qItem === 'object' && qItem.sourceType) ? qItem.sourceType : 'homework';
                const qParentNum = typeof qItem === 'object'
                    ? (parseInt(qItem.parentNum || qItem.errorNum, 10) || (i + 1))
                    : (i + 1);
                const qSubNum = typeof qItem === 'object' ? (parseInt(qItem.subNum, 10) || 1) : 1;
                const qVariationTotal = typeof qItem === 'object' ? (parseInt(qItem.variationTotal, 10) || 0) : 0;
                const qIsVariation = typeof qItem === 'object'
                    ? (Boolean(qItem.isVariation) || qSourceType === 'variation')
                    : false;
                const qBadgeSpec = buildQuestionBadgeSpec(qItem, qWeek, qTopic);

                try {
                    const fetchUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + 't=' + (window.retestCacheVersion || Date.now());
                    const pdfBytes = await fetch(fetchUrl, { cache: 'no-cache' }).then(res => {
                        if (!res.ok) throw new Error('Fetch failed');
                        return res.arrayBuffer();
                    });

                    const sourceDoc = await PDFLib.PDFDocument.load(pdfBytes);
                    const pageCount = sourceDoc.getPageCount();

                    for (let pIdx = 0; pIdx < pageCount; pIdx++) {
                        const srcPage = sourceDoc.getPage(pIdx);
                        const { width: origW, height: origH } = srcPage.getSize();
                        const box = srcPage.getMediaBox();

                        // 智能测量有效范围（顶部页眉/横线裁剪与底部留白）
                        const bounds = await detectPdfContentBounds(pdfBytes, pIdx + 1, origW, origH);
                        let { topCropPt, bottomCutPt, effectiveHeightPt, isFullPage } = bounds;

                        // 提取属于当前页的大题错题框选坐标，并保护其不被上下裁剪切除
                        const pageErrorBoxes = (type === 'exercise' && typeof qItem === 'object' && Array.isArray(qItem.errorBoxes))
                            ? qItem.errorBoxes.filter(b => b && (parseInt(b.pageOffset, 10) || 0) === pIdx && typeof b.x === 'number' && typeof b.y === 'number')
                            : [];
                        if (pageErrorBoxes.length > 0) {
                            pageErrorBoxes.forEach(b => {
                                const boxTopInPt = b.y * origH;
                                const boxBottomInPt = (b.y + b.h) * origH;
                                topCropPt = Math.min(topCropPt, Math.max(0, boxTopInPt - 8));
                                bottomCutPt = Math.max(bottomCutPt, Math.min(origH, boxBottomInPt + 8));
                            });
                            effectiveHeightPt = Math.max(70, bottomCutPt - topCropPt);
                            isFullPage = (effectiveHeightPt > (origH - 54) * 0.65);
                        }

                        // 题头/续页抬头：首切片用完整题头，后续切片用紧凑“（续）”
                        const isFirstPageOfQuestion = (pIdx === 0);
                        const isLastPageOfQuestion = (pIdx === pageCount - 1);
                        const answerH = isLastPageOfQuestion ? SEPARATOR_HEIGHT : 0;

                        const boxX = BOX_MARGIN_X + (qIsVariation ? VARIATION_INDENT : 0);
                        const boxW = BOX_WIDTH - (qIsVariation ? VARIATION_INDENT : 0);
                        const bannerW = boxW - 16;
                        const bannerX = boxX + 8;

                        let headerInfo = null;
                        let headerGap = 0;
                        let currentBannerBlock = 0;

                        const itemGroupNums = (typeof qItem === 'object' && Array.isArray(qItem.groupNums)) ? qItem.groupNums : [];
                        const itemErrorNums = (typeof qItem === 'object' && Array.isArray(qItem.errorNums)) ? qItem.errorNums : [];
                        const isBigQItem = !qIsVariation && (itemGroupNums.length > 1 || itemErrorNums.length > 1);
                        const bigRangeTitle = itemGroupNums.length > 1
                            ? ('第' + itemGroupNums[0] + '~' + itemGroupNums[itemGroupNums.length - 1] + '题')
                            : (itemErrorNums.length > 1 ? ('第' + itemErrorNums.join('、') + '题') : ('第' + qParentNum + '题'));

                        if (isFirstPageOfQuestion) {
                            headerInfo = generateQuestionTopicBadge(qBadgeSpec, bannerW);
                            headerGap = QUESTION_TOPIC_BANNER_GAP;
                        } else {
                            const matchedParents = Array.isArray(qItem.matchedParentNums) && qItem.matchedParentNums.length > 0
                                ? qItem.matchedParentNums
                                : (Array.isArray(qItem.parentNums) && qItem.parentNums.length > 0 ? qItem.parentNums : (qParentNum ? [qParentNum] : []));
                            const parentStr = matchedParents.length > 1
                                ? ('第' + matchedParents.join('、') + '题')
                                : (matchedParents.length === 1 ? ('第' + matchedParents[0] + '题') : ('第' + qParentNum + '题'));
                            const bigErrNote = (isBigQItem && itemErrorNums.length > 0)
                                ? ('（本篇错题：第 ' + itemErrorNums.join('、') + ' 题）')
                                : '';
                            const runningLabel = qIsVariation
                                ? (parentStr + ' · 变式' + qSubNum + (qVariationTotal > 0 ? ('/' + qVariationTotal) : '') + '（续）')
                                : (qSourceType === 'preview'
                                    ? (bigRangeTitle + bigErrNote + ' · 预习（续）')
                                    : (bigRangeTitle + bigErrNote + ' · 原题（续）'));
                            headerInfo = generateQuestionRunningHeader(runningLabel, bannerW, qBadgeSpec.theme);
                            headerGap = RUNNING_HEADER_GAP;
                        }
                        if (headerInfo) {
                            currentBannerBlock = headerInfo.heightPt + headerGap;
                        }

                        let groupBannerInfo = null;
                        let groupBannerBlock = 0;
                        const isGroupBannerNeeded = isFirstPageOfQuestion && Boolean(qItem.isGroupStart && qItem.isGroupMerged && qTopicRaw);

                        if (isGroupBannerNeeded) {
                            const bannerTheme = (qSourceType === 'preview') ? 'preview' : 'original';
                            const bannerTopic = hideTopicInBadge ? '错题集中强化' : qTopicRaw;
                            groupBannerInfo = generateTopicGroupBanner({
                                topic: bannerTopic,
                                parentNums: qItem.groupParentNums || [qParentNum],
                                variationCount: qItem.groupVariationCount || 0,
                                week: qWeek,
                                theme: bannerTheme
                            }, BOX_WIDTH);
                            if (groupBannerInfo) {
                                groupBannerBlock = groupBannerInfo.blockPt;
                            }
                        }

                        const innerContentW = boxW - 12;
                        const contentAreaH = PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN;
                        const maxAvailContentH = contentAreaH - (isGroupBannerNeeded ? groupBannerBlock : 0) - BOX_PAD_TOP - BOX_PAD_BOTTOM - currentBannerBlock - answerH;
                        const scale = isFullPage
                            ? Math.min(innerContentW / origW, Math.max(0.1, (maxAvailContentH - 10) / effectiveHeightPt), 1.0)
                            : Math.min(innerContentW / origW, 1.0);
                        const drawW = origW * scale;
                        const drawH = effectiveHeightPt * scale;
                        const realDrawX = (boxX + 6) + (innerContentW - drawW) / 2;

                        // 每一题连同题头/作答区外框总高度
                        const boxH = BOX_PAD_TOP + currentBannerBlock + drawH + answerH + BOX_PAD_BOTTOM;

                        const isPageTop = (!currentPage || currentY >= (PAGE_HEIGHT - TOP_MARGIN - 5));
                        const needsClusterRoom = isFirstPageOfQuestion && !qIsVariation
                            && qVariationTotal > 0 && !isPageTop;
                        const clusterReserve = needsClusterRoom ? 110 : 0;
                        const neededH = (isGroupBannerNeeded ? groupBannerBlock : 0) + boxH;

                        if (!currentPage
                            || (!isPageTop && currentY - neededH < BOTTOM_MARGIN)
                            || (needsClusterRoom && currentY - neededH - clusterReserve < BOTTOM_MARGIN)
                            || (isFullPage && !isPageTop)) {
                            // 空间不足、考点横条与题目可能被拆散，或当前是整页大题且当前页已被占用 -> 开新 A4 页
                            currentPage = mergedPdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
                            currentY = PAGE_HEIGHT - TOP_MARGIN;
                        }

                        // 0. 若当前为考点聚合组的首道题目，先绘制横跨整行的“考点聚合导读卡”
                        if (isGroupBannerNeeded && groupBannerInfo && groupBannerInfo.dataUrl) {
                            try {
                                const groupBannerImg = await mergedPdf.embedPng(groupBannerInfo.dataUrl);
                                currentPage.drawImage(groupBannerImg, {
                                    x: BOX_MARGIN_X,
                                    y: currentY - groupBannerInfo.heightPt,
                                    width: BOX_WIDTH,
                                    height: groupBannerInfo.heightPt
                                });
                                currentY -= groupBannerBlock;
                            } catch (gbErr) {
                                console.warn('Draw group banner failed:', gbErr);
                            }
                        }

                        const boxTopY = currentY;
                        const boxBottomY = boxTopY - boxH;
                        let boxContentY = boxTopY - BOX_PAD_TOP;

                        // 变式框使用极浅绿底，先铺底再画题头/题目，避免遮住内容
                        if (qIsVariation) {
                            currentPage.drawRectangle({
                                x: boxX,
                                y: boxBottomY,
                                width: boxW,
                                height: boxH,
                                color: PDFLib.rgb(0.941, 0.992, 0.957)
                            });
                        }

                        // 裁剪并嵌入
                        const [embedded] = await mergedPdf.embedPdf(sourceDoc, [pIdx]);

                        // 视口上下双向动态裁剪（若有页眉横线，或底部有留白）
                        if (topCropPt > 0 || bottomCutPt < origH * 0.95) {
                            const bottomInOrig = origH - bottomCutPt;
                            embedded.height = effectiveHeightPt;
                            if (embedded.embedder) {
                                embedded.embedder.height = effectiveHeightPt;
                                embedded.embedder.boundingBox = {
                                    left: 0,
                                    bottom: bottomInOrig,
                                    right: origW,
                                    top: origH - topCropPt
                                };
                                embedded.embedder.transformationMatrix = [1, 0, 0, 1, 0, -bottomInOrig];
                            }
                        }

                        // 1. 在题框内顶部绘制“胶囊题头卡”或续页抬头
                        if (headerInfo && headerInfo.dataUrl) {
                            try {
                                const badgeImg = await mergedPdf.embedPng(headerInfo.dataUrl);
                                currentPage.drawImage(badgeImg, {
                                    x: bannerX,
                                    y: boxContentY - headerInfo.heightPt,
                                    width: bannerW,
                                    height: headerInfo.heightPt
                                });
                                boxContentY -= (headerInfo.heightPt + headerGap);
                            } catch (badgeErr) {
                                console.warn('Question topic banner skipped:', badgeErr);
                            }
                        }

                        // 2. 绘制题目切片
                        const questionBottomY = boxContentY - drawH;
                        currentPage.drawPage(embedded, {
                            x: realDrawX,
                            y: questionBottomY,
                            width: drawW,
                            height: drawH
                        });

                        // 2b. 若当前页包含大题错题小问框选坐标，精准绘制黑白打印友好的醒目粗实线方框与反白角标「错题 X」
                        if (pageErrorBoxes.length > 0) {
                            const sliceTopY = questionBottomY + drawH;
                            for (const eb of pageErrorBoxes) {
                                try {
                                    const ebX = realDrawX + (eb.x * origW) * scale;
                                    const ebW = Math.max(14, (eb.w * origW) * scale);
                                    const ebH = Math.max(12, (eb.h * origH) * scale);
                                    const ebTopY = sliceTopY - ((eb.y * origH - topCropPt) * scale);
                                    const ebBottomY = ebTopY - ebH;

                                    // 白色外衬底描边（防止与原卷表格线或文字粘连）
                                    currentPage.drawRectangle({
                                        x: ebX - 0.8,
                                        y: ebBottomY - 0.8,
                                        width: ebW + 1.6,
                                        height: ebH + 1.6,
                                        borderColor: PDFLib.rgb(1, 1, 1),
                                        borderWidth: 2.6,
                                        borderOpacity: 0.9
                                    });

                                    // 高对比深墨色实线框（黑白激光打印依然 100% 锐利醒目）
                                    currentPage.drawRectangle({
                                        x: ebX,
                                        y: ebBottomY,
                                        width: ebW,
                                        height: ebH,
                                        borderColor: PDFLib.rgb(0.06, 0.09, 0.16),
                                        borderWidth: 1.6
                                    });

                                    // 左上角反白高对比角标：选框较紧凑或邻近拥挤时仅显示数字，宽敞时显示「错题 X」
                                    if (eb.qNum) {
                                        const hasCloseNeighbor = pageErrorBoxes.some(other => {
                                            if (!other || other === eb) return false;
                                            const hGap = Math.max(0, Math.max(eb.x, other.x) - Math.min(eb.x + eb.w, other.x + other.w));
                                            const vGap = Math.max(0, Math.max(eb.y, other.y) - Math.min(eb.y + eb.h, other.y + other.h));
                                            return hGap < 0.06 && vGap < 0.045;
                                        });
                                        const isCompactTag = (ebW < 55 || ebH < 26 || pageErrorBoxes.length >= 5 || hasCloseNeighbor);
                                        const tagSpec = generateErrorBoxTagPng(eb.qNum, isCompactTag);
                                        if (tagSpec && tagSpec.dataUrl) {
                                            const tagImg = await mergedPdf.embedPng(tagSpec.dataUrl);
                                            const tagX = Math.max(boxX + 4, ebX - 1);
                                            // 优先置于框线左上沿外侧，若靠近切片顶端则贴合框内左上角
                                            const preferAboveY = ebTopY + 0.5;
                                            const tagY = (preferAboveY + tagSpec.heightPt <= sliceTopY + 3)
                                                ? preferAboveY
                                                : Math.max(ebBottomY, ebTopY - tagSpec.heightPt + 1);
                                            currentPage.drawImage(tagImg, {
                                                x: tagX,
                                                y: tagY,
                                                width: tagSpec.widthPt,
                                                height: tagSpec.heightPt
                                            });
                                        }
                                    }
                                } catch (ebErr) {
                                    console.warn('Draw error box failed:', ebErr);
                                }
                            }
                        }

                        boxContentY = questionBottomY;

                        // 3. 在每道题右下角/作答区内添加视频讲解二维码与说明文字
                        if (window.retestQrCodeEnabled !== false && videoUrl && isLastPageOfQuestion) {
                            try {
                                const qrQuestionNum = qIsVariation
                                    ? (qParentNum + '-' + qSubNum)
                                    : (isBigQItem && itemGroupNums.length > 1
                                        ? (itemGroupNums[0] + '~' + itemGroupNums[itemGroupNums.length - 1])
                                        : qParentNum);
                                const qrDataUrl = await generateQuestionQrBadge(videoUrl, qrQuestionNum);
                                if (qrDataUrl) {
                                    const qrImage = await mergedPdf.embedPng(qrDataUrl);
                                    const badgeW = 54;
                                    const badgeH = 68;
                                    const badgeX = (boxX + boxW) - badgeW - 10;
                                    const badgeY = (answerH >= 65)
                                        ? (boxBottomY + 10)
                                        : Math.max(boxBottomY + 8, questionBottomY + 4);

                                    currentPage.drawImage(qrImage, {
                                        x: badgeX,
                                        y: badgeY,
                                        width: badgeW,
                                        height: badgeH
                                    });

                                    // 轻触跳转超链接（移动端/电脑端交互支持）
                                    try {
                                        const linkAnnot = mergedPdf.context.obj({
                                            Type: 'Annot',
                                            Subtype: 'Link',
                                            Rect: [badgeX, badgeY, badgeX + badgeW, badgeY + badgeH],
                                            Border: [0, 0, 0],
                                            A: {
                                                Type: 'Action',
                                                S: 'URI',
                                                URI: PDFLib.PDFString.of(videoUrl)
                                            }
                                        });
                                        const linkAnnotRef = mergedPdf.context.register(linkAnnot);
                                        currentPage.node.addAnnot(linkAnnotRef);
                                    } catch (annotErr) {
                                        console.warn('Link annotation skipped:', annotErr);
                                    }
                                }
                            } catch (qrErr) {
                                console.warn('Failed to embed question QR badge:', qrErr);
                            }
                        }

                        // 4. 绘制包裹“题头卡 + 题目 + 作答区”的圆角虚线框
                        try {
                            const boxSvgPath = getRetestBoxSvgPath(boxW, boxH, 8);
                            currentPage.drawSvgPath(boxSvgPath, {
                                x: boxX,
                                y: boxTopY,
                                borderColor: qIsVariation
                                    ? PDFLib.rgb(0.45, 0.78, 0.55)
                                    : PDFLib.rgb(0.70, 0.74, 0.80),
                                borderWidth: 0.9,
                                borderDashArray: [4, 3]
                            });
                        } catch (boxErr) {
                            console.warn('Draw question box failed:', boxErr);
                        }

                        // 5. 变式框左侧加一条绿色竖线，即使黑白打印也能看出从属关系
                        if (qIsVariation) {
                            try {
                                currentPage.drawRectangle({
                                    x: boxX + 1.5,
                                    y: boxBottomY + 5,
                                    width: 3,
                                    height: Math.max(8, boxH - 10),
                                    color: PDFLib.rgb(0.06, 0.73, 0.51)
                                });
                            } catch (railErr) {
                                console.warn('Draw variation rail failed:', railErr);
                            }
                        }

                        // 为下一题预留纵向间距：同考点组内紧凑，考点组间留白
                        const nextGap = (!isLastPageOfQuestion)
                            ? BOX_GAP_ITEM
                            : ((typeof qItem === 'object' && qItem.isGroupEnd === false) ? BOX_GAP_ITEM : BOX_GAP_CLUSTER);
                        currentY = boxBottomY - nextGap;
                    }
                } catch (err) {
                    console.error('Failed to load/pack PDF chunk', err);
                }
            }

            // 底部自动标注优雅页码 - 1 -, - 2 -
            try {
                const totalPages = mergedPdf.getPageCount();
                if (totalPages > 0) {
                    const font = await mergedPdf.embedFont(PDFLib.StandardFonts.Helvetica);
                    for (let p = 0; p < totalPages; p++) {
                        const pg = mergedPdf.getPage(p);
                        const label = '- ' + (p + 1) + ' -';
                        const w = font.widthOfTextAtSize(label, 8.5);
                        pg.drawText(label, {
                            x: (PAGE_WIDTH - w) / 2,
                            y: 12,
                            size: 8.5,
                            font: font,
                            color: PDFLib.rgb(0.62, 0.66, 0.73)
                        });
                    }
                }
            } catch (fontErr) {
                console.warn('Page number render skipped', fontErr);
            }

            modalTitle.textContent = '合成完毕';
            modalDesc.textContent = isWeChat ? '正在准备微信高速下载...' : '正在调起下载，请在弹出窗口中确认保存...';

            const pdfBytesFinal = await mergedPdf.save();
            const blob = new Blob([pdfBytesFinal], { type: 'application/pdf' });
            const fileName = data.s + '_' + data.n + '_' + fileLabel + '.pdf';

            // 微信专属优化：上传至服务端生成真实下载直链，彻底解决微信外跳浏览器 blob: 无法解析导致无反应的问题
            if (isWeChat) {
                modalDesc.textContent = '正在生成微信下载直链...';
                try {
                    const formData = new FormData();
                    formData.append('file', blob, fileName);
                    formData.append('filename', fileName);
                    if (currentToken) formData.append('token', currentToken);
                    const sName = (retestData && retestData.data && retestData.data.n) || '';
                    if (sName) formData.append('studentName', sName);

                    const uploadRes = await fetch('api/retest.php?action=create_temp_download', {
                        method: 'POST',
                        body: formData
                    }).then(r => r.json());

                    if (uploadRes && uploadRes.success && uploadRes.downloadUrl) {
                        currentTempDownloadUrl = uploadRes.downloadUrl;
                        currentTempFullUrl = uploadRes.fullUrl || (window.location.origin + '/' + uploadRes.downloadUrl);
                        currentTempFileName = fileName;

                        modal.style.display = 'none';

                        // 弹出微信下载管理弹窗（包含立即下载和复制直链）
                        document.getElementById('wechat-modal-filename').textContent = fileName;
                        document.getElementById('wechat-download-modal').style.display = 'flex';

                        // 自动调起下载（安卓微信拉起外部浏览器时获得真实 URL，外部浏览器直接开始下载；iOS 微信直接调起全屏 PDF 预览）
                        window.location.href = uploadRes.downloadUrl;
                        return;
                    }
                } catch (wechatErr) {
                    console.error('WeChat temp download failed, falling back to blob:', wechatErr);
                }
            }

            // 标准浏览器（PC 端、外部手机浏览器 Chrome / Safari）：走本地 Blob 极速下载
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // 异步上报下载日志
            if (currentToken) {
                const sName = (retestData && retestData.data && retestData.data.n) || '';
                fetch(`api/retest.php?action=log_download&token=${encodeURIComponent(currentToken)}&filename=${encodeURIComponent(fileName)}&studentName=${encodeURIComponent(sName)}`).catch(() => {});
            }

            setTimeout(() => {
                modal.style.display = 'none';
                showToast('下载已就绪');
            }, 1200);

        } catch (error) {
            console.error('Merge Error:', error);
            modalTitle.textContent = '合成失败';
            modalDesc.textContent = '网络连接不稳定，请稍后刷新重试';
            setTimeout(() => {
                modal.style.display = 'none';
            }, 2500);
        }
    }

    // Copy Current Page URL with Toast feedback
    function copyCurrentLink() {
        const url = window.location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
                showToast('已复制页面链接，可粘贴至外部浏览器打开');
            }).catch(() => {
                fallbackCopy(url);
            });
        } else {
            fallbackCopy(url);
        }
    }

    function fallbackCopy(text) {
        const input = document.createElement('textarea');
        input.value = text;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.focus();
        input.select();
        try {
            document.execCommand('copy');
            showToast('已复制页面链接，可粘贴至外部浏览器打开');
        } catch (e) {
            showToast('请手动长按复制地址栏链接');
        }
        document.body.removeChild(input);
    }


    // WeChat Download Actions & Helpers
    function executeWeChatDownload() {
        if (currentTempDownloadUrl) {
            window.location.href = currentTempDownloadUrl;
        } else {
            showToast('未找到有效下载链接，请重新合成');
        }
    }

    function copyDownloadUrl() {
        const url = currentTempFullUrl || currentTempDownloadUrl || window.location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(() => {
                showToast('已复制文件下载直链，可在浏览器粘贴下载');
            }).catch(() => {
                fallbackCopy(url);
            });
        } else {
            fallbackCopy(url);
        }
    }

    function closeWeChatDownloadModal() {
        document.getElementById('wechat-download-modal').style.display = 'none';
    }

    function handleWeChatModalOverlayClick(event) {
        if (event.target === document.getElementById('wechat-download-modal')) {
            closeWeChatDownloadModal();
        }
    }

    function showWeChatGuide() {
        document.getElementById('wechat-guide-mask').style.display = 'flex';
    }

    function hideWeChatGuide() {
        document.getElementById('wechat-guide-mask').style.display = 'none';
    }

    // Show Toast Notification (Unslop 统一规范)
    function showToast(msg, type = 'info', duration = 2800) {
        if (!msg) return;
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        while (container.children.length >= 3) {
            container.firstElementChild.remove();
        }

        const normType = (type === 'warn' || type === 'warning') ? 'warning'
            : (type === 'error' ? 'error'
            : (type === 'success' ? 'success' : 'info'));

        const icons = {
            success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };

        const toast = document.createElement('div');
        toast.className = `toast-item ${normType}`;
        const safeText = String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        toast.innerHTML = `${icons[normType] || icons.info}<div class="toast-content">${safeText}</div>`;

        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        let dismissTimer = null;
        const dismiss = () => {
            if (!toast.parentNode) return;
            if (dismissTimer) clearTimeout(dismissTimer);
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, 200);
        };

        toast.addEventListener('click', dismiss);
        dismissTimer = setTimeout(dismiss, duration);
    }
