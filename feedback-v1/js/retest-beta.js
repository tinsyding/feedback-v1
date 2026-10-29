/**
 * 专属错题本 Beta 实验副本 (2026-09-28 与 retest.js 同步)
 * 与线上 retest.js 独立，实验改动只改本文件；接口共用 api/retest.php
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
    try {
        const savedSpacing = (localStorage.getItem('retest_question_spacing') || localStorage.getItem('retest_beta_spacing'));
        if (savedSpacing) {
            window.retestQuestionSpacing = parseInt(savedSpacing) || 85;
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

    // Beta 新增：知识点横条 PNG 缓存（key 含宽度，不同切片宽度复用不串）
    const topicBadgeCache = {};

    function topicBadgeRoundRect(ctx, x, y, w, h, r) {
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
    function splitTopicLines(ctx, text, maxWidth, maxLines = 4) {
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

    // 错题本每道题前的标题：优先显示“巩固·专题五：勾股定理”或“预习·专题五：勾股定理”，没有专题时退回知识点。
    function formatQuestionTopicLabel(week, topic, sourceType) {
        const weekNum = parseInt(week, 10);
        const typePrefix = sourceType === 'preview' ? '预习' : '巩固';
        let weekLabel = weekNum > 0 ? ('专题' + numToChinese(weekNum)) : '';
        if (weekLabel) weekLabel = typePrefix + '·' + weekLabel;
        const topicText = String(topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
        if (weekLabel && topicText) return weekLabel + '：' + topicText;
        if (weekLabel) return weekLabel;
        if (topicText) return typePrefix + '知识点：' + topicText;
        return '';
    }

    /**
     * Beta 新增：把专题/知识点文字渲染成精致“胶囊考点卡” PNG DataURL（pdf-lib 内置字体无中文，走 canvas）。
     * 左侧为专属分类胶囊药丸（巩固为极方深宝蓝，预习为活力琥珀橙），右侧为核心考点正文。
     * 支持超长考点智能换行（单行 25pt，多行自适应撑高），返回 { dataUrl, heightPt, blockPt, widthPt, lineCount }。
     */
    function generateTopicBadge(labelText, widthPt) {
        const label = String(labelText || '').trim().slice(0, 300);
        if (!label) return null;
        const wPt = Math.max(120, Math.min(540, Number(widthPt) || 540));
        const cacheKey = wPt.toFixed(1) + '___' + label;
        if (topicBadgeCache[cacheKey]) {
            return topicBadgeCache[cacheKey];
        }

        try {
            const K = 2; // 2 倍超采样，保证打印清晰
            const wpx = Math.max(240, Math.round(wPt * K));

            // 解析标签文本：拆分为左侧胶囊文本（tagText）与右侧核心考点（contentText）
            const colonIdx = label.indexOf('：') >= 0 ? label.indexOf('：') : label.indexOf(':');
            let tagText = '';
            let contentText = '';
            if (colonIdx > 0) {
                tagText = label.slice(0, colonIdx).trim();
                contentText = label.slice(colonIdx + 1).trim();
            } else {
                tagText = label.includes('预习') ? '预习' : (label.includes('巩固') ? '巩固' : '考点');
                contentText = label.trim();
            }

            // 规范化胶囊文字（避免出现“巩固知识点”或“预习知识点”这样冗长的药丸）
            if (tagText === '巩固知识点') tagText = '巩固·考点';
            if (tagText === '预习知识点') tagText = '预习·考点';
            if (tagText === '知识点') tagText = '重点考点';

            const isPreview = tagText.includes('预习');

            const testCanvas = document.createElement('canvas');
            const testCtx = testCanvas.getContext('2d');

            // 胶囊字体（粗体紧凑）
            const fontPill = '700 ' + Math.round(10.5 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
            // 考点内容字体（清晰典雅）
            const fontContent = '600 ' + Math.round(11 * K) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

            testCtx.font = fontPill;
            const pillTextW = testCtx.measureText(tagText).width;
            const pillPadX = 9 * K;
            const pillWidth = Math.round(pillTextW + pillPadX * 2);
            const pillHeight = Math.round(17 * K);
            const pillRadius = Math.round(pillHeight / 2);

            // 考点文字准备
            let displayContent = contentText;
            if (displayContent && !displayContent.startsWith('考点') && !displayContent.startsWith('知识点')) {
                displayContent = '考点：' + displayContent;
            }

            const cardPadL = 6 * K;
            const pillToTextGap = 8 * K;
            const cardPadR = 10 * K;
            const maxContentW = wpx - cardPadL - pillWidth - pillToTextGap - cardPadR;

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
                lines = splitTopicLines(testCtx, displayContent, maxContentW, 4);
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
            topicBadgeRoundRect(ctx, 1, 1, wpx - 2, hpx - 2, cardRadius);
            if (isPreview) {
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

            topicBadgeRoundRect(ctx, pillX, pillY, pillWidth, pillHeight, pillRadius);
            if (isPreview) {
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
            ctx.fillText(tagText, pillX + pillWidth / 2, pillY + pillHeight / 2 + 0.5 * K);

            // 3. 右侧考点正文 (Right Topic Text)
            if (lines.length > 0) {
                ctx.font = fontContent;
                ctx.fillStyle = '#0f172a'; // 考点深色墨感字色
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                const textStartX = pillX + pillWidth + pillToTextGap;
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
                blockPt: heightPt + (window.TOPIC_BANNER_GAP || 6),
                widthPt: wPt,
                lineCount: lines.length
            };
            topicBadgeCache[cacheKey] = result;
            return result;
        } catch (err) {
            console.warn('generateTopicBadge failed:', err);
            return null;
        }
    }

    function generateTopicBadgeDataUrl(labelText, widthPt) {
        const badge = generateTopicBadge(labelText, widthPt);
        return badge ? badge.dataUrl : null;
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
        const typeLabel = type === 'exercise' ? '仅错题题目' : '错题题目+答案';
        let pdfsToMerge = [];
        let fileLabel = '';

        const appendWeekPdfs = (wd, fallbackWeek) => {
            if (!wd) return;
            const appendList = (list, sourceType, headerWeek) => {
                if (!list || !list.length) return;
                const validItems = [];
                list.forEach(p => {
                    const url = type === 'exercise' ? p.exercisePdf : p.answerPdf;
                    if (url) {
                        validItems.push({
                            url: url,
                            errorNum: p.errorNum,
                            videoUrl: p.videoUrl || p.video_url || '',
                            topic: p.topic || '',
                            week: headerWeek,
                            sourceType: sourceType
                        });
                    }
                });
                if (validItems.length === 0) return;

                // 同知识点错题合并归类：
                // 若一个学生多道错题属于同一知识点，将这些错题聚合在该知识点下，仅首题展示知识点横条
                const parseQNum = val => {
                    if (typeof val === 'number') return val;
                    const m = String(val || '').match(/\d+/);
                    return m ? parseInt(m[0], 10) : 0;
                };

                const topicGroups = new Map();
                validItems.forEach((item, idx) => {
                    const cleanT = String(item.topic || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');
                    const groupKey = cleanT ? ('topic:' + cleanT) : ('__no_topic_' + (item.errorNum || idx) + '__');
                    if (!topicGroups.has(groupKey)) {
                        topicGroups.set(groupKey, []);
                    }
                    topicGroups.get(groupKey).push(item);
                });

                topicGroups.forEach(groupItems => {
                    groupItems.sort((a, b) => parseQNum(a.errorNum) - parseQNum(b.errorNum));
                    groupItems.forEach((item, idx) => {
                        pdfsToMerge.push({
                            ...item,
                            isFirstInTopicGroup: idx === 0,
                            topicGroupSize: groupItems.length
                        });
                    });
                });
            };
            appendList(wd.previewPdfs, 'preview', wd.previewWeek || fallbackWeek);
            appendList(wd.pdfs, 'homework', fallbackWeek);
        };

        if (allWeeks) {
            const sortedWeeks = Object.keys(weeksData).map(Number).sort((a, b) => a - b);
            sortedWeeks.forEach(w => {
                const wd = weeksData[String(w)];
                appendWeekPdfs(wd, w);
            });
            if (sortedWeeks.length > 3) {
                fileLabel = getTopicLabel(sortedWeeks[0]) + '至' + getTopicLabel(sortedWeeks[sortedWeeks.length - 1]) + '_全' + sortedWeeks.length + '讲合辑_' + typeLabel;
            } else {
                fileLabel = sortedWeeks.map(w => getTopicLabel(w)).join('+') + '_' + typeLabel;
            }
        } else {
            const weekData = weeksData[String(activeWeek)];
            if (!weekData) return;
            appendWeekPdfs(weekData, activeWeek);
            fileLabel = getTopicLabel(activeWeek) + '_' + typeLabel;
        }

        if (pdfsToMerge.length === 0) {
            showToast(allWeeks ? '暂无任何错题需要生成合辑' : '该专题暂无错题需要生成');
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
            const BOX_GAP = 12; // 同页不同题目之间的纵向间距

            // Beta 新增：含答案版每道题首切片上方的“胶囊考点卡”（卡高 25pt + 下间距 6pt）
            const TOPIC_BANNER_H = 25;
            const TOPIC_BANNER_GAP = 6;
            const TOPIC_BANNER_BLOCK = TOPIC_BANNER_H + TOPIC_BANNER_GAP;

            const mergedPdf = await PDFLib.PDFDocument.create();
            let currentPage = null;
            let currentY = PAGE_HEIGHT - TOP_MARGIN;

            for (let i = 0; i < pdfsToMerge.length; i++) {
                modalDesc.textContent = '正在智能分析与排版切片 (' + (i + 1) + '/' + pdfsToMerge.length + ')...';
                const qItem = pdfsToMerge[i];
                const targetUrl = typeof qItem === 'string' ? qItem : qItem.url;
                const videoUrl = (typeof qItem === 'object' && qItem.videoUrl) ? String(qItem.videoUrl).trim() : '';
                const qWeek = (typeof qItem === 'object' && qItem.week) ? qItem.week : activeWeek;
                const qTopic = (typeof qItem === 'object' && qItem.topic) ? String(qItem.topic).trim() : '';
                const qSourceType = (typeof qItem === 'object' && qItem.sourceType) ? qItem.sourceType : 'homework';
                const qTopicLabel = formatQuestionTopicLabel(qWeek, qTopic, qSourceType);
                const qNum = typeof qItem === 'object' ? (qItem.errorNum || (i + 1)) : (i + 1);

                try {
                    const pdfBytes = await fetch(targetUrl).then(res => {
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
                        const { topCropPt, bottomCutPt, effectiveHeightPt, isFullPage } = bounds;

                        // 检查当前页剩余空间是否足够
                        const isFirstInTopicGroup = typeof qItem === 'object' ? (qItem.isFirstInTopicGroup !== false) : true;
                        const showTopicBanner = (pIdx === 0 && isFirstInTopicGroup && !!qTopicLabel);
                        const isLastPageOfQuestion = (pIdx === pageCount - 1);
                        const answerH = isLastPageOfQuestion ? SEPARATOR_HEIGHT : 0;

                        let topicBannerInfo = null;
                        let currentBannerH = TOPIC_BANNER_H;
                        let currentBannerBlock = 0;

                        const bannerW = BOX_WIDTH - 16;
                        const bannerX = BOX_MARGIN_X + 8;

                        if (showTopicBanner) {
                            topicBannerInfo = generateTopicBadge(qTopicLabel, bannerW);
                            if (topicBannerInfo) {
                                currentBannerH = topicBannerInfo.heightPt;
                                currentBannerBlock = currentBannerH + TOPIC_BANNER_GAP;
                            }
                        }

                        const innerContentW = BOX_WIDTH - 12;
                        const contentAreaH = PAGE_HEIGHT - TOP_MARGIN - BOTTOM_MARGIN;
                        const maxAvailContentH = contentAreaH - BOX_PAD_TOP - BOX_PAD_BOTTOM - currentBannerBlock - answerH;
                        const scale = isFullPage
                            ? Math.min(innerContentW / origW, Math.max(0.1, (maxAvailContentH - 10) / effectiveHeightPt), 1.0)
                            : Math.min(innerContentW / origW, 1.0);
                        const drawW = origW * scale;
                        const drawH = effectiveHeightPt * scale;
                        const realDrawX = (BOX_MARGIN_X + 6) + (innerContentW - drawW) / 2;

                        // 每一题连同作答区外框总高度
                        const boxH = BOX_PAD_TOP + currentBannerBlock + drawH + answerH + BOX_PAD_BOTTOM;

                        const isPageTop = (!currentPage || currentY >= (PAGE_HEIGHT - TOP_MARGIN - 5));

                        if (!currentPage || (currentY - boxH < BOTTOM_MARGIN) || (isFullPage && !isPageTop)) {
                            // 空间不足，或当前是整页大题且当前页已被占用 -> 开新 A4 页
                            currentPage = mergedPdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
                            currentY = PAGE_HEIGHT - TOP_MARGIN;
                        }

                        const boxTopY = currentY;
                        const boxBottomY = boxTopY - boxH;
                        let boxContentY = boxTopY - BOX_PAD_TOP;

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

                        // 1. 在题框内顶部绘制“胶囊考点卡”
                        if (showTopicBanner && topicBannerInfo && topicBannerInfo.dataUrl) {
                            try {
                                const badgeImg = await mergedPdf.embedPng(topicBannerInfo.dataUrl);
                                currentPage.drawImage(badgeImg, {
                                    x: bannerX,
                                    y: boxContentY - topicBannerInfo.heightPt,
                                    width: bannerW,
                                    height: topicBannerInfo.heightPt
                                });
                                boxContentY -= (topicBannerInfo.heightPt + TOPIC_BANNER_GAP);
                            } catch (badgeErr) {
                                console.warn('Topic badge embed skipped:', badgeErr);
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
                        boxContentY = questionBottomY;

                        // 3. 在每道题右下角/作答区内添加视频讲解二维码与说明文字
                        if (window.retestQrCodeEnabled !== false && videoUrl && isLastPageOfQuestion) {
                            try {
                                const qrDataUrl = await generateQuestionQrBadge(videoUrl, qNum);
                                if (qrDataUrl) {
                                    const qrImage = await mergedPdf.embedPng(qrDataUrl);
                                    const badgeW = 54;
                                    const badgeH = 68;
                                    const badgeX = (BOX_MARGIN_X + BOX_WIDTH) - badgeW - 10;
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

                        // 4. 绘制包裹“考点卡 + 题目 + 作答区”的圆角虚线框
                        try {
                            const boxSvgPath = getRetestBoxSvgPath(BOX_WIDTH, boxH, 8);
                            currentPage.drawSvgPath(boxSvgPath, {
                                x: BOX_MARGIN_X,
                                y: boxTopY,
                                borderColor: PDFLib.rgb(0.70, 0.74, 0.80),
                                borderWidth: 0.9,
                                borderDashArray: [4, 3]
                            });
                        } catch (boxErr) {
                            console.warn('Draw question box failed:', boxErr);
                        }

                        // 为下一题预留纵向间距
                        currentY = boxBottomY - BOX_GAP;
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

            modalTitle.textContent = '合成完毕！';
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
                showToast('已复制页面链接！可粘贴至外部浏览器打开');
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
            showToast('已复制页面链接！可粘贴至外部浏览器打开');
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
                showToast('已复制文件下载直链！可在浏览器粘贴下载');
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

    // Show Toast Notification
    let toastTimer = null;
    function showToast(msg) {
        const toast = document.getElementById('toast');
        const text = document.getElementById('toast-text');
        text.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
