/** 直接调用风格工具，看返回值到底长什么样（复现「没有 result」） */
const mod = await import('../index.ts')

const list = await mod.style_list.execute({}, {})
console.log('=== style_list 返回类型:', typeof list)
console.log('=== 长度:', typeof list === 'string' ? list.length : '(非字符串)')
console.log('=== 前 600 字符 ===')
console.log(String(list).slice(0, 600))
console.log('=== 换行数:', String(list).split('\n').length)

const get = await mod.style_get.execute({ slug: 'wabi-sabi' }, {})
console.log('\n=== style_get 返回长度:', String(get).length)
console.log('=== 前 200 字符 ===')
console.log(String(get).slice(0, 200))
