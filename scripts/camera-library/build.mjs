#!/usr/bin/env node
/**
 * 生成 / 检查摄像头库产物。
 *   node scripts/camera-library/build.mjs          校验 camera-library/data 并重新生成 camera-library/library.json
 *   node scripts/camera-library/build.mjs --check  只检查，不写文件：数据过门禁、产物合规、产物和数据对得上；有问题退出码 1
 * 改了 data/ 里任何一个文件（包括重新导入）都要跑一次，然后把 library.json 一起提交。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIB_DIR, ARTIFACT, loadRaw, buildArtifactText, checkCameraLibrary } from './library.mjs';

const check = process.argv.includes('--check');
try {
  if (check) {
    const problems = checkCameraLibrary();
    if (problems.length) {
      console.error('摄像头库检查未通过：\n- ' + problems.join('\n- '));
      process.exit(1);
    }
    const a = JSON.parse(readFileSync(resolve(LIB_DIR, ARTIFACT), 'utf8'));
    console.log(`摄像头库检查通过：${a.counts.vendors} 个品牌，${a.counts.pairs} 种主 / 子码流写法（verified ${a.counts.byStatus.verified} / documented ${a.counts.byStatus.documented} / candidate ${a.counts.byStatus.candidate} 条流），上游 ${a.upstream.id}@${a.upstream.commit.slice(0, 7)}`);
  } else {
    const text = buildArtifactText(loadRaw());
    const file = resolve(LIB_DIR, ARTIFACT);
    const same = existsSync(file) && readFileSync(file, 'utf8') === text;
    if (!same) writeFileSync(file, text);
    console.log(same ? `${ARTIFACT} 已是最新，没有改动` : `已写入 ${file}（${text.length} 字节）`);
  }
} catch (e) {
  console.error('失败：' + (e?.message || e));
  process.exit(1);
}
