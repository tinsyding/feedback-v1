const fs = require('fs');
const path = require('path');

const list1 = [
    { errorNum: 2, parentNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2.pdf', sourceType: 'homework' },
    { errorNum: 2, parentNum: 2, subNum: 1, topic: '等腰三角形判定', exercisePdf: 'q2_v1.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 2, parentNum: 2, subNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2_v2.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 5, parentNum: 5, topic: '等腰三角形判定', exercisePdf: 'q5.pdf', sourceType: 'homework' },
    { errorNum: 5, parentNum: 5, subNum: 1, topic: '等腰三角形判定', exercisePdf: 'q5_v1.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 3, parentNum: 3, topic: '角平分线辅助线', exercisePdf: 'q3.pdf', sourceType: 'homework' },
    { errorNum: 3, parentNum: 3, subNum: 1, topic: '角平分线辅助线', exercisePdf: 'q3_v1.pdf', sourceType: 'variation', isVariation: true }
];

// 直接从生产文件 feedback-v1/js/retest.js 抽取 appendList 真实分组实现（含 isSameClusterItem）
const retestCode = fs.readFileSync(path.join(__dirname, '../feedback-v1/js/retest.js'), 'utf8');
const appendListMatch = retestCode.match(/^([ \t]*)const appendList = \(list, sourceType, headerWeek\) => \{[\s\S]*?^\1\};/m);
if (!appendListMatch) {
    throw new Error('Could not extract live appendList from feedback-v1/js/retest.js');
}

function runGrouping(list, sourceType, headerWeek) {
    const type = 'exercise';
    const pdfsToMerge = [];
    const invoke = new Function('type', 'pdfsToMerge', 'list', 'sourceType', 'headerWeek', `
        ${appendListMatch[0]}
        appendList(list, sourceType, headerWeek);
    `);
    invoke(type, pdfsToMerge, list, sourceType, headerWeek);
    return pdfsToMerge;
}

// 运行测试 1：原有基础分组测试
const result = runGrouping(list1, 'homework', '1');
console.log('Result items length:', result.length);
result.forEach((it, idx) => {
    console.log(`[${idx}] parent:${it.parentNum} isVar:${it.isVariation} sub:${it.subNum} merged:${it.isGroupMerged} topic:${it.clusterTopic} gStart:${it.isGroupStart} gEnd:${it.isGroupEnd}`);
});

if (result.length !== 7) throw new Error('Expected 7 items, got ' + result.length);
if (result[0].parentNum !== 2 || result[0].isVariation) throw new Error('First should be original Q2');
if (result[1].parentNum !== 5 || result[1].isVariation) throw new Error('Second should be original Q5');
if (!result[2].isVariation || !result[3].isVariation || !result[4].isVariation) throw new Error('Next 3 should be variations for group 1');
if (result[5].parentNum !== 3 || result[5].isVariation) throw new Error('Item 5 should be original Q3');
if (!result[6].isVariation) throw new Error('Item 6 should be variation Q3');
console.log('ALL ASSERTIONS FOR TEST 1 PASSED!');

// 运行测试 2：多题同知识点共享单道变式测试
const sharedList = [
    { errorNum: 2, parentNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2.pdf', sourceType: 'homework' },
    { errorNum: 5, parentNum: 5, topic: '等腰三角形判定', exercisePdf: 'q5.pdf', sourceType: 'homework' },
    {
        errorNum: 2,
        parentNum: 2,
        parentNums: [2, 5],
        matchedParentNums: [2, 5],
        subNum: 1,
        topic: '等腰三角形判定',
        exercisePdf: 'q_shared_v1.pdf',
        sourceType: 'variation',
        isVariation: true
    }
];

const resShared = runGrouping(sharedList, 'homework', '1');
console.log('\n--- Shared Variation Test ---');
console.log('Shared items length:', resShared.length);
resShared.forEach((it, idx) => {
    console.log(`[${idx}] parent:${it.parentNum} matched:[${it.matchedParentNums.join(',')}] isVar:${it.isVariation} merged:${it.isGroupMerged}`);
});

if (resShared.length !== 3) throw new Error('Expected exactly 3 items (2 originals + 1 shared variation)');
if (resShared[0].parentNum !== 2 || resShared[0].isVariation) throw new Error('First item should be original Q2');
if (resShared[1].parentNum !== 5 || resShared[1].isVariation) throw new Error('Second item should be original Q5');
if (!resShared[2].isVariation) throw new Error('Third item should be variation');
if (resShared[2].matchedParentNums.join(',') !== '2,5') throw new Error('Shared variation should match [2, 5]');
console.log('SHARED VARIATION TEST PASSED!');

// 运行测试 3：即使两处都传入了同一道共享变式（物理去重测试）
const dupSharedList = [
    { errorNum: 2, parentNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2.pdf', sourceType: 'homework' },
    { errorNum: 5, parentNum: 5, topic: '等腰三角形判定', exercisePdf: 'q5.pdf', sourceType: 'homework' },
    { errorNum: 2, parentNum: 2, parentNums: [2], subNum: 1, topic: '等腰三角形判定', exercisePdf: 'same_v.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 5, parentNum: 5, parentNums: [5], subNum: 1, topic: '等腰三角形判定', exercisePdf: 'same_v.pdf', sourceType: 'variation', isVariation: true }
];
const resDup = runGrouping(dupSharedList, 'homework', '1');
console.log('\n--- Deduplication Test ---');
console.log('Deduplicated items length:', resDup.length);
if (resDup.length !== 3) throw new Error('Expected 3 items after deduplicating same PDF URL in group');
if (resDup[2].matchedParentNums.join(',') !== '2,5') throw new Error('Merged variation should match both parents [2, 5]');
console.log('DEDUPLICATION TEST PASSED!');

// 运行测试 4：region_crop 模式同文件不同框选区域（验证 live retest.js isSameClusterItem / 去重逻辑）
const regionList = [
    {
        errorNum: 1,
        parentNum: 1,
        mode: 'region_crop',
        regions: [{ pageOffset: 0, x: 0.1, y: 0.1, w: 0.8, h: 0.2 }],
        topic: '一次函数图像',
        exercisePdf: 'shared_page.pdf',
        sourceType: 'homework'
    },
    {
        errorNum: 1,
        parentNum: 1,
        subNum: 1,
        mode: 'region_crop',
        regions: [{ pageOffset: 0, x: 0.1, y: 0.4, w: 0.8, h: 0.2 }],
        topic: '一次函数图像',
        exercisePdf: 'shared_page.pdf',
        sourceType: 'variation',
        isVariation: true
    },
    {
        errorNum: 2,
        parentNum: 2,
        subNum: 2,
        mode: 'region_crop',
        regions: [{ pageOffset: 0, x: 0.1, y: 0.7, w: 0.8, h: 0.2 }],
        topic: '一次函数图像',
        exercisePdf: 'shared_page.pdf',
        sourceType: 'variation',
        isVariation: true
    }
];
const resRegion = runGrouping(regionList, 'homework', '1');
console.log('\n--- Region Crop Cluster Boundary Test ---');
if (resRegion.length !== 3) throw new Error('Expected 3 items when region_crop variations use distinct regions on same PDF');
if (!resRegion[1].isClusterStart || !resRegion[1].isClusterEnd) throw new Error('Expected variation 1 to form its own cluster boundary');
if (!resRegion[2].isClusterStart || !resRegion[2].isClusterEnd) throw new Error('Expected variation 2 to form its own cluster boundary');
console.log('REGION CROP CLUSTER TEST PASSED!');
