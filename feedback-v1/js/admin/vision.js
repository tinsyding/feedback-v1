/**
 * Admin 视觉大模型与防误发提示词配置模块 (vision.js)
 */

/* ========================================================
   VISION MODEL & PROMPT CONFIG LOGIC
   ======================================================== */
let currentVisionConfig = {};

async function loadVisionConfig() {
    const statusEl = document.getElementById('vision-save-status');
    try {
        const response = await fetch(`${API_BASE}?action=vision_config`);
        const result = await response.json();
        if (result.success && result.data) {
            currentVisionConfig = result.data;
            updateVisionConfigUI();
        } else {
            console.error('加载视觉模型配置失败:', result.error);
        }
    } catch (err) {
        console.error('加载视觉模型配置网络异常:', err);
    }
}

function updateVisionConfigUI() {
    const baseUrlInput = document.getElementById('vision-base-url');
    if (baseUrlInput) baseUrlInput.value = currentVisionConfig.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

    const modelInput = document.getElementById('vision-model');
    if (modelInput) modelInput.value = currentVisionConfig.model || 'qwen3.8-flash';

    const keyInput = document.getElementById('vision-api-key');
    if (keyInput) {
        keyInput.value = '';
        if (currentVisionConfig.has_api_key && currentVisionConfig.api_key) {
            keyInput.placeholder = `已配置: ${currentVisionConfig.api_key} (留空则保持不变)`;
        } else {
            keyInput.placeholder = '请输入您的 API Key (如 sk-...)';
        }
    }

    const promptDropText = document.getElementById('vision-prompt-dropdown');
    if (promptDropText) promptDropText.value = currentVisionConfig.prompt_dropdown || '';

    const promptHeadText = document.getElementById('vision-prompt-header');
    if (promptHeadText) promptHeadText.value = currentVisionConfig.prompt_header || '';

    // 更新侧边栏徽章状态
    const navBadge = document.getElementById('nav-vision-badge');
    if (navBadge) {
        if (currentVisionConfig.has_api_key) {
            navBadge.textContent = '已就绪';
            navBadge.style.color = '#10b981';
            navBadge.style.background = 'rgba(16, 185, 129, 0.15)';
        } else {
            navBadge.textContent = '待配置';
            navBadge.style.color = '#ef4444';
            navBadge.style.background = 'rgba(239, 68, 68, 0.15)';
        }
    }

    // 快捷按钮高亮匹配
    updatePresetButtons(currentVisionConfig.model);
}

function updatePresetButtons(currentModel) {
    const presets = document.querySelectorAll('.model-preset-pill');
    presets.forEach(p => {
        const m = p.getAttribute('data-model');
        if (m === currentModel) {
            p.classList.add('active');
        } else {
            p.classList.remove('active');
        }
    });
}

function setVisionModelPreset(modelName) {
    const modelInput = document.getElementById('vision-model');
    if (modelInput) {
        modelInput.value = modelName;
        updatePresetButtons(modelName);
    }
}

function toggleVisionApiKeyVisibility() {
    const keyInput = document.getElementById('vision-api-key');
    const eyeIcon = document.getElementById('vision-api-key-eye');
    if (!keyInput) return;
    if (keyInput.type === 'password') {
        keyInput.type = 'text';
        if (eyeIcon) eyeIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
    } else {
        keyInput.type = 'password';
        if (eyeIcon) eyeIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    }
}

function resetVisionPrompt(task) {
    if (task === 'dropdown') {
        const dropEl = document.getElementById('vision-prompt-dropdown');
        if (dropEl && currentVisionConfig.default_prompt_dropdown) {
            dropEl.value = currentVisionConfig.default_prompt_dropdown;
            showToast('已重置为第一道防线（下拉选人）官方默认提示词', 'info');
        }
    } else if (task === 'header') {
        const headEl = document.getElementById('vision-prompt-header');
        if (headEl && currentVisionConfig.default_prompt_header) {
            headEl.value = currentVisionConfig.default_prompt_header;
            showToast('已重置为第二道防线（会话标题）官方默认提示词', 'info');
        }
    }
}

async function saveVisionConfig() {
    const baseUrl = document.getElementById('vision-base-url')?.value.trim() || '';
    const model = document.getElementById('vision-model')?.value.trim() || '';
    const apiKey = document.getElementById('vision-api-key')?.value.trim() || '';
    const promptDrop = document.getElementById('vision-prompt-dropdown')?.value.trim() || '';
    const promptHead = document.getElementById('vision-prompt-header')?.value.trim() || '';
    const statusEl = document.getElementById('vision-save-status');

    if (!baseUrl) {
        showToast('API 端点不能为空', 'error');
        return;
    }
    if (!model) {
        showToast('模型名称不能为空', 'error');
        return;
    }

    const payload = {
        base_url: baseUrl,
        model: model,
        prompt_dropdown: promptDrop,
        prompt_header: promptHead
    };
    if (apiKey) {
        payload.api_key = apiKey;
    }

    if (statusEl) {
        statusEl.innerHTML = '<span class="spinner"></span> 保存中...';
        statusEl.className = 'save-status saving show';
    }

    try {
        const response = await fetch(`${API_BASE}?action=vision_config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (result.success) {
            currentVisionConfig = Object.assign(currentVisionConfig, result.data);
            updateVisionConfigUI();
            showToast('视觉大模型与提示词配置已成功保存！', 'success');
            if (statusEl) {
                statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><polyline points="20 6 9 17 4 12"></polyline></svg> 保存成功';
                statusEl.className = 'save-status success show';
                setTimeout(() => {
                    statusEl.textContent = '';
                    statusEl.className = 'save-status';
                }, 2500);
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

async function testVisionConnection() {
    const testBtn = document.getElementById('vision-test-btn');
    const resultBox = document.getElementById('vision-test-result');
    const baseUrl = document.getElementById('vision-base-url')?.value.trim() || '';
    const model = document.getElementById('vision-model')?.value.trim() || '';
    const apiKey = document.getElementById('vision-api-key')?.value.trim() || '';

    if (testBtn) {
        testBtn.disabled = true;
        testBtn.innerHTML = '<span class="spinner"></span> 正在探测连通性...';
    }
    if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.88rem;">正在向模型端点发送极小测试图像切片，请稍候...</div>';
    }

    try {
        const response = await fetch(`${API_BASE}?action=test_vision_config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_url: baseUrl,
                model: model,
                api_key: apiKey
            })
        });
        const result = await response.json();
        if (result.success) {
            const data = result.data || {};
            showToast(`✓ API 连通成功！延迟: ${data.duration_ms}ms`, 'success');
            if (resultBox) {
                resultBox.innerHTML = `
                    <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-sm); padding: 12px 14px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                            <span style="font-weight: 600; color: #10b981;">✓ 连通成功 (HTTP ${data.http_code || 200})</span>
                            <span style="font-size: 0.82rem; color: #10b981; font-weight: 600;">耗时: ${data.duration_ms} ms</span>
                        </div>
                        <div style="font-size: 0.84rem; color: var(--text-secondary); margin-bottom: 4px;"><strong>模型:</strong> ${data.model}</div>
                        <div style="font-size: 0.82rem; color: var(--text-tertiary); font-family: monospace; word-break: break-all;"><strong>响应内容:</strong> ${escapeHtml(data.reply || '')}</div>
                    </div>
                `;
            }
        } else {
            showToast(result.error || '连通失败', 'error');
            if (resultBox) {
                const errDetail = result.data?.error || result.error || '未知网络异常';
                resultBox.innerHTML = `
                    <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-sm); padding: 12px 14px;">
                        <div style="font-weight: 600; color: #ef4444; margin-bottom: 4px;">✗ 连通失败</div>
                        <div style="font-size: 0.84rem; color: #ef4444; word-break: break-all;">${escapeHtml(errDetail)}</div>
                    </div>
                `;
            }
        }
    } catch (err) {
        showToast('探测请求超时或网络异常: ' + err.message, 'error');
        if (resultBox) {
            resultBox.innerHTML = `
                <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-sm); padding: 12px 14px;">
                    <div style="font-weight: 600; color: #ef4444; margin-bottom: 4px;">✗ 请求发送失败</div>
                    <div style="font-size: 0.84rem; color: #ef4444;">${escapeHtml(err.message)}</div>
                </div>
            `;
        }
    } finally {
        if (testBtn) {
            testBtn.disabled = false;
            testBtn.innerHTML = '🧪 测试 API 连通性';
        }
    }
}

window.loadVisionConfig = loadVisionConfig;
window.saveVisionConfig = saveVisionConfig;
window.testVisionConnection = testVisionConnection;
window.resetVisionPrompt = resetVisionPrompt;
window.setVisionModelPreset = setVisionModelPreset;
window.toggleVisionApiKeyVisibility = toggleVisionApiKeyVisibility;
