/**
 * ============================================================================
 * 上传页各类文件上传、解析与列表管理模块
 * 包含：
 *   - 多文件类（课后巩固 / 课前预习 / 英语笔记 / 随堂测）统一解析与增删渲染
 *   - 统计报告（专注度积分）解析与最高分校准
 *   - 全员花名册（CSV/XLSX）解析、班级多选与名单外学生检测
 *   - 上传控件与拖拽区域初始化
 *
 * 依赖：common.js、upload.js（全局状态变量及步骤/校验回调）
 * ============================================================================
 */
(function () {
    'use strict';

    // ========== 通用解析与渲染工具 ==========
    function readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(reader.error || new Error('读取失败'));
            reader.onabort = () => reject(new Error('aborted'));
            reader.readAsArrayBuffer(file);
        });
    }

    function readXlsxFirstSheetRows(arrayBuffer) {
        if (typeof XLSX === 'undefined') {
            throw new Error('Excel 解析引擎 (SheetJS) 未就绪，请刷新页面后重试');
        }
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    }

    function rowsToCsvText(rows) {
        return rows.map(row => row.map(cell => {
            const s = String(cell);
            return s.includes(',') || s.includes('"') || s.includes('\n')
                ? '"' + s.replace(/"/g, '""') + '"'
                : s;
        }).join(',')).join('\n');
    }

    function buildFileItemHtml({ iconSvg, fileName, countText, previewType, index, removeCall, extraActionsHtml = '' }) {
        const safeName = escapeHtml(fileName);
        const safeAttrName = escapeAttr(fileName);
        return `
            <div class="file-info">
                <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${iconSvg}
                </svg>
                <span class="file-name" title="${safeAttrName}">${safeName} <span style="color:var(--text-tertiary)">(${escapeHtml(countText)})</span></span>
            </div>
            <div class="file-actions">
                <button type="button" class="file-action-btn file-preview-btn" onclick="if(event)event.stopPropagation(); previewUploadedFile('${previewType}', ${index}, event)" title="预览关键列数据">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    <span>预览</span>
                </button>
                ${extraActionsHtml}
                <div class="file-remove" onclick="${removeCall}" title="移除此文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            </div>
        `;
    }

    // ========== 辅助文件抓取上传 ==========
    // 纯诊断旁路：失败绝不影响主上传流程，但必须留痕。
    // 历史教训：此处曾是空 catch(e){}，把 Logger.getClientInfo 未导出导致的
    // TypeError 完全吞掉，使 api/upload_capture.php 长期静默收不到任何数据。
    function captureUploadedFile(file, type) {
        if (!window.Logger) return;
        try {
            const fp = Logger.getClientInfo().fingerprint || 'unknown';
            const formData = new FormData();
            formData.append('file', file);
            formData.append('fingerprint', fp);
            formData.append('type', type);
            fetch('api/upload_capture.php', {
                method: 'POST',
                body: formData
            }).catch((e) => console.warn('[capture] 诊断抓取上传失败:', e));
        } catch (e) {
            console.warn('[capture] 诊断抓取跳过:', e);
        }
    }

    // ========== 多文件上传配置表（Homework / Preview / Note / ClassTest） ==========
    function upsertRawFile(rawFiles, entry) {
        const existingIdx = rawFiles.findIndex(f => f.name === entry.name);
        if (existingIdx >= 0) {
            rawFiles[existingIdx] = entry;
        } else {
            rawFiles.push(entry);
        }
    }

    async function parseStandardCsvFile(file, typeKey, isAppend) {
        const text = await readFileAsTextWithProgress(
            file,
            () => { },
            (reader) => activeReaders.push(reader)
        );
        const data = parseCSV(text);
        if (data.length > 0) {
            const cfg = MULTI_FILE_TYPES[typeKey];
            upsertRawFile(cfg.getRawFiles(), { name: file.name, data, text });
            captureUploadedFile(file, cfg.captureType);
            Logger.action('file_uploaded', {
                type: cfg.logType,
                fileName: file.name,
                rows: data.length - 1,
                fileSize: file.size,
                isAppend
            });
        }
    }

    async function parseWenjuanxingPreviewFile(file) {
        const arrayBuffer = await readFileAsArrayBuffer(file);
        const rawJsonData = readXlsxFirstSheetRows(arrayBuffer);
        if (rawJsonData.length === 0) return;

        // 数据源瘦身：问卷星表格保留必要列（序号、姓名、总分及各题目作答列），剔除无用的提交时间、IP、来源等臃肿列。
        const header = rawJsonData[0].map(h => String(h).trim());
        const nameIdx = header.findIndex(h => h.includes('您的姓名') || (h.includes('姓名') && !h.includes('时间')));
        const scoreIdx = header.findIndex(h => h === '总分' || h.includes('总分'));
        let jsonData = rawJsonData;
        if (nameIdx >= 0 && scoreIdx >= 0) {
            const qCols = typeof extractWenjuanxingQuestionColumns === 'function'
                ? extractWenjuanxingQuestionColumns(header)
                : [];
            const qColIndices = qCols.map(c => c.colIdx);
            const colIndices = [0, nameIdx, scoreIdx, ...qColIndices].filter((v, i, a) => a.indexOf(v) === i);
            jsonData = rawJsonData.map(row => colIndices.map(idx => row[idx] ?? ''));

            if (typeof getWenjuanxingBenchmark === 'function') {
                const bm = getWenjuanxingBenchmark(jsonData);
                if (bm && bm.questionCount > 0) {
                    if (bm.isR1Benchmark) {
                        showToast(`问卷星已识别 ${bm.questionCount} 道题，首行（${bm.benchmarkName}）为满分标定卷已设为标准答案`, 'success');
                    } else {
                        showToast(`问卷星已识别 ${bm.questionCount} 道题，已根据最高分（${bm.maxScore}分）答卷提取标准答案`, 'info');
                    }
                }
            }
        }
        const csvText = rowsToCsvText(jsonData);
        upsertRawFile(rawPreviewFiles, { name: file.name, data: jsonData, text: csvText });
        captureUploadedFile(file, 'preview_xlsx');
    }

    const MULTI_FILE_TYPES = {
        homework: {
            getRawFiles: () => rawHomeworkFiles,
            setRawFiles: (v) => { rawHomeworkFiles = v; },
            setData: (v) => { homeworkData = v; },
            setFileName: (v) => { homeworkFileName = v; },
            getFileInput: () => homeworkFileInput,
            appendInputId: 'homework-file-append',
            getDropZone: () => homeworkDropZone,
            getInfoEl: () => homeworkInfo,
            defaultInfoText: '拖拽巩固作业文件或点击浏览',
            listContainerId: 'file-list-container',
            fileCountId: 'file-count',
            fileListId: 'homework-file-list',
            captureType: 'homework',
            logType: 'homework',
            previewType: 'homework',
            removeHandlerName: 'removeHomeworkFile',
            iconSvg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
            getAppendLabel: () => `${getUploadHomeworkLabelFull()}文件`,
            getClearDialogText: () => ({
                title: `清空${getUploadHomeworkLabelFull()}文件`,
                body: `确定要清空所有已上传的${getUploadHomeworkLabelFull()}文件吗？`,
                toast: `已清空${getUploadHomeworkLabelFull()}文件`
            }),
            onEmpty: () => {
                checkNextButton();
            },
            onUpdated: () => {
                checkNextButton();
                if (physicsPreviewSource === 'wenjuanxing' && previewData) {
                    checkWenjuanxingNameMatches();
                }
                if (rosterData) {
                    checkDroppedStudents();
                }
            }
        },
        preview: {
            getRawFiles: () => rawPreviewFiles,
            setRawFiles: (v) => { rawPreviewFiles = v; },
            setData: (v) => { previewData = v; },
            setFileName: (v) => { previewFileName = v; },
            getFileInput: () => previewFileInput,
            appendInputId: 'preview-file-append',
            getDropZone: () => previewDropZone,
            getInfoEl: () => previewInfo,
            defaultInfoText: '拖拽预习作业文件或点击浏览',
            listContainerId: 'preview-file-list-container',
            fileCountId: 'preview-file-count',
            fileListId: 'preview-file-list',
            captureType: 'preview',
            logType: 'preview',
            previewType: 'preview',
            removeHandlerName: 'removePreviewFile',
            iconSvg: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>',
            getAppendLabel: () => '预习作业文件',
            getClearDialogText: () => ({
                title: '清空预习作业文件',
                body: '确定要清空所有已上传的预习作业文件吗？',
                toast: '已清空预习作业文件'
            }),
            validateFiles: (fileArray) => {
                const isWenjuanxing = physicsPreviewSource === 'wenjuanxing';
                for (const file of fileArray) {
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (isWenjuanxing) {
                        if (ext !== 'xlsx' && ext !== 'xls') {
                            showToast('问卷星请上传 XLSX 文件');
                            return false;
                        }
                    } else if (ext !== 'csv') {
                        showToast('请上传 CSV 文件');
                        return false;
                    }
                }
                return true;
            },
            parseFile: async (file, isAppend) => {
                if (physicsPreviewSource === 'wenjuanxing') {
                    await parseWenjuanxingPreviewFile(file);
                } else {
                    await parseStandardCsvFile(file, 'preview', isAppend);
                }
            },
            onEmpty: () => {
                checkNextButton();
                resetPreviewMetricModeOptions(true);
            },
            onUpdated: (header, allRows) => {
                checkNextButton();
                if (physicsPreviewSource !== 'wenjuanxing') {
                    checkPreviewScoreColumn(header, allRows);
                }
                if (physicsPreviewSource === 'wenjuanxing' && homeworkData) {
                    checkWenjuanxingNameMatches();
                }
                if (rosterData) {
                    checkDroppedStudents();
                }
            }
        },
        note: {
            getRawFiles: () => rawNoteFiles,
            setRawFiles: (v) => { rawNoteFiles = v; },
            setData: (v) => { noteData = v; },
            setFileName: (v) => { noteFileName = v; },
            getFileInput: () => noteFileInput,
            appendInputId: 'note-file-append',
            getDropZone: () => noteDropZone,
            getInfoEl: () => noteInfo,
            defaultInfoText: '拖拽笔记作业文件或点击浏览',
            listContainerId: 'note-file-list-container',
            fileCountId: 'note-file-count',
            fileListId: 'note-file-list',
            captureType: 'note',
            logType: 'note',
            previewType: 'note',
            removeHandlerName: 'removeNoteFile',
            iconSvg: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
            getAppendLabel: () => '笔记作业文件',
            getClearDialogText: () => ({
                title: '清空笔记作业文件',
                body: '确定要清空所有已上传的笔记作业文件吗？',
                toast: '已清空笔记作业文件'
            })
        },
        classTest: {
            getRawFiles: () => rawClassTestFiles,
            setRawFiles: (v) => { rawClassTestFiles = v; },
            setData: (v) => { classTestData = v; },
            setFileName: (v) => { classTestFileName = v; },
            getFileInput: () => classTestFileInput,
            appendInputId: 'class-test-file-append',
            getDropZone: () => classTestDropZone,
            getInfoEl: () => classTestInfo,
            defaultInfoText: '拖拽课堂测试作业文件或点击浏览',
            listContainerId: 'class-test-file-list-container',
            fileCountId: 'class-test-file-count',
            fileListId: 'class-test-file-list',
            captureType: 'class_test',
            logType: 'class_test',
            previewType: 'class_test',
            removeHandlerName: 'removeClassTestFile',
            iconSvg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line>',
            getAppendLabel: () => '课堂测试作业文件',
            getClearDialogText: () => ({
                title: '清空课堂测试作业文件',
                body: '确定要清空所有已上传的课堂测试作业文件吗？',
                toast: '已清空课堂测试作业文件'
            })
        }
    };

    async function handleMultiFiles(typeKey, files, isAppend = false) {
        if (!requireSubject()) return;
        const cfg = MULTI_FILE_TYPES[typeKey];
        const fileArray = Array.from(files);

        if (cfg.validateFiles) {
            if (!cfg.validateFiles(fileArray)) return;
        } else {
            for (const file of fileArray) {
                if (!file.name.endsWith('.csv')) {
                    showToast('请上传CSV文件');
                    return;
                }
            }
        }

        uploadCancelled = false;
        if (!isAppend) {
            cfg.setRawFiles([]);
        }

        for (const file of fileArray) {
            if (uploadCancelled) break;
            try {
                if (cfg.parseFile) {
                    await cfg.parseFile(file, isAppend);
                } else {
                    await parseStandardCsvFile(file, typeKey, isAppend);
                }
            } catch (error) {
                if (error?.message === 'aborted') return;
                Logger.error('file_parse_error', {
                    type: cfg.logType,
                    fileName: file.name,
                    error: error?.message || String(error)
                });
                console.error('文件读取失败:', error);
                showToast(`文件 ${file.name} 读取失败`);
            }
        }

        activeReaders = [];
        const fileInput = cfg.getFileInput();
        if (fileInput) fileInput.value = '';
        const appendInput = document.getElementById(cfg.appendInputId);
        if (appendInput) appendInput.value = '';

        updateMultiFileData(typeKey);
        if (isAppend && fileArray.length > 0) {
            showToast(`已追加 ${fileArray.length} 个${cfg.getAppendLabel()}`);
        }
    }

    function updateMultiFileData(typeKey) {
        const cfg = MULTI_FILE_TYPES[typeKey];
        const rawFiles = cfg.getRawFiles();
        const container = document.getElementById(cfg.listContainerId);
        const dropZone = cfg.getDropZone();
        const infoEl = cfg.getInfoEl();

        if (rawFiles.length === 0) {
            cfg.setData(null);
            cfg.setFileName('');
            if (dropZone) dropZone.classList.remove('uploaded');
            if (infoEl) infoEl.textContent = cfg.defaultInfoText;
            if (container) container.classList.remove('visible');
            renderMultiFileList(typeKey);
            if (cfg.onEmpty) cfg.onEmpty();
            return;
        }

        const header = rawFiles[0].data[0];
        const allRows = [];
        rawFiles.forEach(file => {
            if (file.data.length > 1) {
                allRows.push(...file.data.slice(1));
            }
        });
        cfg.setData([header, ...allRows]);
        cfg.setFileName(rawFiles[0].name);
        if (dropZone) dropZone.classList.add('uploaded');

        const infoText = rawFiles.length > 1
            ? `已加载 ${rawFiles.length} 个文件 (${allRows.length}条数据)`
            : `已加载 (${allRows.length}条数据)`;
        if (infoEl) infoEl.textContent = infoText;

        if (container) container.classList.add('visible');

        const fileCount = document.getElementById(cfg.fileCountId);
        if (fileCount) {
            fileCount.textContent = `${rawFiles.length} 个文件`;
        }

        renderMultiFileList(typeKey);
        if (cfg.onUpdated) cfg.onUpdated(header, allRows);
    }

    function renderMultiFileList(typeKey) {
        const cfg = MULTI_FILE_TYPES[typeKey];
        const list = document.getElementById(cfg.fileListId);
        if (!list) return;

        const rawFiles = cfg.getRawFiles();
        list.innerHTML = '';
        if (rawFiles.length === 0) return;

        rawFiles.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'file-item';
            const count = file.data.length > 1 ? file.data.length - 1 : 0;
            item.innerHTML = buildFileItemHtml({
                iconSvg: cfg.iconSvg,
                fileName: file.name,
                countText: `${count}条`,
                previewType: cfg.previewType,
                index,
                removeCall: `${cfg.removeHandlerName}(${index})`
            });
            list.appendChild(item);
        });
    }

    function removeMultiFile(typeKey, index) {
        const cfg = MULTI_FILE_TYPES[typeKey];
        const rawFiles = cfg.getRawFiles();
        if (index >= 0 && index < rawFiles.length) {
            const name = rawFiles[index].name;
            rawFiles.splice(index, 1);
            updateMultiFileData(typeKey);
            showToast(`已移除文件: ${name}`);
        }
    }

    function clearMultiFiles(typeKey) {
        const cfg = MULTI_FILE_TYPES[typeKey];
        if (cfg.getRawFiles().length === 0) return;
        const { title, body, toast } = cfg.getClearDialogText();
        showCustomDialog({
            title,
            body,
            confirmText: '清空',
            danger: true,
            onConfirm: () => {
                cfg.setRawFiles([]);
                updateMultiFileData(typeKey);
                showToast(toast);
            }
        });
    }

    // 保留各业务具名函数接口，兼容现有调用方与事件委托
    const handleHomeworkFiles = (files, isAppend = false) => handleMultiFiles('homework', files, isAppend);
    const updateHomeworkData = () => updateMultiFileData('homework');
    const renderHomeworkFileList = () => renderMultiFileList('homework');
    const removeHomeworkFile = (index) => removeMultiFile('homework', index);
    const clearHomeworkFiles = () => clearMultiFiles('homework');

    const handlePreviewFiles = (files, isAppend = false) => handleMultiFiles('preview', files, isAppend);
    const updatePreviewData = () => updateMultiFileData('preview');
    const renderPreviewFileList = () => renderMultiFileList('preview');
    const removePreviewFile = (index) => removeMultiFile('preview', index);
    const clearPreviewFiles = () => clearMultiFiles('preview');

    const handleNoteFiles = (files, isAppend = false) => handleMultiFiles('note', files, isAppend);
    const updateNoteData = () => updateMultiFileData('note');
    const renderNoteFileList = () => renderMultiFileList('note');
    const removeNoteFile = (index) => removeMultiFile('note', index);
    const clearNoteFiles = () => clearMultiFiles('note');

    const handleClassTestFiles = (files, isAppend = false) => handleMultiFiles('classTest', files, isAppend);
    const updateClassTestData = () => updateMultiFileData('classTest');
    const renderClassTestFileList = () => renderMultiFileList('classTest');
    const removeClassTestFile = (index) => removeMultiFile('classTest', index);
    const clearClassTestFiles = () => clearMultiFiles('classTest');

    // ========== Report File Handling ==========
    async function handleReportFile(file) {
        if (!requireSubject()) return;
        if (!file.name.endsWith('.csv')) {
            showToast('请上传CSV文件');
            return;
        }
        uploadCancelled = false;
        try {
            const text = await readFileAsTextWithProgress(
                file,
                () => { },
                (reader) => activeReaders.push(reader)
            );
            reportFileName = file.name;
            reportData = parseCSV(text);
            if (reportData && reportData.length > 0) {
                const rptHeader = reportData[0];
                const attIdx = rptHeader.findIndex(h =>
                    (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) &&
                    !h.includes('时长') && !h.includes('率')
                );
                if (attIdx < 0) {
                    rptHeader.push('是否有效出勤');
                    const rewardIdx = rptHeader.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
                    for (let i = 1; i < reportData.length; i++) {
                        const row = reportData[i];
                        const reward = rewardIdx >= 0 ? String(row[rewardIdx] || '').trim() : '';
                        const isAbsent = (reward === '-' || reward === '');
                        row.push(isAbsent ? '缺勤' : '出勤');
                    }
                }
            }
            captureUploadedFile(file, 'report');
            reportDropZone.classList.add('uploaded');
            reportInfo.textContent = `已加载 (${reportData.length - 1}条数据)`;
            reportDropZone.dataset.rawText = text;

            detectAndSetFocusMaxScore(reportData);
            renderReportFileList();
            showToast('统计报告已加载');
        } catch (error) {
            if (error?.message !== 'aborted') {
                showToast(`文件 ${file.name} 读取失败`);
            }
        } finally {
            activeReaders = [];
            reportFileInput.value = '';
        }
    }

    function renderReportFileList() {
        const container = document.getElementById('report-file-list-container');
        const list = document.getElementById('report-file-list');
        const countEl = document.getElementById('report-file-count');
        if (!list) return;

        if (!reportData || !reportFileName) {
            list.innerHTML = '';
            if (container) container.classList.remove('visible');
            return;
        }

        if (container) container.classList.add('visible');
        if (countEl) countEl.textContent = '已上传统计报告';

        const header = reportData[0] || [];
        const classIdx = header.findIndex(h => String(h || '').includes('班级'));
        let countText = `${reportData.length - 1}条`;
        if (classIdx >= 0) {
            const beta1Count = reportData.slice(1).filter(r => String(r[classIdx] || '').trim().includes('β1')).length;
            countText = `β1: ${beta1Count}条 / 共${reportData.length - 1}条`;
        }

        const exportImgBtnHtml = `
            <button type="button" class="file-action-btn file-export-img-btn" onclick="if(event)event.stopPropagation(); exportLowFocusReportImage(event)" title="导出4分及以下专注度情况表格图片">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                <span>导出图片</span>
            </button>`;

        list.innerHTML = `<div class="file-item">${buildFileItemHtml({
            iconSvg: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18"></path><path d="M9 3v18"></path>',
            fileName: reportFileName,
            countText,
            previewType: 'report',
            index: 0,
            removeCall: 'clearReportFile()',
            extraActionsHtml: exportImgBtnHtml
        })}</div>`;
    }

    const COMPOUND_SURNAMES = new Set([
        '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙',
        '慕容', '长孙', '宇文', '司徒', '司空', '夏侯', '端木', '南宫',
        '百里', '东郭', '西门', '独孤', '令狐', '轩辕', '呼延', '太史',
        '申屠', '公冶', '宗政', '濮阳', '淳于', '单于', '公叔', '仲孙',
        '鲜于', '闾丘', '子车', '亓官', '钟离', '澹台', '公羊', '赫连',
        '拓跋', '闻人'
    ]);

    function maskStudentNameForFocusTable(rawName) {
        const clean = String(rawName || '').replace(/^\d+/, '').trim();
        if (!clean) return '-';
        const chars = Array.from(clean);
        if (chars.length <= 1) return chars[0];
        if (chars.length >= 3) {
            const firstTwo = chars[0] + chars[1];
            if (COMPOUND_SURNAMES.has(firstTwo)) {
                return firstTwo + '*'.repeat(chars.length - 2);
            }
        }
        return chars[0] + '*'.repeat(chars.length - 1);
    }

    function collectLowFocusRows(data, scoreOffset = 0) {
        if (!data || data.length < 2) return [];
        const header = data[0].map(h => String(h || '').trim());
        const rows = data.slice(1);

        const rewardIdx = header.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('专注度') || h.includes('课堂积分') || h === '积分');
        if (rewardIdx < 0) return [];

        const classIdx = header.findIndex(h => h.includes('班级'));
        let idIdx = header.findIndex(h => h === '学号' || h === '学生学号' || h === '学员编号' || h === '学生编号' || h === '编号' || h === '卡号');
        if (idIdx < 0) idIdx = header.findIndex(h => h.includes('学号') || h.includes('编号') || h.includes('卡号'));

        let nameIdx = header.findIndex(h => h === '姓名' || h === '学生姓名' || h === '学员姓名');
        if (nameIdx < 0) nameIdx = header.findIndex(h => h.includes('姓名'));

        const attIdx = header.findIndex(h =>
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) &&
            !h.includes('时长') && !h.includes('率')
        );

        const offset = Number.isFinite(scoreOffset) ? scoreOffset : 0;
        const result = [];

        rows.forEach(row => {
            if (!row || row.length === 0) return;

            if (attIdx >= 0) {
                const att = String(row[attIdx] || '').trim();
                if (att.includes('缺勤')) return;
            }

            const rawReward = String(row[rewardIdx] ?? '').trim();
            if (!rawReward || rawReward === '-') return;
            const rawVal = parseFloat(rawReward);
            if (!Number.isFinite(rawVal)) return;

            if (classIdx >= 0) {
                const cName = String(row[classIdx] || '').trim();
                const isBeta1 = cName.includes('β1');
                // 仅保留 β1 学员，以及非 β1 但实际有专注度积分（>0）的学员
                if (!isBeta1 && rawVal <= 0) return;
            }

            const adjustedScore = Math.max(0, Math.round((rawVal + offset) * 10) / 10);
            if (adjustedScore > 4) return;

            const rawNameCell = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
            let studentId = idIdx >= 0 ? String(row[idIdx] || '').trim() : '';
            if (!studentId && rawNameCell) {
                const prefixDigits = rawNameCell.match(/^(\d+)/);
                if (prefixDigits) studentId = prefixDigits[1];
            }

            const maskedName = maskStudentNameForFocusTable(rawNameCell);
            const scoreText = Number.isInteger(adjustedScore) ? String(adjustedScore) : String(adjustedScore);

            result.push({
                id: studentId || '-',
                maskedName,
                score: adjustedScore,
                scoreText
            });
        });

        result.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return a.id.localeCompare(b.id, 'zh-CN', { numeric: true });
        });

        return result;
    }

    function renderLowFocusTableCanvas(rows) {
        const scale = 2;
        const outerPad = 28;
        const titleBlockHeight = 64;
        const headerRowHeight = 42;
        const dataRowHeight = 40;
        const fontFamily = '"PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif';

        const measureCanvas = document.createElement('canvas');
        const mctx = measureCanvas.getContext('2d');
        mctx.font = `500 14px ${fontFamily}`;

        let maxIdWidth = mctx.measureText('学号').width;
        let maxNameWidth = mctx.measureText('姓名').width;
        rows.forEach(r => {
            maxIdWidth = Math.max(maxIdWidth, mctx.measureText(r.id).width);
            maxNameWidth = Math.max(maxNameWidth, mctx.measureText(r.maskedName).width);
        });

        const colIdWidth = Math.max(150, Math.ceil(maxIdWidth) + 40);
        const colNameWidth = Math.max(120, Math.ceil(maxNameWidth) + 40);
        const colScoreWidth = 104;
        const tableWidth = colIdWidth + colNameWidth + colScoreWidth;
        const tableHeight = headerRowHeight + rows.length * dataRowHeight;

        const width = outerPad * 2 + tableWidth;
        const height = outerPad * 2 + titleBlockHeight + tableHeight;

        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        // Title block
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#0f172a';
        ctx.font = `600 19px ${fontFamily}`;
        ctx.fillText('4分及以下专注度情况', width / 2, outerPad + 18);

        ctx.fillStyle = '#64748b';
        ctx.font = `400 12px ${fontFamily}`;
        ctx.fillText(`共 ${rows.length} 人`, width / 2, outerPad + 42);

        const tableX = outerPad;
        const tableY = outerPad + titleBlockHeight;

        // Table header background
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(tableX, tableY, tableWidth, headerRowHeight);

        const col1Center = tableX + colIdWidth / 2;
        const col2Center = tableX + colIdWidth + colNameWidth / 2;
        const col3Center = tableX + colIdWidth + colNameWidth + colScoreWidth / 2;

        ctx.fillStyle = '#334155';
        ctx.font = `600 14px ${fontFamily}`;
        ctx.fillText('学号', col1Center, tableY + headerRowHeight / 2);
        ctx.fillText('姓名', col2Center, tableY + headerRowHeight / 2);
        ctx.fillText('积分', col3Center, tableY + headerRowHeight / 2);

        // Data rows
        rows.forEach((row, idx) => {
            const y = tableY + headerRowHeight + idx * dataRowHeight;
            ctx.fillStyle = idx % 2 === 1 ? '#f8fafc' : '#ffffff';
            ctx.fillRect(tableX, y, tableWidth, dataRowHeight);

            const cy = y + dataRowHeight / 2;

            ctx.fillStyle = '#334155';
            ctx.font = `400 14px ${fontFamily}`;
            ctx.fillText(row.id, col1Center, cy);

            ctx.fillStyle = '#0f172a';
            ctx.font = `500 14px ${fontFamily}`;
            ctx.fillText(row.maskedName, col2Center, cy);

            ctx.fillStyle = row.score <= 2 ? '#dc2626' : '#d97706';
            ctx.font = `600 14px ${fontFamily}`;
            ctx.fillText(row.scoreText, col3Center, cy);

            // Row top divider
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tableX, y + 0.5);
            ctx.lineTo(tableX + tableWidth, y + 0.5);
            ctx.stroke();
        });

        // Vertical column dividers
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        const sep1X = tableX + colIdWidth + 0.5;
        const sep2X = tableX + colIdWidth + colNameWidth + 0.5;
        ctx.beginPath();
        ctx.moveTo(sep1X, tableY);
        ctx.lineTo(sep1X, tableY + tableHeight);
        ctx.moveTo(sep2X, tableY);
        ctx.lineTo(sep2X, tableY + tableHeight);
        ctx.stroke();

        // Outer table border
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableWidth - 1, tableHeight - 1);

        return canvas;
    }

    function exportLowFocusReportImage(event) {
        if (event) event.stopPropagation();
        if (!reportData || reportData.length < 2) {
            showToast('请先上传专注度文件（统计报告）');
            return;
        }

        const offset = typeof focusScoreOffset === 'number' ? focusScoreOffset : 0;
        const rows = collectLowFocusRows(reportData, offset);
        if (rows.length === 0) {
            showToast('当前没有4分及以下的专注度记录');
            return;
        }

        const canvas = renderLowFocusTableCanvas(rows);
        const now = new Date();
        const dateTag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const fileName = `4分及以下专注度情况_${dateTag}.png`;

        canvas.toBlob(async (blob) => {
            if (!blob) {
                showToast('图片生成失败');
                return;
            }
            if (typeof saveFileWithDialog === 'function') {
                const saved = await saveFileWithDialog(blob, fileName, 'PNG Image', 'png', 'image/png');
                if (saved) showToast(`已导出图片（共 ${rows.length} 人）`);
            } else {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = fileName;
                link.href = url;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                showToast(`已导出图片（共 ${rows.length} 人）`);
            }
        }, 'image/png');
    }

    function clearReportFile() {
        if (!reportData) return;
        reportData = null;
        reportFileName = '';

        if (reportDropZone) reportDropZone.classList.remove('uploaded');
        if (reportInfo) reportInfo.textContent = '拖拽文件或点击上传';
        if (reportDropZone) delete reportDropZone.dataset.rawText;

        renderReportFileList();

        const maxScoreInfo = document.getElementById('focus-max-score-info');
        if (maxScoreInfo) maxScoreInfo.style.display = 'none';
        const scoreAdjust = document.getElementById('focus-score-adjust');
        if (scoreAdjust) scoreAdjust.style.display = 'none';

        showToast('已清除统计报告（专注度文件）');
    }

    function detectAndSetFocusMaxScore(data) {
        if (!data || data.length < 2) return;

        const header = data[0];
        const rows = data.slice(1);
        const rewardIdx = header.findIndex(h => h.includes('奖励积分') || h.includes('专注度积分') || h.includes('课堂积分') || h === '积分');
        const classIdx = header.findIndex(h => String(h || '').includes('班级'));
        const attIdx = header.findIndex(h =>
            (h.includes('是否有效出勤') || h.includes('有效出勤') || h.includes('出勤状态') || h === '出勤' || h.includes('是否出勤')) &&
            !h.includes('时长') && !h.includes('率')
        );

        if (rewardIdx < 0) return;

        let maxScore = 0;
        rows.forEach(row => {
            // 仅线上β1学生参与最高分计算
            if (classIdx >= 0) {
                const cName = String(row[classIdx] || '').trim();
                if (!cName.includes('β1')) return;
            }
            // 明确缺勤者不计入最高分
            if (attIdx >= 0) {
                const att = String(row[attIdx] || '').trim();
                if (att.includes('缺勤')) return;
            }
            const reward = row[rewardIdx];
            if (reward && reward !== '-' && reward !== '') {
                const val = parseFloat(reward);
                if (!isNaN(val) && val > maxScore) {
                    maxScore = val;
                }
            }
        });

        originalFocusMaxScore = maxScore;
        focusScoreOffset = 0;

        const maxScoreInfo = document.getElementById('focus-max-score-info');
        const maxScoreValue = document.getElementById('focus-max-score-value');
        const adjustDiv = document.getElementById('focus-score-adjust');
        const offsetInfo = document.getElementById('focus-offset-info');

        if (maxScore > 0) {
            if (maxScoreInfo) maxScoreInfo.style.display = 'flex';
            if (maxScoreValue) maxScoreValue.textContent = maxScore;
            if (adjustDiv) adjustDiv.style.display = 'block';
            if (offsetInfo) offsetInfo.textContent = '';
        }

        updateFocusScoreState(maxScore);
    }

    function updateFocusScoreState(adjustedMaxScore) {
        const defaultBtn = document.getElementById('focus-source-default-btn');
        const maxScoreValue = document.getElementById('focus-max-score-value');

        if (maxScoreValue) {
            maxScoreValue.textContent = adjustedMaxScore;
        }

        if (adjustedMaxScore === 6) {
            if (defaultBtn) {
                defaultBtn.classList.remove('disabled');
                defaultBtn.style.opacity = '';
                defaultBtn.style.cursor = '';
                defaultBtn.title = '';
                defaultBtn.removeAttribute('data-disabled');
            }
            generateFocusCommentFields(6);
            if (focusCommentSource === 'custom') {
                switchFocusCommentSource('default');
                showToast('调整后最高分为6分，已启用默认评语');
            }
        } else {
            forceFocusCommentCustom(adjustedMaxScore);
        }
    }

    function adjustFocusScore(delta) {
        const newOffset = focusScoreOffset + delta;
        const adjustedMaxScore = originalFocusMaxScore + newOffset;

        if (adjustedMaxScore < 0) {
            showToast('分数不能为负数');
            return;
        }

        focusScoreOffset = newOffset;

        const offsetInfo = document.getElementById('focus-offset-info');
        if (offsetInfo) {
            if (focusScoreOffset > 0) {
                offsetInfo.textContent = `+${focusScoreOffset}`;
                offsetInfo.style.background = 'linear-gradient(135deg, #22c55e20, #16a34a20)';
                offsetInfo.style.color = '#16a34a';
                offsetInfo.style.border = '1px solid #22c55e44';
            } else if (focusScoreOffset < 0) {
                offsetInfo.textContent = `${focusScoreOffset}`;
                offsetInfo.style.background = 'linear-gradient(135deg, #ef444420, #dc262620)';
                offsetInfo.style.color = '#dc2626';
                offsetInfo.style.border = '1px solid #ef444444';
            } else {
                offsetInfo.textContent = '';
                offsetInfo.style.background = '';
                offsetInfo.style.color = '';
                offsetInfo.style.border = '';
            }
        }

        updateFocusScoreState(adjustedMaxScore);
    }

    // ========== All Students Roster Handling ==========
    async function handleRosterFile(file) {
        if (!requireSubject()) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext !== 'csv' && ext !== 'xlsx' && ext !== 'xls') {
            showToast('请上传CSV或Excel文件');
            return;
        }
        try {
            let text = '';
            if (ext === 'xlsx' || ext === 'xls') {
                const arrayBuffer = await readFileAsArrayBuffer(file);
                const jsonData = readXlsxFirstSheetRows(arrayBuffer);
                if (jsonData.length > 0) {
                    text = rowsToCsvText(jsonData);
                }
            } else {
                text = await readFileAsTextWithProgress(
                    file,
                    () => { },
                    (reader) => activeReaders.push(reader)
                );
            }

            rosterFileName = file.name;
            rosterData = parseCSV(text);
            // 新名单：重置班级选择（默认行为由 checkDroppedStudents 按作业自动匹配）
            classSelectionTouched = false;
            selectedFeedbackClasses = [];
            rosterParsedRows = [];
            rosterClassStats = [];
            captureUploadedFile(file, 'roster');
            rosterDropZone.classList.add('uploaded');
            rosterInfo.textContent = `已加载 (${Math.max(0, rosterData.length - 1)}条数据)`;
            rosterDropZone.dataset.rawText = text;
            showToast('所有学生名单已加载');
            checkDroppedStudents();
        } catch (error) {
            if (error?.message !== 'aborted') {
                showToast(`文件 ${file.name} 读取失败`);
            }
        } finally {
            activeReaders = [];
            if (rosterFileInput) rosterFileInput.value = '';
        }
    }

    function clearRosterFile() {
        rosterData = null;
        rosterFileName = '';
        detectedDroppedStudents = { preview: [], homework: [] };
        droppedStudentsAcknowledged = false;
        detectedClassName = '';
        rosterParsedRows = [];
        rosterClassStats = [];
        selectedFeedbackClasses = [];
        classSelectionTouched = false;
        const classWrap = document.getElementById('roster-class-wrap');
        if (classWrap) classWrap.style.display = 'none';
        const classGroup = document.getElementById('roster-class-group');
        if (classGroup) classGroup.innerHTML = '';
        if (rosterDropZone) rosterDropZone.classList.remove('uploaded');
        if (rosterInfo) rosterInfo.textContent = '拖拽文件或点击上传';
        const statusDiv = document.getElementById('roster-status');
        if (statusDiv) statusDiv.style.display = 'none';
        showToast('已清除学生名单');
    }

    /**
     * 解析名单为 [{name, className}]，列缺失或空表时提示并返回 null
     */
    function parseRosterRows() {
        if (!rosterData || rosterData.length < 2) return null;

        const rosterHeader = rosterData[0];
        const rosterNameIdx = rosterHeader.findIndex(h => h.includes('姓名'));
        const rosterClassIdx = rosterHeader.findIndex(h => h.includes('班级名称'));

        if (rosterNameIdx < 0 || rosterClassIdx < 0) {
            showToast('学生名单CSV缺少"姓名"或"班级名称"列');
            return null;
        }

        // Clean up roster names (remove BOM, trim, and strip numeric prefix like "55615吉恩萱" -> "吉恩萱")
        // Also strip α/β suffixes from class names so we can unify students in the same actual class.
        const rows = rosterData.slice(1).map(r => {
            const rawName = (r[rosterNameIdx] || '').replace(/[\uFEFF]/g, '').trim();
            const match = rawName.match(/\d+(.+)/);
            return {
                name: match ? match[1] : rawName,
                className: (r[rosterClassIdx] || '').replace(/[\uFEFF]/g, '').replace(/[αβ]\d*$/i, '').trim()
            };
        }).filter(r => r.name && r.className);

        if (rows.length === 0) {
            showToast('学生名单为空');
            return null;
        }
        return rows;
    }

    /**
     * 渲染“需要反馈的班级”多选芯片（DOM 方式构建，班级名不拼 HTML，防注入）
     */
    function renderFeedbackClassChips() {
        const wrap = document.getElementById('roster-class-wrap');
        const group = document.getElementById('roster-class-group');
        if (!wrap || !group) return;
        group.innerHTML = '';
        if (rosterClassStats.length === 0) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'block';
        rosterClassStats.forEach(({ name, count }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ui-pill' + (selectedFeedbackClasses.includes(name) ? ' active' : '');
            btn.title = `点击切换是否纳入反馈（${count}人）`;
            const label = document.createElement('span');
            label.textContent = name;
            const badge = document.createElement('span');
            badge.className = 'pill-count';
            badge.textContent = `${count}人`;
            btn.append(label, badge);
            btn.addEventListener('click', () => toggleFeedbackClass(name));
            group.appendChild(btn);
        });
    }

    function toggleFeedbackClass(name) {
        const i = selectedFeedbackClasses.indexOf(name);
        if (i >= 0) {
            if (selectedFeedbackClasses.length <= 1) {
                showToast('至少保留一个反馈班级');
                return;
            }
            selectedFeedbackClasses.splice(i, 1);
        } else {
            selectedFeedbackClasses.push(name);
        }
        classSelectionTouched = true;
        renderFeedbackClassChips();
        refreshScopedDropped();
    }

    /**
     * 所选班级的展示标签（弹窗与状态文案共用）
     */
    function getScopeLabel() {
        if (selectedFeedbackClasses.length <= 2) return selectedFeedbackClasses.join('、');
        return `${selectedFeedbackClasses.slice(0, 2).join('、')}等${selectedFeedbackClasses.length}个班级`;
    }

    /**
     * 按所选班级并集计算名单外学生（退课 + 未选班级），复用 droppedStudents 通道，
     * viewer 侧无需改动即可过滤反馈卡片、统计与未交名单。
     */
    function refreshScopedDropped() {
        droppedStudentsAcknowledged = false;
        if (rosterParsedRows.length === 0 || selectedFeedbackClasses.length === 0) {
            detectedDroppedStudents = { preview: [], homework: [] };
            return;
        }
        const scopeSet = new Set();
        rosterParsedRows.forEach(r => {
            if (selectedFeedbackClasses.includes(r.className)) scopeSet.add(r.name);
        });

        const hwStudentNames = extractStudentNamesFromData(homeworkData);
        const pvStudentNames = extractStudentNamesFromData(previewData);

        detectedDroppedStudents = {
            preview: pvStudentNames.filter(name => !scopeSet.has(name)),
            homework: hwStudentNames.filter(name => !scopeSet.has(name))
        };
        detectedClassName = selectedFeedbackClasses[0] || '';

        const totalDropped = new Set([...detectedDroppedStudents.homework, ...detectedDroppedStudents.preview]).size;
        if (totalDropped === 0) {
            updateRosterStatus(`已选班级：${getScopeLabel()}（${scopeSet.size}人）\n所有作业学生均在名单中`, 'success');
        } else {
            updateRosterStatus(
                `已选班级：${getScopeLabel()}（${scopeSet.size}人）\n检测到 ${totalDropped} 名不在所选班级名单的学生`,
                'warning'
            );
        }
    }

    /**
     * Core logic: detect dropped students
     * 1. 解析名单得到各班级
     * 2. 未手动选过班级时，按作业自动匹配班级并默认仅选它（兼容旧行为）；
     *    手动选过则保留用户选择
     * 3. 以所选班级并集为反馈范围，作业中超出范围的学生走退课通道排除
     */
    function checkDroppedStudents() {
        const rows = parseRosterRows();
        if (!rows) {
            rosterParsedRows = [];
            rosterClassStats = [];
            const group = document.getElementById('roster-class-group');
            if (group) group.innerHTML = '';
            const wrap = document.getElementById('roster-class-wrap');
            if (wrap) wrap.style.display = 'none';
            return;
        }
        rosterParsedRows = rows;

        const countMap = {};
        rows.forEach(r => { countMap[r.className] = (countMap[r.className] || 0) + 1; });
        rosterClassStats = Object.keys(countMap).sort().map(k => ({ name: k, count: countMap[k] }));

        const hwStudentNames = extractStudentNamesFromData(homeworkData);
        const pvStudentNames = extractStudentNamesFromData(previewData);
        const allHomeworkNames = [...hwStudentNames, ...pvStudentNames];

        if (!classSelectionTouched) {
            if (allHomeworkNames.length > 0) {
                const nameToClass = {};
                rows.forEach(r => { nameToClass[r.name] = r.className; });
                let foundClass = null;
                for (const name of allHomeworkNames) {
                    if (nameToClass[name]) {
                        foundClass = nameToClass[name];
                        break;
                    }
                }
                if (!foundClass) {
                    updateRosterStatus('未能在名单中找到匹配的学生，请确认名单是否正确', 'warning');
                    selectedFeedbackClasses = rosterClassStats.map(c => c.name);
                    renderFeedbackClassChips();
                    return;
                }
                selectedFeedbackClasses = [foundClass];
            } else {
                selectedFeedbackClasses = rosterClassStats.map(c => c.name);
            }
        } else {
            const valid = new Set(rosterClassStats.map(c => c.name));
            selectedFeedbackClasses = selectedFeedbackClasses.filter(n => valid.has(n));
            if (selectedFeedbackClasses.length === 0) {
                selectedFeedbackClasses = rosterClassStats.map(c => c.name);
            }
        }
        renderFeedbackClassChips();

        if (allHomeworkNames.length === 0) {
            const statusDiv = document.getElementById('roster-status');
            if (statusDiv) statusDiv.style.display = 'none';
            return;
        }
        refreshScopedDropped();
    }

    function extractStudentNamesFromData(data) {
        if (!data || data.length < 2) return [];
        const header = data[0];
        const nameIdx = header.findIndex(h => String(h).includes('姓名'));
        if (nameIdx < 0) return [];
        let rows = data.slice(1);
        if (data === previewData && physicsPreviewSource === 'wenjuanxing' && typeof getWenjuanxingBenchmark === 'function') {
            const bm = getWenjuanxingBenchmark(previewData);
            if (bm && bm.isR1Benchmark) {
                rows = rows.slice(1);
            }
        }
        return rows
            .map(r => {
                const fullName = String(r[nameIdx] || '').trim();
                const match = fullName.match(/\d+(.+)/);
                return match ? match[1] : fullName;
            })
            .filter(n => n);
    }

    function updateRosterStatus(message, type) {
        const statusDiv = document.getElementById('roster-status');
        const statusText = document.getElementById('roster-status-text');
        const statusCallout = document.getElementById('roster-status-callout');
        if (!statusDiv || !statusText) return;

        statusDiv.style.display = 'block';
        statusText.textContent = message;

        if (statusCallout) {
            if (type === 'success') {
                statusCallout.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                statusCallout.style.background = 'rgba(34, 197, 94, 0.05)';
            } else if (type === 'warning') {
                statusCallout.style.borderColor = 'rgba(245, 158, 11, 0.3)';
                statusCallout.style.background = 'rgba(245, 158, 11, 0.05)';
            } else {
                statusCallout.style.borderColor = '';
                statusCallout.style.background = '';
            }
        }
    }

    function showDroppedStudentsModal(droppedPreview, droppedHomework, className) {
        const modal = document.getElementById('dropped-students-modal');
        const body = document.getElementById('dropped-students-body');
        if (!modal || !body) return;

        let html = '';

        const renderSection = (title, names) => {
            let sectionHtml = `<div style="margin-bottom: 12px;"><span style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">${escapeHtml(title)}</span></div>`;
            names.forEach(name => {
                sectionHtml += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; padding:8px 12px; background:var(--ui-fill-weak); border:1px solid var(--border-light); border-radius:var(--radius-sm);">
                    <span style="color: #ef4444;">✕</span>
                    <span style="font-size:0.85rem; color:var(--text-primary);">${escapeHtml(name)}</span>
                </div>`;
            });
            return sectionHtml;
        };

        if (droppedPreview.length > 0) {
            html += renderSection(`课前预习（${droppedPreview.length}人不在 ${className} 名单中）：`, droppedPreview);
        }

        if (droppedHomework.length > 0) {
            if (droppedPreview.length > 0) html += `<div style="margin-top: 14px;"></div>`;
            html += renderSection(`${getUploadHomeworkLabelFull()}（${droppedHomework.length}人不在 ${className} 名单中）：`, droppedHomework);
        }

        body.innerHTML = html;
        openNativeDialog(modal, {
            dismissible: true,
            onAfterClose: finishDroppedStudentsClose
        });
    }

    function finishDroppedStudentsClose() {
        droppedStudentsAcknowledged = true;

        if (pendingNavigationStep) {
            const step = pendingNavigationStep;
            pendingNavigationStep = null;
            goToStep(step);
        }
    }

    function closeDroppedStudentsModal() {
        closeNativeDialog('dropped-students-modal');
        if (!window.DialogHelper) {
            finishDroppedStudentsClose();
        }
    }

    // ========== File Inputs & Drag/Drop 初始化 ==========
    function setupFileInputs() {
        // 注册所有上传 input 的 click 事件，每次点击前清空 value，确保选择同名修改后的文件时依然能够 100% 触发 change 事件
        const multiBindings = [
            { input: homeworkFileInput, appendId: 'homework-file-append', handler: handleHomeworkFiles },
            { input: previewFileInput, appendId: 'preview-file-append', handler: handlePreviewFiles },
            { input: noteFileInput, appendId: 'note-file-append', handler: handleNoteFiles },
            { input: classTestFileInput, appendId: 'class-test-file-append', handler: handleClassTestFiles }
        ];
        const allFileInputs = [];

        multiBindings.forEach(({ input, appendId, handler }) => {
            const appendInput = document.getElementById(appendId);
            if (input) {
                allFileInputs.push(input);
                input.addEventListener('click', function () { this.value = ''; });
                input.addEventListener('change', (e) => {
                    if (e.target.files.length > 0) handler(e.target.files, false);
                });
            }
            if (appendInput) {
                allFileInputs.push(appendInput);
                appendInput.addEventListener('click', function () { this.value = ''; });
                appendInput.addEventListener('change', (e) => {
                    if (e.target.files.length > 0) handler(e.target.files, true);
                });
            }
        });

        [
            { input: reportFileInput, handler: handleReportFile },
            { input: rosterFileInput, handler: handleRosterFile }
        ].forEach(({ input, handler }) => {
            if (!input) return;
            allFileInputs.push(input);
            input.addEventListener('click', function () { this.value = ''; });
            input.addEventListener('change', (e) => {
                if (e.target.files[0]) handler(e.target.files[0]);
            });
        });

        // 监听浏览器后退/前进缓存（bfcache），唤醒时重置 input.value
        window.addEventListener('pageshow', () => {
            allFileInputs.forEach(input => {
                if (input) input.value = '';
            });
        });
    }

    function setupDragAndDrop() {
        // 拖拽到卡片主区域默认执行覆盖/刷新（老师返工重新批改后的典型操作）
        // 若需要追加，可使用右上角明确的"+"按钮，或多选文件一次性拖入
        const dropBindings = [
            { zone: homeworkDropZone, input: homeworkFileInput, handler: (files) => handleHomeworkFiles(files, false), multiple: true },
            { zone: previewDropZone, input: previewFileInput, handler: (files) => handlePreviewFiles(files, false), multiple: true },
            { zone: noteDropZone, input: noteFileInput, handler: (files) => handleNoteFiles(files, false), multiple: true },
            { zone: classTestDropZone, input: classTestFileInput, handler: (files) => handleClassTestFiles(files, false), multiple: true },
            { zone: reportDropZone, input: reportFileInput, handler: handleReportFile, multiple: false },
            { zone: rosterDropZone, input: rosterFileInput, handler: handleRosterFile, multiple: false }
        ];

        dropBindings.forEach(({ zone, input, handler, multiple }) => {
            if (zone && input) {
                setupDropZone(zone, input, handler, multiple);
            }
        });
    }

    // ========== Expose Public API ==========
    Object.assign(window, {
        captureUploadedFile,
        readFileAsArrayBuffer,
        handleHomeworkFiles,
        updateHomeworkData,
        renderHomeworkFileList,
        removeHomeworkFile,
        clearHomeworkFiles,
        handlePreviewFiles,
        updatePreviewData,
        renderPreviewFileList,
        removePreviewFile,
        clearPreviewFiles,
        handleNoteFiles,
        updateNoteData,
        renderNoteFileList,
        removeNoteFile,
        clearNoteFiles,
        handleClassTestFiles,
        updateClassTestData,
        renderClassTestFileList,
        removeClassTestFile,
        clearClassTestFiles,
        handleReportFile,
        renderReportFileList,
        exportLowFocusReportImage,
        collectLowFocusRows,
        maskStudentNameForFocusTable,
        renderLowFocusTableCanvas,
        clearReportFile,
        detectAndSetFocusMaxScore,
        updateFocusScoreState,
        adjustFocusScore,
        handleRosterFile,
        clearRosterFile,
        parseRosterRows,
        renderFeedbackClassChips,
        toggleFeedbackClass,
        getScopeLabel,
        refreshScopedDropped,
        checkDroppedStudents,
        extractStudentNamesFromData,
        updateRosterStatus,
        showDroppedStudentsModal,
        finishDroppedStudentsClose,
        closeDroppedStudentsModal
    });

    setupFileInputs();
    setupDragAndDrop();
})();
