// 摄像头 AI 能力库（camera-library/data/ai-capability.json）的数据门禁：证据等级、来源登记、不存口令、黑名单带原因。
// 运行：node --test scripts/camera-library-ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'camera-library', 'data');
const ai = JSON.parse(readFileSync(resolve(dir, 'ai-capability.json'), 'utf8'));
const sources = JSON.parse(readFileSync(resolve(dir, 'sources.json'), 'utf8'));
const EVIDENCE = ['verified', 'documented', 'candidate'];

test('每个品牌：证据等级合法、来源在台账里且用法允许、适配器 id 和事件通道写明', () => {
  assert.ok(ai.vendors.length >= 1);
  const ids = new Set();
  for (const v of ai.vendors) {
    assert.ok(!ids.has(v.id), '品牌重复：' + v.id); ids.add(v.id);
    assert.ok(EVIDENCE.includes(v.evidence), v.id + ' 证据等级不合法');
    assert.ok(v.adapter && v.eventChannel, v.id + ' 缺 adapter / eventChannel');
    assert.ok(Array.isArray(v.aliases) && v.aliases.length, v.id + ' 缺 aliases');
    for (const s of v.sources) {
      const reg = sources.sources.find((x) => x.id === s);
      assert.ok(reg, v.id + ' 的来源 ' + s + ' 没在 sources.json 登记');
      assert.ok(['own', 'cite', 'import'].includes(reg.usage), v.id + ' 的来源 ' + s + ' 用法不允许：' + reg.usage);
    }
  }
});

test('candidate 必须写明为什么只是候选；verified 必须带真机证据；黑名单型号必须带原因', () => {
  for (const v of ai.vendors) {
    if (v.evidence === 'candidate') assert.ok(String(v.evidenceNote || '').length >= 10, v.id + ' candidate 缺 evidenceNote');
    if (v.evidence === 'verified') assert.ok(Array.isArray(v.device) && v.device.length && v.device.every((d) => d.model && d.date && d.result), v.id + ' verified 缺 device 证据（型号 / 日期 / 结果）');
    for (const b of v.blockModels) assert.ok(b.model && b.reason, v.id + ' 黑名单条目要有 model 和 reason');
  }
});

test('红线：整个文件里不许有口令、账号密码对、带凭据的地址', () => {
  const text = JSON.stringify(ai);
  assert.ok(!/password|passwd|pwd\s*[=:]/i.test(text.replace(/不存任何口令|不存口令/g, '')), '出现了 password 字样');
  assert.ok(!/:\/\/[^/\s"]*@/.test(text), '地址里带了凭据');
  assert.ok(!/(admin|root)\s*[:/]\s*\S+/i.test(text.replace(/\/ISAPI\S*/g, '')), '像是账号口令对');
});
