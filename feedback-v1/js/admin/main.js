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
