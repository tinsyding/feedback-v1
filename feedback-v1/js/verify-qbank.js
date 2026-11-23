/**
 * 题库配置存证公开核验逻辑 (verify-qbank.js)
 * 支持：在线回执核验 + 浏览器原生 crypto.subtle Ed25519 / SHA-256 独立重验 + 离线 .json 凭证验真
 */
(function () {
    'use strict';

    const VERIFY_API = 'api/v1/qbank/verify';
    const JWKS_URL = '/.well-known/jwks.json';

    const BANK_TYPE_LABELS = {
        homework: '课后巩固',
        preview: '预习',
        variation: '课后举一反三'
    };

    const ACTION_LABELS = {
        create: '初次创建',
        update: '更新保存',
        tier_sync: '班层批量同步',
        delete: '教师删除',
        admin_edit: '后台编辑',
        admin_delete: '后台删除',
        admin_rollback: '后台回滚'
    };

    const STATUS_META = {
        VALID: {
            cls: 'valid',
            pill: 'VALID · 有效最新版本',
            title: '核验通过 · 当前有效版本',
            desc: '该题库配置已在系统存证生效，且当前仍是对应教学专题的最新版本。'
        },
        SUPERSEDED: {
            cls: 'superseded',
            pill: 'SUPERSEDED · 已被覆盖',
            title: '历史存证 · 已被后续版本覆盖',
            desc: '该回执对应配置曾真实存在并完成存证，但之后已被更新版本替代，请以最新生效版本为准。'
        },
        DELETED: {
            cls: 'deleted',
            pill: 'DELETED · 已被删除',
            title: '历史存证 · 该配置已被删除',
            desc: '该回执对应题库配置曾真实存证，现已被删除，下方保留删除人与删除时间的不可抵赖存证。'
        },
        NOT_FOUND: {
            cls: 'not-found',
            pill: 'NOT_FOUND · 查无记录',
            title: '系统查无此回执编号',
            desc: '存证台账中未检索到该回执编号，请核对编号拼写是否完整，或切换「离线凭证验真」校验本地 .json 文件。'
        }
    };

    const state = {
        mode: 'online',
        jwksKeys: [],
        jwksLoaded: false,
        jwksError: '',
        offlineKeySource: 'jwks',
        lastOnlineCode: '',
        lastOnlineBundle: null,
        lastOfflineBundle: null
    };

    /* ======================================================================
       Utilities & Safe Escaping
       ====================================================================== */
    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>'"]/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[ch] || ch));
    }

    function showToast(message, type = 'info', duration = 2600) {
        if (!message) return;
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            container.setAttribute('popover', 'manual');
            document.body.appendChild(container);
        }
        if (window.DialogHelper && typeof window.DialogHelper.promoteToast === 'function') {
            window.DialogHelper.promoteToast(container);
        }
        while (container.children.length >= 4) {
            container.firstElementChild.remove();
        }
        const norm = type === 'warn' ? 'warning' : (['success', 'error', 'warning', 'info'].includes(type) ? type : 'info');
        const icons = {
            success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };
        const toast = document.createElement('div');
        toast.className = `toast-item ${norm}`;
        toast.innerHTML = `${icons[norm]}<div class="toast-content">${escapeHtml(message)}</div>`;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        let timer = null;
        const dismiss = () => {
            if (!toast.parentNode) return;
            if (timer) clearTimeout(timer);
            toast.classList.remove('show');
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
        };
        toast.addEventListener('click', dismiss);
        timer = setTimeout(dismiss, duration);
    }

    async function copyText(text, successMsg = '已复制到剪贴板') {
        const val = String(text ?? '');
        if (!val) return;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(val);
                showToast(successMsg, 'success');
                return;
            }
        } catch (_) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = val;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast(successMsg, 'success');
        } catch (_) {
            showToast('复制失败，请手动选中复制', 'error');
        }
    }

    function downloadJsonFile(filename, dataObj) {
        const jsonStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function extractReceiptCode(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        try {
            if (/^https?:\/\//i.test(s) || s.includes('code=')) {
                const u = new URL(s, window.location.origin);
                const c = u.searchParams.get('code');
                if (c) return c.trim().toUpperCase();
            }
        } catch (_) {
            const m = s.match(/[?&]code=([^&#\s]+)/i);
            if (m && m[1]) return decodeURIComponent(m[1]).trim().toUpperCase();
        }
        return s.toUpperCase();
    }

    function getUnitForSeason(season) {
        return (season === '暑' || season === '寒' || season === 'summer' || season === 'winter') ? '讲' : '周';
    }

    function formatBankType(bt) {
        return BANK_TYPE_LABELS[bt] || bt || '-';
    }

    function formatAction(act) {
        return ACTION_LABELS[act] || act || '-';
    }

    function formatOperator(opObj, usernameFallback, nameFallback) {
        const username = opObj?.username ?? usernameFallback ?? '';
        const realName = opObj?.real_name ?? nameFallback ?? '';
        if (realName && username && realName !== username) {
            return `${realName} (${username})`;
        }
        return realName || username || '-';
    }

    function getVerifyUrl(receiptCode, rawVerifyUrl) {
        if (receiptCode) {
            return `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(receiptCode)}`;
        }
        if (rawVerifyUrl && /^https?:\/\//i.test(rawVerifyUrl)) return rawVerifyUrl;
        return window.location.href;
    }

    /* ======================================================================
       WebCrypto Helpers (Ed25519 + SHA-256)
       ====================================================================== */
    function decodeBase64UrlToBytes(b64u) {
        const cleaned = String(b64u || '').trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
        if (!cleaned) return new Uint8Array(0);
        const padLen = (4 - (cleaned.length % 4)) % 4;
        const padded = cleaned + '='.repeat(padLen);
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
        }
        return out;
    }

    function bytesToHex(buf) {
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    async function computeSha256Hex(str) {
        if (!window.crypto || !window.crypto.subtle) return null;
        const bytes = new TextEncoder().encode(str);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return bytesToHex(digest);
    }

    function parseCanonicalJsonSafe(canonicalPayload) {
        if (typeof canonicalPayload !== 'string' || !canonicalPayload.trim()) return null;
        try {
            const obj = JSON.parse(canonicalPayload);
            return (obj && typeof obj === 'object') ? obj : null;
        } catch (_) {
            return null;
        }
    }

    function checkReceiptCanonicalConsistency(receipt, canonicalObj) {
        if (!canonicalObj) {
            return { ok: false, reason: 'canonical_payload 缺失或非合法 JSON' };
        }
        const mismatches = [];
        if (receipt.receipt_code && canonicalObj.receipt_code && receipt.receipt_code !== canonicalObj.receipt_code) {
            mismatches.push('receipt_code');
        }
        if (receipt.action && canonicalObj.action && receipt.action !== canonicalObj.action) {
            mismatches.push('action');
        }
        if (receipt.content_sha256 && canonicalObj.content_sha256 && receipt.content_sha256.toLowerCase() !== String(canonicalObj.content_sha256).toLowerCase()) {
            mismatches.push('content_sha256');
        }
        const issued = receipt.issued_at || receipt.issued_at_utc || '';
        if (issued && canonicalObj.issued_at && issued !== canonicalObj.issued_at) {
            mismatches.push('issued_at');
        }
        if (receipt.revision_no !== undefined && receipt.revision_no !== null && canonicalObj.revision_no !== undefined && canonicalObj.revision_no !== null && Number(receipt.revision_no) !== Number(canonicalObj.revision_no)) {
            mismatches.push('revision_no');
        }
        if (receipt.scope && canonicalObj.scope) {
            for (const dim of ['bank_type', 'year', 'season', 'subject', 'grade', 'tier', 'week']) {
                const rv = receipt.scope[dim];
                const cv = canonicalObj.scope[dim];
                if (rv !== undefined && rv !== null && rv !== '' && cv !== undefined && cv !== null && cv !== '' && String(rv) !== String(cv)) {
                    mismatches.push(`scope.${dim}`);
                }
            }
        }
        if (receipt.summary && canonicalObj.summary) {
            if (receipt.summary.question_count !== undefined && canonicalObj.summary.question_count !== undefined && Number(receipt.summary.question_count) !== Number(canonicalObj.summary.question_count)) {
                mismatches.push('summary.question_count');
            }
            if (Array.isArray(receipt.summary.topics) && receipt.summary.topics.length > 0 && Array.isArray(canonicalObj.summary.topics) && canonicalObj.summary.topics.length > 0) {
                if (receipt.summary.topics.length !== canonicalObj.summary.topics.length) {
                    mismatches.push('summary.topics.length');
                } else {
                    for (let i = 0; i < receipt.summary.topics.length; i++) {
                        const rt = receipt.summary.topics[i] || {};
                        const ct = canonicalObj.summary.topics[i] || {};
                        if (Number(rt.q_num) !== Number(ct.q_num) || String(rt.topic || '') !== String(ct.topic || '') || String(rt.exercise_sha256_short || '') !== String(ct.exercise_sha256_short || '') || String(rt.answer_sha256_short || '') !== String(ct.answer_sha256_short || '')) {
                            mismatches.push(`summary.topics[${i}]`);
                            break;
                        }
                    }
                }
            }
        }
        if (mismatches.length > 0) {
            return { ok: false, reason: `展示字段与 canonical_payload 不一致: ${mismatches.join(', ')}` };
        }
        return { ok: true, reason: '展示字段与被签名规范负载完全一致' };
    }

    async function verifyEntryHashLocally(receipt, canonicalObj) {
        const entryHash = String(receipt?.entry_hash || '').trim().toLowerCase();
        if (!entryHash) {
            return { checked: false, valid: null, reason: '凭证未提供 entry_hash' };
        }
        if (!window.crypto || !window.crypto.subtle) {
            return { checked: false, valid: null, reason: '当前环境不支持 WebCrypto SHA-256' };
        }
        const prev = String(receipt.prev_entry_hash ?? canonicalObj?.prev_entry_hash ?? '');
        const code = String(receipt.receipt_code ?? canonicalObj?.receipt_code ?? '');
        const contentSha = String(receipt.content_sha256 ?? canonicalObj?.content_sha256 ?? '');
        const issuedAt = String(receipt.issued_at ?? receipt.issued_at_utc ?? canonicalObj?.issued_at ?? '');
        if (!code || !contentSha || !issuedAt) {
            return { checked: false, valid: null, reason: '缺少计算 entry_hash 所需的字段' };
        }
        const preimage = `${prev}\n${code}\n${contentSha}\n${issuedAt}`;
        const computed = await computeSha256Hex(preimage);
        if (!computed) {
            return { checked: false, valid: null, reason: '浏览器无法计算 SHA-256' };
        }
        const valid = computed === entryHash;
        return {
            checked: true,
            valid,
            computed,
            reason: valid ? 'SHA-256(prev + code + content_sha256 + issued_at) 精确匹配' : `本地计算的哈希 ${computed.slice(0, 12)}... 与回执 entry_hash 不匹配`
        };
    }

    async function verifyEd25519InBrowser(jwk, canonicalPayload, sigBase64Url) {
        if (!canonicalPayload || !sigBase64Url) {
            return { supported: true, valid: false, reason: '缺少 canonical_payload 或 signature' };
        }
        if (!jwk || typeof jwk !== 'object') {
            return { supported: true, valid: false, reason: '未找到匹配的验签公钥 (JWK)' };
        }
        if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
            return { supported: true, valid: false, reason: '公钥 JWK 格式无效（须为 kty:"OKP", crv:"Ed25519", x）' };
        }
        if (jwk.alg && jwk.alg !== 'EdDSA' && jwk.alg !== 'Ed25519') {
            return { supported: true, valid: false, reason: `不支持的 JWK 算法标识: ${jwk.alg}` };
        }

        let xBytes;
        let sigBytes;
        try {
            xBytes = decodeBase64UrlToBytes(jwk.x);
            sigBytes = decodeBase64UrlToBytes(sigBase64Url);
        } catch (err) {
            return { supported: true, valid: false, reason: '公钥或签名 Base64URL 解码失败' };
        }
        if (xBytes.length !== 32) {
            return { supported: true, valid: false, reason: `Ed25519 公钥长度错误 (${xBytes.length} 字节，应为 32 字节)` };
        }
        if (sigBytes.length !== 64) {
            return { supported: true, valid: false, reason: `Ed25519 签名长度错误 (${sigBytes.length} 字节，应为 64 字节)` };
        }

        if (typeof window.crypto === 'undefined' || !window.crypto.subtle) {
            return {
                supported: false,
                valid: null,
                reason: '当前浏览器环境不支持 WebCrypto（非 HTTPS 安全上下文或浏览器版本过旧），无法在本地执行独立验签。'
            };
        }

        try {
            const cleanJwk = { kty: 'OKP', crv: 'Ed25519', x: String(jwk.x).trim() };
            const cryptoKey = await window.crypto.subtle.importKey(
                'jwk',
                cleanJwk,
                { name: 'Ed25519' },
                false,
                ['verify']
            );
            const msgBytes = new TextEncoder().encode(canonicalPayload);
            const ok = await window.crypto.subtle.verify(
                { name: 'Ed25519' },
                cryptoKey,
                sigBytes,
                msgBytes
            );
            return {
                supported: true,
                valid: Boolean(ok),
                keyStatus: jwk.status || 'unknown',
                kid: jwk.kid || '',
                reason: ok
                    ? '浏览器原生 WebCrypto Ed25519 独立验签通过'
                    : 'Ed25519 签名验证失败：内容可能被篡改或公钥不匹配'
            };
        } catch (err) {
            const msg = String(err?.message || err || '');
            if (err?.name === 'NotSupportedError' || /Ed25519|OKP|not supported|unsupported|algorithm/i.test(msg)) {
                return {
                    supported: false,
                    valid: null,
                    reason: '当前浏览器不支持 WebCrypto Ed25519（需 Chrome 113+ / Safari 17+ / Firefox 129+ / Edge 113+）。'
                };
            }
            return {
                supported: true,
                valid: false,
                reason: `浏览器验签出错：${msg}`
            };
        }
    }

    /* ======================================================================
       JWKS Fetch & Inspector
       ====================================================================== */
    async function fetchJwks(force = false) {
        if (state.jwksLoaded && !force && state.jwksKeys.length > 0) {
            return state.jwksKeys;
        }
        const dot = document.getElementById('jwks-status-dot');
        const txt = document.getElementById('jwks-status-text');
        const offSummary = document.getElementById('offline-jwks-summary');
        try {
            const res = await fetch(JWKS_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const keys = Array.isArray(json?.keys) ? json.keys : [];
            state.jwksKeys = keys;
            state.jwksLoaded = true;
            state.jwksError = '';
            if (dot) dot.className = 'vq-jwks-dot ready';
            if (txt) txt.textContent = `公钥库 (${keys.length})`;
            if (offSummary) {
                const activeCnt = keys.filter((k) => !k.status || k.status === 'active').length;
                offSummary.textContent = keys.length > 0
                    ? `已加载 ${keys.length} 把公钥（其中 ${activeCnt} 把 active），将按凭证 kid 自动匹配`
                    : '服务端 JWKS 暂未返回公钥';
            }
            return keys;
        } catch (err) {
            state.jwksError = err?.message || '拉取失败';
            state.jwksLoaded = false;
            if (dot) dot.className = 'vq-jwks-dot error';
            if (txt) txt.textContent = '公钥库未就绪';
            if (offSummary) {
                offSummary.textContent = `拉取 /.well-known/jwks.json 失败 (${state.jwksError})，可切换手动粘贴 JWK 公钥`;
            }
            return [];
        }
    }

    function findJwkForKid(keys, kid) {
        if (!Array.isArray(keys) || keys.length === 0) return null;
        if (kid) {
            const exact = keys.find((k) => k && k.kid === kid);
            if (exact) return exact;
        }
        if (keys.length === 1 && !kid) return keys[0];
        return null;
    }

    function renderJwksModal() {
        const body = document.getElementById('jwks-modal-body');
        if (!body) return;
        if (state.jwksError) {
            body.innerHTML = `<div class="vq-state-desc">拉取公钥库失败：${escapeHtml(state.jwksError)}</div>`;
            return;
        }
        if (!state.jwksKeys.length) {
            body.innerHTML = '<div class="vq-state-desc">当前系统暂未注册公开验签公钥。</div>';
            return;
        }
        body.innerHTML = state.jwksKeys.map((k, idx) => {
            const st = k.status || 'active';
            const stCls = st === 'active' ? 'valid' : (st === 'revoked' ? 'deleted' : 'superseded');
            return `
                <div class="vq-jwk-card">
                    <div class="vq-jwk-head">
                        <span class="vq-mono" style="font-weight:600; font-size:0.86rem;">kid: ${escapeHtml(k.kid || '-')}</span>
                        <span class="vq-status-pill ${stCls}">${escapeHtml(st)}</span>
                    </div>
                    <div style="font-size:0.78rem; color:var(--text-secondary);">
                        算法：${escapeHtml(k.kty || 'OKP')} / ${escapeHtml(k.crv || 'Ed25519')} (${escapeHtml(k.alg || 'EdDSA')})
                        ${k.created_at ? ` · 注册时间：${escapeHtml(k.created_at)}` : ''}
                    </div>
                    <div class="vq-hash-row">
                        <div class="vq-hash-row-meta">
                            <div class="vq-hash-row-label">公钥 x (Base64URL)</div>
                            <div class="vq-hash-row-val">${escapeHtml(k.x || '-')}</div>
                        </div>
                        <button type="button" class="vq-btn sm secondary" data-copy-jwk-idx="${idx}">复制 JWK</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function openJwksModal() {
        const modal = document.getElementById('jwks-modal');
        if (!modal) return;
        renderJwksModal();
        if (window.DialogHelper) {
            window.DialogHelper.open(modal, { dismissible: true });
        } else {
            modal.style.display = 'flex';
        }
    }

    function closeJwksModal() {
        const modal = document.getElementById('jwks-modal');
        if (!modal) return;
        if (window.DialogHelper) {
            window.DialogHelper.close(modal);
        } else {
            modal.style.display = 'none';
        }
    }

    /* ======================================================================
       Shared Receipt & Verification Detail Renderer
       ====================================================================== */
    function renderScopeAndMetaCard(receipt, options = {}) {
        const scope = receipt.scope || {};
        const unit = getUnitForSeason(scope.season);
        const revLabel = receipt.revision_no ? `v${receipt.revision_no}` : '-';
        const actionLabel = formatAction(receipt.action);
        const opText = formatOperator(receipt.operator, receipt.operator_username, receipt.operator_name);
        const supersedesCode = receipt.supersedes || receipt.supersedes_receipt_code || '';
        const summary = receipt.summary || {};

        return `
            <div class="vq-card">
                <h2 class="vq-card-heading">
                    <span>配置范围与存证元数据</span>
                    <span class="vq-code-chip">${escapeHtml(revLabel)} · ${escapeHtml(actionLabel)}</span>
                </h2>
                <div class="vq-tags-row">
                    <span class="vq-dim-tag accent"><span class="k">学科</span>${escapeHtml(scope.subject || '-')}</span>
                    <span class="vq-dim-tag"><span class="k">类型</span>${escapeHtml(formatBankType(scope.bank_type))}</span>
                    <span class="vq-dim-tag"><span class="k">学期</span>${escapeHtml(scope.year || '-')}年 · ${escapeHtml(scope.season || '-')}</span>
                    <span class="vq-dim-tag"><span class="k">年级</span>${escapeHtml(scope.grade || '-')}</span>
                    <span class="vq-dim-tag"><span class="k">班层</span>${escapeHtml(scope.tier || '-')}</span>
                    <span class="vq-dim-tag"><span class="k">专题</span>第 ${escapeHtml(scope.week ?? '-')} ${unit}</span>
                </div>

                <div class="vq-kv-grid">
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">回执编号</div>
                        <div class="vq-kv-value vq-mono">${escapeHtml(receipt.receipt_code || '-')}</div>
                    </div>
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">操作教师</div>
                        <div class="vq-kv-value">${escapeHtml(opText)}</div>
                    </div>
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">服务器签发时间 (CST)</div>
                        <div class="vq-kv-value vq-mono">${escapeHtml(receipt.issued_at_cst || receipt.issued_at || '-')}</div>
                    </div>
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">前置覆盖版本</div>
                        <div class="vq-kv-value">
                            ${supersedesCode
                                ? (options.allowOnlineJump !== false
                                    ? `<button type="button" class="vq-code-link-btn" data-jump-code="${escapeHtml(supersedesCode)}">${escapeHtml(supersedesCode)}</button>`
                                    : `<span class="vq-mono">${escapeHtml(supersedesCode)}</span>`)
                                : '<span style="color:var(--text-muted);">无（初始版本）</span>'}
                        </div>
                    </div>
                </div>

                <div class="vq-stats-grid">
                    <div class="vq-stat-box">
                        <div class="vq-stat-val">${escapeHtml(summary.question_count ?? 0)}</div>
                        <div class="vq-stat-label">配置总题数</div>
                    </div>
                    <div class="vq-stat-box">
                        <div class="vq-stat-val">${escapeHtml(summary.exercise_pdf_count ?? 0)} / ${escapeHtml(summary.question_count ?? 0)}</div>
                        <div class="vq-stat-label">题目 PDF 覆盖</div>
                    </div>
                    <div class="vq-stat-box">
                        <div class="vq-stat-val">${escapeHtml(summary.answer_pdf_count ?? 0)} / ${escapeHtml(summary.question_count ?? 0)}</div>
                        <div class="vq-stat-label">答案 PDF 覆盖</div>
                    </div>
                    <div class="vq-stat-box">
                        <div class="vq-stat-val">${escapeHtml(summary.topic_filled_count ?? 0)} / ${escapeHtml(summary.question_count ?? 0)}</div>
                        <div class="vq-stat-label">知识点已填</div>
                    </div>
                </div>
            </div>
        `;
    }

    function renderMaskedTopicsCard(receipt) {
        const topics = Array.isArray(receipt?.summary?.topics) ? receipt.summary.topics : [];
        if (topics.length === 0) {
            return `
                <div class="vq-card">
                    <h2 class="vq-card-heading">逐题脱敏存证清单</h2>
                    <div class="vq-state-desc">该回执记录包含 0 道题目（例如清空或删除操作记录）。</div>
                </div>
            `;
        }
        const rowsHtml = topics.map((t) => {
            const exShort = t.exercise_sha256_short || (t.exercise_sha256 ? String(t.exercise_sha256).slice(0, 12) : '');
            const anShort = t.answer_sha256_short || (t.answer_sha256 ? String(t.answer_sha256).slice(0, 12) : '');
            return `
                <tr>
                    <td class="vq-mono" style="font-weight:600; width:72px;">第 ${escapeHtml(t.q_num ?? '-')} 题</td>
                    <td>${t.topic ? escapeHtml(t.topic) : '<span style="color:var(--text-muted);">未填写知识点</span>'}</td>
                    <td>${exShort ? `<span class="vq-hash-pill">${escapeHtml(exShort)}</span>` : '<span style="color:var(--text-muted);">-</span>'}</td>
                    <td>${anShort ? `<span class="vq-hash-pill">${escapeHtml(anShort)}</span>` : '<span style="color:var(--text-muted);">-</span>'}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="vq-card">
                <h2 class="vq-card-heading">
                    <span>逐题脱敏存证清单</span>
                    <span style="font-size:0.76rem; font-weight:400; color:var(--text-muted);">已隐去原 PDF 路径，仅保留 SHA-256 指纹前缀</span>
                </h2>
                <div class="vq-table-wrap">
                    <table class="vq-table">
                        <thead>
                            <tr>
                                <th>题号</th>
                                <th>知识点 / 考点</th>
                                <th>题目 PDF SHA-256 前缀</th>
                                <th>答案 PDF SHA-256 前缀</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function renderCryptoCard(receipt, cryptoReport, options = {}) {
        const prefix = options.prefix || 'online';
        const checks = [];

        if (typeof options.serverSignatureValid === 'boolean') {
            checks.push({
                cls: options.serverSignatureValid ? 'pass' : 'fail',
                title: '服务端 Ed25519 验签',
                state: options.serverSignatureValid ? '验签通过' : '验签未通过',
                detail: options.serverSignatureValid ? '服务端已使用公钥校验 canonical_payload 与签名匹配' : '服务端报告签名校验失败'
            });
        }
        if (typeof options.serverChainValid === 'boolean') {
            checks.push({
                cls: options.serverChainValid ? 'pass' : 'fail',
                title: '全局哈希链校验',
                state: options.serverChainValid ? '链条完整' : '链条校验异常',
                detail: options.serverChainValid ? 'prev_entry_hash 与上一条存证 entry_hash 连续一致' : '台账哈希链存在断裂或异常'
            });
        }

        const ed = cryptoReport.ed25519 || {};
        let edCls = 'warn';
        let edState = '未执行';
        if (ed.supported === false) {
            edCls = 'warn';
            edState = '浏览器不支持 Ed25519 WebCrypto';
        } else if (ed.valid === true) {
            edCls = ed.keyStatus === 'revoked' ? 'warn' : 'pass';
            edState = ed.keyStatus === 'revoked' ? '数学验签通过（密钥已吊销）' : '浏览器独立验签通过';
        } else if (ed.valid === false) {
            edCls = 'fail';
            edState = '浏览器独立验签失败';
        }
        checks.push({
            cls: edCls,
            title: '浏览器 crypto.subtle Ed25519 重验',
            state: edState,
            detail: ed.reason || ''
        });

        const eh = cryptoReport.entryHash || {};
        const cons = cryptoReport.consistency || {};
        let shaCls = 'warn';
        let shaState = '未校对';
        let shaDetail = eh.reason || '';
        if (cons.ok === false) {
            shaCls = 'fail';
            shaState = '负载与外层字段不一致';
            shaDetail = cons.reason;
        } else if (eh.checked) {
            shaCls = eh.valid ? 'pass' : 'fail';
            shaState = eh.valid ? 'SHA-256 哈希链自检通过' : 'entry_hash 不匹配';
        }
        checks.push({
            cls: shaCls,
            title: '本地 SHA-256 与负载一致性',
            state: shaState,
            detail: shaDetail
        });

        const canonicalRaw = typeof receipt.canonical_payload === 'string' ? receipt.canonical_payload : '';
        const canonicalObj = parseCanonicalJsonSafe(canonicalRaw);
        const canonicalPretty = canonicalObj ? JSON.stringify(canonicalObj, null, 2) : canonicalRaw;

        const hashRows = [
            { label: '内容快照指纹 (content_sha256)', val: receipt.content_sha256 || '-' },
            { label: '当前台账哈希 (entry_hash)', val: receipt.entry_hash || '-' },
            { label: '前驱台账哈希 (prev_entry_hash)', val: receipt.prev_entry_hash || '（创世首条为空）' },
            { label: '签名密钥标识 (kid)', val: receipt.kid || '-' },
            { label: 'Ed25519 数字签名 (Base64URL)', val: receipt.signature || '-' }
        ];

        return `
            <div class="vq-card">
                <h2 class="vq-card-heading">
                    <span>密码学核验面板</span>
                    <span style="font-size:0.76rem; font-weight:400; color:var(--text-muted);">浏览器端零信任独立验证</span>
                </h2>

                <div class="vq-checks-grid">
                    ${checks.map((c) => `
                        <div class="vq-check-item ${c.cls}">
                            <div class="vq-check-title">${escapeHtml(c.title)}</div>
                            <div class="vq-check-state">${escapeHtml(c.state)}</div>
                            <div class="vq-check-detail">${escapeHtml(c.detail)}</div>
                        </div>
                    `).join('')}
                </div>

                <div class="vq-hash-list">
                    ${hashRows.map((h, idx) => `
                        <div class="vq-hash-row">
                            <div class="vq-hash-row-meta">
                                <div class="vq-hash-row-label">${escapeHtml(h.label)}</div>
                                <div class="vq-hash-row-val">${escapeHtml(h.val)}</div>
                            </div>
                            ${h.val && h.val !== '-' && !h.val.startsWith('（') ? `<button type="button" class="vq-btn sm secondary" data-copy-value="${escapeHtml(h.val)}" data-copy-msg="已复制摘要字段">复制</button>` : ''}
                        </div>
                    `).join('')}
                </div>

                <details class="vq-details">
                    <summary>查看被签名规范负载原文 (canonical_payload)</summary>
                    <div class="vq-details-body">
                        <div class="vq-details-bar">
                            <span style="font-size:0.76rem; color:var(--text-muted);">严格按 UTF-8 字节串验签，任何单字符改动都会导致验签失败</span>
                            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                ${canonicalObj ? `<button type="button" class="vq-btn sm secondary" data-toggle-pretty="${prefix}">切换格式化视图</button>` : ''}
                                <button type="button" class="vq-btn sm secondary" data-copy-canonical="${prefix}">复制原文</button>
                            </div>
                        </div>
                        <pre class="vq-pre" id="${prefix}-canonical-raw">${escapeHtml(canonicalRaw || '（未包含 canonical_payload）')}</pre>
                        ${canonicalObj ? `<pre class="vq-pre" id="${prefix}-canonical-pretty" hidden>${escapeHtml(canonicalPretty)}</pre>` : ''}
                    </div>
                </details>

                <div class="vq-actions-bar">
                    <button type="button" class="vq-btn sm primary" data-download-cred="${prefix}">下载离线凭证 (.json)</button>
                    <button type="button" class="vq-btn sm secondary" data-download-report="${prefix}">下载核验报告 (.json)</button>
                    <button type="button" class="vq-btn sm secondary" data-copy-report="${prefix}">复制核验报告摘要</button>
                    ${receipt.receipt_code ? `<button type="button" class="vq-btn sm secondary" data-copy-link="${escapeHtml(receipt.receipt_code)}">复制核验链接</button>` : ''}
                </div>
            </div>
        `;
    }

    function buildStandardCredential(receipt) {
        const canonicalObj = parseCanonicalJsonSafe(receipt.canonical_payload);
        return {
            schema: canonicalObj?.schema || 'jifang.qbank.attestation.v1',
            receipt,
            canonical_payload: receipt.canonical_payload || '',
            signature: receipt.signature || '',
            kid: receipt.kid || '',
            verify_url: getVerifyUrl(receipt.receipt_code, receipt.verify_url)
        };
    }

    function buildTextReport(bundle) {
        const r = bundle.receipt || {};
        const scope = r.scope || {};
        const sum = r.summary || {};
        const unit = getUnitForSeason(scope.season);
        const lines = [
            '【极方题库配置存证核验报告】',
            `核验模式：${bundle.mode === 'offline' ? '离线凭证本地验真' : '在线台账核验'}`,
            `台账状态：${bundle.status || 'OFFLINE_CREDENTIAL'}`,
            `回执编号：${r.receipt_code || '-'}`,
            `教学专题：${scope.year || '-'}年${scope.season || '-'} · ${formatBankType(scope.bank_type)} · ${scope.subject || '-'} · ${scope.grade || '-'} · ${scope.tier || '-'} · 第${scope.week ?? '-'}${unit}`,
            `操作类型：${formatAction(r.action)} (v${r.revision_no ?? '-'})`,
            `操作教师：${formatOperator(r.operator, r.operator_username, r.operator_name)}`,
            `签发时间：${r.issued_at_cst || r.issued_at || '-'}`,
            `题目统计：共 ${sum.question_count ?? 0} 题（题目PDF ${sum.exercise_pdf_count ?? 0}，答案PDF ${sum.answer_pdf_count ?? 0}，知识点 ${sum.topic_filled_count ?? 0}）`,
            `内容指纹：${r.content_sha256 || '-'}`,
            `台账哈希：${r.entry_hash || '-'}`,
            `浏览器 Ed25519 重验：${bundle.crypto?.ed25519?.supported === false ? '浏览器不支持' : (bundle.crypto?.ed25519?.valid ? '通过' : '未通过')}`,
            `核验链接：${getVerifyUrl(r.receipt_code, r.verify_url)}`,
            `核验时间：${new Date().toLocaleString('zh-CN')}`
        ];
        return lines.join('\n');
    }

    function buildJsonReport(bundle) {
        return {
            report_schema: 'jifang.qbank.verify_report.v1',
            verified_at: new Date().toISOString(),
            mode: bundle.mode,
            status: bundle.status || null,
            server_signature_valid: bundle.serverSignatureValid ?? null,
            server_chain_valid: bundle.serverChainValid ?? null,
            browser_crypto_check: bundle.crypto || null,
            receipt: bundle.receipt || null,
            superseded_by: bundle.superseded_by || null,
            deleted_info: bundle.deleted_info || null,
            latest_receipt_code: bundle.latest_receipt_code || null
        };
    }

    /* ======================================================================
       Mode 1: Online Verification
       ====================================================================== */
    function setOnlineUiState(view) {
        const loading = document.getElementById('online-loading');
        const errBox = document.getElementById('online-error');
        const emptyBox = document.getElementById('online-empty');
        const resBox = document.getElementById('online-result');
        if (loading) loading.hidden = view !== 'loading';
        if (errBox) errBox.hidden = view !== 'error';
        if (emptyBox) emptyBox.hidden = view !== 'empty';
        if (resBox) resBox.hidden = view !== 'result';
    }

    function updateUrlCodeParam(code, push = false) {
        try {
            const url = new URL(window.location.href);
            if (code) url.searchParams.set('code', code);
            else url.searchParams.delete('code');
            if (push) window.history.pushState({ code }, '', url.toString());
            else window.history.replaceState({ code }, '', url.toString());
        } catch (_) {}
    }

    async function runOnlineVerify(rawCode, options = {}) {
        const code = extractReceiptCode(rawCode);
        const input = document.getElementById('online-code-input');
        if (input) {
            input.value = code;
            syncOnlineClearBtn();
        }
        if (!code) {
            setOnlineUiState('empty');
            showToast('请输入存证回执编号', 'warn');
            return;
        }

        state.lastOnlineCode = code;
        if (options.updateUrl !== false) {
            updateUrlCodeParam(code, Boolean(options.pushHistory));
        }

        setOnlineUiState('loading');
        const submitBtn = document.getElementById('btn-online-submit');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const [verifyRes, initialKeys] = await Promise.all([
                fetch(`${VERIFY_API}?code=${encodeURIComponent(code)}`, { cache: 'no-store' }),
                fetchJwks(false)
            ]);

            let payload = null;
            try {
                payload = await verifyRes.json();
            } catch (_) {
                payload = null;
            }

            if (verifyRes.status === 404 && (!payload || !payload.data)) {
                renderOnlineNotFound(code);
                return;
            }
            if (!verifyRes.ok || !payload || !payload.success || !payload.data) {
                const msg = payload?.error || `服务端返回错误 (HTTP ${verifyRes.status})`;
                throw new Error(msg);
            }

            const data = payload.data;
            const status = String(data.status || 'NOT_FOUND').toUpperCase();
            if (status === 'NOT_FOUND' || !data.receipt) {
                renderOnlineNotFound(code, data);
                return;
            }

            const receipt = data.receipt;
            let keys = initialKeys;
            let matchedKey = findJwkForKid(keys, receipt.kid);
            if (!matchedKey && receipt.kid) {
                keys = await fetchJwks(true);
                matchedKey = findJwkForKid(keys, receipt.kid);
            }

            const canonicalObj = parseCanonicalJsonSafe(receipt.canonical_payload);
            const [ed25519, entryHash] = await Promise.all([
                verifyEd25519InBrowser(matchedKey, receipt.canonical_payload, receipt.signature),
                verifyEntryHashLocally(receipt, canonicalObj)
            ]);
            const consistency = checkReceiptCanonicalConsistency(receipt, canonicalObj);

            const cryptoReport = { ed25519, entryHash, consistency };
            let merkleCheck = null;
            if (data.anchor && receipt?.entry_hash) {
                merkleCheck = await verifyMerkleProofInBrowser(
                    receipt.entry_hash,
                    data.anchor.merkle_root,
                    data.anchor.proof
                );
            }

            const bundle = {
                mode: 'online',
                status,
                serverSignatureValid: Boolean(data.signature_valid),
                serverChainValid: Boolean(data.chain_valid),
                crypto: cryptoReport,
                receipt,
                anchor: data.anchor || null,
                merkleCheck,
                superseded_by: data.superseded_by || null,
                deleted_info: data.deleted_info || null,
                latest_receipt_code: data.latest_receipt_code || null
            };
            state.lastOnlineBundle = bundle;

            renderOnlineResult(bundle);
        } catch (err) {
            const errTitle = document.getElementById('online-error-title');
            const errDesc = document.getElementById('online-error-desc');
            if (errTitle) errTitle.textContent = '在线核验请求失败';
            if (errDesc) errDesc.textContent = err?.message || '网络请求异常，请稍后重试。';
            setOnlineUiState('error');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    function renderOnlineNotFound(code, data) {
        const meta = STATUS_META.NOT_FOUND;
        const container = document.getElementById('online-result');
        if (!container) return;
        state.lastOnlineBundle = {
            mode: 'online',
            status: 'NOT_FOUND',
            receipt: { receipt_code: code },
            latest_receipt_code: data?.latest_receipt_code || null
        };
        container.innerHTML = `
            <div class="vq-status-banner ${meta.cls}">
                <div class="vq-banner-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
                </div>
                <div class="vq-banner-body">
                    <div class="vq-banner-top">
                        <h2 class="vq-banner-title">${escapeHtml(meta.title)}</h2>
                        <span class="vq-status-pill ${meta.cls}">${escapeHtml(meta.pill)}</span>
                    </div>
                    <p class="vq-banner-desc">${escapeHtml(meta.desc)}</p>
                    <div class="vq-banner-code-row">
                        <span class="vq-receipt-code-hero">${escapeHtml(code)}</span>
                        <button type="button" class="vq-btn sm secondary" id="btn-switch-offline-from-nf">前往离线凭证验真</button>
                    </div>
                </div>
            </div>
        `;
        setOnlineUiState('result');
    }

    function renderOnlineResult(bundle) {
        const container = document.getElementById('online-result');
        if (!container) return;
        const meta = STATUS_META[bundle.status] || STATUS_META.NOT_FOUND;
        const r = bundle.receipt;

        let bannerIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>';
        if (bundle.status === 'SUPERSEDED') {
            bannerIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
        } else if (bundle.status === 'DELETED') {
            bannerIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
        }

        let transitionHtml = '';
        if (bundle.status === 'SUPERSEDED' && bundle.superseded_by) {
            const sb = bundle.superseded_by;
            const diffs = Array.isArray(sb.diff_summary) ? sb.diff_summary : [];
            const showLatestJump = bundle.latest_receipt_code && bundle.latest_receipt_code !== sb.receipt_code;
            transitionHtml = `
                <div class="vq-transition-card superseded">
                    <h2 class="vq-card-heading">
                        <span>版本覆盖详情（已被继任版本替代）</span>
                        ${showLatestJump ? `<button type="button" class="vq-code-link-btn" data-jump-code="${escapeHtml(bundle.latest_receipt_code)}">直达当前最新：${escapeHtml(bundle.latest_receipt_code)}</button>` : ''}
                    </h2>
                    <div class="vq-kv-grid">
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">继任回执号（点击跳转复核）</div>
                            <div class="vq-kv-value">
                                <button type="button" class="vq-code-link-btn" data-jump-code="${escapeHtml(sb.receipt_code)}">${escapeHtml(sb.receipt_code || '-')}</button>
                            </div>
                        </div>
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">覆盖操作与题数</div>
                            <div class="vq-kv-value">${escapeHtml(formatAction(sb.action))} · ${escapeHtml(sb.question_count ?? '-')} 题</div>
                        </div>
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">修改人</div>
                            <div class="vq-kv-value">${escapeHtml(formatOperator(null, sb.operator_username, sb.operator_name))}</div>
                        </div>
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">覆盖时间 (CST)</div>
                            <div class="vq-kv-value vq-mono">${escapeHtml(sb.issued_at_cst || '-')}</div>
                        </div>
                    </div>
                    ${diffs.length > 0 ? `
                        <ul class="vq-diff-list">
                            ${diffs.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}
                        </ul>
                    ` : ''}
                </div>
            `;
        } else if (bundle.status === 'DELETED' && bundle.deleted_info) {
            const di = bundle.deleted_info;
            transitionHtml = `
                <div class="vq-transition-card deleted">
                    <h2 class="vq-card-heading">删除存证详情</h2>
                    <div class="vq-kv-grid">
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">删除存证回执号</div>
                            <div class="vq-kv-value">
                                ${di.receipt_code
                                    ? `<button type="button" class="vq-code-link-btn" data-jump-code="${escapeHtml(di.receipt_code)}">${escapeHtml(di.receipt_code)}</button>`
                                    : '-'}
                            </div>
                        </div>
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">删除执行人</div>
                            <div class="vq-kv-value">${escapeHtml(formatOperator(null, di.operator_username, di.operator_name))}</div>
                        </div>
                        <div class="vq-kv-box">
                            <div class="vq-kv-label">删除时间 (CST)</div>
                            <div class="vq-kv-value vq-mono">${escapeHtml(di.issued_at_cst || '-')}</div>
                        </div>
                    </div>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="vq-status-banner ${meta.cls}">
                <div class="vq-banner-icon" aria-hidden="true">${bannerIcon}</div>
                <div class="vq-banner-body">
                    <div class="vq-banner-top">
                        <h2 class="vq-banner-title">${escapeHtml(meta.title)}</h2>
                        <span class="vq-status-pill ${meta.cls}">${escapeHtml(meta.pill)}</span>
                    </div>
                    <p class="vq-banner-desc">${escapeHtml(meta.desc)}</p>
                    <div class="vq-banner-code-row">
                        <span class="vq-receipt-code-hero">${escapeHtml(r.receipt_code || '')}</span>
                        <button type="button" class="vq-btn sm secondary" data-copy-value="${escapeHtml(r.receipt_code || '')}" data-copy-msg="已复制回执编号">复制回执号</button>
                    </div>
                </div>
            </div>
            ${transitionHtml}
            ${renderScopeAndMetaCard(r, { allowOnlineJump: true })}
            ${renderMaskedTopicsCard(r)}
            ${renderCryptoCard(r, bundle.crypto, {
                prefix: 'online',
                serverSignatureValid: bundle.serverSignatureValid,
                serverChainValid: bundle.serverChainValid
            })}
            ${renderAnchorCard(bundle.anchor, bundle.merkleCheck, r.receipt_code)}
        `;
        setOnlineUiState('result');
    }

    function hexToBytes(hex) {
        const clean = String(hex || '').trim();
        if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i += 1) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    async function sha256Concat(prefixByte, a, b) {
        const len = 1 + a.length + (b ? b.length : 0);
        const buf = new Uint8Array(len);
        buf[0] = prefixByte;
        buf.set(a, 1);
        if (b) buf.set(b, 1 + a.length);
        const digest = await window.crypto.subtle.digest('SHA-256', buf);
        return new Uint8Array(digest);
    }

    async function verifyMerkleProofInBrowser(entryHashHex, merkleRootHex, proof) {
        if (!window.crypto?.subtle) {
            return { supported: false, valid: false, reason: '当前浏览器不支持 WebCrypto SHA-256' };
        }
        const entryBytes = hexToBytes(entryHashHex);
        const rootBytes = hexToBytes(merkleRootHex);
        if (!entryBytes || entryBytes.length !== 32 || !rootBytes || rootBytes.length !== 32) {
            return { supported: true, valid: false, reason: 'entry_hash 或 merkle_root 格式无效' };
        }
        const steps = Array.isArray(proof) ? proof : [];
        let cur = await sha256Concat(0x00, entryBytes, null);
        for (const step of steps) {
            const sib = hexToBytes(step?.hash);
            if (!sib || sib.length !== 32) {
                return { supported: true, valid: false, reason: 'Merkle 审计路径节点哈希无效' };
            }
            if (step.position === 'left') {
                cur = await sha256Concat(0x01, sib, cur);
            } else if (step.position === 'right') {
                cur = await sha256Concat(0x01, cur, sib);
            } else {
                return { supported: true, valid: false, reason: '未知 Merkle 节点位置' };
            }
        }
        const computed = bytesToHex(cur);
        const expected = bytesToHex(rootBytes);
        return {
            supported: true,
            valid: computed === expected,
            computedRoot: computed,
            reason: computed === expected
                ? `已通过 RFC 6962 SHA-256 路径复算（${steps.length} 层节点）`
                : '浏览器重算的 Merkle Root 与锚定根不一致'
        };
    }

    function renderAnchorCard(anchor, merkleCheck, receiptCode) {
        if (!anchor) {
            return `
                <div class="vq-card">
                    <h2 class="vq-card-heading">
                        <span>外部可信时间锚定 (Merkle + RFC 3161 TSA)</span>
                        <span class="vq-code-chip">等待批次封装</span>
                    </h2>
                    <p style="margin:0; font-size:0.86rem; color:var(--text-secondary);">
                        该存证记录已写入不可变台账链，将在下次定时批次或管理员手动触发时纳入 SHA-256 Merkle Tree 并向外部 RFC 3161 TSA 机构锚定时间戳。
                    </p>
                </div>
            `;
        }
        const isAnchored = anchor.tsa_status === 'anchored';
        const badgeCls = isAnchored ? 'pass' : 'warn';
        const badgeText = isAnchored ? '外部 TSA 时间戳已锚定' : '本地 Merkle 已封装（待外部 TSA）';
        const merkleOk = merkleCheck && merkleCheck.valid;
        const merkleCls = merkleCheck?.supported === false ? 'warn' : (merkleOk ? 'pass' : 'fail');
        const merkleState = merkleCheck?.supported === false ? '浏览器不支持' : (merkleOk ? '浏览器 Merkle Proof 验真通过' : 'Merkle Proof 校验失败');
        const stepsCount = Array.isArray(anchor.proof) ? anchor.proof.length : 0;

        return `
            <div class="vq-card">
                <h2 class="vq-card-heading">
                    <span>外部可信时间锚定 (Merkle + RFC 3161 TSA)</span>
                    <span class="vq-code-chip">${escapeHtml(anchor.anchor_code || '-')}</span>
                </h2>
                <div class="vq-checks-grid">
                    <div class="vq-check-item ${merkleCls}">
                        <div class="vq-check-title">浏览器 SHA-256 Merkle Proof 重算</div>
                        <div class="vq-check-state">${escapeHtml(merkleState)}</div>
                        <div class="vq-check-detail">${escapeHtml(merkleCheck?.reason || '')}</div>
                    </div>
                    <div class="vq-check-item ${badgeCls}">
                        <div class="vq-check-title">外部 RFC 3161 TSA 可信时间源</div>
                        <div class="vq-check-state">${escapeHtml(badgeText)}</div>
                        <div class="vq-check-detail">${escapeHtml(isAnchored ? `TSA 签发时间：${anchor.tsa_gen_time || anchor.anchored_at || '-'}` : '当前批次仅完成本地 Merkle 封装')}</div>
                    </div>
                </div>
                <div class="vq-kv-grid" style="margin-top:12px;">
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">涵盖台账序号</div>
                        <div class="vq-kv-value vq-mono">#${escapeHtml(anchor.seq_from)} ~ #${escapeHtml(anchor.seq_to)}（共 ${escapeHtml(anchor.revision_count)} 条 · ${stepsCount} 层路径）</div>
                    </div>
                    <div class="vq-kv-box">
                        <div class="vq-kv-label">TSA 服务地址</div>
                        <div class="vq-kv-value vq-mono">${escapeHtml(anchor.tsa_url || '（未启用外部 TSA）')}</div>
                    </div>
                </div>
                <div class="vq-hash-list" style="margin-top:10px;">
                    <div class="vq-hash-row">
                        <div class="vq-hash-row-meta">
                            <div class="vq-hash-row-label">批次 Merkle Root (SHA-256)</div>
                            <div class="vq-hash-row-val">${escapeHtml(anchor.merkle_root || '-')}</div>
                        </div>
                        ${anchor.merkle_root ? `<button type="button" class="vq-btn sm secondary" data-copy-value="${escapeHtml(anchor.merkle_root)}" data-copy-msg="已复制 Merkle Root">复制</button>` : ''}
                    </div>
                </div>
                ${anchor.tsa_token_b64 ? `
                    <div class="vq-actions-bar" style="margin-top:12px;">
                        <button type="button" class="vq-btn sm secondary" data-download-tsr="online">下载 RFC 3161 时间戳令牌 (.tsr)</button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /* ======================================================================
       Mode 2: Offline Credential Verification
       ====================================================================== */
    function normalizeOfflineCredential(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('JSON 根节点必须是一个对象');
        }
        let receipt = null;
        let hasWrapper = false;
        if (parsed.data && parsed.data.receipt && typeof parsed.data.receipt === 'object') {
            receipt = { ...parsed.data.receipt };
            hasWrapper = true;
        } else if (parsed.receipt && typeof parsed.receipt === 'object') {
            receipt = { ...parsed.receipt };
            hasWrapper = true;
        } else {
            receipt = { ...parsed };
        }

        if (hasWrapper) {
            for (const key of ['canonical_payload', 'signature', 'kid', 'receipt_code', 'content_sha256', 'entry_hash', 'prev_entry_hash']) {
                const hasTop = typeof parsed[key] === 'string';
                const hasNested = Object.prototype.hasOwnProperty.call(receipt, key) && typeof receipt[key] === 'string';
                if (hasTop && hasNested && parsed[key] !== receipt[key]) {
                    throw new Error(`凭证顶层字段 ${key} 与嵌套 receipt.${key} 存在冲突，拒绝验真`);
                }
                if (!receipt[key] && hasTop && parsed[key]) {
                    receipt[key] = parsed[key];
                }
            }
        }
        if (!receipt.verify_url && typeof parsed.verify_url === 'string') {
            receipt.verify_url = parsed.verify_url;
        }

        const canonicalObj = parseCanonicalJsonSafe(receipt.canonical_payload);
        if (canonicalObj) {
            if (typeof parsed.schema === 'string' && parsed.schema && typeof canonicalObj.schema === 'string' && canonicalObj.schema && parsed.schema !== canonicalObj.schema) {
                throw new Error(`凭证顶层 schema (${parsed.schema}) 与规范负载 schema (${canonicalObj.schema}) 不一致，拒绝验真`);
            }
            receipt.receipt_code = receipt.receipt_code || canonicalObj.receipt_code || '';
            receipt.action = receipt.action || canonicalObj.action || '';
            receipt.issued_at = receipt.issued_at || canonicalObj.issued_at || '';
            receipt.scope = { ...(canonicalObj.scope || {}), ...(receipt.scope || {}) };
            receipt.revision_no = receipt.revision_no ?? canonicalObj.revision_no;
            receipt.supersedes = receipt.supersedes || receipt.supersedes_receipt_code || canonicalObj.supersedes || '';
            receipt.operator = { ...(canonicalObj.operator || {}), ...(receipt.operator || {}) };
            const rawSum = (receipt.summary && typeof receipt.summary === 'object') ? receipt.summary : {};
            const canSum = (canonicalObj.summary && typeof canonicalObj.summary === 'object') ? canonicalObj.summary : {};
            const rawTopics = Array.isArray(rawSum.topics) ? rawSum.topics : [];
            const canTopics = Array.isArray(canSum.topics) ? canSum.topics : [];
            receipt.summary = {
                ...canSum,
                ...rawSum,
                topics: rawTopics.length > 0 ? rawTopics : canTopics
            };
            receipt.content_sha256 = receipt.content_sha256 || canonicalObj.content_sha256 || '';
            receipt.prev_entry_hash = receipt.prev_entry_hash ?? canonicalObj.prev_entry_hash ?? '';
        }

        if (!receipt.canonical_payload || !receipt.signature) {
            throw new Error('凭证缺少 canonical_payload 或 signature 字段，无法进行密码学验签');
        }
        return { receipt, canonicalObj };
    }

    function renderOfflineParseError(resBox, title, message) {
        state.lastOfflineBundle = null;
        if (!resBox) return;
        resBox.innerHTML = `
            <div class="vq-status-banner deleted">
                <div class="vq-banner-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                </div>
                <div class="vq-banner-body">
                    <div class="vq-banner-top">
                        <h2 class="vq-banner-title">${escapeHtml(title)}</h2>
                        <span class="vq-status-pill deleted">FAILED · 验真失败</span>
                    </div>
                    <p class="vq-banner-desc">${escapeHtml(message)}</p>
                </div>
            </div>
        `;
        resBox.hidden = false;
    }

    function parseManualJwk(rawText, kid) {
        const text = String(rawText || '').trim();
        if (!text) {
            throw new Error('请粘贴 JWK 公钥 JSON');
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new Error('JWK 公钥 JSON 语法错误：' + (err?.message || ''));
        }
        if (parsed && Array.isArray(parsed.keys)) {
            const found = findJwkForKid(parsed.keys, kid);
            if (!found) {
                throw new Error(`在粘贴的 JWKS 公钥集中未找到 kid=${kid || '(未指定)'} 对应的公钥`);
            }
            return found;
        }
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        throw new Error('JWK 公钥必须为 JSON 对象');
    }

    async function runOfflineVerify() {
        const rawJson = document.getElementById('offline-json-input')?.value.trim() || '';
        const resBox = document.getElementById('offline-result');
        if (!rawJson) {
            showToast('请先选择 .json 凭证文件或粘贴凭证 JSON 内容', 'warn');
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(rawJson);
        } catch (err) {
            const msg = '凭证 JSON 格式错误：' + (err?.message || '无法解析');
            showToast(msg, 'error', 3600);
            renderOfflineParseError(resBox, '离线凭证验真未通过', msg);
            return;
        }

        let norm;
        try {
            norm = normalizeOfflineCredential(parsed);
        } catch (err) {
            const msg = err.message || '凭证字段不完整';
            showToast(msg, 'error', 3600);
            renderOfflineParseError(resBox, '离线凭证验真未通过', msg);
            return;
        }

        const { receipt, canonicalObj } = norm;

        let jwk = null;
        let keyError = '';
        if (state.offlineKeySource === 'manual') {
            try {
                jwk = parseManualJwk(document.getElementById('offline-jwk-input')?.value || '', receipt.kid);
            } catch (err) {
                keyError = err.message || '手动公钥解析失败';
            }
        } else {
            let keys = await fetchJwks(false);
            jwk = findJwkForKid(keys, receipt.kid);
            if (!jwk && receipt.kid) {
                keys = await fetchJwks(true);
                jwk = findJwkForKid(keys, receipt.kid);
            }
            if (!jwk) {
                keyError = state.jwksError
                    ? `无法拉取服务端公钥库 (${state.jwksError})，可切换为「手动粘贴 JWK 公钥」`
                    : `服务端公钥库中未找到 kid=${receipt.kid || '(未指定)'}，可切换为「手动粘贴 JWK 公钥」`;
            }
        }

        const ed25519 = keyError
            ? { supported: true, valid: false, reason: keyError }
            : await verifyEd25519InBrowser(jwk, receipt.canonical_payload, receipt.signature);
        const entryHash = await verifyEntryHashLocally(receipt, canonicalObj);
        const consistency = checkReceiptCanonicalConsistency(receipt, canonicalObj);

        const cryptoReport = { ed25519, entryHash, consistency };
        const bundle = {
            mode: 'offline',
            status: ed25519.supported === false
                ? 'UNSUPPORTED'
                : (ed25519.valid && consistency.ok ? 'VERIFIED' : 'FAILED'),
            crypto: cryptoReport,
            receipt
        };
        state.lastOfflineBundle = bundle;

        if (!resBox) return;

        let bannerCls = 'valid';
        let bannerTitle = '本地 Ed25519 验真通过';
        let bannerDesc = '该离线凭证的数字签名与规范负载完全匹配，证明其确由持有对应私钥的系统签发且未被篡改。';
        let bannerPill = 'VERIFIED · 验真通过';
        if (bundle.status === 'FAILED') {
            bannerCls = 'deleted';
            bannerTitle = '离线凭证验真未通过';
            bannerDesc = ed25519.valid === false ? ed25519.reason : consistency.reason;
            bannerPill = 'FAILED · 验真失败';
        } else if (bundle.status === 'UNSUPPORTED') {
            bannerCls = 'superseded';
            bannerTitle = '凭证解析成功（当前浏览器不支持原生 Ed25519）';
            bannerDesc = `${ed25519.reason} 仍已为您核对凭证结构${entryHash.checked ? (entryHash.valid ? '及 SHA-256 哈希自检' : '（注意：SHA-256 自检失败）') : ''}。`;
            bannerPill = 'UNSUPPORTED · 浏览器受限';
        } else if (ed25519.keyStatus === 'revoked') {
            bannerCls = 'superseded';
            bannerTitle = '签名有效，但签发密钥已被吊销 (revoked)';
            bannerDesc = '密码学签名数学验证通过，但该公钥在服务端已被标记为吊销状态，请核实线上最新状态。';
            bannerPill = 'REVOKED KEY · 密钥已吊销';
        }

        resBox.innerHTML = `
            <div class="vq-status-banner ${bannerCls}">
                <div class="vq-banner-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>
                </div>
                <div class="vq-banner-body">
                    <div class="vq-banner-top">
                        <h2 class="vq-banner-title">${escapeHtml(bannerTitle)}</h2>
                        <span class="vq-status-pill ${bannerCls === 'deleted' ? 'deleted' : (bannerCls === 'superseded' ? 'superseded' : 'valid')}">${escapeHtml(bannerPill)}</span>
                    </div>
                    <p class="vq-banner-desc">${escapeHtml(bannerDesc)}</p>
                    ${receipt.receipt_code ? `
                        <div class="vq-banner-code-row">
                            <span class="vq-receipt-code-hero">${escapeHtml(receipt.receipt_code)}</span>
                            <button type="button" class="vq-btn sm primary" id="btn-offline-compare-online" data-compare-code="${escapeHtml(receipt.receipt_code)}">在线比对当前最新状态</button>
                            <button type="button" class="vq-btn sm secondary" data-jump-code="${escapeHtml(receipt.receipt_code)}">转到在线核验查看</button>
                        </div>
                    ` : ''}
                    <div id="offline-online-compare" class="vq-compare-box" hidden></div>
                </div>
            </div>
            ${renderScopeAndMetaCard(receipt, { allowOnlineJump: true })}
            ${renderMaskedTopicsCard(receipt)}
            ${renderCryptoCard(receipt, cryptoReport, { prefix: 'offline' })}
        `;
        resBox.hidden = false;
    }

    async function compareOfflineWithOnline(code) {
        const box = document.getElementById('offline-online-compare');
        const btn = document.getElementById('btn-offline-compare-online');
        if (!box || !code) return;
        box.hidden = false;
        box.textContent = '正在向服务端查询该回执当前最新状态...';
        if (btn) btn.disabled = true;

        try {
            const res = await fetch(`${VERIFY_API}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
            const json = await res.json();
            if (!res.ok || !json.success || !json.data) {
                throw new Error(json?.error || `HTTP ${res.status}`);
            }
            const d = json.data;
            const st = String(d.status || 'NOT_FOUND').toUpperCase();
            const meta = STATUS_META[st] || STATUS_META.NOT_FOUND;
            const localSha = (state.lastOfflineBundle?.receipt?.content_sha256 || '').toLowerCase();
            const remoteSha = (d.receipt?.content_sha256 || '').toLowerCase();
            const shaMatch = localSha && remoteSha ? (localSha === remoteSha) : null;

            let extraHtml = '';
            if (st === 'SUPERSEDED' && d.superseded_by) {
                extraHtml = `<div style="margin-top:6px;">已被 <b>${escapeHtml(d.superseded_by.operator_name || d.superseded_by.operator_username || '-')}</b> 于 <span class="vq-mono">${escapeHtml(d.superseded_by.issued_at_cst || '-')}</span> 更新为 <button type="button" class="vq-code-link-btn" data-jump-code="${escapeHtml(d.superseded_by.receipt_code)}">${escapeHtml(d.superseded_by.receipt_code)}</button></div>`;
            } else if (st === 'DELETED' && d.deleted_info) {
                extraHtml = `<div style="margin-top:6px;">已被 <b>${escapeHtml(d.deleted_info.operator_name || d.deleted_info.operator_username || '-')}</b> 于 <span class="vq-mono">${escapeHtml(d.deleted_info.issued_at_cst || '-')}</span> 删除</div>`;
            }

            box.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                    <span><b>在线比对结果：</b><span class="vq-status-pill ${meta.cls}">${escapeHtml(meta.pill)}</span></span>
                    ${shaMatch !== null ? `<span>content_sha256 比对：<b>${shaMatch ? '与线上台账完全一致' : '与线上记录不一致'}</b></span>` : ''}
                </div>
                ${extraHtml}
            `;
        } catch (err) {
            box.innerHTML = `<span style="color:var(--vq-err-fg);">在线比对失败：${escapeHtml(err?.message || '网络异常')}</span>`;
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ======================================================================
       Mode Switching & Event Wiring (CSP Safe - No Inline Handlers)
       ====================================================================== */
    function switchMode(mode) {
        const nextMode = mode === 'offline' ? 'offline' : 'online';
        state.mode = nextMode;
        const onlineBtn = document.getElementById('mode-btn-online');
        const offlineBtn = document.getElementById('mode-btn-offline');
        const onlinePanel = document.getElementById('panel-online');
        const offlinePanel = document.getElementById('panel-offline');

        if (onlineBtn) {
            onlineBtn.classList.toggle('active', nextMode === 'online');
            onlineBtn.setAttribute('aria-selected', nextMode === 'online' ? 'true' : 'false');
        }
        if (offlineBtn) {
            offlineBtn.classList.toggle('active', nextMode === 'offline');
            offlineBtn.setAttribute('aria-selected', nextMode === 'offline' ? 'true' : 'false');
        }
        if (onlinePanel) onlinePanel.hidden = nextMode !== 'online';
        if (offlinePanel) offlinePanel.hidden = nextMode !== 'offline';
    }

    function syncOnlineClearBtn() {
        const input = document.getElementById('online-code-input');
        const clearBtn = document.getElementById('btn-online-clear');
        if (!input || !clearBtn) return;
        clearBtn.hidden = !input.value.trim();
    }

    function handleOfflineFile(file) {
        if (!file) return;
        const nameEl = document.getElementById('offline-file-name');
        const textarea = document.getElementById('offline-json-input');
        const reader = new FileReader();
        reader.onload = () => {
            if (textarea) textarea.value = String(reader.result || '');
            if (nameEl) nameEl.textContent = `已载入文件：${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
            runOfflineVerify();
        };
        reader.onerror = () => {
            showToast('读取本地文件失败', 'error');
        };
        reader.readAsText(file, 'utf-8');
    }

    function bindEvents() {
        document.querySelectorAll('[data-vq-mode]').forEach((btn) => {
            btn.addEventListener('click', () => switchMode(btn.getAttribute('data-vq-mode')));
        });

        const onlineForm = document.getElementById('online-verify-form');
        const onlineInput = document.getElementById('online-code-input');
        const clearBtn = document.getElementById('btn-online-clear');
        const pasteBtn = document.getElementById('btn-online-paste');
        const retryBtn = document.getElementById('btn-online-retry');

        if (onlineForm) {
            onlineForm.addEventListener('submit', (e) => {
                e.preventDefault();
                runOnlineVerify(onlineInput?.value || '', { pushHistory: true });
            });
        }

        if (onlineInput) {
            onlineInput.addEventListener('input', syncOnlineClearBtn);
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (onlineInput) {
                    onlineInput.value = '';
                    onlineInput.focus();
                }
                syncOnlineClearBtn();
                setOnlineUiState('empty');
                updateUrlCodeParam('', true);
            });
        }

        if (pasteBtn) {
            pasteBtn.addEventListener('click', async () => {
                try {
                    if (navigator.clipboard && navigator.clipboard.readText) {
                        const txt = await navigator.clipboard.readText();
                        if (txt && txt.trim()) {
                            runOnlineVerify(txt, { pushHistory: true });
                            return;
                        }
                    }
                } catch (_) {}
                if (onlineInput) onlineInput.focus();
                showToast('请直接在输入框中按 Ctrl+V 粘贴回执编号', 'info');
            });
        }

        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                runOnlineVerify(state.lastOnlineCode || onlineInput?.value || '', { updateUrl: false });
            });
        }

        // Offline dropzone & file picker
        const dropzone = document.getElementById('offline-dropzone');
        const fileInput = document.getElementById('offline-file-input');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', () => fileInput.click());
            dropzone.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInput.click();
                }
            });
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.classList.add('dragover');
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.classList.remove('dragover');
            });
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
                const file = e.dataTransfer?.files?.[0];
                if (file) handleOfflineFile(file);
            });
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (file) handleOfflineFile(file);
                fileInput.value = '';
            });
        }

        document.getElementById('btn-offline-format')?.addEventListener('click', () => {
            const ta = document.getElementById('offline-json-input');
            if (!ta || !ta.value.trim()) return;
            try {
                ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
                showToast('JSON 已格式化', 'success', 1600);
            } catch (err) {
                showToast('JSON 语法错误：' + (err?.message || ''), 'error');
            }
        });

        document.querySelectorAll('[data-keysrc]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const src = btn.getAttribute('data-keysrc') === 'manual' ? 'manual' : 'jwks';
                state.offlineKeySource = src;
                document.querySelectorAll('[data-keysrc]').forEach((b) => {
                    b.classList.toggle('active', b.getAttribute('data-keysrc') === src);
                });
                const jwksBox = document.getElementById('offline-keysrc-jwks');
                const manualBox = document.getElementById('offline-keysrc-manual');
                if (jwksBox) jwksBox.hidden = src !== 'jwks';
                if (manualBox) manualBox.hidden = src !== 'manual';
            });
        });

        document.getElementById('btn-refresh-jwks')?.addEventListener('click', async () => {
            await fetchJwks(true);
            showToast('已刷新公钥库', 'success', 1600);
        });

        document.getElementById('btn-offline-verify')?.addEventListener('click', runOfflineVerify);

        document.getElementById('btn-offline-clear')?.addEventListener('click', () => {
            const ta = document.getElementById('offline-json-input');
            const nameEl = document.getElementById('offline-file-name');
            const resBox = document.getElementById('offline-result');
            if (ta) ta.value = '';
            if (nameEl) nameEl.textContent = '支持教师端回执卡下载的标准存证凭证文件（纯本地解析，不上传文件）';
            if (resBox) {
                resBox.hidden = true;
                resBox.innerHTML = '';
            }
            state.lastOfflineBundle = null;
        });

        // JWKS modal buttons
        document.getElementById('btn-open-jwks')?.addEventListener('click', async () => {
            await fetchJwks(false);
            openJwksModal();
        });
        document.getElementById('btn-close-jwks')?.addEventListener('click', closeJwksModal);
        document.getElementById('btn-modal-close-jwks')?.addEventListener('click', closeJwksModal);
        document.getElementById('btn-modal-refresh-jwks')?.addEventListener('click', async () => {
            await fetchJwks(true);
            renderJwksModal();
            showToast('公钥库已更新', 'success', 1600);
        });

        // Delegated dynamic actions inside result containers & JWKS modal
        document.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (!target) return;

            if (target.id === 'btn-switch-offline-from-nf') {
                switchMode('offline');
                return;
            }
            if (target.hasAttribute('data-jump-code')) {
                const code = target.getAttribute('data-jump-code');
                if (code) {
                    switchMode('online');
                    runOnlineVerify(code, { pushHistory: true });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
                return;
            }
            if (target.hasAttribute('data-compare-code')) {
                compareOfflineWithOnline(target.getAttribute('data-compare-code'));
                return;
            }
            if (target.hasAttribute('data-copy-value')) {
                copyText(target.getAttribute('data-copy-value'), target.getAttribute('data-copy-msg') || '已复制');
                return;
            }
            if (target.hasAttribute('data-copy-link')) {
                const c = target.getAttribute('data-copy-link');
                copyText(getVerifyUrl(c), '已复制核验链接');
                return;
            }
            if (target.hasAttribute('data-copy-canonical')) {
                const pfx = target.getAttribute('data-copy-canonical');
                const bundle = pfx === 'offline' ? state.lastOfflineBundle : state.lastOnlineBundle;
                copyText(bundle?.receipt?.canonical_payload || '', '已复制规范负载原文');
                return;
            }
            if (target.hasAttribute('data-toggle-pretty')) {
                const pfx = target.getAttribute('data-toggle-pretty');
                const rawEl = document.getElementById(`${pfx}-canonical-raw`);
                const prettyEl = document.getElementById(`${pfx}-canonical-pretty`);
                if (rawEl && prettyEl) {
                    const showPretty = prettyEl.hidden;
                    prettyEl.hidden = !showPretty;
                    rawEl.hidden = showPretty;
                }
                return;
            }
            if (target.hasAttribute('data-download-cred')) {
                const pfx = target.getAttribute('data-download-cred');
                const bundle = pfx === 'offline' ? state.lastOfflineBundle : state.lastOnlineBundle;
                if (bundle?.receipt) {
                    const code = bundle.receipt.receipt_code || 'qbank-receipt';
                    downloadJsonFile(`${code}.credential.json`, buildStandardCredential(bundle.receipt));
                    showToast('已导出离线存证凭证 (.json)', 'success');
                }
                return;
            }
            if (target.hasAttribute('data-download-tsr')) {
                const tokenB64 = state.lastOnlineBundle?.anchor?.tsa_token_b64;
                if (tokenB64) {
                    const binStr = atob(tokenB64);
                    const bytes = new Uint8Array(binStr.length);
                    for (let i = 0; i < binStr.length; i += 1) {
                        bytes[i] = binStr.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: 'application/timestamp-reply' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const ancCode = state.lastOnlineBundle?.anchor?.anchor_code || 'qbank-anchor';
                    a.href = url;
                    a.download = `${ancCode}.tsr`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    showToast('已下载 RFC 3161 时间戳令牌 (.tsr)', 'success');
                }
                return;
            }
            if (target.hasAttribute('data-download-report')) {
                const pfx = target.getAttribute('data-download-report');
                const bundle = pfx === 'offline' ? state.lastOfflineBundle : state.lastOnlineBundle;
                if (bundle) {
                    const code = bundle.receipt?.receipt_code || 'qbank-verify';
                    downloadJsonFile(`${code}.verify-report.json`, buildJsonReport(bundle));
                    showToast('已导出核验报告 (.json)', 'success');
                }
                return;
            }
            if (target.hasAttribute('data-copy-report')) {
                const pfx = target.getAttribute('data-copy-report');
                const bundle = pfx === 'offline' ? state.lastOfflineBundle : state.lastOnlineBundle;
                if (bundle) {
                    copyText(buildTextReport(bundle), '已复制核验报告摘要');
                }
                return;
            }
            if (target.hasAttribute('data-copy-jwk-idx')) {
                const idx = parseInt(target.getAttribute('data-copy-jwk-idx'), 10);
                const key = state.jwksKeys[idx];
                if (key) {
                    copyText(JSON.stringify(key, null, 2), '已复制该 JWK 公钥 JSON');
                }
            }
        });

        window.addEventListener('popstate', () => {
            const params = new URLSearchParams(window.location.search);
            const code = params.get('code');
            if (code) {
                switchMode('online');
                runOnlineVerify(code, { updateUrl: false });
            } else {
                const input = document.getElementById('online-code-input');
                if (input) input.value = '';
                syncOnlineClearBtn();
                setOnlineUiState('empty');
            }
        });
    }

    function init() {
        bindEvents();
        fetchJwks(false);

        const params = new URLSearchParams(window.location.search);
        const queryCode = params.get('code') || '';
        let hashCode = '';
        if (!queryCode && window.location.hash.includes('code=')) {
            const m = window.location.hash.match(/code=([^&#]+)/);
            if (m && m[1]) hashCode = decodeURIComponent(m[1]);
        }
        const initialCode = queryCode || hashCode;
        if (initialCode) {
            switchMode('online');
            runOnlineVerify(initialCode, { updateUrl: Boolean(hashCode) });
        } else {
            setOnlineUiState('empty');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
