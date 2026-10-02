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
    engineState: 'Idle', // Idle | Running | Paused | Stopped | Completed
    isTauri: typeof window.__TAURI__ !== 'undefined',
    currentTheme: localStorage.getItem('jf_theme') || 'light',
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
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),
    rosterList: document.getElementById('rosterList'),
    
    // 预览卡片
    previewName: document.getElementById('previewName'),
    previewId: document.getElementById('previewId'),
    previewCycle: document.getElementById('previewCycle'),
    previewStatus: document.getElementById('previewStatus'),
    retestCard: document.getElementById('retestCard'),
    retestUrlText: document.getElementById('retestUrlText'),
    copyRetestBtn: document.getElementById('copyRetestBtn'),
    openRetestBtn: document.getElementById('openRetestBtn'),
    previewMessage: document.getElementById('previewMessage'),
    previewWordCount: document.getElementById('previewWordCount'),
    
    // 进度与操作栏
    progressText: document.getElementById('progressText'),
    progressPct: document.getElementById('progressPct'),
    progressFill: document.getElementById('progressFill'),
    startBtn: document.getElementById('startBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    stopBtn: document.getElementById('stopBtn'),
    
    // 日志与控制台
    consoleBox: document.getElementById('consoleBox'),
    clearLogsBtn: document.getElementById('clearLogsBtn'),
    
    // 设置项
    intervalInput: document.getElementById('intervalInput'),
    batchSizeInput: document.getElementById('batchSizeInput'),
    batchCooldownInput: document.getElementById('batchCooldownInput'),
    cloudVisionToggle: document.getElementById('cloudVisionToggle'),
  };

  // ==========================================
  // 初始化函数
  // ==========================================
  function init() {
    initTheme();
    initNavigation();
    initMetricFilters();
    initSearch();
    initPreviewActions();
    initControls();
    initLogs();
    initWecomDetection();
    initFileLoader();

    // 默认载入演示数据 (测试.json 规格)
    loadMockData();
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
        <span class="col-cycle">${escapeHtml(student.cycle || '-')}</span>
        <span class="col-status">${statusBadge}</span>
      `;

      // 单击行选择学生并更新预览卡片
      row.addEventListener('click', (e) => {
        if (e.target.type === 'checkbox') return; // 复选框事件单独捕获
        selectStudent(originalIndex);
      });

      // 复选框勾选事件
      const cb = row.querySelector('.student-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) {
          state.selectedIndices.add(originalIndex);
        } else {
          state.selectedIndices.delete(originalIndex);
        }
        updateSelectAllState();
      });

      dom.rosterList.appendChild(row);
    });

    updateSelectAllState();
    updateMetrics();
  }

  function getStatusBadge(status) {
    switch (status) {
      case 'Success':
        return '<span class="status-pill success">已发送</span>';
      case 'Failed':
        return '<span class="status-pill failed">失败</span>';
      case 'Skipped':
        return '<span class="status-pill failed">跳过</span>';
      case 'Sending':
        return '<span class="status-pill pending">发送中...</span>';
      case 'Pending':
      default:
        return '<span class="status-pill pending">待发送</span>';
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
  // 6. 详情预览与错题本卡片
  // ==========================================
  function selectStudent(index) {
    state.activeStudentIndex = index;
    const student = state.students[index];
    if (!student) return;

    // 高亮行
    document.querySelectorAll('.roster-row').forEach(row => {
      row.classList.toggle('selected', parseInt(row.dataset.index, 10) === index);
    });

    dom.previewName.textContent = student.clean_name || student.studentName;
    dom.previewId.textContent = student.student_id ? `学号: ${student.student_id}` : '未指定学号';
    dom.previewCycle.textContent = student.cycle ? `周次: ${student.cycle}` : '第1周';
    
    // 状态标识
    dom.previewStatus.textContent = student.status === 'Success' ? '已发送' :
      (student.status === 'Failed' ? '发送失败' : '准备就绪');
    dom.previewStatus.className = 'status-pill ' + 
      (student.status === 'Success' ? 'success' : (student.status === 'Failed' ? 'failed' : 'pending'));

    dom.previewMessage.value = student.message || '';
    dom.previewWordCount.textContent = `${(student.message || '').length} 字`;

    // 检测专属错题本链接
    const retestMatch = (student.message || '').match(/https:\/\/vip\.wxjifang\.cn\/retest\.html\S+/);
    if (retestMatch) {
      dom.retestCard.style.display = 'flex';
      dom.retestUrlText.textContent = retestMatch[0];
      dom.retestUrlText.dataset.url = retestMatch[0];
    } else {
      dom.retestCard.style.display = 'none';
    }
  }

  function initPreviewActions() {
    dom.copyRetestBtn.addEventListener('click', () => {
      const url = dom.retestUrlText.dataset.url;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => {
        const originalText = dom.copyRetestBtn.textContent;
        dom.copyRetestBtn.textContent = '✅ 已复制!';
        setTimeout(() => {
          dom.copyRetestBtn.textContent = originalText;
        }, 1500);
      });
    });

    dom.openRetestBtn.addEventListener('click', () => {
      const url = dom.retestUrlText.dataset.url;
      if (!url) return;
      if (state.isTauri && window.__TAURI__.shell) {
        window.__TAURI__.shell.open(url);
      } else {
        window.open(url, '_blank');
      }
    });
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
      const itemsToSend = Array.from(state.selectedIndices).map(idx => state.students[idx]);
      const config = {
        batch_size: parseInt(dom.batchSizeInput.value, 10) || 15,
        item_interval_ms: parseInt(dom.intervalInput.value, 10) || 1200,
        batch_cooldown_sec: parseInt(dom.batchCooldownInput.value, 10) || 10,
        use_cloud_vision: dom.cloudVisionToggle.checked,
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
      appendLog('SUCCESS', `[发信成功] 已向 ${student.clean_name} 家长送达作业周反馈与错题本`);
      
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
          if (state.students[payload.index]) {
            state.students[payload.index].status = payload.status;
            renderRoster();
          }
        } else if (payload.type === 'StateChanged') {
          setEngineState(payload.state);
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
    const statusDot = dom.wecomStatus.querySelector('.status-dot');
    const statusLabel = dom.wecomStatus.querySelector('.status-label');

    if (state.isTauri) {
      setInterval(() => {
        window.__TAURI__.core.invoke('check_wecom_status')
          .then(online => {
            dom.wecomStatus.className = 'wecom-status ' + (online ? 'online' : 'offline');
            statusLabel.textContent = online ? '企微已就绪' : '企微未启动';
          })
          .catch(() => {});
      }, 3000);
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
    // 创建隐藏的 input[type=file] 以便在无原生对话框时直接使用浏览器文件选择
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
            // HTML 格式解析
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

    state.students = rawItems.map((item, idx) => {
      // 提取学号与姓名
      const rawName = item.studentName || item.student_name || `未知_${idx}`;
      const match = rawName.match(/^(\d{4,9})?\s*([^\d\s()（）]+)/);
      const studentId = item.student_id || (match ? match[1] || '' : '');
      const cleanName = item.clean_name || (match ? match[2] || rawName : rawName);

      // 提取周次
      const cycleMatch = (item.message || '').match(/第\s*(\d+)\s*周/);
      const cycle = item.cycle || (cycleMatch ? `第${cycleMatch[1]}周` : '第1周');

      return {
        studentName: rawName,
        student_id: studentId,
        clean_name: cleanName,
        cycle: cycle,
        message: item.message || '',
        status: item.status || 'Pending',
      };
    });

    state.selectedIndices.clear();
    state.students.forEach((_, i) => state.selectedIndices.add(i));
    state.activeStudentIndex = 0;

    renderRoster();
    selectStudent(0);
    appendLog('INFO', `成功载入 [${sourceName}]：包含 ${state.students.length} 位学生数据`);
  }

  // 简易前端 HTML 解析器 (与 Rust parser.rs 的 parse_html 逻辑完全对齐)
  function parseHtmlFeedback(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
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
  // 11. 演示数据加载
  // ==========================================
  window.loadMockData = function () {
    const mockList = [
      {
        studentName: "90001张三",
        message: "张三家长您好，\n以下是小张数学作业情况反馈：\n-------------------------\n第3周课前预习作业得分为1，\n最高4，平均3，排名2/2。\n首字母一定要大写！！！！\n-------------------------\n第2周课后巩固作业得分为92，\n最高92，平均82，排名1/3。\n度数一定要记得带单位!!!!!\n\n【个人薄弱点】：②翻折与等腰、④角平分线辅助线\n【错题本】：点击链接查看本专题的错题\nhttps://vip.wxjifang.cn/retest.html?token=45zmH8hWgW"
      },
      {
        studentName: "80001李四",
        message: "李四家长您好，\n以下是小李数学作业情况反馈：\n-------------------------\n第3周课前预习作业得分为4，\n最高4，平均3，排名1/2。\n-------------------------\n第2周课后巩固作业得分为72，\n最高92，平均82，排名3/3。\n度数一定要记得带单位!!!!!\n\n【错题本】：点击链接查看本专题的错题\nhttps://vip.wxjifang.cn/retest.html?token=hizSN8xvgu"
      },
      {
        studentName: "70001王五",
        message: "王五家长您好，\n以下是小王数学作业情况反馈：\n-------------------------\n第3周课前预习作业未提交。\n-------------------------\n第2周课后巩固作业得分为82，\n最高92，平均82，排名2/3。\n度数一定要记得带单位!!!!!\n\n【个人薄弱点】：⑥等腰角度问题、⑧等腰三角形双分割问题\n【错题本】：点击链接查看本专题的错题\nhttps://vip.wxjifang.cn/retest.html?token=YZoGGwmZwA"
      }
    ];

    loadParsedData(mockList, "内置示范数据集 (测试.json)");
  };

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
