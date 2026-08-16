/**
 * test-dsh-skill.ts —— dsh skill 兼容层测试
 *
 * 覆盖：
 *  1. 纯函数：isDshSkillName / parseDshSkillFrontmatter / parseDshSkillFile /
 *     resolveDshSkillRoots / discoverDshSkills
 *  2. 工具：dsh_skill_catalog / dsh_skill（含 disable-model-invocation 拒绝）
 *  3. 真实样本：dsh 官方 .agents/skills 的 dsh-pre-push-checks / dsh-prose-standard
 */
import {
  isDshSkillName,
  parseDshSkillFrontmatter,
  parseDshSkillFile,
  resolveDshSkillRoots,
  discoverDshSkills,
  loadDshSkill,
} from '../src/tools/inner_skills/dsh-skill/lib';
import { dsh_skill_catalog, dsh_skill } from '../src/tools/inner_skills/dsh-skill/index';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FIXTURE = path.join('scripts', 'fixtures', 'dsh-skill-fixture');
const FIXTURE_ABS = path.resolve(FIXTURE);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function expectContains(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

// ── 1. isDshSkillName ──
check('isDshSkillName: kebab-case 通过', isDshSkillName('dsh-pre-push-checks') === true);
check('isDshSkillName: 纯小写单词通过', isDshSkillName('goodskill') === true);
check('isDshSkillName: 数字通过', isDshSkillName('skill2') === true);
check('isDshSkillName: 大写拒绝', isDshSkillName('Bad-Name') === false);
check('isDshSkillName: 连续连字符拒绝', isDshSkillName('a--b') === false);
check('isDshSkillName: 首连字符拒绝', isDshSkillName('-abc') === false);
check('isDshSkillName: 尾连字符拒绝', isDshSkillName('abc-') === false);

// ── 2. parseDshSkillFrontmatter ──
const goodRaw = fs.readFileSync(path.join(FIXTURE, 'good-skill', 'SKILL.md'), 'utf-8');
const parsed = parseDshSkillFrontmatter(goodRaw);
check('frontmatter: 解析成功', parsed !== undefined);
check('frontmatter: name 正确', parsed?.data.name === 'good-skill');
check('frontmatter: description 正确', (parsed?.data.description as string).includes('compatibility'));
check('frontmatter: whenToUse 可选字段', parsed?.data.whenToUse === 'When testing the compatibility layer.');
check('frontmatter: body 为 frontmatter 之后正文', parsed?.body.trim().startsWith('# Good Skill') === true);

const noFm = parseDshSkillFrontmatter('# no frontmatter\nplain text');
check('frontmatter: 无 frontmatter 返回 undefined', noFm === undefined);
const brokenFm = parseDshSkillFrontmatter('---\nname: x\n'); // 未闭合
check('frontmatter: 未闭合返回 undefined', brokenFm === undefined);

// ── 3. parseDshSkillFile ──
(async () => {
  const good = await parseDshSkillFile(path.join(FIXTURE, 'good-skill', 'SKILL.md'));
  check('parseDshSkillFile: 目录形态解析成功', good?.name === 'good-skill');
  check('parseDshSkillFile: content 为正文', good?.content.includes('Usage') === true);
  check('parseDshSkillFile: directory 为资源基准', path.resolve(good.directory ?? '') === path.join(FIXTURE_ABS, 'good-skill'));

  const flat = await parseDshSkillFile(path.join(FIXTURE, 'flat-skill.md'));
  check('parseDshSkillFile: 扁平形态解析成功', flat?.name === 'flat-skill');

  const bad = await parseDshSkillFile(path.join(FIXTURE, 'bad-skill', 'SKILL.md'));
  check('parseDshSkillFile: 缺 description 返回 undefined', bad === undefined);
  // ── 4. resolveDshSkillRoots（先设置 SEEK_DSH_SKILL_DIRS 使 custom 根生效）──
  process.env.SEEK_DSH_SKILL_DIRS = FIXTURE_ABS;
  const roots = resolveDshSkillRoots(FIXTURE_ABS);

  const dModel = await parseDshSkillFile(path.join(FIXTURE, 'disable-model', 'SKILL.md'));
  check('parseDshSkillFile: disable-model-invocation 解析', dModel?.modelInvocable === false);
  check('parseDshSkillFile: user-invocable 解析', dModel?.userInvocable === true);

  const official = await parseDshSkillFile(path.join(FIXTURE, 'official-push-checks', 'SKILL.md'));
  check('parseDshSkillFile: dsh 官方 skill 解析成功', official?.name === 'dsh-pre-push-checks');
  check('parseDshSkillFile: dsh 官方 skill description 非空', (official?.description ?? '').length > 20);
  check('parseDshSkillFile: dsh 官方 skill 正文非空', (official?.content ?? '').length > 500);

  check('roots: 含 project-dsh (.dsh/skills)', roots.some(r => r.source === 'project-dsh' && r.rank === 100));
  check('roots: 含 project-agents (.agents/skills)', roots.some(r => r.source === 'project-agents' && r.rank === 200));
  check('roots: 含 custom（来自 SEEK_DSH_SKILL_DIRS）', roots.some(r => r.source === 'custom' && r.rank === 300));
  check('roots: 含 user-dsh', roots.some(r => r.source === 'user-dsh' && r.rank === 400));
  check('roots: 含 user-agents', roots.some(r => r.source === 'user-agents' && r.rank === 500));

  // ── 5. discoverDshSkills（SEEK_DSH_SKILL_DIRS 指向 fixture）──
  process.env.SEEK_DSH_SKILL_DIRS = FIXTURE_ABS;
  const skills = await discoverDshSkills(FIXTURE_ABS);
  const names = skills.map(s => s.name);
  check('discover: 发现 good-skill', names.includes('good-skill'));
  check('discover: 发现 flat-skill（扁平形态）', names.includes('flat-skill'));
  check('discover: 发现 disable-model', names.includes('disable-model'));
  check('discover: 发现 dsh 官方 skill', names.includes('dsh-pre-push-checks') && names.includes('dsh-prose-standard'));
  check('discover: 跳过缺 description', names.includes('bad-skill') === false);
  check('discover: 跳过非法名称', names.includes('invalid-name') === false);
  check('discover: 跳过无 frontmatter', names.includes('no-frontmatter') === false);
  check('discover: 摘要含 description', skills.find(s => s.name === 'good-skill')?.description.includes('compatibility') === true);
  check('discover: 排序按名称', skills[0]?.name === [...names].sort()[0]);
  delete process.env.SEEK_DSH_SKILL_DIRS;

  // ── 6. dsh_skill_catalog 工具 ──
  process.env.SEEK_DSH_SKILL_DIRS = FIXTURE_ABS;
  const catResult = await dsh_skill_catalog.execute({});
  check('catalog: 返回可用列表', typeof catResult === 'string' && catResult.includes('good-skill'));
  check('catalog: 含 description', typeof catResult === 'string' && catResult.includes('compatibility'));
  check('catalog: 含官方 skill', typeof catResult === 'string' && catResult.includes('dsh-pre-push-checks'));

  // ── 7. dsh_skill 工具 ──
  const goodLoad = await dsh_skill.execute({ name: 'good-skill' });
  check('dsh_skill: 加载成功含 <skill_content>', typeof goodLoad === 'string' && goodLoad.includes('<skill_content name="good-skill">'));
  check('dsh_skill: 含正文指令', typeof goodLoad === 'string' && goodLoad.includes('# Good Skill'));
  check('dsh_skill: 含资源基准目录', typeof goodLoad === 'string' && goodLoad.includes('<skill_resources>') && goodLoad.includes('good-skill'));
  check('dsh_skill: 含 instructions 块', typeof goodLoad === 'string' && goodLoad.includes('<skill_instructions>'));

  const officialLoad = await dsh_skill.execute({ name: 'dsh-pre-push-checks' });
  check('dsh_skill: 官方 skill 加载', typeof officialLoad === 'string' && officialLoad.includes('Inspect the outgoing change'));

  const dModelLoad = await dsh_skill.execute({ name: 'disable-model' });
  check('dsh_skill: disable-model-invocation 拒绝', typeof dModelLoad === 'string' && dModelLoad.includes('不可调用'));

  const unknownLoad = await dsh_skill.execute({ name: 'no-such-skill' });
  check('dsh_skill: 未知 skill 报未找到', typeof unknownLoad === 'string' && unknownLoad.includes('未找到'));

  const invalidLoad = await dsh_skill.execute({ name: 'Bad-Name' });
  check('dsh_skill: 非法名称拒绝', typeof invalidLoad === 'string' && invalidLoad.includes('kebab-case'));

  // ── 8. loadDshSkill 独立加载 ──
  const loaded = await loadDshSkill('good-skill', FIXTURE_ABS);
  check('loadDshSkill: 命中', loaded?.name === 'good-skill' && loaded?.content.includes('Do thing one'));
  delete process.env.SEEK_DSH_SKILL_DIRS;

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exitCode = failed > 0 ? 1 : 0;
})();





