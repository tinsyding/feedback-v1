const fs = require('fs');
const path = require('path');
const XLSX = require('../feedback-v1/js/libs/xlsx.full.min.js');

// Mock browser globals needed by common.js
global.window = global;
global.window.addEventListener = () => {};
global.document = {
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ appendChild: () => {}, setAttribute: () => {}, classList: { add: () => {} }, style: {} }),
    body: { appendChild: () => {}, classList: { add: () => {} } },
    documentElement: { setAttribute: () => {} }
};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
global.logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
};

// Load common.js
const commonCode = fs.readFileSync(path.join(__dirname, '../feedback-v1/js/common.js'), 'utf8');
eval(commonCode);

console.log('--- Testing common.js Functions ---');

// 1. normalizeWenjuanxingAnswer
const testCases = [
    { in: '1', out: 'A' },
    { in: '2', out: 'B' },
    { in: '3', out: 'C' },
    { in: '4', out: 'D' },
    { in: '1┋3', out: 'A┋C' },
    { in: '3┋1', out: 'A┋C' },
    { in: '2,4', out: 'B┋D' },
    { in: '3、1', out: 'A┋C' },
    { in: 'a', out: 'A' },
    { in: 'B┋D', out: 'B┋D' },
    { in: 'D┋B', out: 'B┋D' },
    { in: '', out: '' },
    { in: null, out: '' }
];

for (const tc of testCases) {
    const res = normalizeWenjuanxingAnswer(tc.in);
    if (res !== tc.out) {
        console.error(`FAIL: normalizeWenjuanxingAnswer('${tc.in}') = '${res}', expected '${tc.out}'`);
        process.exit(1);
    }
}
console.log('PASS: normalizeWenjuanxingAnswer works for all single/multi-choice formats.');

// 2. extractLessonNumber from upload.js
const uploadCode = fs.readFileSync(path.join(__dirname, '../feedback-v1/js/upload.js'), 'utf8');
const extractLessonMatch = uploadCode.match(/function extractLessonNumber[\s\S]*?\n\}/);
const chineseToNumberMatch = uploadCode.match(/function chineseToNumber[\s\S]*?\n\}/);
if (!extractLessonMatch || !chineseToNumberMatch) {
    console.error('FAIL: Could not find extractLessonNumber/chineseToNumber in upload.js');
    process.exit(1);
}
eval(chineseToNumberMatch[0]);
eval(extractLessonMatch[0]);

const lessonCases = [
    { in: '9P-8物理预习.xlsx', out: 8 },
    { in: '9ps06物理预习.xlsx', out: 6 },
    { in: '8PS-03预习.xlsx', out: 3 },
    { in: 'PS05测试.xlsx', out: 5 },
    { in: '专题二预习.xlsx', out: 2 },
    { in: '专题12预习.xlsx', out: 12 },
    { in: '第8次预习.xlsx', out: 8 }
];

for (const lc of lessonCases) {
    const res = extractLessonNumber(lc.in, 'preview');
    if (res !== lc.out) {
        console.error(`FAIL: extractLessonNumber('${lc.in}', 'preview') = ${res}, expected ${lc.out}`);
        process.exit(1);
    }
}
console.log('PASS: extractLessonNumber handles physics prefixes (9P-8, 9ps06, etc.) correctly.');

// 3. Synthetic Benchmark Testing: Teacher Row 1 Benchmark (Branch A)
console.log('\n--- Testing Row 1 Teacher Benchmark (Branch A) ---');
const dataBranchA = [
    ['序号', '提交答卷时间', '总分', '您的姓名：', '第1题', '第2题', '第3题', '第4题'],
    [1, '2026/10/14 10:00:00', 100, '物理王老师(测试)', '1', '2', '3', '4'], // Benchmark teacher: 100 (A, B, C, D)
    [2, '2026/10/14 10:05:00', 75, '张三', '1', '3', '3', '4'],            // Wrong: 2 (B!=C)
    [3, '2026/10/14 10:10:00', 50, '李四', '2', '2', '1', '4'],            // Wrong: 1 (A!=B), 3 (C!=A)
    [4, '2026/10/14 10:15:00', 100, '王五', '1', '2', '3', '4']            // Full score student
];

const benchmarkA = getWenjuanxingBenchmark(dataBranchA);
console.log('Branch A benchmark detected:', {
    isR1Benchmark: benchmarkA.isR1Benchmark,
    benchmarkName: benchmarkA.benchmarkName,
    standardAnswers: benchmarkA.standardAnswers
});
if (!benchmarkA.isR1Benchmark || benchmarkA.benchmarkName !== '物理王老师(测试)') {
    console.error('FAIL: Expected Row 1 teacher benchmark detected!');
    process.exit(1);
}

const parsedA = parseWenjuanxingBenchmarkAndErrors(dataBranchA, null);
if (parsedA.map['物理王老师(测试)']) {
    console.error('FAIL: Teacher benchmark present in student map!');
    process.exit(1);
}
if (JSON.stringify(parsedA.map['张三'].errors) !== JSON.stringify([2])) {
    console.error('FAIL: 张三 error match failed:', parsedA.map['张三'].errors);
    process.exit(1);
}
if (JSON.stringify(parsedA.map['李四'].errors) !== JSON.stringify([1, 3])) {
    console.error('FAIL: 李四 error match failed:', parsedA.map['李四'].errors);
    process.exit(1);
}
console.log('PASS: Branch A accurately matches errors and excludes teacher.');

// 4. Synthetic Benchmark Testing: Fallback Benchmark (Branch B - Row 1 not max score)
console.log('\n--- Testing Fallback Benchmark (Branch B) ---');
const dataBranchB = [
    ['序号', '提交答卷时间', '总分', '您的姓名：', '1.单选题', '2.单选题', '3.单选题'],
    [1, '2026/10/14 10:00:00', 66.7, '普通学生A', 'A', 'C', 'C'], // Row 1 is a student (wrong Q2)
    [2, '2026/10/14 10:05:00', 100, '学霸学生B', 'A', 'B', 'C']   // Row 2 is full score standard
];

const benchmarkB = getWenjuanxingBenchmark(dataBranchB);
console.log('Branch B benchmark detected:', {
    isR1Benchmark: benchmarkB.isR1Benchmark,
    benchmarkName: benchmarkB.benchmarkName,
    standardAnswers: benchmarkB.standardAnswers
});
if (benchmarkB.isR1Benchmark !== false || benchmarkB.benchmarkName !== '学霸学生B') {
    console.error('FAIL: Expected fallback to Row 2 standard!');
    process.exit(1);
}

const parsedB = parseWenjuanxingBenchmarkAndErrors(dataBranchB, null);
// Row 1 should NOT be excluded because isR1Benchmark is false
if (!parsedB.map['普通学生A']) {
    console.error('FAIL: 普通学生A should NOT be excluded when Row 1 is not teacher benchmark!');
    process.exit(1);
}
if (JSON.stringify(parsedB.map['普通学生A'].errors) !== JSON.stringify([2])) {
    console.error('FAIL: 普通学生A error match failed:', parsedB.map['普通学生A'].errors);
    process.exit(1);
}
console.log('PASS: Branch B correctly uses fallback and keeps all students.');

// 5. Test buildWenjuanxingPreviewMetrics from viewer.js
console.log('\n--- Testing buildWenjuanxingPreviewMetrics (viewer.js logic) ---');
const viewerCode = fs.readFileSync(path.join(__dirname, '../feedback-v1/js/viewer.js'), 'utf8');
const vm = require('vm');
const sandbox = {
    window: {},
    console: console,
    normalizeWenjuanxingAnswer: global.normalizeWenjuanxingAnswer,
    extractWenjuanxingQuestionColumns: global.extractWenjuanxingQuestionColumns,
    getWenjuanxingBenchmark: global.getWenjuanxingBenchmark,
    parseWenjuanxingBenchmarkAndErrors: global.parseWenjuanxingBenchmarkAndErrors,
    extractStudentNamesFromData: global.extractStudentNamesFromData,
    formatMetricValue: global.formatMetricValue,
    parseScoreValue: global.parseScoreValue,
    shouldForceIntegerScores: () => false
};
vm.createContext(sandbox);

const funcMatch = viewerCode.match(/function buildWenjuanxingPreviewMetrics[\s\S]*?\n\}/);
const formatMetricMatch = viewerCode.match(/function formatMetricValue[\s\S]*?\n\}/);
vm.runInContext(formatMetricMatch[0], sandbox);
vm.runInContext(funcMatch[0], sandbox);

const metrics = sandbox.buildWenjuanxingPreviewMetrics(dataBranchA, null);
console.log('buildWenjuanxingPreviewMetrics summary:', {
    submittedCount: metrics.stats.submittedCount,
    displayMax: metrics.stats.displayMax,
    displayAvg: metrics.stats.displayAvg,
    isR1Benchmark: metrics.stats.benchmark?.isR1Benchmark,
    benchmarkName: metrics.stats.benchmark?.benchmarkName
});

if (metrics.map['物理王老师(测试)']) {
    console.error('FAIL: Teacher present in viewer map!');
    process.exit(1);
}
if (metrics.stats.submittedCount !== 3) {
    console.error('FAIL: Expected submittedCount to be 3 (excluding teacher), got:', metrics.stats.submittedCount);
    process.exit(1);
}
console.log('PASS: buildWenjuanxingPreviewMetrics verified.');

// 6. Test upload.js roster exclusion for Wenjuanxing
console.log('\n--- Testing upload.js name extraction & benchmark exclusion ---');
const uploadSandbox = {
    window: {},
    console: console,
    previewData: dataBranchA,
    physicsPreviewSource: 'wenjuanxing',
    normalizeWenjuanxingAnswer: global.normalizeWenjuanxingAnswer,
    extractWenjuanxingQuestionColumns: global.extractWenjuanxingQuestionColumns,
    getWenjuanxingBenchmark: global.getWenjuanxingBenchmark,
    parseWenjuanxingBenchmarkAndErrors: global.parseWenjuanxingBenchmarkAndErrors
};
vm.createContext(uploadSandbox);

const extractNamesMatch = uploadCode.match(/function extractStudentNamesFromData[\s\S]*?\n\}/);
const getWjxNamesMatch = uploadCode.match(/function getWenjuanxingNames[\s\S]*?\n\}/);
vm.runInContext(extractNamesMatch[0], uploadSandbox);
vm.runInContext(getWjxNamesMatch[0], uploadSandbox);

const namesExtracted = uploadSandbox.extractStudentNamesFromData(dataBranchA);
const wjxNamesExtracted = uploadSandbox.getWenjuanxingNames(dataBranchA);

if (namesExtracted.includes('物理王老师(测试)') || wjxNamesExtracted.includes('物理王老师(测试)')) {
    console.error('FAIL: Teacher benchmark was NOT excluded in upload.js!');
    process.exit(1);
}
console.log('PASS: upload.js correctly excluded teacher from roster and mismatch dialogs.');

console.log('\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! ✅');
