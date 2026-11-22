#!/usr/bin/env node
/**
 * 生成 / 检查录像机库、网络设备库和 AI 摘要。
 *   node scripts/device-library/build.mjs          校验 camera-library/data/{recorders,netdevs}.json，生成产物和 device-library.ai.md
 *   node scripts/device-library/build.mjs --check  只检查不写文件；有问题退出码 1
 * 摄像头库本身仍由 scripts/camera-library/build.mjs 生成；AI 摘要要用它的产物，所以先跑它。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIB_DIR, PARTS, AI_DIGEST, buildProductText, checkDeviceLibraries } from './lib.mjs';
import { buildAiDigest } from './ai-digest.mjs';

try {
  if (process.argv.includes('--check')) {
    const problems = checkDeviceLibraries(LIB_DIR, buildAiDigest);
    if (problems.length) {
      console.error('设备库检查未通过：\n- ' + problems.join('\n- '));
      process.exit(1);
    }
    for (const [name, file] of Object.entries(PARTS)) {
      const c = JSON.parse(readFileSync(resolve(LIB_DIR, file), 'utf8')).counts;
      console.log(`${name} 检查通过：${c.families} 个协议族 / 平台，${c.models} 个型号（verified ${c.evidence.verified} / documented ${c.evidence.documented} / candidate ${c.evidence.candidate} 处）`);
    }
  } else {
    const write = (file, text) => {
      const f = resolve(LIB_DIR, file);
      const same = existsSync(f) && readFileSync(f, 'utf8') === text;
      if (!same) writeFileSync(f, text);
      console.log(same ? `${file} 已是最新` : `已写入 ${file}（${text.length} 字节）`);
    };
    for (const [name, file] of Object.entries(PARTS)) write(file, buildProductText(name));
    write(AI_DIGEST, buildAiDigest());
  }
} catch (e) {
  console.error('失败：' + (e?.message || e));
  process.exit(1);
}
