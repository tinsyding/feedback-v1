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
            const msg = isChecked
                ? '已成功开启题目视频讲解二维码（下载 PDF 将附带二维码）'
                : '已成功关闭题目视频讲解二维码（下载 PDF 将无二维码）';
            await saveConfig(true, msg);
        }

        function updateSenderFlashToggleLabel(enabled) {
            const badge = document.getElementById('sender-flash-status-badge');
            if (badge) {
                if (enabled) {
                    badge.textContent = '云端 Flash 开启';
                    badge.style.background = 'rgba(16, 185, 129, 0.15)';
                    badge.style.color = '#10b981';
                    badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                } else {
                    badge.textContent = '已禁用 · 强制本地 OCR';
                    badge.style.background = 'rgba(245, 158, 11, 0.15)';
                    badge.style.color = '#f59e0b';
                    badge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
                }
            }
        }

        async function onSenderFlashToggleChange() {
            const flashToggle = document.getElementById('sender-flash-toggle');
            const isChecked = flashToggle ? flashToggle.checked : true;
            updateSenderFlashToggleLabel(isChecked);
            const msg = isChecked
                ? '已开启云端 Qwen3.8-Flash 标题核验（客户端将优先云端秒验）'
                : '已停用云端 Qwen-Flash，已强制所有客户端使用本地离线极速 OCR（免 Token 消耗）';
            await saveConfig(true, msg);
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

            // Qwen3.8-Flash 标题核验开关 (disableQwenFlashTitle 为 true 代表关闭)
            const flashEnabled = currentConfig.disableQwenFlashTitle !== true;
            const flashToggle = document.getElementById('sender-flash-toggle');
            if (flashToggle) {
                flashToggle.checked = flashEnabled;
                updateSenderFlashToggleLabel(flashEnabled);
            }

            // 大模型配置回显
            const apiKeyInput = document.getElementById('ai-api-key');
            if (apiKeyInput) apiKeyInput.value = currentConfig.dashscopeApiKey || '';

            const apiBaseInput = document.getElementById('ai-api-base');
            if (apiBaseInput) apiBaseInput.value = currentConfig.identifyApiBase || '';

            const modelInput = document.getElementById('ai-model');
            if (modelInput) modelInput.value = currentConfig.identifyModel || '';

            const fastModelInput = document.getElementById('ai-fast-model');
            if (fastModelInput) fastModelInput.value = currentConfig.identifyFastModel || '';

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

        async function saveConfig(isSilent = false, customSilentMsg = '') {
            const year = parseInt(document.getElementById('semester-year').value) || 2026;
            const weeks = parseInt(document.getElementById('semester-weeks').value) || 14;
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            const qrEnabled = qrToggle ? qrToggle.checked : true;
            const flashToggle = document.getElementById('sender-flash-toggle');
            const flashEnabled = flashToggle ? flashToggle.checked : true;
            const statusEl = document.getElementById('save-status');

            const config = {
                semesterYear: year,
                defaultSeason: currentSeason,
                semesterWeeks: weeks,
                forceIntegerScores: true,
                retestQrCodeEnabled: qrEnabled,
                disableQwenFlashTitle: !flashEnabled
            };

            const apiKeyInput = document.getElementById('ai-api-key');
            const apiBaseInput = document.getElementById('ai-api-base');
            const modelInput = document.getElementById('ai-model');
            const fastModelInput = document.getElementById('ai-fast-model');

            if (apiKeyInput) config.dashscopeApiKey = apiKeyInput.value.trim();
            if (apiBaseInput) config.identifyApiBase = apiBaseInput.value.trim();
            if (modelInput) config.identifyModel = modelInput.value.trim();
            if (fastModelInput) config.identifyFastModel = fastModelInput.value.trim();

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
                        ? (customSilentMsg || '系统配置已更新生效')
                        : '系统全局配置已成功保存并实时生效';
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

        function toggleApiKeyVisibility() {
            const input = document.getElementById('ai-api-key');
            const eye = document.getElementById('ai-key-eye-icon');
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                if (eye) {
                    eye.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
                }
            } else {
                input.type = 'password';
                if (eye) {
                    eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
                }
            }
        }

        async function testAiConnection() {
            const btn = document.getElementById('ai-test-btn');
            const resultBox = document.getElementById('ai-test-result');
            const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
            const baseUrl = document.getElementById('ai-api-base')?.value.trim() || '';
            const model = document.getElementById('ai-model')?.value.trim() || '';

            if (!apiKey && !(currentConfig && currentConfig.dashscopeApiKey)) {
                showToast('请先输入 API Key 再进行连通性测试', 'warning');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> 正在测试连通性...';
            }
            if (resultBox) {
                resultBox.style.display = 'block';
                resultBox.innerHTML = '<div style="font-size: 0.82rem; color: var(--text-secondary); padding: 8px 12px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-color);"><span class="spinner"></span> 正在连接 AI 端点测试...</div>';
            }

            try {
                const resp = await fetch(`${API_BASE}?action=test_ai_config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: apiKey,
                        base_url: baseUrl,
                        model: model
                    })
                });
                const result = await resp.json();
                if (result.success) {
                    const data = result.data || {};
                    showToast(`API 连通成功，延迟: ${data.duration_ms}ms`, 'success');
                    if (resultBox) {
                        resultBox.innerHTML = `
                            <div style="background: rgba(76, 195, 138, 0.1); border: 1px solid rgba(76, 195, 138, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                                    <span style="font-weight: 500; color: var(--positive, #16a34a);">连通成功 (HTTP ${data.http_code || 200})</span>
                                    <span style="color: var(--positive, #16a34a); font-family: var(--font-mono, monospace);">耗时: ${data.duration_ms} ms</span>
                                </div>
                                <div style="color: var(--text-secondary); font-size: 0.8rem;">
                                    <strong>测试模型:</strong> <code>${escapeHtml(data.model || model || 'qwen3.8-max')}</code>
                                    ${data.reply ? ` | <strong>回复:</strong> ${escapeHtml(data.reply)}` : ''}
                                </div>
                            </div>
                        `;
                    }
                } else {
                    const errDetail = result.data?.error || result.error || '连通失败';
                    const duration = result.data?.duration_ms ? ` (耗时 ${result.data.duration_ms}ms)` : '';
                    showToast('连通失败: ' + errDetail, 'error');
                    if (resultBox) {
                        resultBox.innerHTML = `
                            <div style="background: rgba(229, 72, 77, 0.1); border: 1px solid rgba(229, 72, 77, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                                <div style="font-weight: 500; color: var(--negative, #dc2626); margin-bottom: 4px;">连通失败${duration}</div>
                                <div style="color: var(--negative, #dc2626); font-size: 0.8rem; word-break: break-all;">${escapeHtml(errDetail)}</div>
                            </div>
                        `;
                    }
                }
            } catch (err) {
                showToast('请求异常: ' + err.message, 'error');
                if (resultBox) {
                    resultBox.innerHTML = `
                        <div style="background: rgba(229, 72, 77, 0.1); border: 1px solid rgba(229, 72, 77, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                            <div style="font-weight: 500; color: var(--negative, #dc2626); margin-bottom: 4px;">网络异常</div>
                            <div style="color: var(--negative, #dc2626); font-size: 0.8rem;">${escapeHtml(err.message)}</div>
                        </div>
                    `;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                        </svg>
                        <span>测试 API 连通性</span>
                    `;
                }
            }
        }

        window.onRetestQrToggleChange = onRetestQrToggleChange;
        window.onSenderFlashToggleChange = onSenderFlashToggleChange;
        window.toggleApiKeyVisibility = toggleApiKeyVisibility;
        window.testAiConnection = testAiConnection;

