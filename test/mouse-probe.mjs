import { parseMouseEvents } from 'ink-use-mouse';
import { writeFileSync } from 'fs';

const samples = {
  press: '\x1b[<0;10;5M',
  release: '\x1b[<0;10;5m',
  scrollUp: '\x1b[<64;20;8M',
  scrollDown: '\x1b[<65;20;9M',
  move: '\x1b[<35;30;12M',
  moveNoButton: '\x1b[<3;30;12M',
};

const out = {};
for (const [k, v] of Object.entries(samples)) {
  try {
    out[k] = parseMouseEvents(v);
  } catch (e) {
    out[k] = 'ERR: ' + e.message;
  }
}
writeFileSync('mouse-probe-result.json', JSON.stringify(out, null, 2));
console.log('written, keys=' + Object.keys(out).length);
