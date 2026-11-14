/**
 * 统一三态主题引导与控制器（浅色 / 深色 / 跟随系统）
 * 须作为首屏同步脚本置于 <head> 最前，避免 FOUC 闪烁并同步 <meta name="color-scheme">。
 */
(function (global) {
    'use strict';

    const root = document.documentElement;
    const scope = root.getAttribute('data-theme-scope') || 'default';
    const STORAGE_KEY = scope === 'admin' ? 'admin_theme' : 'theme';
    const MEDIA_QUERY = '(prefers-color-scheme: dark)';
    const VALID_MODES = new Set(['light', 'dark', 'system']);

    function getMetaColorScheme() {
        let meta = document.querySelector('meta[name="color-scheme"]');
        if (!meta && document.head) {
            meta = document.createElement('meta');
            meta.name = 'color-scheme';
            meta.content = 'light dark';
            document.head.appendChild(meta);
        }
        return meta;
    }

    function readStoredMode() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return VALID_MODES.has(raw) ? raw : 'system';
        } catch (e) {
            return 'system';
        }
    }

    function getSystemEffective() {
        if (global.matchMedia && global.matchMedia(MEDIA_QUERY).matches) {
            return 'dark';
        }
        return 'light';
    }

    function resolveEffective(mode) {
        if (mode === 'light' || mode === 'dark') return mode;
        return getSystemEffective();
    }

    function applyMode(mode, persist) {
        const nextMode = VALID_MODES.has(mode) ? mode : 'system';
        if (persist) {
            try {
                if (nextMode === 'system') {
                    localStorage.removeItem(STORAGE_KEY);
                } else {
                    localStorage.setItem(STORAGE_KEY, nextMode);
                }
            } catch (e) {}
        }

        const effective = resolveEffective(nextMode);
        const colorScheme = nextMode === 'system' ? 'light dark' : nextMode;

        root.setAttribute('data-theme', effective);
        root.setAttribute('data-theme-mode', nextMode);
        root.style.colorScheme = colorScheme;

        const meta = getMetaColorScheme();
        if (meta && meta.content !== colorScheme) {
            meta.content = colorScheme;
        }

        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
            metaThemeColor.setAttribute('content', effective === 'light' ? '#fafafa' : '#141415');
        }

        syncControls(nextMode, effective);
        return effective;
    }

    const MODE_LABELS = {
        system: '跟随系统',
        light: '浅色模式',
        dark: '深色模式'
    };

    function syncControls(mode, effective) {
        const m = mode || readStoredMode();
        const eff = effective || resolveEffective(m);

        document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
            const target = btn.getAttribute('data-theme-set');
            const isActive = target === m;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });

        const legacyInput = document.getElementById('theme-toggle-input');
        if (legacyInput && legacyInput.type === 'checkbox') {
            legacyInput.checked = eff === 'light';
        }

        const toggleText = document.getElementById('theme-toggle-text');
        if (toggleText) {
            toggleText.textContent = MODE_LABELS[m] || MODE_LABELS.system;
        }
    }

    function cycleMode() {
        const current = readStoredMode();
        const order = ['system', 'light', 'dark'];
        const idx = order.indexOf(current);
        const next = order[(idx + 1) % order.length];
        return applyMode(next, true);
    }

    // 首屏立即同步应用（零闪烁）
    applyMode(readStoredMode(), false);

    // 跟随系统偏好实时变化
    if (global.matchMedia) {
        const mql = global.matchMedia(MEDIA_QUERY);
        const onMediaChange = function () {
            if (readStoredMode() === 'system') {
                applyMode('system', false);
            }
        };
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onMediaChange);
        } else if (typeof mql.addListener === 'function') {
            mql.addListener(onMediaChange);
        }
    }

    // 跨标签页同步
    global.addEventListener('storage', function (e) {
        if (e.key === STORAGE_KEY || e.key === null) {
            applyMode(readStoredMode(), false);
        }
    });

    // DOM 就绪后同步按钮选中态并绑定三态切换事件
    function bindControls() {
        syncControls();
        document.addEventListener('click', function (e) {
            const btn = e.target && e.target.closest ? e.target.closest('[data-theme-set]') : null;
            if (!btn) return;
            const target = btn.getAttribute('data-theme-set');
            if (VALID_MODES.has(target)) {
                applyMode(target, true);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindControls);
    } else {
        bindControls();
    }

    global.ThemeManager = {
        getMode: readStoredMode,
        getEffectiveTheme: function () { return resolveEffective(readStoredMode()); },
        setMode: function (mode) { return applyMode(mode, true); },
        cycleMode: cycleMode,
        syncUI: syncControls
    };

    // 兼容旧版调用方式
    global.toggleTheme = function (arg) {
        if (arg && typeof arg === 'object' && 'checked' in arg) {
            return applyMode(arg.checked ? 'light' : 'dark', true);
        }
        return cycleMode();
    };

    // 统一原生 <dialog> Top-Layer 管理器（含 closedby="any" 的 Safari 外点与焦点还原降级）
    const dialogRestoreFocus = new WeakMap();
    const dialogOptionsMap = new WeakMap();
    const boundDialogs = new WeakSet();

    function bindNativeDialog(dialog) {
        if (!dialog || boundDialogs.has(dialog)) return;
        boundDialogs.add(dialog);

        let pointerDownOnBackdrop = false;
        dialog.addEventListener('pointerdown', function (e) {
            pointerDownOnBackdrop = (e.target === dialog);
        });
        dialog.addEventListener('pointerup', function (e) {
            if (!pointerDownOnBackdrop) return;
            pointerDownOnBackdrop = false;
            if (e.target !== dialog) return;
            const opts = dialogOptionsMap.get(dialog) || {};
            if (opts.dismissible === false) return;
            closeNativeDialog(dialog, 'backdrop');
        });

        dialog.addEventListener('cancel', function (e) {
            const opts = dialogOptionsMap.get(dialog) || {};
            if (opts.dismissible === false) {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            closeNativeDialog(dialog, 'cancel');
        });

        dialog.addEventListener('close', function () {
            const opts = dialogOptionsMap.get(dialog) || {};
            dialog.classList.remove('active');
            const prev = dialogRestoreFocus.get(dialog);
            dialogRestoreFocus.delete(dialog);
            if (typeof opts.onAfterClose === 'function') {
                try { opts.onAfterClose(dialog); } catch (_) {}
            }
            if (opts.removeOnClose && dialog.parentNode) {
                dialog.parentNode.removeChild(dialog);
            }
            if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
                try {
                    prev.focus({ preventScroll: true });
                } catch (_) {
                    try { prev.focus(); } catch (__) {}
                }
            }
        });
    }

    function openNativeDialog(el, opts) {
        const dialog = typeof el === 'string' ? document.getElementById(el) : el;
        if (!dialog) return null;
        const options = opts || {};
        dialogOptionsMap.set(dialog, options);

        if (dialog.tagName === 'DIALOG' && typeof dialog.showModal === 'function') {
            bindNativeDialog(dialog);
            if (!dialog.open) {
                if (document.activeElement && document.activeElement !== document.body) {
                    dialogRestoreFocus.set(dialog, document.activeElement);
                }
                dialog.style.removeProperty('display');
                dialog.classList.add('active');
                dialog.showModal();
            } else {
                dialog.classList.add('active');
            }
        } else {
            dialog.style.display = 'flex';
            dialog.classList.add('active');
        }
        return dialog;
    }

    function closeNativeDialog(el, reason) {
        const dialog = typeof el === 'string' ? document.getElementById(el) : el;
        if (!dialog) return;
        const opts = dialogOptionsMap.get(dialog) || {};
        if ((reason === 'backdrop' || reason === 'cancel') && typeof opts.onCancel === 'function') {
            opts.onCancel(reason);
        }
        if (dialog.tagName === 'DIALOG' && typeof dialog.close === 'function') {
            if (dialog.open) {
                dialog.close(reason || '');
            } else {
                dialog.classList.remove('active');
            }
        } else {
            dialog.classList.remove('active');
            dialog.style.display = 'none';
            if (opts.onAfterClose) {
                try { opts.onAfterClose(dialog); } catch (_) {}
            }
            if (opts.removeOnClose && dialog.parentNode) {
                dialog.parentNode.removeChild(dialog);
            }
        }
    }

    function isNativeDialogOpen(el) {
        const dialog = typeof el === 'string' ? document.getElementById(el) : el;
        if (!dialog) return false;
        if (dialog.tagName === 'DIALOG') return Boolean(dialog.open);
        return dialog.classList.contains('active') || (dialog.style.display !== 'none' && dialog.style.display !== '');
    }

    function promoteToastPopover(container) {
        if (!container || typeof container.showPopover !== 'function') return;
        if (!container.hasAttribute('popover')) {
            container.setAttribute('popover', 'manual');
        }
        try {
            if (container.matches(':popover-open')) {
                container.hidePopover();
            }
            container.showPopover();
        } catch (_) {}
    }

    global.DialogHelper = {
        open: openNativeDialog,
        close: closeNativeDialog,
        isOpen: isNativeDialogOpen,
        promoteToast: promoteToastPopover
    };
})(window);
