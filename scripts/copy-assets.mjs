import { readdirSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const OUT = join(ROOT, 'dist', 'release', 'agent');

function copyDir(src, dest, filter) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, filter);
    } else if (filter(entry.name)) {
      copyFileSync(s, d);
    }
  }
}

// 1. Copy prompts/*.md
copyDir(join(ROOT, 'src', 'prompts'), join(OUT, 'prompts'), n => n.endsWith('.md'));

// 2. Copy skill configs (enable.json + SYSTEM_INJECTION.md)
copyDir(join(ROOT, 'src', 'tools', 'inner_skills'), join(OUT, 'tools', 'inner_skills'),
  n => n === 'enable.json' || n.endsWith('.md'));

// 3. Copy compiled JS from dist/agent
copyDir(join(ROOT, 'dist', 'agent'), OUT, () => true);

// 4. Write package.json so Node treats .js files as ESM
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: 'seek-agent-runtime',
  type: 'module',
  private: true
}, null, 2), 'utf8');

console.log('Assets copied to ' + OUT);

