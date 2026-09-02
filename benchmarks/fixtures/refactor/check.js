// 判定脚本：退出码 0 = 行为未变
const { addAllPositive, sumOverTen } = require('./utils.js');

const nums = [1, -3, 12, 5, -7, 20, 0, 11];
if (addAllPositive(nums) !== 1 + 5 + 12 + 20 + 11) {
  console.error('FAIL: addAllPositive 结果不符');
  process.exit(1);
}
if (sumOverTen(nums) !== 12 + 20 + 11) {
  console.error('FAIL: sumOverTen 结果不符');
  process.exit(1);
}

// 额外检查：公共逻辑确实被提取（任一 helper 里不得再出现独立的过滤 + 累加循环 x2）
const src = require('fs').readFileSync(require('path').join(__dirname, 'utils.js'), 'utf-8');
const loopCount = (src.match(/for\s*\(/g) || []).length;
if (loopCount > 1) {
  console.error(`FAIL: 仍有重复的循环逻辑（检测到 ${loopCount} 个 for）`);
  process.exit(1);
}

console.log('PASS: behavior unchanged and deduplicated');
process.exit(0);