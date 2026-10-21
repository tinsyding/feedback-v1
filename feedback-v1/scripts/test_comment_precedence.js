/**
 * CSV 评语优先级纯函数测试。
 *
 * 运行：node feedback-v1/scripts/test_comment_precedence.js
 *
 * 规则：订正评语非空时作为最终展示评语；错题题号也优先从订正评语解析，
 * 订正评语没有题号时回退到原批改评语。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const commonPath = path.join(__dirname, '..', 'js', 'common.js');
const code = fs.readFileSync(commonPath, 'utf8');

// common.js 是浏览器脚本；用最小 DOM/window 桩加载其中的纯函数。
const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { onLine: true },
    fetch: async () => ({}),
    document: { readyState: 'loading', addEventListener() {} },
    location: { pathname: '/upload.html' }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'common.js' });

const {
    findCommentColumnIndex,
    getEffectiveComment,
    parseCommentForPlus
} = sandbox;

function expectNums(actual, expected) {
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

// 列名识别：必须避开末尾的“学生批改评语/学生订正评语”。
const header = ['序号', '姓名', '批改评语', '订正评语', '学生批改评语', '学生订正评语'];
assert.strictEqual(findCommentColumnIndex(header, '批改评语'), 2);
assert.strictEqual(findCommentColumnIndex(header, '订正评语'), 3);
assert.strictEqual(findCommentColumnIndex(['学生批改评语'], '批改评语'), -1);
assert.strictEqual(findCommentColumnIndex(['老师批改评语'], '批改评语'), 0);
assert.strictEqual(findCommentColumnIndex(null, '批改评语'), -1);

// 最终评语优先级。
assert.strictEqual(getEffectiveComment(['1', '张三', '原评语', '订正评语'], 2, 3), '订正评语');
assert.strictEqual(getEffectiveComment(['1', '张三', '原评语', '   '], 2, 3), '原评语');
assert.strictEqual(getEffectiveComment(['1', '张三', '原评语'], 2, -1), '原评语');
assert.strictEqual(getEffectiveComment(['1', '张三', '', ''], 2, 3), '');
assert.strictEqual(getEffectiveComment(null, 2, 3), '');

// 订正评语有题号：展示订正评语，同时清洗掉错题前缀。
let result = parseCommentForPlus(
    '本次作业的错题题号为：4，6\n原评语',
    '本次作业的错题题号为：4，6\n都订正对啦',
    {}
);
expectNums(result.errorNums, [4, 6]);
assert.strictEqual(result.displayComment, '都订正对啦');

// 原评语和订正评语都有题号且不一致：优先使用订正评语的题号。
result = parseCommentForPlus(
    '本次作业的错题题号为：4，6\n原评语',
    '本次作业的错题题号为：7，8\n都订正对啦',
    {}
);
expectNums(result.errorNums, [7, 8]);
assert.strictEqual(result.displayComment, '都订正对啦');

// 原评语没有题号，订正评语有题号：使用订正评语的题号。
result = parseCommentForPlus('作业没拍全', '本次作业的错题题号为：6，7', {});
expectNums(result.errorNums, [6, 7]);
assert.strictEqual(result.displayComment, '');

// 订正评语没有题号，原评语有题号：回退保留原错题信息，展示订正评语。
result = parseCommentForPlus('本次作业的错题题号为：4，6\n原评语', '订正的都对啦', {});
expectNums(result.errorNums, [4, 6]);
assert.strictEqual(result.displayComment, '订正的都对啦');

// 没有订正评语：保持原有行为。
result = parseCommentForPlus('本次作业的错题题号为：5\n原评语', '本次作业的错题题号为：5\n原评语', {});
expectNums(result.errorNums, [5]);
assert.strictEqual(result.displayComment, '原评语');

// 只有订正评语，且题号为全角数字。
result = parseCommentForPlus('', '本次作业的错题题号为：６', {});
expectNums(result.errorNums, [6]);
assert.strictEqual(result.displayComment, '');

// 订正评语明确全对、没有题号，但原评语有题号：回退保留原题号。
result = parseCommentForPlus('本次作业的错题题号为：7', '全对！\n非常优秀！', {});
expectNums(result.errorNums, [7]);
assert.strictEqual(result.displayComment, '全对！\n非常优秀！');

console.log('comment precedence tests passed');
