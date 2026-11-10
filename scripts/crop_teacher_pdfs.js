/**
 * 教师上传 PDF 页码及页脚文本自动识别与精准裁剪工具
 * 
 * 规则：
 * 1. 检查 PDF 第 1 页底部区域（y < 60pt）是否存在页码（如 1、1/N、- 1 - 等）
 * 2. 同步识别并剔除页码旁的伴生文本（如物理/英语的“内部资料，请勿外传/严禁外传”及学科标语）
 * 3. 扫描全页正文最低基线，确保安全裁剪余量，绝不误伤正文、选项或图形
 * 4. 采用 PDF-Lib Form XObject 精准视口平移与边界重建，生成标准化 (0, 0) 原点新文档
 */

const fs = require('fs');
const path = require('path');
const PDFLib = require('../feedback-v1/js/libs/pdf-lib.min.js');
const pdfjs = require('../feedback-v1/js/libs/pdfjs/pdf.min.js');
pdfjs.GlobalWorkerOptions.workerSrc = path.resolve(__dirname, '../feedback-v1/js/libs/pdfjs/pdf.worker.min.js');

function detectPage1Footer(items) {
    // 候选区域：页面底部 y < 45pt
    const candidates = items.filter(it => it.y < 45);
    if (!candidates.length) return null;

    const texts = candidates.map(c => c.str.trim()).filter(Boolean);
    const combined = texts.join(' ');
    const compact = texts.join('');

    // 检测第 1 页页码模式：如 1、1/N、1 / N、- 1 -、第1页、Page 1 等
    const pageNumRegex = /(?:^|\s)(?:[-—~]?\s*1\s*[-—~]?|1\s*\/\s*\d+|第\s*1\s*页|page\s*1)(?:\s|$)/i;
    const hasNum = pageNumRegex.test(combined) || pageNumRegex.test(compact) ||
        texts.some(t => /^[-—~]?\s*1\s*[-—~]?$/.test(t) || /^1\s*\/\s*\d+$/.test(t) || /^第1页$/i.test(t));

    if (!hasNum) return null;

    // 提取页脚元素（页码、内部资料、标语等位于 y < 42pt 的项）
    let maxTop = 0;
    const footerItems = [];
    for (const c of candidates) {
        if (c.y < 42) {
            footerItems.push(c);
            const top = c.y + c.sz * 1.05;
            if (top > maxTop) maxTop = top;
        }
    }
    return {
        footerItems,
        maxTop
    };
}

async function processPdf(filePath) {
    const fileName = path.basename(filePath);
    const srcBytes = fs.readFileSync(filePath);
    let doc;
    try {
        doc = await pdfjs.getDocument({ data: new Uint8Array(srcBytes) }).promise;
    } catch (e) {
        return { filePath, fileName, status: 'error', error: e.message };
    }

    const numPages = doc.numPages;
    if (numPages === 0) return { filePath, fileName, status: 'skipped', reason: '空文件' };

    // 1. 检查第 1 页
    const p1 = await doc.getPage(1);
    const tc1 = await p1.getTextContent();
    const items1 = tc1.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
            str: it.str.trim(),
            x: it.transform[4],
            y: it.transform[5],
            sz: Math.hypot(it.transform[2], it.transform[3])
        }));

    const footerInfo = detectPage1Footer(items1);
    if (!footerInfo) {
        return { filePath, fileName, status: 'skipped', reason: '第1页未检测到页码' };
    }

    // 2. 扫描所有页面的正文最低基线（y > 43pt）
    let minContentY = 9999;
    let minContentText = '';
    let minContentPage = 0;

    for (let p = 1; p <= numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        for (const it of tc.items) {
            const str = it.str.trim();
            if (!str) continue;
            const y = it.transform[5];
            if (y > 43 && y < minContentY) {
                minContentY = y;
                minContentText = str;
                minContentPage = p;
            }
        }
    }

    // 3. 计算最佳裁剪高度 cropBottom
    // 裁剪线必须：高于页脚最高字顶（+1.8pt 以上），且低于正文最低基线（-3pt 以上）
    const minSafeCrop = footerInfo.maxTop + 1.8;
    const maxSafeCrop = minContentY - 3.0;

    let targetCrop;
    if (maxSafeCrop > minSafeCrop) {
        // 取中点或适度裁剪（不超过 minSafeCrop + 4pt，留出更多呼吸间隙）
        targetCrop = Math.min((minSafeCrop + maxSafeCrop) / 2, minSafeCrop + 4);
    } else {
        targetCrop = minSafeCrop;
    }
    const cropBottom = Math.round(targetCrop * 2) / 2;

    // 4. 使用 PDFLib 重建无页脚的新 PDF（视口平移法）
    const newDoc = await PDFLib.PDFDocument.create();
    const srcDoc = await PDFLib.PDFDocument.load(srcBytes);
    const embeddedPages = await newDoc.embedPdf(srcDoc, Array.from({ length: numPages }, (_, i) => i));

    for (let i = 0; i < numPages; i++) {
        const srcPage = srcDoc.getPage(i);
        const { width: origW, height: origH } = srcPage.getSize();
        const newH = origH - cropBottom;
        const newPage = newDoc.addPage([origW, newH]);
        newPage.drawPage(embeddedPages[i], {
            x: 0,
            y: -cropBottom,
            width: origW,
            height: origH
        });
    }

    const croppedBytes = await newDoc.save();
    const outBuffer = Buffer.from(croppedBytes);

    // 5. 校验裁剪结果：注意使用 slice(0) 避免 buffer 被 worker 线程转移，确认第 1 页不再含有页码
    const verifyDoc = await pdfjs.getDocument({ data: croppedBytes.slice(0) }).promise;
    const verifyP1 = await verifyDoc.getPage(1);
    const verifyTc1 = await verifyP1.getTextContent();
    const verifyItems1 = verifyTc1.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
            str: it.str.trim(),
            x: it.transform[4],
            y: it.transform[5],
            sz: Math.hypot(it.transform[2], it.transform[3])
        }));

    const leakedFooter = detectPage1Footer(verifyItems1);
    if (leakedFooter) {
        return {
            filePath,
            fileName,
            status: 'failed',
            reason: `裁剪后检测到底部残留页码: ${leakedFooter.footerItems.map(f => f.str).join(' ')}`
        };
    }

    // 6. 原子覆写原文件
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, outBuffer);
    fs.renameSync(tmpPath, filePath);

    return {
        filePath,
        fileName,
        status: 'cropped',
        numPages,
        cropBottom,
        fileSize: outBuffer.length,
        footerText: footerInfo.footerItems.map(f => f.str).join(' '),
        lowestContent: `y=${minContentY.toFixed(1)} (第${minContentPage}页: "${minContentText.slice(0, 15)}")`
    };
}

async function run() {
    const targetDirs = [
        path.resolve(__dirname, '../files-examples'),
        path.resolve(__dirname, '../feedback-v1/data/pdfs')
    ];

    let allFiles = [];
    for (const d of targetDirs) {
        if (fs.existsSync(d)) {
            const list = fs.readdirSync(d)
                .filter(f => f.toLowerCase().endsWith('.pdf'))
                .map(f => path.join(d, f));
            allFiles = allFiles.concat(list);
        }
    }

    console.log(`=======================================================`);
    console.log(`开始扫描服务器中的老师上传 PDF 文件 (共 ${allFiles.length} 份)...`);
    console.log(`=======================================================\n`);

    const results = [];
    for (const f of allFiles) {
        const res = await processPdf(f);
        results.push(res);
        if (res.status === 'cropped') {
            console.log(`✅ [已裁切] ${res.fileName}`);
            console.log(`   - 页数: ${res.numPages} 页，大小: ${(res.fileSize / 1024).toFixed(1)} KB`);
            console.log(`   - 剔除页码/伴生文字: [${res.footerText}]`);
            console.log(`   - 底部裁剪高度: ${res.cropBottom} pt`);
            console.log(`   - 安全间隙核验: 正文最低线 ${res.lowestContent}`);
        } else if (res.status === 'skipped') {
            // 静默跳过无页码的文件
        } else {
            console.log(`❌ [失败] ${res.fileName}: ${res.reason || res.error}`);
        }
    }

    const croppedList = results.filter(r => r.status === 'cropped');
    const skippedList = results.filter(r => r.status === 'skipped');
    const failedList = results.filter(r => r.status === 'failed' || r.status === 'error');

    console.log(`\n=======================================================`);
    console.log(`执行总结：`);
    console.log(`- 扫描文件总数: ${allFiles.length}`);
    console.log(`- 成功裁剪页码及伴生字: ${croppedList.length}`);
    console.log(`- 跳过（原本无页码）: ${skippedList.length}`);
    console.log(`- 异常/失败: ${failedList.length}`);
    console.log(`=======================================================`);
}

run();
