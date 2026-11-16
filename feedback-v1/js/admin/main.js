/**
 * Admin 主入口与路由控制器 (Tab Switching, Metas, Bootstrap)
 */

        /* ========================================================
           Navigation & Tab Switching
           ======================================================== */
        const TAB_METAS = {
            config: {
                title: '系统配置',
                breadcrumb: '系统配置'
            },
            records: {
                title: '学生学情错题',
                breadcrumb: '学生学情错题'
            },
            teachers: {
                title: '教师账号管理',
                breadcrumb: '教师账号管理'
            },
            batches: {
                title: '生成批次记录',
                breadcrumb: '生成批次记录'
            },
            logs: {
                title: '操作日志',
                breadcrumb: '操作日志'
            },
            database: {
                title: '数据库管理',
                breadcrumb: '数据库管理'
            },
            changelog: {
                title: '更新日志',
                breadcrumb: '更新日志'
            }
        };

        let activeTab = 'records';
        window.activeTab = 'records';

        function switchTab(tab) {
            activeTab = tab;
            window.activeTab = tab;
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

            const targetNav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
            if (targetNav) targetNav.classList.add('active');

            const targetTabContent = document.getElementById(`${tab}-tab`);
            if (targetTabContent) targetTabContent.classList.add('active');

            const meta = TAB_METAS[tab] || { title: tab, breadcrumb: tab };
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.textContent = meta.title;
            const pageDesc = document.getElementById('page-desc');
            if (pageDesc) pageDesc.textContent = meta.desc || '';
            const headerBreadcrumb = document.getElementById('header-breadcrumb');
            if (headerBreadcrumb) headerBreadcrumb.textContent = meta.breadcrumb;

            if (tab === 'records') {
                initRecordsTab();
            } else if (tab === 'teachers') {
                initTeachersTab();
            } else if (tab === 'batches') {
                initBatchesTab();
            } else if (tab === 'logs') {
                loadFilters();
                loadLogs(1);
            } else if (tab === 'database') {
                initDatabaseTab();
            } else if (tab === 'changelog') {
                loadChangelogs();
            }

            closeMobileMenu();
        }

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                switchTab(item.dataset.tab);
            });
        });

        function openMobileMenu() {
            const sidebar = document.querySelector('.admin-sidebar');
            const overlay = document.getElementById('mobile-overlay');
            if (sidebar) {
                sidebar.classList.add('open');
                sidebar.classList.add('mobile-open');
            }
            if (overlay) {
                overlay.classList.add('show');
                overlay.classList.add('active');
            }
            document.body.classList.add('mobile-nav-active');
            document.body.style.overflow = 'hidden';
        }

        function closeMobileMenu() {
            const sidebar = document.querySelector('.admin-sidebar');
            const overlay = document.getElementById('mobile-overlay');
            if (sidebar) {
                sidebar.classList.remove('open');
                sidebar.classList.remove('mobile-open');
            }
            if (overlay) {
                overlay.classList.remove('show');
                overlay.classList.remove('active');
            }
            document.body.classList.remove('mobile-nav-active');
            document.body.style.overflow = '';
        }

        window.openMobileMenu = openMobileMenu;
        window.closeMobileMenu = closeMobileMenu;

        document.getElementById('mobile-menu-btn')?.addEventListener('click', openMobileMenu);
        document.getElementById('mobile-overlay')?.addEventListener('click', closeMobileMenu);
        document.getElementById('sidebar-close-btn')?.addEventListener('click', closeMobileMenu);

        // 按 ESC 键快速退出移动端侧边栏
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMobileMenu();
            }
        });

        // 窗口尺寸扩大至桌面端时自动复位
        window.addEventListener('resize', () => {
            if (window.innerWidth > 1024) {
                closeMobileMenu();
            }
        });


        const ADMIN_CLICK_ACTIONS = {
            'reset-active-zoom': () => resetActiveTableZoom(),
            'resolve-confirm': (_el, arg) => resolveConfirm(arg === '1'),
            'close-pwd-modal': () => closeChangePwdModal(),
            'submit-pwd': () => submitChangePwd(),
            'open-pwd-modal': () => openChangePwdModal(),
            'logout': () => logout(),
            'open-mobile-menu': () => openMobileMenu(),
            'close-mobile-menu': () => closeMobileMenu(),
            'set-season': (_el, arg) => setSeason(arg),
            'toggle-api-key': () => toggleApiKeyVisibility(),
            'test-ai-conn': () => testAiConnection(),
            'save-config': () => saveConfig(),
            'reset-records-filters': () => resetRecordsFilters(),
            'rec-zoom': (_el, arg) => changeRecTableZoom(parseFloat(arg)),
            'rec-zoom-reset': () => resetRecTableZoom(),
            'toggle-records-view': () => toggleRecordsViewMode(),
            'batch-delete-records': () => batchDeleteRecords(),
            'reload-records': () => loadRecordsData(recCurrentPage),
            'open-record-create': () => openRecordCreateModal(),
            'records-sort': (_el, arg) => setRecordsSort(arg),
            'reset-batches-filters': () => resetBatchesFilters(),
            'batch-delete-batches': () => batchDeleteBatches(),
            'reload-batches': () => loadBatchesData(batCurrentPage),
            'batches-sort': (_el, arg) => setBatchesSort(arg),
            'batch-delete-teachers': () => batchDeleteTeachers(),
            'open-new-teacher': () => openDbRecordModal(null, 'users'),
            'reload-teachers': () => loadTeachersData(),
            'teacher-sort': (_el, arg) => setTeacherSort(arg),
            'switch-logs-subview': (_el, arg) => switchLogsSubview(arg),
            'quick-filter-sender': () => quickFilterSenderModule(),
            'export-logs': () => exportLogs(),
            'load-logs': () => loadLogs(),
            'load-sender-clients': () => loadSenderClients(),
            'db-zoom': (_el, arg) => changeDbTableZoom(parseFloat(arg)),
            'db-zoom-reset': () => resetDbTableZoom(),
            'toggle-db-view': () => toggleDbViewMode(),
            'batch-delete-db': () => batchDeleteDbRecords(),
            'reload-db': () => loadDbData(dbCurrentPage),
            'open-db-create': () => openDbRecordModal(),
            'db-sort': (_el, arg) => setDbSort(arg),
            'open-changelog': () => openChangelogModal(),
            'close-db-record': () => closeDbRecordModal(),
            'save-db-record': () => saveDbRecord(),
            'close-db-detail': () => closeDbDetailModal(),
            'close-token-search': () => closeTokenSearchModal(),
            'clear-token-input': () => clearTokenModalInput(),
            'paste-token-search': () => pasteFromClipboardToTokenSearch(),
            'do-token-search': () => doSearchStudentByToken(),
            'close-changelog': () => closeChangelogModal(),
            'add-changelog-row': () => addChangelogItemRow(),
            'save-changelog': () => saveChangelog(),
            'dock-batch-delete': () => triggerDockBatchDelete(),
            'clear-all-selections': () => clearAllSelections()
        };

        const ADMIN_CHANGE_ACTIONS = {
            'retest-qr-toggle': () => onRetestQrToggleChange(),
            'sc-stage-toggle': () => onSenderStageToggleChange(),
            'sc-service-toggle': () => onSenderServiceToggleChange(),
            'records-per-page': (el) => changeRecordsPerPage(el.value),
            'select-all-records': (el) => toggleSelectAllRecords(el.checked),
            'batches-per-page': (el) => changeBatchesPerPage(el.value),
            'select-all-batches': (el) => toggleSelectAllBatches(el.checked),
            'reload-teachers-p1': () => loadTeachersData(1),
            'teachers-per-page': (el) => changeTeachersPerPage(el.value),
            'select-all-teachers': (el) => toggleSelectAllTeachers(el),
            'load-logs': () => loadLogs(),
            'load-sender-clients': () => loadSenderClients(),
            'db-per-page': (el) => changeDbPerPage(el.value),
            'select-all-db': (el) => toggleDbSelectAll(el)
        };

        const ADMIN_INPUT_ACTIONS = {
            'overview-text': () => updateOverviewText(),
            'debounce-records': () => debounceLoadRecordsData(),
            'debounce-batches': () => debounceLoadBatchesData(),
            'debounce-teachers': () => debounceLoadTeachersData(),
            'debounce-logs': () => debounceLoadLogs(),
            'render-sender-clients': () => renderSenderClientsList(),
            'debounce-db': () => debounceLoadDbData(),
            'token-modal-clear': () => toggleTokenModalClearBtn()
        };

        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const handler = ADMIN_CLICK_ACTIONS[target.dataset.action];
            if (handler) handler(target, target.dataset.arg);
        });

        document.addEventListener('change', (e) => {
            const target = e.target.closest('[data-change]');
            if (!target) return;
            const handler = ADMIN_CHANGE_ACTIONS[target.dataset.change];
            if (handler) handler(target, target.dataset.arg);
        });

        document.addEventListener('input', (e) => {
            const target = e.target.closest('[data-input]');
            if (!target) return;
            const handler = ADMIN_INPUT_ACTIONS[target.dataset.input];
            if (handler) handler(target, target.dataset.arg);
        });

        const dbRecordForm = document.getElementById('db-record-form');
        if (dbRecordForm) {
            dbRecordForm.addEventListener('submit', (e) => {
                e.preventDefault();
                saveDbRecord();
            });
        }

        const tokenModalInput = document.getElementById('token-modal-input');
        if (tokenModalInput) {
            tokenModalInput.addEventListener('keydown', (e) => {
                if (!e.isComposing && e.keyCode !== 229 && e.key === 'Enter') {
                    doSearchStudentByToken();
                }
            });
        }

        /* ========================================================
           System Bootstrap
           ======================================================== */
        (async () => {
            initTheme();
            setupTableWheelZoom();
            const authed = await checkAuth();
            if (authed) {
                await loadConfig();
                loadRecordsStats();
            }
            document.body.classList.add('page-ready', 'ready');
        })();
