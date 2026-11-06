const fs = require('fs');

const list1 = [
    { errorNum: 2, parentNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2.pdf', sourceType: 'homework' },
    { errorNum: 2, parentNum: 2, subNum: 1, topic: '等腰三角形判定', exercisePdf: 'q2_v1.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 2, parentNum: 2, subNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2_v2.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 5, parentNum: 5, topic: '等腰三角形判定', exercisePdf: 'q5.pdf', sourceType: 'homework' },
    { errorNum: 5, parentNum: 5, subNum: 1, topic: '等腰三角形判定', exercisePdf: 'q5_v1.pdf', sourceType: 'variation', isVariation: true },
    { errorNum: 3, parentNum: 3, topic: '角平分线辅助线', exercisePdf: 'q3.pdf', sourceType: 'homework' },
    { errorNum: 3, parentNum: 3, subNum: 1, topic: '角平分线辅助线', exercisePdf: 'q3_v1.pdf', sourceType: 'variation', isVariation: true }
];

function runGrouping(list, sourceType, headerWeek) {
    const parseQNum = val => {
        if (typeof val === 'number') return val;
        const m = String(val || '').match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    };
    const cleanTopic = t => String(t || '').trim().replace(/[\s,，.。;；:：、\-_—]+$/u, '');

    const validItems = [];
    list.forEach(p => {
        const url = p.exercisePdf;
        if (url) {
            const actualSourceType = (sourceType === 'preview') ? 'preview' : (p.sourceType || sourceType);
            const isVar = actualSourceType === 'variation' || Boolean(p.isVariation);

            let pNums = [];
            if (Array.isArray(p.matchedParentNums) && p.matchedParentNums.length > 0) {
                pNums = p.matchedParentNums.map(parseQNum).filter(n => n > 0);
            } else if (Array.isArray(p.parentNums) && p.parentNums.length > 0) {
                pNums = p.parentNums.map(parseQNum).filter(n => n > 0);
            } else if (typeof p.parent_question_nums === 'string' && p.parent_question_nums) {
                pNums = p.parent_question_nums.split(',').map(parseQNum).filter(n => n > 0);
            }
            const pNum = parseQNum(p.parentNum || p.parent_question_num || p.errorNum);
            if (pNums.length === 0 && pNum > 0) {
                pNums = [pNum];
            }

            validItems.push({
                url: url,
                errorNum: parseQNum(p.errorNum),
                parentNum: pNum,
                parentNums: pNums,
                matchedParentNums: pNums,
                subNum: p.subNum || 1,
                videoUrl: p.videoUrl || p.video_url || '',
                topic: p.topic || '',
                week: headerWeek,
                sourceType: actualSourceType,
                isVariation: isVar
            });
        }
    });

    validItems.sort((a, b) => {
        const diff = parseQNum(a.errorNum) - parseQNum(b.errorNum);
        if (diff !== 0) return diff;
        const rankA = a.isVariation ? (10 + (a.subNum || 1)) : 0;
        const rankB = b.isVariation ? (10 + (b.subNum || 1)) : 0;
        return rankA - rankB;
    });

    const parentTopicMap = new Map();
    validItems.forEach(item => {
        if (!item.isVariation && cleanTopic(item.topic)) {
            parentTopicMap.set(item.parentNum, cleanTopic(item.topic));
        }
    });

    const groups = [];
    const groupByTopicKey = new Map();

    validItems.forEach(item => {
        const parentNum = item.parentNum;
        const itemTopic = cleanTopic(item.topic) || parentTopicMap.get(parentNum) || '';
        const topicKey = itemTopic ? ('topic:' + itemTopic) : ('orphan_parent:' + parentNum);

        let group = groupByTopicKey.get(topicKey);
        if (!group) {
            group = {
                topicKey: topicKey,
                topic: itemTopic,
                sourceType: item.sourceType,
                firstOrder: parentNum,
                parentNumsSet: new Set(),
                originalItems: [],
                variationItems: []
            };
            groups.push(group);
            groupByTopicKey.set(topicKey, group);
        }

        group.parentNumsSet.add(parentNum);
        if (parentNum < group.firstOrder) {
            group.firstOrder = parentNum;
        }

        if (!item.isVariation) {
            group.originalItems.push(item);
        } else {
            // 同一考点组内变式按 url 去重并合并关联原题
            const existingVar = group.variationItems.find(v => v.url === item.url);
            if (existingVar) {
                const mergedPNums = Array.from(new Set(
                    (existingVar.parentNums || []).concat(item.parentNums || [])
                )).sort((a, b) => a - b);
                existingVar.parentNums = mergedPNums;
                existingVar.matchedParentNums = mergedPNums;
            } else {
                group.variationItems.push(item);
            }
        }
    });

    groups.sort((a, b) => a.firstOrder - b.firstOrder);

    const pdfsToMerge = [];
    groups.forEach(group => {
        const parentNums = Array.from(group.parentNumsSet).sort((a, b) => a - b);
        const isGroupMerged = group.topic !== '' && group.originalItems.length >= 2;

        group.originalItems.sort((a, b) => a.parentNum - b.parentNum);

        // 计算组内各变式命中的原题
        group.variationItems.forEach(v => {
            const allP = Array.isArray(v.parentNums) && v.parentNums.length > 0 ? v.parentNums : [v.parentNum];
            const matched = allP.filter(p => parentNums.includes(p));
            v.matchedParentNums = matched.length > 0 ? matched : (allP.length > 0 ? allP : [v.parentNum]);
        });

        group.variationItems.sort((a, b) => {
            const pA = Array.isArray(a.matchedParentNums) && a.matchedParentNums.length > 0 ? a.matchedParentNums[0] : a.parentNum;
            const pB = Array.isArray(b.matchedParentNums) && b.matchedParentNums.length > 0 ? b.matchedParentNums[0] : b.parentNum;
            const pDiff = pA - pB;
            if (pDiff !== 0) return pDiff;
            return (a.subNum || 1) - (b.subNum || 1);
        });

        const totalVariationsInGroup = group.variationItems.length;

        const groupItems = group.originalItems.concat(group.variationItems);
        if (groupItems.length === 0) return;

        groupItems.forEach((item, idx) => {
            const pNum = item.parentNum;
            const varTotal = totalVariationsInGroup;
            const varCount = totalVariationsInGroup;

            pdfsToMerge.push({
                ...item,
                parentNum: pNum,
                parentNums: item.parentNums || [pNum],
                matchedParentNums: item.matchedParentNums || [pNum],
                clusterTopic: group.topic,
                variationTotal: varTotal,
                variationCount: varCount,
                isGroupMerged: isGroupMerged,
                groupTopic: group.topic,
                groupParentNums: parentNums,
                groupVariationCount: totalVariationsInGroup,
                isGroupStart: idx === 0,
                isGroupEnd: idx === groupItems.length - 1,
                isClusterStart: idx === 0 || groupItems[idx - 1].url !== item.url || groupItems[idx - 1].isVariation !== item.isVariation,
                isClusterEnd: idx === groupItems.length - 1 || groupItems[idx + 1].url !== item.url || groupItems[idx + 1].isVariation !== item.isVariation
            });
        });
    });

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
