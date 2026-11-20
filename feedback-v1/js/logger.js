/**
 * JF-AutoFeedback 前端日志收集器
 * 
 * 使用方式：
 *   Logger.error('csv_parse_error', { fileName: 'xxx.csv', error: e.message });
 *   Logger.warn('column_mismatch', { expected: ['姓名','得分'], actual: headers });
 *   Logger.action('file_upload', { fileName: 'xxx.csv', rows: 42 });
 *   Logger.info('page_loaded', { page: 'upload-semester' });
 */

const Logger = (() => {
    const LOG_API = 'api/logs.php?action=log';
    const BATCH_SIZE = 5;           // 积攒多少条后批量上报
    const FLUSH_INTERVAL = 10000;   // 定时上报间隔 (ms)
    const DEDUP_WINDOW = 5000;      // 相同错误去重窗口 (ms)
    const LEVELS = ['info', 'action', 'warn', 'error'];

    let buffer = [];
    let flushTimer = null;
    let recentErrors = new Map();   // key -> timestamp, 用于去重
    let pageContext = {};           // 当前页面上下文
    let clientInfo = null;          // 客户端信息缓存

    // ========== 客户端信息 ==========
    function generateFingerprint() {
        if (window.localStorage && localStorage.getItem('jf_fp')) {
            return localStorage.getItem('jf_fp');
        }
        let fp = 'fp_';
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.textBaseline = 'top';
                ctx.font = '14px Arial';
                ctx.fillText('JF-AutoFeedback', 2, 2);
                const dataUrl = canvas.toDataURL();
                let hash = 0;
                for (let i = 0; i < dataUrl.length; i++) {
                    const char = dataUrl.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash;
                }
                fp += Math.abs(hash).toString(16);
            } else {
                fp += Math.random().toString(36).substring(2, 10);
            }
        } catch(e) {
            fp += Math.random().toString(36).substring(2, 10);
        }
        if (window.localStorage) {
            localStorage.setItem('jf_fp', fp);
        }
        return fp;
    }

    function getClientInfo() {
        if (clientInfo) return clientInfo;
        clientInfo = {
            userAgent: navigator.userAgent,
            language: navigator.language || 'unknown',
            screenSize: `${screen.width}x${screen.height}`,
            windowSize: `${window.innerWidth}x${window.innerHeight}`,
            platform: navigator.platform || 'unknown',
            cookieEnabled: navigator.cookieEnabled,
            online: navigator.onLine,
            fingerprint: generateFingerprint()
        };
        return clientInfo;
    }

    // ========== 去重检查 ==========
    function isDuplicate(level, event, details) {
        if (level !== 'error' && level !== 'warn') return false;
        const key = `${level}:${event}:${JSON.stringify(details?.message || details?.error || '')}`;
        const now = Date.now();
        const lastTime = recentErrors.get(key);
        if (lastTime && (now - lastTime) < DEDUP_WINDOW) {
            return true;
        }
        recentErrors.set(key, now);
        // 清理过期条目
        if (recentErrors.size > 100) {
            for (const [k, t] of recentErrors) {
                if (now - t > DEDUP_WINDOW) recentErrors.delete(k);
            }
        }
        return false;
    }

    let aggregatedCopies = { count: 0, totalLength: 0 };

    function flushAggregated() {
        if (aggregatedCopies.count > 0) {
            const entry = {
                timestamp: Date.now(),
                level: 'action',
                module: pageContext.module || 'viewer',
                event: 'content_copied',
                details: {
                    copyCount: aggregatedCopies.count,
                    totalLength: aggregatedCopies.totalLength
                },
                context: {
                    ...pageContext,
                    sessionId: pageContext.sessionId || '',
                    page: pageContext.page || location.pathname.split('/').pop() || 'unknown'
                },
                client: {
                    ...getClientInfo(),
                    ...(pageContext.fingerprint ? { fingerprint: pageContext.fingerprint } : {})
                }
            };
            buffer.push(entry);
            aggregatedCopies = { count: 0, totalLength: 0 };
        }
    }

    // ========== 核心日志方法 ==========
    function log(level, event, details = {}) {
        try {
            if (isDuplicate(level, event, details)) return;

            // 高频复制事件智能聚合，避免刷爆日志
            if (event === 'content_copied') {
                aggregatedCopies.count++;
                aggregatedCopies.totalLength += (typeof details === 'object' && details.length ? details.length : 0);
                if (aggregatedCopies.count >= 10) {
                    flushAggregated();
                    flush();
                }
                return;
            }

            const currentOp = window.currentUser?.username || pageContext.operator || '';
            const entry = {
                timestamp: Date.now(),
                level,
                module: pageContext.module || 'global',
                event,
                operator: currentOp,
                details: typeof details === 'string' ? { message: details } : details,
                context: {
                    ...pageContext,
                    operator: currentOp,
                    sessionId: pageContext.sessionId || '',
                    page: pageContext.page || location.pathname.split('/').pop() || 'unknown'
                },
                client: {
                    ...getClientInfo(),
                    ...(pageContext.fingerprint ? { fingerprint: pageContext.fingerprint } : {})
                }
            };

            buffer.push(entry);

            // 达到批量阈值立即上报
            if (buffer.length >= BATCH_SIZE) {
                flush();
            }
        } catch (e) {
            // 日志系统自身的错误静默处理
            console.warn('[Logger] Internal error:', e);
        }
    }

    // ========== 批量上报 ==========
    function flush() {
        flushAggregated();
        if (buffer.length === 0) return;

        const entries = buffer.splice(0);
        const payload = JSON.stringify({ entries });

        try {
            fetch(LOG_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {
                // 上报失败静默处理，不影响用户
            });
        } catch (e) {
            // 静默
        }
    }

    // ========== 页面关闭兜底 ==========
    function flushBeacon() {
        flushAggregated();
        if (buffer.length === 0) return;
        const entries = buffer.splice(0);
        const payload = JSON.stringify({ entries });
        try {
            if (navigator.sendBeacon) {
                navigator.sendBeacon(LOG_API, new Blob([payload], { type: 'application/json' }));
            } else {
                // fallback: 同步 XHR
                const xhr = new XMLHttpRequest();
                xhr.open('POST', LOG_API, false);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(payload);
            }
        } catch (e) {
            // 静默
        }
    }

    // ========== 全局错误捕获 ==========
    function setupGlobalErrorHandlers() {
        // 未捕获的 JS 异常
        window.addEventListener('error', (e) => {
            log('error', 'uncaught_error', {
                message: e.message || 'Unknown error',
                filename: e.filename || '',
                lineno: e.lineno || 0,
                colno: e.colno || 0,
                stack: e.error?.stack || ''
            });
        });

        // 未处理的 Promise rejection
        window.addEventListener('unhandledrejection', (e) => {
            const reason = e.reason;
            log('error', 'unhandled_rejection', {
                message: reason?.message || String(reason || 'Unknown rejection'),
                stack: reason?.stack || ''
            });
        });

        // 网络状态变化
        window.addEventListener('online', () => log('info', 'network_online'));
        window.addEventListener('offline', () => log('warn', 'network_offline'));
    }

    // ========== 初始化 ==========
    function init(options = {}) {
        pageContext = {
            module: options.module || 'global',
            page: options.page || location.pathname.split('/').pop() || 'unknown',
            sessionId: options.sessionId || '',
            subject: options.subject || ''
        };

        // 设置定时上报
        if (flushTimer) clearInterval(flushTimer);
        flushTimer = setInterval(flush, FLUSH_INTERVAL);

        // 页面关闭/离开时兜底上报（使用 pagehide 避免破坏浏览器 BFCache 往返缓存）
        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushBeacon();
            }
        });
        window.addEventListener('pagehide', flushBeacon);

        // 注册全局错误捕获
        setupGlobalErrorHandlers();

        // 记录页面加载
        log('info', 'page_loaded', {
            page: pageContext.page,
            url: location.href,
            referrer: document.referrer || '',
            theme: document.documentElement.getAttribute('data-theme') || 'unknown'
        });
    }

    // ========== 更新上下文 ==========
    function setContext(updates) {
        Object.assign(pageContext, updates);
    }

    // ========== 公开 API ==========
    return {
        init,
        setContext,
        getClientInfo,
        flush,
        error: (event, details) => log('error', event, details),
        warn: (event, details) => log('warn', event, details),
        action: (event, details) => log('action', event, details),
        info: (event, details) => log('info', event, details)
    };
})();

// 暴露到全局
window.Logger = Logger;
