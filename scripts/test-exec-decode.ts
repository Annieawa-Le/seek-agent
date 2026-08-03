/**
 * test-exec-decode.ts — execute_command 智能解码回归测试
 *
 * 覆盖场景：
 *  1. UTF-8 输出（Node 程序，此前被强制 GBK 解码乱码）
 *  2. GBK 输出（cmd 内建命令 echo，仍应正常）
 *  3. UTF-8 序列被切断（timeout/中断切在多字节字符中间）
 *  4. 纯 GBK 中文 buffer 不被误判为 UTF-8
 *  5. Python 输出（PYTHONUTF8 env 下应为 UTF-8）
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { decodeSmart } from '../src/tools/execute-command.js';

const execPromise = promisify(exec);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${detail ? '→ ' + detail : ''}`);
  }
}

/** 模拟 execute_command 的调用方式（exec + buffer + env） */
async function runRaw(cmd: string): Promise<Buffer> {
  const { stdout } = await execPromise(cmd, {
    encoding: 'buffer',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  return stdout as Buffer;
}

async function main() {
  // 1. Node 程序输出 UTF-8 中文
  const utf8Buf = await runRaw(`node -e "console.log('中文测试ABC')"`);
  const utf8Text = decodeSmart(utf8Buf).trim();
  check('UTF-8 输出解码正常', utf8Text === '中文测试ABC', `实际: ${utf8Text}`);

  // 2. cmd 内建 echo 输出 GBK 中文
  const gbkBuf = await runRaw(`echo 中文测试`);
  const gbkText = decodeSmart(gbkBuf).trim();
  check('GBK 输出回退解码正常', gbkText.includes('中文测试'), `实际: ${gbkText}`);

  // 3. UTF-8 序列被切断：截 2 字节只丢末尾 ASCII；截 5 字节切在'试'(E8AF95)多字节中间
  const cut2 = utf8Buf.subarray(0, utf8Buf.length - 2);
  const cutText2 = decodeSmart(cut2).trim();
  check('UTF-8 末尾切断正常', cutText2 === '中文测试AB', `实际: ${cutText2}`);
  const cut5 = utf8Buf.subarray(0, utf8Buf.length - 5);
  const cutText5 = decodeSmart(cut5).trim();
  check('UTF-8 多字节切断兜底正常', cutText5 === '中文测', `实际: ${cutText5}`);

  // 4. 纯 GBK buffer（构造：GBK 编码的"中文测试"）
  //    iconv-lite 编码生成 GBK 字节
  const iconv = (await import('iconv-lite')).default;
  const gbkEncoded = iconv.encode('中文测试', 'gbk');
  const decoded = decodeSmart(gbkEncoded);
  check('纯 GBK buffer 不误判为 UTF-8', decoded === '中文测试', `实际: ${decoded}`);

  // 5. Python 输出（有 PYTHONUTF8 时 UTF-8）
  try {
    const pyBuf = await runRaw(`python -c "print('Python中文')"`);
    const pyText = decodeSmart(pyBuf).trim();
    check('Python 输出解码正常', pyText === 'Python中文', `实际: ${pyText}`);
  } catch {
    check('Python 输出解码正常', false, 'python 命令不可用或执行失败');
  }

  // 6. ASCII 输出不受影响
  const asciiBuf = await runRaw(`echo hello world`);
  const asciiText = decodeSmart(asciiBuf).trim();
  check('ASCII 输出正常', asciiText === 'hello world', `实际: ${asciiText}`);

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 项通过，${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});



