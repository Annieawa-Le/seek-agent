// 求和函数：当前实现对负数处理有缺陷（负数被当作 0）
function add(a, b) {
  const va = a < 0 ? 0 : a;
  const vb = b < 0 ? 0 : b;
  return va + vb;
}
module.exports = { add };