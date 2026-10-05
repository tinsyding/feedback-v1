/**
 * Admin 系统全局配置模块 (Tab 1: loadConfig, saveConfig, setSeason)
 */

        /* ========================================================
           TAB 1: System Config Logic
           ======================================================== */
        let currentConfig = {};
        let currentSeason = 'autumn';

        const SEASON_CONFIG = {
            spring: { label: '春', shortLabel: '春', text: '春', unit: '周', defaultWeeks: 18, isVacation: false },
            summer: { label: '暑', shortLabel: '暑', text: '暑', unit: '讲', defaultWeeks: 12, isVacation: true },
            autumn: { label: '秋', shortLabel: '秋', text: '秋', unit: '周', defaultWeeks: 18, isVacation: false },
            winter: { label: '寒', shortLabel: '寒', text: '寒', unit: '讲', defaultWeeks: 8, isVacation: true }
        };

        function normalizeSeason(val) {
            if (val === 'spring' || val === '春' || val === 1) return 'spring';
            if (val === 'summer' || val === '暑') return 'summer';
            if (val === 'autumn' || val === '秋') return 'autumn';
            if (val === 'winter' || val === '寒' || val === 0) return 'winter';
            return 'autumn';
        }

        async function loadConfig() {
            try {
                const response = await fetch(`${API_BASE}?action=config`);
                const result = await response.json();
                if (result.success) {
                    currentConfig = result.data;
                    updateConfigUI();
                }
            } catch (err) {
                console.error('加载配置失败:', err);
            }
        }

        function updateRetestQrToggleLabel(enabled) {
            const badge = document.getElementById('retest-qrcode-status-badge');
            if (badge) {
                if (enabled) {
                    badge.textContent = '开启状态';
                    badge.style.background = 'rgba(16, 185, 129, 0.15)';
                    badge.style.color = '#10b981';
                    badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                } else {
                    badge.textContent = '已关闭';
                    badge.style.background = 'rgba(239, 68, 68, 0.12)';
                    badge.style.color = '#ef4444';
                    badge.style.borderColor = 'rgba(239, 68, 68, 0.25)';
                }
            }
        }

        async function onRetestQrToggleChange() {
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            const isChecked = qrToggle ? qrToggle.checked : true;
            updateRetestQrToggleLabel(isChecked);
            // 实时自动保存并弹窗提示
            await saveConfig(true);
        }

        function updateConfigUI() {
            currentSeason = normalizeSeason(currentConfig.defaultSeason ?? 'autumn');
            const year = parseInt(currentConfig.semesterYear) || 2026;
            const weeks = parseInt(currentConfig.semesterWeeks) || (SEASON_CONFIG[currentSeason]?.defaultWeeks || 14);

            const yearInput = document.getElementById('semester-year');
            if (yearInput) yearInput.value = year;

            const weeksInput = document.getElementById('semester-weeks');
            if (weeksInput) weeksInput.value = weeks;

            // 二维码讲解开关
            const qrEnabled = currentConfig.retestQrCodeEnabled !== false;
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            if (qrToggle) {
                qrToggle.checked = qrEnabled;
                updateRetestQrToggleLabel(qrEnabled);
            }

            ['spring', 'summer', 'autumn', 'winter'].forEach(s => {
                const card = document.getElementById(`season-${s}`);
                if (card) card.classList.toggle('active', currentSeason === s);
            });

            updateOverviewText();
        }

        function setSeason(seasonKey) {
            currentSeason = normalizeSeason(seasonKey);
            const meta = SEASON_CONFIG[currentSeason] || SEASON_CONFIG.spring;
            ['spring', 'summer', 'autumn', 'winter'].forEach(s => {
                const card = document.getElementById(`season-${s}`);
                if (card) card.classList.toggle('active', currentSeason === s);
            });
            const weeksInput = document.getElementById('semester-weeks');
            if (weeksInput && meta.defaultWeeks) {
                weeksInput.value = meta.defaultWeeks;
            }
            updateOverviewText();
        }

        function updateOverviewText() {
            const meta = SEASON_CONFIG[currentSeason] || SEASON_CONFIG.spring;
            const year = document.getElementById('semester-year')?.value || 2026;
            const weeks = document.getElementById('semester-weeks')?.value || 14;

            // Update Hero Card
            const envText = document.getElementById('info-env-text');
            if (envText) envText.textContent = `${year} 年 · ${meta.label}`;

            const metricYear = document.getElementById('hero-metric-year');
            if (metricYear) metricYear.textContent = `${year} 年`;

            const metricSeason = document.getElementById('hero-metric-season');
            if (metricSeason) metricSeason.textContent = meta.label;

            const metricWeeks = document.getElementById('hero-metric-weeks');
            if (metricWeeks) metricWeeks.textContent = `${weeks} ${meta.unit}`;

            const suffix = document.getElementById('weeks-unit-suffix');
            if (suffix) suffix.textContent = meta.unit;
        }

        async function saveConfig(isSilent = false) {
            const year = parseInt(document.getElementById('semester-year').value) || 2026;
            const weeks = parseInt(document.getElementById('semester-weeks').value) || 14;
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            const qrEnabled = qrToggle ? qrToggle.checked : true;
            const statusEl = document.getElementById('save-status');

            const config = {
                semesterYear: year,
                defaultSeason: currentSeason,
                semesterWeeks: weeks,
                forceIntegerScores: true,
                retestQrCodeEnabled: qrEnabled
            };
            if (currentConfig && currentConfig.retestQuestionSpacing) {
                config.retestQuestionSpacing = currentConfig.retestQuestionSpacing;
            }

            if (statusEl) {
                statusEl.innerHTML = '<span class="spinner"></span> 保存中...';
                statusEl.className = 'save-status saving show';
            }

            try {
                const response = await fetch(`${API_BASE}?action=config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                const result = await response.json();
                if (result.success) {
                    currentConfig = result.data.config;
                    const toastMsg = isSilent
                        ? (qrEnabled ? '已成功开启题目视频讲解二维码（下载 PDF 将附带二维码）' : '已成功关闭题目视频讲解二维码（下载 PDF 将无二维码）')
                        : '系统全局配置已成功保存并实时生效！';
                    showToast(toastMsg, 'success');
                    if (statusEl) {
                        statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><polyline points="20 6 9 17 4 12"></polyline></svg> 保存成功';
                        statusEl.className = 'save-status success show';
                        setTimeout(() => {
                            statusEl.textContent = '';
                            statusEl.className = 'save-status';
                        }, 2000);
                    }
                } else {
                    showToast(result.error || '保存失败', 'error');
                    if (statusEl) {
                        statusEl.textContent = result.error || '保存失败';
                        statusEl.className = 'save-status error show';
                    }
                }
            } catch (err) {
                showToast('网络连接超时或服务器异常', 'error');
                if (statusEl) {
                    statusEl.textContent = '网络错误';
                    statusEl.className = 'save-status error show';
                }
            }
        }

