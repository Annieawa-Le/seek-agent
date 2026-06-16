import { patchStaging } from '../src/tools/patch-staging.js';

interface FakePatch {
    type: 'add' | 'del' | 'modify';
    rawFilePath: string;
    resolvedPath: string;
    description: string;
    params: Record<string, any>;
    createdAt: number;
    sessionId: string;
}

function makePatch(type: 'add' | 'del' | 'modify', idx: number): FakePatch {
    return {
        type,
        rawFilePath: `test-${idx}.ts`,
        resolvedPath: `test-${idx}.ts`,
        description: `${type} #${idx}`,
        params: {},
        createdAt: Date.now(),
        sessionId: patchStaging.getSessionId(),
    };
}

// ── 1. 清空初始状态 ──
patchStaging.clear();
console.log('=== 初始状态 ===');
console.log('size:', patchStaging.size, '| isEmpty:', patchStaging.isEmpty());

// ── 2. 添加 3 个 patch，逐个 pop ──
console.log('\n=== 添加 3 个 patch，逐次 pop ===');
patchStaging.add(makePatch('add', 1));
patchStaging.add(makePatch('modify', 2));
patchStaging.add(makePatch('del', 3));
console.log('添加后 size:', patchStaging.size);

let p: any;
p = patchStaging.pop();
console.log('pop #1:', p?.description, '| size:', patchStaging.size);
p = patchStaging.pop();
console.log('pop #2:', p?.description, '| size:', patchStaging.size);
p = patchStaging.pop();
console.log('pop #3:', p?.description, '| size:', patchStaging.size);

// ── 3. 空暂存区 pop ──
console.log('\n=== 空暂存区 pop ===');
p = patchStaging.pop();
console.log('pop on empty:', p ?? 'undefined', '| size:', patchStaging.size);

// ── 4. 验证 LIFO 顺序 ──
console.log('\n=== 验证倒序弹出 (LIFO) ===');
patchStaging.add(makePatch('add', 10));
patchStaging.add(makePatch('modify', 20));
patchStaging.add(makePatch('del', 30));

const order: string[] = [];
let item: any = patchStaging.pop();
while (item) {
    order.push(item.description);
    item = patchStaging.pop();
}
console.log('弹出顺序:', order.join(' → '));
console.log('期望顺序:  del #30 → modify #20 → add #10');
const ok = JSON.stringify(order) === JSON.stringify(['del #30', 'modify #20', 'add #10']);
console.log('顺序正确:', ok ? '✅ PASS' : '❌ FAIL');

// ── 5. clear 后 pop ──
console.log('\n=== clear 后 pop ===');
patchStaging.add(makePatch('add', 99));
patchStaging.clear();
console.log('clear 后 size:', patchStaging.size, '| isEmpty:', patchStaging.isEmpty());
p = patchStaging.pop();
console.log('clear 后 pop:', p ?? 'undefined (ok)');

console.log('\n=== ✅ 全部测试完成 ===');
