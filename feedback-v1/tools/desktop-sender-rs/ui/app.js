/**
 * 极方每周反馈程序 (Fluent 现代版) - 前端交互逻辑
 * 支持 Tauri 2.0 原生 IPC 双向通道与浏览器离线测试 Hybrid 模式
 */

(function () {
  'use strict';

  // ==========================================
  // 全局状态管理
  // ==========================================
  const state = {
    students: [],
    selectedIndices: new Set(),
    activeStudentIndex: -1,
    currentFilter: 'all', // all | pending | success | failed
    searchQuery: '',
    currentSourceName: '内置测试数据',
    engineState: 'Idle', // Idle | Running | Paused | Stopped | Completed
    isTauri: typeof window.__TAURI__ !== 'undefined',
    currentTheme: localStorage.getItem('jf_theme') || 'light',
    historyFilterCycle: 'all',
    historySearchQuery: '',
    activeModalArchiveId: null,
  };

  // DOM 元素引用
  const dom = {
    navItems: document.querySelectorAll('.nav-item'),
    pageViews: document.querySelectorAll('.page-view'),
    themeToggle: document.getElementById('themeToggle'),
    themeIcon: document.getElementById('themeIcon'),
    wecomStatus: document.getElementById('wecomStatus'),
    
    // 指标卡片
    metricCards: document.querySelectorAll('.metric-card'),
    countTotal: document.getElementById('countTotal'),
    countPending: document.getElementById('countPending'),
    countSuccess: document.getElementById('countSuccess'),
    countFailed: document.getElementById('countFailed'),
    
    // 工作台
    searchInput: document.getElementById('searchInput'),
    searchClearBtn: document.getElementById('searchClearBtn'),
    loadFileBtn: document.getElementById('loadFileBtn'),
    loadedFileBadge: document.getElementById('loadedFileBadge'),
    copyStudentBtn: document.getElementById('copyStudentBtn'),
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),
    rosterList: document.getElementById('rosterList'),
    
    // 预览卡片
    previewName: document.getElementById('previewName'),
    previewId: document.getElementById('previewId'),
    previewCycle: document.getElementById('previewCycle'),
    previewStatus: document.getElementById('previewStatus'),
    previewMessage: document.getElementById('previewMessage'),
    previewWordCount: document.getElementById('previewWordCount'),
    copyMessageBtn: document.getElementById('copyMessageBtn'),
    
    // 进度与操作栏
    progressText: document.getElementById('progressText'),
    progressPct: document.getElementById('progressPct'),
    progressFill: document.getElementById('progressFill'),
    startBtn: document.getElementById('startBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    stopBtn: document.getElementById('stopBtn'),
    
    // 历史档案页面
    hMetricBatches: document.getElementById('hMetricBatches'),
    hMetricStudents: document.getElementById('hMetricStudents'),
    hMetricRate: document.getElementById('hMetricRate'),
    historyCycleFilter: document.getElementById('historyCycleFilter'),
    historySearchInput: document.getElementById('historySearchInput'),
    historyTableBody: document.getElementById('historyTableBody'),
    historyEmptyState: document.getElementById('historyEmptyState'),
    clearAllHistoryBtn: document.getElementById('clearAllHistoryBtn'),

    // 历史档案学生明细弹窗
    historyDetailModal: document.getElementById('historyDetailModal'),
    modalArchiveTitle: document.getElementById('modalArchiveTitle'),
    modalArchiveSubtitle: document.getElementById('modalArchiveSubtitle'),
    closeModalBtn: document.getElementById('closeModalBtn'),
    modalMetaGrid: document.getElementById('modalMetaGrid'),
    modalRosterList: document.getElementById('modalRosterList'),
    exportArchiveCsvBtn: document.getElementById('exportArchiveCsvBtn'),
    loadArchiveToWorkspaceBtn: document.getElementById('loadArchiveToWorkspaceBtn'),

    // 日志与控制台
    consoleBox: document.getElementById('consoleBox'),
    clearLogsBtn: document.getElementById('clearLogsBtn'),
    
    // 设置项
    intervalInput: document.getElementById('intervalInput'),
    batchSizeInput: document.getElementById('batchSizeInput'),
    batchCooldownInput: document.getElementById('batchCooldownInput'),
  };

  // ==========================================
  // 初始化函数
  // ==========================================
  function init() {
    initTheme();
    initNavigation();
    initMetricFilters();
    initSearch();
    initCopyActions();
    initControls();
    initLogs();
    initWecomDetection();
    initFileLoader();
    initHistoryModule();

    // 默认空状态初始化，等待用户载入数据
    renderRoster();
  }

  // ==========================================
  // 1. 主题切换与持久化 (Fluent Light / Dark)
  // ==========================================
  function initTheme() {
    setTheme(state.currentTheme);
    dom.themeToggle.addEventListener('click', () => {
      const nextTheme = state.currentTheme === 'light' ? 'dark' : 'light';
      setTheme(nextTheme);
    });
  }

  function setTheme(theme) {
    state.currentTheme = theme;
    localStorage.setItem('jf_theme', theme);
    if (theme === 'dark') {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
      dom.themeIcon.textContent = '🌙';
    } else {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      dom.themeIcon.textContent = '☀️';
    }
  }

  // ==========================================
  // 2. Navigation Rail 页面路由
  // ==========================================
  function initNavigation() {
    dom.navItems.forEach(item => {
      item.addEventListener('click', () => {
        const pageId = item.getAttribute('data-page');
        switchPage(pageId);
      });
    });
  }

  function switchPage(pageName) {
    dom.navItems.forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-page') === pageName);
    });
    dom.pageViews.forEach(page => {
      const targetId = 'page' + pageName.charAt(0).toUpperCase() + pageName.slice(1);
      page.classList.toggle('active', page.id === targetId);
    });

    if (pageName === 'history') {
      HistoryManager.render();
    }
  }

  // ==========================================
  // 3. 统计卡片与过滤
  // ==========================================
  function initMetricFilters() {
    dom.metricCards.forEach(card => {
      card.addEventListener('click', () => {
        dom.metricCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.currentFilter = card.getAttribute('data-filter') || 'all';
        renderRoster();
      });
    });
  }

  function updateMetrics() {
    let pending = 0, success = 0, failed = 0;
    state.students.forEach(s => {
      if (s.status === 'Success') success++;
      else if (s.status === 'Failed' || s.status === 'Skipped') failed++;
      else pending++;
    });

    const total = state.students.length;
    dom.countTotal.textContent = total;
    dom.countPending.textContent = pending;
    dom.countSuccess.textContent = success;
    dom.countFailed.textContent = failed;
  }

  // ==========================================
  // 4. 搜索框过滤与全选
  // ==========================================
  function initSearch() {
    dom.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim().toLowerCase();
      dom.searchClearBtn.style.display = state.searchQuery ? 'block' : 'none';
      renderRoster();
    });

    dom.searchClearBtn.addEventListener('click', () => {
      dom.searchInput.value = '';
      state.searchQuery = '';
      dom.searchClearBtn.style.display = 'none';
      renderRoster();
    });

    dom.selectAllCheckbox.addEventListener('change', (e) => {
      const checked = e.target.checked;
      const filtered = getFilteredStudents();
      filtered.forEach(({ originalIndex }) => {
        if (checked) {
          state.selectedIndices.add(originalIndex);
        } else {
          state.selectedIndices.delete(originalIndex);
        }
      });
      renderRoster();
    });
  }

  function getFilteredStudents() {
    const list = [];
    state.students.forEach((student, index) => {
      // 状态筛选
      if (state.currentFilter === 'pending' && student.status !== 'Pending' && student.status !== 'Sending') return;
      if (state.currentFilter === 'success' && student.status !== 'Success') return;
      if (state.currentFilter === 'failed' && student.status !== 'Failed' && student.status !== 'Skipped') return;

      // 关键词筛选
      if (state.searchQuery) {
        const idMatch = (student.student_id || '').toLowerCase().includes(state.searchQuery);
        const nameMatch = (student.clean_name || student.studentName || '').toLowerCase().includes(state.searchQuery);
        if (!idMatch && !nameMatch) return;
      }

      list.push({ student, originalIndex: index });
    });
    return list;
  }

  // ==========================================
  // 5. 名单渲染与列表交互
  // ==========================================
  function renderRoster() {
    const filtered = getFilteredStudents();
    dom.rosterList.innerHTML = '';

    if (filtered.length === 0) {
      dom.rosterList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <div class="empty-text">未找到符合条件的学生记录</div>
        </div>`;
      updateMetrics();
      updateSelectAllState();
      return;
    }

    filtered.forEach(({ student, originalIndex }) => {
      const row = document.createElement('div');
      row.className = 'roster-row' + (originalIndex === state.activeStudentIndex ? ' selected' : '');
      row.dataset.index = originalIndex;

      const isChecked = state.selectedIndices.has(originalIndex);
      const statusBadge = getStatusBadge(student.status);

      row.innerHTML = `
        <span class="col-check">
          <input type="checkbox" class="student-checkbox" ${isChecked ? 'checked' : ''} data-index="${originalIndex}" />
        </span>
        <span class="col-id">${escapeHtml(student.student_id || '-')}</span>
        <span class="col-name">${escapeHtml(student.clean_name || student.studentName)}</span>
        <span class="col-cycle">${escapeHtml(student.cycle || '第1周')}</span>
        <span class="col-status">${statusBadge}</span>
      `;

      // 点击整行切换选中预览
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('student-checkbox')) return;
        selectStudent(originalIndex);
      });

      // 独立复选框勾选
      const cb = row.querySelector('.student-checkbox');
      cb.addEventListener('change', (e) => {
        const checked = e.target.checked;
        if (checked) {
          state.selectedIndices.add(originalIndex);
        } else {
          state.selectedIndices.delete(originalIndex);
        }
        updateSelectAllState();
      });

      dom.rosterList.appendChild(row);
    });

    updateMetrics();
    updateSelectAllState();
  }

  function getStatusBadge(status) {
    switch (status) {
      case 'Success':
        return '<span class="status-pill success">已发送</span>';
      case 'Sending':
        return '<span class="status-pill pending">发送中...</span>';
      case 'Failed':
        return '<span class="status-pill failed">失败</span>';
      case 'Skipped':
        return '<span class="status-pill failed">跳过</span>';
      case 'Pending':
      default:
        return '<span class="status-pill">待发送</span>';
    }
  }

  function updateSelectAllState() {
    const filtered = getFilteredStudents();
    if (filtered.length === 0) {
      dom.selectAllCheckbox.checked = false;
      dom.selectAllCheckbox.indeterminate = false;
      return;
    }
    const allChecked = filtered.every(item => state.selectedIndices.has(item.originalIndex));
    const someChecked = filtered.some(item => state.selectedIndices.has(item.originalIndex));
    dom.selectAllCheckbox.checked = allChecked;
    dom.selectAllCheckbox.indeterminate = !allChecked && someChecked;
  }

  // ==========================================
  // 6. 详情预览与快捷复制 (学号姓名 / 评语文案)
  // ==========================================
  function selectStudent(index) {
    state.activeStudentIndex = index;
    const student = state.students[index];
    if (!student) return;

    // 高亮当前行
    document.querySelectorAll('.roster-row').forEach(row => {
      row.classList.toggle('selected', parseInt(row.dataset.index, 10) === index);
    });

    dom.previewName.textContent = student.clean_name || student.studentName;
    dom.previewId.textContent = student.student_id ? `学号: ${student.student_id}` : '未指定学号';
    dom.previewCycle.textContent = student.cycle ? `周次: ${student.cycle}` : '第1周';
    
    // 状态标识
    dom.previewStatus.textContent = student.status === 'Success' ? '已发送' :
      (student.status === 'Failed' ? '发送失败' : (student.status === 'Sending' ? '发送中...' : '准备就绪'));
    dom.previewStatus.className = 'status-pill ' + 
      (student.status === 'Success' ? 'success' : (student.status === 'Failed' ? 'failed' : 'pending'));

    dom.previewMessage.value = student.message || '';
    dom.previewWordCount.textContent = `${(student.message || '').length} 字`;
  }

  function initCopyActions() {
    // 1. 左侧：复制当前选中学生的学号加姓名（如 "12345，吴涛"）
    if (dom.copyStudentBtn) {
      dom.copyStudentBtn.addEventListener('click', () => {
        if (state.activeStudentIndex < 0 || !state.students[state.activeStudentIndex]) {
          alert('请先在左侧列表中点击选择学生！');
          return;
        }
        const student = state.students[state.activeStudentIndex];
        const studentName = student.clean_name || student.studentName || '';
        const studentId = student.student_id ? String(student.student_id).trim() : '';
        // 严格按照用户指定的中文逗号格式：例如 "12345，吴涛"
        const copyText = studentId ? `${studentId}，${studentName}` : studentName;

        safeCopyToClipboard(copyText, () => {
          const originalText = dom.copyStudentBtn.textContent;
          dom.copyStudentBtn.textContent = `✓ 已复制 (${copyText})!`;
          dom.copyStudentBtn.classList.add('btn-copied');
          setTimeout(() => {
            dom.copyStudentBtn.textContent = originalText;
            dom.copyStudentBtn.classList.remove('btn-copied');
          }, 1500);
        });
      });
    }

    // 2. 右侧：复制整个反馈文案
    if (dom.copyMessageBtn) {
      dom.copyMessageBtn.addEventListener('click', () => {
        const text = dom.previewMessage.value.trim();
        if (!text) {
          alert('当前选中的学生暂无反馈文案！');
          return;
        }
        safeCopyToClipboard(text, () => {
          const originalText = dom.copyMessageBtn.textContent;
          dom.copyMessageBtn.textContent = '✓ 文案已复制!';
          dom.copyMessageBtn.classList.add('btn-copied');
          setTimeout(() => {
            dom.copyMessageBtn.textContent = originalText;
            dom.copyMessageBtn.classList.remove('btn-copied');
          }, 1500);
        });
      });
    }
  }

  function safeCopyToClipboard(text, onSuccess) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
        fallbackCopy(text, onSuccess);
      });
    } else {
      fallbackCopy(text, onSuccess);
    }
  }

  function fallbackCopy(text, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      if (onSuccess) onSuccess();
    } catch (e) {
      alert('写入系统剪贴板失败，请手动选择复制。');
    }
    document.body.removeChild(ta);
  }

  // ==========================================
  // 7. 发送控制与状态机 (支持 Tauri 与 Mock 模拟)
  // ==========================================
  let mockTimer = null;

  function initControls() {
    dom.startBtn.addEventListener('click', onStartClick);
    dom.pauseBtn.addEventListener('click', onPauseClick);
    dom.stopBtn.addEventListener('click', onStopClick);
    dom.clearLogsBtn.addEventListener('click', () => {
      dom.consoleBox.innerHTML = '';
      appendLog('INFO', '控制台日志已清空');
    });
  }

  function setEngineState(newState) {
    state.engineState = newState;
    switch (newState) {
      case 'Running':
        dom.startBtn.disabled = true;
        dom.pauseBtn.disabled = false;
        dom.stopBtn.disabled = false;
        dom.pauseBtn.textContent = '⏸ 暂停';
        dom.progressText.textContent = '自动化发信中... 请保持企微窗口在前台';
        break;
      case 'Paused':
        dom.startBtn.disabled = true;
        dom.pauseBtn.disabled = false;
        dom.stopBtn.disabled = false;
        dom.pauseBtn.textContent = '▶️ 继续';
        dom.progressText.textContent = '发信已挂起暂停';
        break;
      case 'Stopped':
      case 'Completed':
      case 'Idle':
      default:
        dom.startBtn.disabled = false;
        dom.pauseBtn.disabled = true;
        dom.stopBtn.disabled = true;
        dom.pauseBtn.textContent = '⏸ 暂停';
        dom.progressText.textContent = newState === 'Completed' ? '🎉 全部发送完毕！' : '等待开始任务';
        break;
    }
  }

  function onStartClick() {
    const selectedCount = state.selectedIndices.size;
    if (selectedCount === 0) {
      alert('请先在左侧列表中勾选需要发送的学生！');
      return;
    }

    appendLog('INFO', `启动批量发信流程，勾选发送对象: ${selectedCount} 人`);
    setEngineState('Running');

    if (state.isTauri) {
      // Tauri 原生后端调用
      const itemsToSend = Array.from(state.selectedIndices).map(idx => {
        const student = state.students[idx];
        return {
          ...student,
          original_index: idx,
          originalIndex: idx,
        };
      });
      const config = {
        batch_size: parseInt(dom.batchSizeInput.value, 10) || 15,
        item_interval_ms: parseInt(dom.intervalInput.value, 10) || 1200,
        batch_cooldown_sec: parseInt(dom.batchCooldownInput.value, 10) || 10,
        use_cloud_vision: true, // 强制默认启用 AI 视觉双保险体系
      };
      window.__TAURI__.core.invoke('start_send', { items: itemsToSend, config })
        .catch(err => {
          appendLog('ERROR', `调用底层引擎失败: ${err}`);
          setEngineState('Stopped');
        });
    } else {
      // 浏览器端纯前端模拟演练
      simulateSendingLoop();
    }
  }

  function onPauseClick() {
    if (state.engineState === 'Running') {
      appendLog('WARN', '用户触发暂停，挂起发信队列');
      setEngineState('Paused');
      if (state.isTauri) {
        window.__TAURI__.core.invoke('pause_send');
      } else {
        clearTimeout(mockTimer);
      }
    } else if (state.engineState === 'Paused') {
      appendLog('INFO', '用户触发继续，恢复发信队列');
      setEngineState('Running');
      if (state.isTauri) {
        window.__TAURI__.core.invoke('resume_send');
      } else {
        simulateSendingLoop();
      }
    }
  }

  function onStopClick() {
    appendLog('WARN', '用户触发强制终止，停止自动化发信');
    setEngineState('Stopped');
    if (state.isTauri) {
      window.__TAURI__.core.invoke('stop_send');
    } else {
      clearTimeout(mockTimer);
    }
  }

  function simulateSendingLoop() {
    const queue = Array.from(state.selectedIndices).filter(idx => {
      const s = state.students[idx];
      return s.status === 'Pending' || s.status === 'Sending';
    });

    if (queue.length === 0) {
      setEngineState('Completed');
      updateProgress(100);
      appendLog('SUCCESS', '所有勾选学生已全部发送完毕');
      HistoryManager.archiveCurrentWorkspace();
      return;
    }

    const currentIdx = queue[0];
    const student = state.students[currentIdx];
    student.status = 'Sending';
    selectStudent(currentIdx);
    renderRoster();

    appendLog('INFO', `[正在处理] 正在搜索联系人: ${student.student_id} ${student.clean_name}`);

    const interval = parseInt(dom.intervalInput.value, 10) || 1200;
    mockTimer = setTimeout(() => {
      if (state.engineState !== 'Running') return;

      student.status = 'Success';
      appendLog('SUCCESS', `[发信成功] 已向 ${student.clean_name} 家长送达作业周反馈`);
      
      const totalSelected = state.selectedIndices.size;
      const finishedCount = Array.from(state.selectedIndices).filter(i => state.students[i].status === 'Success').length;
      const pct = Math.round((finishedCount / totalSelected) * 100);
      updateProgress(pct);

      renderRoster();
      selectStudent(currentIdx);

      simulateSendingLoop();
    }, interval);
  }

  function updateProgress(pct) {
    dom.progressFill.style.width = `${pct}%`;
    dom.progressPct.textContent = `${pct}%`;
  }

  // ==========================================
  // 8. 实时运行日志
  // ==========================================
  function initLogs() {
    // 监听来自 Tauri 的事件广播
    if (state.isTauri && window.__TAURI__.event) {
      window.__TAURI__.event.listen('engine-event', (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (payload.type === 'Log') {
          appendLog(payload.level, payload.message);
        } else if (payload.type === 'Progress') {
          const pct = Math.round((payload.current / payload.total) * 100);
          updateProgress(pct);
        } else if (payload.type === 'ItemUpdated') {
          const targetIndex = (payload.index !== undefined && payload.index !== null) ? payload.index : payload.original_index;
          if (targetIndex !== undefined && state.students[targetIndex]) {
            state.students[targetIndex].status = payload.status;
            renderRoster();
          }
        } else if (payload.type === 'StateChanged') {
          setEngineState(payload.state);
          if (payload.state === 'Completed') {
            HistoryManager.archiveCurrentWorkspace();
          }
        }
      });
    }
  }

  function appendLog(level, message) {
    const line = document.createElement('div');
    const timeStr = new Date().toTimeString().split(' ')[0];
    line.className = `log-line log-${level.toLowerCase()}`;
    line.textContent = `[${timeStr} ${level}] ${message}`;
    dom.consoleBox.appendChild(line);
    dom.consoleBox.scrollTop = dom.consoleBox.scrollHeight;
  }

  // ==========================================
  // 9. 企微窗口状态自检
  // ==========================================
  function initWecomDetection() {
    const statusLabel = dom.wecomStatus.querySelector('.status-label');

    if (state.isTauri) {
      const check = () => {
        window.__TAURI__.core.invoke('check_wecom_status')
          .then(online => {
            dom.wecomStatus.className = 'wecom-status ' + (online ? 'online' : 'offline');
            statusLabel.textContent = online ? '企微已就绪' : '企微未启动';
          })
          .catch(() => {});
      };
      // 启动时立即自检一次，避免等待初始延迟
      check();
      setInterval(check, 2500);
    } else {
      // 演示模式默认就绪
      setTimeout(() => {
        dom.wecomStatus.className = 'wecom-status online';
        statusLabel.textContent = '企微在线 (演示)';
      }, 600);
    }
  }

  // ==========================================
  // 10. 数据载入与文件解析 (JSON / HTML)
  // ==========================================
  function initFileLoader() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.html,.htm';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        try {
          if (file.name.endsWith('.json')) {
            const data = JSON.parse(text);
            loadParsedData(data, file.name);
          } else {
            const data = parseHtmlFeedback(text);
            loadParsedData(data, file.name);
          }
        } catch (err) {
          alert('文件解析失败: ' + err.message);
        }
      };
      reader.readAsText(file, 'utf-8');
    });

    dom.loadFileBtn.addEventListener('click', () => {
      if (state.isTauri && window.__TAURI__.dialog) {
        window.__TAURI__.dialog.open({
          filters: [{ name: '反馈数据文件', extensions: ['json', 'html', 'htm'] }],
        }).then(selected => {
          if (selected) {
            window.__TAURI__.core.invoke('load_data_file', { path: selected })
              .then(items => loadParsedData(items, selected));
          }
        });
      } else {
        fileInput.click();
      }
    });
  }

  function loadParsedData(rawItems, sourceName) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      alert('数据文件中未发现有效学生反馈记录！');
      return;
    }

    state.currentSourceName = sourceName || '未命名数据';

    // 匹配同班级/来源且同周期的历史已发送档案
    const archives = HistoryManager.getAllArchives();
    const historySentMap = new Map();
    archives.forEach(arch => {
      (arch.students || []).forEach(s => {
        if (s.status === 'Success') {
          const cyc = (s.cycle || arch.cycle || '').trim();
          if (s.student_id) historySentMap.set(`${s.student_id}_${cyc}`, true);
          if (s.clean_name) historySentMap.set(`${s.clean_name}_${cyc}`, true);
          if (s.studentName) historySentMap.set(`${s.studentName}_${cyc}`, true);
        }
      });
    });

    state.selectedIndices.clear();

    state.students = rawItems.map((item, idx) => {
      // 提取学号与姓名
      const rawName = item.studentName || item.student_name || `未知_${idx}`;
      const match = rawName.match(/^(\d{4,9})?\s*([^\d\s()（）]+)/);
      const studentId = item.student_id ? String(item.student_id).trim() : (match ? match[1] || '' : '');
      const cleanName = item.clean_name || (match ? match[2] || rawName : rawName);

      // 提取周次
      const cycleMatch = (item.message || '').match(/第\s*(\d+)\s*周/);
      const cycle = item.cycle || (cycleMatch ? `第${cycleMatch[1]}周` : '第1周');

      // 联动历史档案：如果当前周次已送达，自动标记为已发送并不予默认勾选
      let isAlreadySent = false;
      if (studentId && historySentMap.has(`${studentId}_${cycle}`)) {
        isAlreadySent = true;
      } else if (historySentMap.has(`${cleanName}_${cycle}`) || historySentMap.has(`${rawName}_${cycle}`)) {
        isAlreadySent = true;
      }

      const initialStatus = isAlreadySent ? 'Success' : (item.status || 'Pending');
      if (initialStatus !== 'Success') {
        state.selectedIndices.add(idx);
      }

      return {
        studentName: rawName,
        student_id: studentId,
        clean_name: cleanName,
        cycle: cycle,
        message: item.message || '',
        status: initialStatus,
        original_index: idx,
      };
    });

    state.activeStudentIndex = 0;

    // 更新标题栏徽章
    if (dom.loadedFileBadge) {
      const shortName = sourceName.split(/[/\\]/).pop();
      dom.loadedFileBadge.textContent = `${shortName} (${state.students.length}人)`;
      dom.loadedFileBadge.title = sourceName;
    }

    renderRoster();
    selectStudent(0);
    appendLog('INFO', `成功载入 [${sourceName}]：包含 ${state.students.length} 位学生数据`);
  }

  function parseHtmlFeedback(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 1. 优先提取高保真内嵌 JSON 数据 (<script id="feedback-data">)
    const scriptEl = doc.getElementById('feedback-data');
    if (scriptEl && scriptEl.textContent) {
      try {
        const parsed = JSON.parse(scriptEl.textContent.trim());
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {
        console.warn('解析 HTML 内嵌 feedback-data JSON 异常，降级至 DOM 卡片解析:', e);
      }
    }

    // 2. DOM 卡片备用解析
    const cards = doc.querySelectorAll('.feedback-card, .student-card');
    const results = [];

    cards.forEach(card => {
      const nameEl = card.querySelector('.student-name, h3, h2');
      const msgEl = card.querySelector('.message-body, .feedback-text, pre');
      if (nameEl && msgEl) {
        results.push({
          studentName: nameEl.textContent.trim(),
          message: msgEl.textContent.trim(),
        });
      }
    });

    return results;
  }

  // ==========================================
  // 11. 历史发送档案管理中心 (HistoryManager)
  // ==========================================
  const HistoryManager = {
    STORAGE_KEY: 'jf_history_archives',

    getAllArchives() {
      try {
        const raw = localStorage.getItem(this.STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    },

    saveArchives(list) {
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(list));
      } catch (e) {
        console.error('保存历史记录失败:', e);
      }
    },

    archiveCurrentWorkspace() {
      if (!state.students || state.students.length === 0) return;
      const archives = this.getAllArchives();
      const firstCycle = state.students[0].cycle || '第1周';
      const shortName = state.currentSourceName.split(/[/\\]/).pop().replace(/\.[^/.]+$/, '');
      const nowStr = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
      
      const newArchive = {
        id: 'arch_' + Date.now(),
        name: shortName || '批量发送档案',
        cycle: firstCycle,
        timestamp: nowStr,
        students: JSON.parse(JSON.stringify(state.students)),
      };

      // 插入到首部
      archives.unshift(newArchive);
      this.saveArchives(archives);
      this.render();
      appendLog('INFO', `历史台账已更新归档：${newArchive.name} [${newArchive.cycle}]`);
    },

    deleteArchive(id) {
      if (!confirm('确定要删除这条历史发送档案吗？')) return;
      let archives = this.getAllArchives();
      archives = archives.filter(a => a.id !== id);
      this.saveArchives(archives);
      this.render();
    },

    clearAll() {
      if (!confirm('确定要清空所有历史发送档案吗？此操作无法恢复！')) return;
      this.saveArchives([]);
      this.render();
    },

    render() {
      const archives = this.getAllArchives();

      // 1. 更新顶部指标
      let totalBatches = archives.length;
      let totalSent = 0;
      let totalCount = 0;

      archives.forEach(arch => {
        const students = arch.students || [];
        totalCount += students.length;
        totalSent += students.filter(s => s.status === 'Success').length;
      });

      const rate = totalCount > 0 ? Math.round((totalSent / totalCount) * 100) : 100;
      dom.hMetricBatches.textContent = totalBatches;
      dom.hMetricStudents.textContent = `${totalSent} 人`;
      dom.hMetricRate.textContent = `${rate}%`;

      // 2. 更新周次下拉筛选器
      const cycles = Array.from(new Set(archives.map(a => a.cycle || '第1周'))).sort();
      const currentVal = dom.historyCycleFilter.value || 'all';
      dom.historyCycleFilter.innerHTML = '<option value="all">全部周次</option>';
      cycles.forEach(cyc => {
        const opt = document.createElement('option');
        opt.value = cyc;
        opt.textContent = cyc;
        dom.historyCycleFilter.appendChild(opt);
      });
      dom.historyCycleFilter.value = cycles.includes(currentVal) ? currentVal : 'all';

      // 3. 过滤并渲染表格
      const selectedCycle = dom.historyCycleFilter.value;
      const searchKeyword = (dom.historySearchInput.value || '').trim().toLowerCase();

      const filtered = archives.filter(arch => {
        if (selectedCycle !== 'all' && (arch.cycle || '第1周') !== selectedCycle) return false;
        if (searchKeyword) {
          const matchName = (arch.name || '').toLowerCase().includes(searchKeyword);
          const matchCycle = (arch.cycle || '').toLowerCase().includes(searchKeyword);
          if (!matchName && !matchCycle) return false;
        }
        return true;
      });

      dom.historyTableBody.innerHTML = '';
      if (filtered.length === 0) {
        dom.historyEmptyState.style.display = 'flex';
        return;
      }
      dom.historyEmptyState.style.display = 'none';

      filtered.forEach(arch => {
        const students = arch.students || [];
        const total = students.length;
        const success = students.filter(s => s.status === 'Success').length;
        const pct = total > 0 ? Math.round((success / total) * 100) : 0;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(arch.name)}</strong></td>
          <td><span class="badge-cycle">${escapeHtml(arch.cycle || '第1周')}</span></td>
          <td>
            <div class="table-progress">
              <span>${success}/${total} 人</span>
              <div class="table-progress-bar">
                <div class="table-progress-fill" style="width: ${pct}%;"></div>
              </div>
            </div>
          </td>
          <td><span class="${pct === 100 ? 'text-success' : 'text-warning'} font-weight-bold">${pct}%</span></td>
          <td><span style="color: var(--text-muted); font-size: 12px;">${escapeHtml(arch.timestamp)}</span></td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 6px;">
              <button class="btn btn-sm btn-secondary btn-detail" data-id="${arch.id}">👁️ 明细</button>
              <button class="btn btn-sm btn-primary btn-load" data-id="${arch.id}">🚀 载入</button>
              <button class="btn btn-sm btn-danger btn-del" data-id="${arch.id}">🗑️</button>
            </div>
          </td>
        `;

        tr.querySelector('.btn-detail').addEventListener('click', () => {
          this.openDetailModal(arch.id);
        });
        tr.querySelector('.btn-load').addEventListener('click', () => {
          this.loadArchiveToWorkspace(arch.id);
        });
        tr.querySelector('.btn-del').addEventListener('click', () => {
          this.deleteArchive(arch.id);
        });

        dom.historyTableBody.appendChild(tr);
      });
    },

    openDetailModal(archiveId) {
      const archives = this.getAllArchives();
      const arch = archives.find(a => a.id === archiveId);
      if (!arch) return;

      state.activeModalArchiveId = archiveId;
      dom.modalArchiveTitle.textContent = arch.name;
      dom.modalArchiveSubtitle.textContent = `归档时间: ${arch.timestamp} | 周期: ${arch.cycle || '第1周'}`;

      const students = arch.students || [];
      const total = students.length;
      const successCount = students.filter(s => s.status === 'Success').length;
      const failedCount = total - successCount;

      dom.modalMetaGrid.innerHTML = `
        <div>总人数: <strong>${total} 人</strong></div>
        <div class="text-success">已成功送达: <strong>${successCount} 人</strong></div>
        <div class="${failedCount > 0 ? 'text-danger' : 'text-muted'}">未发送/异常: <strong>${failedCount} 人</strong></div>
      `;

      dom.modalRosterList.innerHTML = '';
      students.forEach(st => {
        const row = document.createElement('div');
        row.className = 'modal-student-row';
        const stName = escapeHtml(st.clean_name || st.studentName);
        const stId = escapeHtml(st.student_id || '-');
        const stStatus = getStatusBadge(st.status);
        const msgPreview = escapeHtml((st.message || '').replace(/\n/g, ' ').slice(0, 35)) + '...';

        row.innerHTML = `
          <div class="modal-student-main">
            <span style="font-weight: 600; min-width: 60px;">${stName}</span>
            <span class="id-badge">${stId}</span>
            <span style="font-size: 11.5px; color: var(--text-muted);">${msgPreview}</span>
          </div>
          <div>${stStatus}</div>
        `;
        dom.modalRosterList.appendChild(row);
      });

      dom.historyDetailModal.style.display = 'flex';
    },

    closeDetailModal() {
      dom.historyDetailModal.style.display = 'none';
      state.activeModalArchiveId = null;
    },

    loadArchiveToWorkspace(archiveId) {
      const archives = this.getAllArchives();
      const arch = archives.find(a => a.id === archiveId);
      if (!arch || !arch.students || arch.students.length === 0) {
        alert('该档案中无可用学生记录！');
        return;
      }

      loadParsedData(arch.students, `[历史归档] ${arch.name}`);
      this.closeDetailModal();
      switchPage('workspace');
    },

    exportArchiveToCsv(archiveId) {
      const archives = this.getAllArchives();
      const arch = archives.find(a => a.id === archiveId);
      if (!arch) return;

      const students = arch.students || [];
      let csvContent = '\uFEFF学号,姓名,周次,状态,最后归档时间,反馈评语\n';
      students.forEach(s => {
        const id = `"${(s.student_id || '').replace(/"/g, '""')}"`;
        const name = `"${(s.clean_name || s.studentName || '').replace(/"/g, '""')}"`;
        const cycle = `"${(s.cycle || arch.cycle || '').replace(/"/g, '""')}"`;
        const status = s.status === 'Success' ? '已发送' : '未发送/异常';
        const time = `"${arch.timestamp}"`;
        const msg = `"${(s.message || '').replace(/"/g, '""')}"`;
        csvContent += `${id},${name},${cycle},${status},${time},${msg}\n`;
      });

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `${arch.name}_${arch.cycle}_发送记录.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  function initHistoryModule() {
    dom.historyCycleFilter.addEventListener('change', () => HistoryManager.render());
    dom.historySearchInput.addEventListener('input', () => HistoryManager.render());
    dom.clearAllHistoryBtn.addEventListener('click', () => HistoryManager.clearAll());

    // 弹窗事件
    dom.closeModalBtn.addEventListener('click', () => HistoryManager.closeDetailModal());
    dom.historyDetailModal.addEventListener('click', (e) => {
      if (e.target === dom.historyDetailModal) {
        HistoryManager.closeDetailModal();
      }
    });

    dom.loadArchiveToWorkspaceBtn.addEventListener('click', () => {
      if (state.activeModalArchiveId) {
        HistoryManager.loadArchiveToWorkspace(state.activeModalArchiveId);
      }
    });

    dom.exportArchiveCsvBtn.addEventListener('click', () => {
      if (state.activeModalArchiveId) {
        HistoryManager.exportArchiveToCsv(state.activeModalArchiveId);
      }
    });
  }

  // 工具函数: 转义 HTML 防止 XSS
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
