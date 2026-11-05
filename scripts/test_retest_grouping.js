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
            validItems.push({
                url: url,
                errorNum: parseQNum(p.errorNum),
                parentNum: parseQNum(p.parentNum || p.parent_question_num || p.errorNum),
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
            group.variationItems.push(item);
        }
    });

    groups.sort((a, b) => a.firstOrder - b.firstOrder);

    const pdfsToMerge = [];
    groups.forEach(group => {
        const parentNums = Array.from(group.parentNumsSet).sort((a, b) => a - b);
        const isGroupMerged = group.topic !== '' && group.originalItems.length >= 2;

        group.originalItems.sort((a, b) => a.parentNum - b.parentNum);
        group.variationItems.sort((a, b) => {
            const pDiff = a.parentNum - b.parentNum;
            if (pDiff !== 0) return pDiff;
            return (a.subNum || 1) - (b.subNum || 1);
        });

        const variationTotalByParent = new Map();
        const variationCountByParent = new Map();
        group.variationItems.forEach(v => {
            const p = v.parentNum;
            const s = parseInt(v.subNum, 10) || 1;
            variationTotalByParent.set(p, Math.max(variationTotalByParent.get(p) || 0, s));
            variationCountByParent.set(p, (variationCountByParent.get(p) || 0) + 1);
        });

        const groupItems = group.originalItems.concat(group.variationItems);
        if (groupItems.length === 0) return;

        const totalVariationsInGroup = group.variationItems.length;

        groupItems.forEach((item, idx) => {
            const pNum = item.parentNum;
            const varTotal = variationTotalByParent.get(pNum) || 0;
            const varCount = variationCountByParent.get(pNum) || 0;

            pdfsToMerge.push({
                ...item,
                parentNum: pNum,
                clusterTopic: group.topic,
                variationTotal: varTotal,
                variationCount: varCount,
                isGroupMerged: isGroupMerged,
                groupTopic: group.topic,
                groupParentNums: parentNums,
                groupVariationCount: totalVariationsInGroup,
                isGroupStart: idx === 0,
                isGroupEnd: idx === groupItems.length - 1,
                isClusterStart: idx === 0 || groupItems[idx - 1].parentNum !== pNum || groupItems[idx - 1].isVariation !== item.isVariation || groupItems[idx - 1].subNum !== item.subNum,
                isClusterEnd: idx === groupItems.length - 1 || groupItems[idx + 1].parentNum !== pNum || groupItems[idx + 1].isVariation !== item.isVariation || groupItems[idx + 1].subNum !== item.subNum
            });
        });
    });

    return pdfsToMerge;
}

const res = runGrouping(list1, 'homework', 1);
console.log('Result items length:', res.length);
res.forEach((r, i) => {
    console.log(`[${i}] parent:${r.parentNum} isVar:${r.isVariation} sub:${r.subNum} merged:${r.isGroupMerged} topic:${r.clusterTopic} gStart:${r.isGroupStart} gEnd:${r.isGroupEnd}`);
});

// Verification assertions:
// Group 1 should be '等腰三角形判定' (firstOrder: 2)
// Item 0: Q2 (原题), gStart: true, merged: true
// Item 1: Q5 (原题), gStart: false, merged: true
// Item 2: Q2-v1, isVar: true, sub: 1
// Item 3: Q2-v2, isVar: true, sub: 2
// Item 4: Q5-v1, isVar: true, sub: 1, gEnd: true
// Group 2 should be '角平分线辅助线' (firstOrder: 3)
// Item 5: Q3 (原题), gStart: true, merged: false
// Item 6: Q3-v1, isVar: true, sub: 1, gEnd: true

console.assert(res.length === 7, 'Length should be 7');
console.assert(res[0].parentNum === 2 && !res[0].isVariation && res[0].isGroupStart, 'res[0] should be Q2 original and groupStart');
console.assert(res[1].parentNum === 5 && !res[1].isVariation && !res[1].isGroupStart, 'res[1] should be Q5 original and NOT groupStart');
console.assert(res[2].parentNum === 2 && res[2].isVariation && res[2].subNum === 1, 'res[2] should be Q2-v1');
console.assert(res[3].parentNum === 2 && res[3].isVariation && res[3].subNum === 2, 'res[3] should be Q2-v2');
console.assert(res[4].parentNum === 5 && res[4].isVariation && res[4].subNum === 1 && res[4].isGroupEnd, 'res[4] should be Q5-v1 and groupEnd');
console.assert(res[5].parentNum === 3 && !res[5].isVariation && res[5].isGroupStart && !res[5].isGroupMerged, 'res[5] should be Q3 original not merged');
console.assert(res[6].parentNum === 3 && res[6].isVariation && res[6].isGroupEnd, 'res[6] should be Q3-v1 and groupEnd');

console.log('ALL ASSERTIONS PASSED!');

// Edge case 1: questions with empty topic
const list2 = [
    { errorNum: 2, parentNum: 2, topic: '等腰三角形判定', exercisePdf: 'q2.pdf', sourceType: 'homework' },
    { errorNum: 3, parentNum: 3, topic: '', exercisePdf: 'q3.pdf', sourceType: 'homework' },
    { errorNum: 5, parentNum: 5, topic: '等腰三角形判定', exercisePdf: 'q5.pdf', sourceType: 'homework' },
    { errorNum: 6, parentNum: 6, topic: '', exercisePdf: 'q6.pdf', sourceType: 'homework' },
];

const res2 = runGrouping(list2, 'homework', 1);
console.log('res2:');
res2.forEach(r => console.log('  p:' + r.parentNum + ' topic:' + r.clusterTopic + ' merged:' + r.isGroupMerged));
console.assert(res2[0].parentNum === 2 && res2[0].isGroupMerged === true, 'Q2 merged');
console.assert(res2[1].parentNum === 5 && res2[1].isGroupMerged === true, 'Q5 merged');
console.assert(res2[2].parentNum === 3 && res2[2].isGroupMerged === false, 'Q3 not merged');
console.assert(res2[3].parentNum === 6 && res2[3].isGroupMerged === false, 'Q6 not merged');
console.log('Edge case 1 passed!');

// Edge case 2: orphan variation
const list3 = [
    { errorNum: 2, parentNum: 2, subNum: 1, topic: '等腰三角形判定', exercisePdf: 'q2_v1.pdf', sourceType: 'variation', isVariation: true }
];
const res3 = runGrouping(list3, 'homework', 1);
console.assert(res3.length === 1 && res3[0].isVariation === true, 'Orphan variation handled');
console.log('Edge case 2 passed!');
