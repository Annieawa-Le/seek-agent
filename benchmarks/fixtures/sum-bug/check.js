// 判定脚本：退出码 0 = 任务通过
const { add } = require('./math.js');
const cases = [
  [1, 2, 3],
  [-1, -2, -3],
  [5, -7, -2],
  [0, 0, 0],
  [-10, 10, 0],
];
for (const [a, b, expect] of cases) {
  const got = add(a, b);
  if (got !== expect) {
    console.error(`FAIL: add(${a}, ${b}) = ${got}, expect ${expect}`);
    process.exit(1);
  }
}
console.log('PASS: all cases');
process.exit(0);