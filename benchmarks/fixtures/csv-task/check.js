// 判定脚本：退出码 0 = 任务通过。读取 result.txt，断言格式与总和值。
const fs = require('fs');
const path = require('path');

const expected = 187; // 12+7+23+4+31+9+18+2+15+66
const resultFile = path.join(__dirname, 'result.txt');
if (!fs.existsSync(resultFile)) {
  console.error('FAIL: result.txt 不存在');
  process.exit(1);
}
const content = fs.readFileSync(resultFile, 'utf-8').trim();
const m = content.match(/^TOTAL=(\d+)$/);
if (!m) {
  console.error(`FAIL: result.txt 格式不符: "${content}"`);
  process.exit(1);
}
if (Number(m[1]) !== expected) {
  console.error(`FAIL: TOTAL=${m[1]}, expect ${expected}`);
  process.exit(1);
}
console.log('PASS: result.txt 正确');
process.exit(0);