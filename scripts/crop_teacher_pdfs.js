/**
 * 教师上传 PDF 页码及页脚文本自动识别与精准裁剪工具
 * 
 * 规则：
 * 1. 检查 PDF 第 1 页底部区域（y < 62pt）是否存在页码或页脚标语：
 *    - 任意页码格式（1、N、N/M、- N -、第N页、第N页（共M页）、Page N 等）
 *    - 伴生/独立页脚标语（如“内部资料，请勿外传/严禁外传”、“极方：...”等）
 * 2. 严格区分页脚与正文/算式/选项，不误伤正文内容
 * 3. 扫描全页正文最低基线，若正文与页脚间距不足则跳过，绝不误伤正文、选项或图形
 * 4. 采用 PDF-Lib Form XObject 精准视口平移与边界重建，生成标准化 (0, 0) 原点新文档，并保留原文件权限与属主
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PDFLib = require('../feedback-v1/js/libs/pdf-lib.min.js');
const pdfjs = require('../feedback-v1/js/libs/pdfjs/pdf.min.js');
pdfjs.GlobalWorkerOptions.workerSrc = path.resolve(__dirname, '../feedback-v1/js/libs/pdfjs/pdf.worker.min.js');

/**
 * 查询数据库中已被 question_meta 坐标引用的 PDF 文件名集合。
 * 直接裁剪这些 PDF 会改变页面高度，导致已保存的归一化切题框 (y, h) 上下错位。
 */
function loadCoordReferencedPdfs() {
    const referenced = new Set();
    try {
        const sql = "SELECT DISTINCT exercise_pdf FROM qbank_questions WHERE question_meta IS NOT NULL AND question_meta != '' AND question_meta != '{}' AND exercise_pdf != '' UNION SELECT DISTINCT answer_pdf FROM qbank_questions WHERE question_meta IS NOT NULL AND question_meta != '' AND question_meta != '{}' AND answer_pdf != '';";
        let args = ['--default-character-set=utf8mb4', '-N', '-B', 'feedback', '-e', sql];
        let env = { ...process.env };

        if (fs.existsSync('/root/.my.cnf')) {
            args = ['--defaults-extra-file=/root/.my.cnf', ...args];
        } else {
            const cfgPath = path.resolve(__dirname, '../feedback-v1/api/db.local.php');
            if (!fs.existsSync(cfgPath)) return { referenced, checked: false };
            const cfgText = fs.readFileSync(cfgPath, 'utf8');
            const getVal = (k, def = '') => {
                const m = cfgText.match(new RegExp(`['"]${k}['"]\\s*=>\\s*(?:['"]([^'"]*)['"]|(\\d+))`));
                return m ? (m[1] !== undefined ? m[1] : m[2]) : def;
            };
            const host = getVal('host', '127.0.0.1');
            const port = getVal('port', '3306');
            const user = getVal('username', 'tinsy');
            const pass = getVal('password', '');
            const dbname = getVal('dbname', 'feedback');
            if (pass) env.MYSQL_PWD = pass;
            args = [`-h${host}`, `-P${port}`, `-u${user}`, '--default-character-set=utf8mb4', '-N', '-B', dbname, '-e', sql];
        }

        const out = execFileSync('mysql', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of out.split(/\r?\n/)) {
            const base = path.basename(line.trim());
            if (base) referenced.add(base);
        }
        return { referenced, checked: true };
    } catch (_) {
        return { referenced, checked: false };
    }
}

const FOOTER_SCAN_MAX_Y = 62;
const BANNER_REGEX = /(?:内部资料|请勿外传|严禁外传|极方：|每一份托付|极致方法)/;
const PAGE_NUM_ONLY_REGEX = /^(?:[-—~]?\d{1,3}[-—~]?|\d{1,3}\/\d{0,3}|第\d{1,3}页?(?:[（(]?共\d{1,3}页[）)]?|\/共\d{1,3}页)?|共\d{1,3}页|page\d+(?:of\d+)?)$/i;

function isFooterLine(lineItems, pageHeight) {
    const texts = lineItems.map(c => c.str.trim()).filter(Boolean);
    if (!texts.length) return false;
    const compact = texts.join('').replace(/\s+/g, '');
    if (!compact) return false;

    // 1. 已知机构页脚标语（含伴生页码或独立标语），限制长度防止误匹配正文
    if (BANNER_REGEX.test(compact) && compact.length <= 50) {
        return true;
    }

    // 2. 明确的页码格式（不含小数点/句号/中文正文，允许任意页码 N）
    if (PAGE_NUM_ONLY_REGEX.test(compact)) {
        // 单独裸数字在 y >= 55pt 时可能是题干末尾或分式/上标，仅在 y < 55pt 时作为页码
        if (/^\d{1,3}$/.test(compact) && lineItems[0].y >= 55) {
            return false;
        }
        // 防止把靠近底部的多栏或极小残余数字当成页码（通常页码字号 >= 6）
        if (pageHeight && lineItems[0].y > pageHeight * 0.12) {
            return false;
        }
        return true;
    }

    return false;
}

function groupIntoLines(items, tolerance = 4.0) {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
        let line = lines.find(l => Math.abs(l.y - it.y) <= tolerance);
        if (!line) {
            line = { y: it.y, items: [] };
            lines.push(line);
        }
        line.items.push(it);
    }
    for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
    }
    return lines;
}

function detectPage1Footer(items, pageHeight = 842) {
    // 候选区域：页面底部 y < FOOTER_SCAN_MAX_Y (62pt)
    const candidates = items.filter(it => it.y >= 0 && it.y < FOOTER_SCAN_MAX_Y);
    if (!candidates.length) return null;

    const lines = groupIntoLines(candidates);
    const footerItems = [];
    let maxTop = 0;

    for (const line of lines) {
        if (isFooterLine(line.items, pageHeight)) {
            for (const c of line.items) {
                footerItems.push(c);
                const top = c.y + Math.max(c.sz, 8) * 1.05;
                if (top > maxTop) maxTop = top;
            }
        } else if (footerItems.length > 0) {
            // 一旦遇到非页脚行，停止向上收集，避免吞入上方正文
            break;
        }
    }

    if (!footerItems.length) return null;

    return {
        footerItems,
        maxTop
    };
}

async function processPdf(filePath, options = {}) {
    const { dryRun = false } = options;
    const fileName = path.basename(filePath);
    const origStat = fs.statSync(filePath);
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
    const vp1 = p1.getViewport({ scale: 1 });
    const tc1 = await p1.getTextContent();
    const items1 = tc1.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
            str: it.str.trim(),
            x: it.transform[4],
            y: it.transform[5],
            sz: Math.hypot(it.transform[2], it.transform[3])
        }));

    const footerInfo = detectPage1Footer(items1, vp1.height);
    if (!footerInfo) {
        return { filePath, fileName, status: 'skipped', reason: '第1页未检测到页码或页脚' };
    }

    // 2. 扫描所有页面的正文最低基线（排除页脚本身）
    let minContentY = 9999;
    let minContentText = '';
    let minContentPage = 0;

    for (let p = 1; p <= numPages; p++) {
        const page = p === 1 ? p1 : await doc.getPage(p);
        const vp = p === 1 ? vp1 : page.getViewport({ scale: 1 });
        const tc = p === 1 ? tc1 : await page.getTextContent();
        const pageItems = tc.items
            .filter(it => it.str && it.str.trim())
            .map(it => ({
                str: it.str.trim(),
                x: it.transform[4],
                y: it.transform[5],
                sz: Math.hypot(it.transform[2], it.transform[3])
            }));

        const lines = groupIntoLines(pageItems);
        for (const line of lines) {
            if (line.y <= footerInfo.maxTop + 1.5 && isFooterLine(line.items, vp.height)) {
                continue;
            }
            for (const it of line.items) {
                if (it.y > 0 && it.y < minContentY) {
                    minContentY = it.y;
                    minContentText = it.str;
                    minContentPage = p;
                }
            }
        }
    }

    // 3. 计算最佳裁剪高度 cropBottom
    // 裁剪线必须：高于页脚最高字顶（+1.8pt 以上），且低于正文最低基线（-3.0pt 以上）
    const minSafeCrop = footerInfo.maxTop + 1.8;
    const maxSafeCrop = minContentY - 3.0;

    if (minContentY < 9999 && maxSafeCrop < minSafeCrop) {
        return {
            filePath,
            fileName,
            status: 'skipped',
            reason: `正文与页脚间距不足 (footerTop=${footerInfo.maxTop.toFixed(1)}, minContentY=${minContentY.toFixed(1)} @ p${minContentPage}: "${minContentText.slice(0, 15)}")`
        };
    }

    let targetCrop;
    if (maxSafeCrop > minSafeCrop) {
        // 取中点或适度裁剪（不超过 minSafeCrop + 4pt，留出更多呼吸间隙）
        targetCrop = Math.min((minSafeCrop + maxSafeCrop) / 2, minSafeCrop + 4);
    } else {
        targetCrop = minSafeCrop;
    }
    const cropBottom = Math.round(targetCrop * 2) / 2;

    if (dryRun) {
        return {
            filePath,
            fileName,
            status: 'dry-run',
            numPages,
            cropBottom,
            footerText: footerInfo.footerItems.map(f => f.str).join(' '),
            footerTop: footerInfo.maxTop,
            lowestContent: minContentY < 9999 ? `y=${minContentY.toFixed(1)} (第${minContentPage}页: "${minContentText.slice(0, 15)}")` : 'none'
        };
    }

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

    // 5. 校验裁剪结果：注意使用 slice(0) 避免 buffer 被 worker 线程转移，确认原页脚已移出可视区域 (y < 0)
    const verifyDoc = await pdfjs.getDocument({ data: croppedBytes.slice(0) }).promise;
    const verifyP1 = await verifyDoc.getPage(1);
    const verifyVp1 = verifyP1.getViewport({ scale: 1 });
    const verifyTc1 = await verifyP1.getTextContent();
    const verifyItems1 = verifyTc1.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
            str: it.str.trim(),
            x: it.transform[4],
            y: it.transform[5],
            sz: Math.hypot(it.transform[2], it.transform[3])
        }));

    const origFooterCompact = footerInfo.footerItems.map(f => f.str).join('').replace(/\s+/g, '');
    const leakedFooter = detectPage1Footer(verifyItems1, verifyVp1.height);
    if (leakedFooter) {
        const leakedCompact = leakedFooter.footerItems.map(f => f.str).join('').replace(/\s+/g, '');
        const isSameFooter = leakedCompact === origFooterCompact || BANNER_REGEX.test(leakedCompact) || !/^\d{1,3}$/.test(leakedCompact);
        if (isSameFooter && leakedFooter.footerItems.some(f => f.y < 20)) {
            return {
                filePath,
                fileName,
                status: 'failed',
                reason: `裁剪后检测到底部残留页码/页脚: ${leakedFooter.footerItems.map(f => f.str).join(' ')}`
            };
        }
    }

    // 6. 原子覆写原文件，保留权限与属主
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, outBuffer);
    fs.chmodSync(tmpPath, origStat.mode);
    try {
        fs.chownSync(tmpPath, origStat.uid, origStat.gid);
    } catch (_) {
        // 非 root 用户可能无权 chown，忽略
    }
    fs.renameSync(tmpPath, filePath);

    return {
        filePath,
        fileName,
        status: 'cropped',
        numPages,
        cropBottom,
        fileSize: outBuffer.length,
        footerText: footerInfo.footerItems.map(f => f.str).join(' '),
        lowestContent: minContentY < 9999 ? `y=${minContentY.toFixed(1)} (第${minContentPage}页: "${minContentText.slice(0, 15)}")` : 'none'
    };
}

function parseArgs(argv) {
    const args = { dryRun: false, allowReferenced: false, listFile: null, dirs: [] };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--allow-referenced') args.allowReferenced = true;
        else if (argv[i] === '--list' && argv[i + 1]) args.listFile = argv[++i];
        else if (argv[i] === '--dir' && argv[i + 1]) args.dirs.push(argv[++i]);
    }
    return args;
}

async function run() {
    const args = parseArgs(process.argv);
    const { referenced: coordReferencedPdfs, checked: dbChecked } = args.allowReferenced
        ? { referenced: new Set(), checked: false }
        : loadCoordReferencedPdfs();

    const targetDirs = args.dirs.length
        ? args.dirs.map(d => path.resolve(d))
        : [
            path.resolve(__dirname, '../files-examples'),
            path.resolve(__dirname, '../feedback-v1/data/pdfs')
        ];

    let allFiles = [];
    if (args.listFile) {
        const baseDir = args.dirs.length
            ? path.resolve(args.dirs[0])
            : path.resolve(__dirname, '../feedback-v1/data/pdfs');
        const names = fs.readFileSync(args.listFile, 'utf8')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);
        allFiles = names
            .map(n => path.isAbsolute(n) ? n : path.join(baseDir, n))
            .filter(f => fs.existsSync(f));
    } else {
        for (const d of targetDirs) {
            if (fs.existsSync(d)) {
                const list = fs.readdirSync(d)
                    .filter(f => f.toLowerCase().endsWith('.pdf'))
                    .map(f => path.join(d, f));
                allFiles = allFiles.concat(list);
            }
        }
    }

    const excludedCount = args.allowReferenced
        ? 0
        : allFiles.filter(f => coordReferencedPdfs.has(path.basename(f))).length;
    if (!args.allowReferenced && excludedCount > 0) {
        allFiles = allFiles.filter(f => !coordReferencedPdfs.has(path.basename(f)));
    }

    console.log(`=======================================================`);
    console.log(`开始扫描服务器中的老师上传 PDF 文件 (共 ${allFiles.length} 份)${args.dryRun ? ' [DRY-RUN]' : ''}...`);
    if (!args.allowReferenced) {
        if (dbChecked) {
            console.log(`🛡️  已自动排除 ${excludedCount} 份不分页/框题方案 PDF（库中登记 ${coordReferencedPdfs.size} 份，无需去页脚裁剪）`);
        } else {
            console.log(`⚠️  未能连接数据库核查 question_meta 引用；若目录中包含不分页/框题 PDF 请谨慎操作`);
        }
    }
    console.log(`=======================================================\n`);

    const results = [];
    for (const f of allFiles) {
        const res = await processPdf(f, { dryRun: args.dryRun });
        results.push(res);
        if (res.status === 'cropped' || res.status === 'dry-run') {
            const tag = res.status === 'dry-run' ? '🔍 [待裁切]' : '✅ [已裁切]';
            console.log(`${tag} ${res.fileName}`);
            console.log(`   - 页数: ${res.numPages} 页${res.fileSize ? `，大小: ${(res.fileSize / 1024).toFixed(1)} KB` : ''}`);
            console.log(`   - 剔除页码/伴生文字: [${res.footerText}]`);
            console.log(`   - 底部裁剪高度: ${res.cropBottom} pt`);
            console.log(`   - 安全间隙核验: 正文最低线 ${res.lowestContent}`);
        } else if (res.status === 'skipped') {
            if (res.reason && res.reason !== '第1页未检测到页码或页脚') {
                console.log(`⚠️ [跳过] ${res.fileName}: ${res.reason}`);
            }
        } else {
            console.log(`❌ [失败] ${res.fileName}: ${res.reason || res.error}`);
        }
    }

    const croppedList = results.filter(r => r.status === 'cropped' || r.status === 'dry-run');
    const skippedList = results.filter(r => r.status === 'skipped');
    const failedList = results.filter(r => r.status === 'failed' || r.status === 'error');

    console.log(`\n=======================================================`);
    console.log(`执行总结：`);
    console.log(`- 扫描文件总数: ${allFiles.length}`);
    console.log(`- ${args.dryRun ? '待裁剪' : '成功裁剪'}页码及伴生字: ${croppedList.length}`);
    console.log(`- 跳过（无页脚或间距不足）: ${skippedList.length}`);
    console.log(`- 异常/失败: ${failedList.length}`);
    console.log(`=======================================================`);
}

run();
