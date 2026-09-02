// 工具函数：下面两个函数逻辑重复（过滤 + 累加），请提取一个公共 helper 并让两者复用它，
// 保持对外行为完全一致（check.js 的断言必须继续通过）。
function addAllPositive(nums) {
  let sum = 0;
  for (const n of nums) {
    if (n > 0) sum += n;
  }
  return sum;
}

function sumOverTen(nums) {
  let sum = 0;
  for (const n of nums) {
    if (n > 10) sum += n;
  }
  return sum;
}

module.exports = { addAllPositive, sumOverTen };