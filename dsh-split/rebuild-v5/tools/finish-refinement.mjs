import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertBootAdmission} from './boot-admission.mjs';
import {sha256} from './read-asar.mjs';

const root=path.resolve(import.meta.dirname,'..');
const releaseFile=path.resolve(process.argv[2]);
const boot=assertBootAdmission(releaseFile);
const manifest=JSON.parse(fs.readFileSync(releaseFile,'utf8'));
const referenceFile=path.resolve(process.argv[3]);
const reference=JSON.parse(fs.readFileSync(referenceFile,'utf8'));
if(!reference.passed||!reference.interactions?.performance)throw new Error('A successful measured reference is required');
const candidate=boot.checks.find(c=>c.mode==='enabled');
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const scenarios=['outer-resize','sidebar-resize','left-sidebar-toggle'].map(name=>{
  const before=reference.interactions.performance.runs.filter(r=>r.name===name);
  const after=candidate.interactions.performance.runs.filter(r=>r.name===name);
  if(before.length!==3||after.length!==3)throw new Error('Three comparable runs are required');
  const summarize=runs=>Object.fromEntries(['scriptMs','layoutMs','layoutCount','p95FrameMs'].map(key=>[key,median(runs.map(r=>r[key]))]));
  const baseline=summarize(before),updated=summarize(after);
  const reduction=100*(1-updated.scriptMs/baseline.scriptMs);
  if(reduction<15)throw new Error(`Performance acceptance failed for ${name}: script reduction ${reduction.toFixed(1)}%`);
  return {name,baseline,updated,scriptReductionPercent:+reduction.toFixed(1)};
});
const evidence=path.join(root,'evidence');
fs.mkdirSync(evidence,{recursive:true});
for(const theme of ['light','dark'])fs.copyFileSync(path.join(candidate.home,`refinement-${theme}.png`),path.join(evidence,`refinement-${theme}.png`));
const report={verifiedAt:new Date().toISOString(),version:manifest.version,release:manifest.release,releaseSha256:sha256(fs.readFileSync(releaseFile)),
  staticTests:manifest.verification.testCount,nativeBootModes:boot.checks.map(c=>({mode:c.mode,passed:c.passed,errorCount:c.errorCount})),
  refinement:candidate.interactions.refinement,performance:{scenarios,reference:referenceFile,candidate:path.join(candidate.home,'result.json'),
    scope:candidate.interactions.performance.scope,qualification:'Measurements ran while the desktop was in use. Frame intervals vary with machine load; reduced script work is verified, a universal frame-rate guarantee is not claimed.'},
  nativeEditorsPreserved:candidate.interactions.performance.nativeEditorsPreserved,desktopRestartPerformed:false,
  activation:'Existing DSH instance stays on the previous loaded release. This upgrade takes effect at the next normal launch; no reload or restart is invoked.'};
fs.writeFileSync(path.join(evidence,'visual-refinement.json'),JSON.stringify(report,null,2));
for(const [script,args] of [['tools/install-local.mjs',[releaseFile]],['tools/check-installed.mjs',[]]]){
  const result=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error(`${script}: ${result.stderr||result.stdout}`);
  console.log(result.stdout.trim());
}
const installed=JSON.parse(fs.readFileSync(path.join(root,'installed.json'),'utf8'));
report.receiptPath=installed.receiptPath;report.installedAt=installed.installedAt;
fs.writeFileSync(path.join(evidence,'visual-refinement.json'),JSON.stringify(report,null,2));
const labels={'outer-resize':'分屏宽度拖拽','sidebar-resize':'会话内 Sidebar 调宽','left-sidebar-toggle':'左侧导航收展'};
const rows=scenarios.map(s=>`| ${labels[s.name]} | ${s.baseline.scriptMs} ms | ${s.updated.scriptMs} ms | ${s.scriptReductionPercent}% |`).join('\n');
fs.writeFileSync(path.join(evidence,'visual-refinement.md'),`# 分屏统一改动验收\n\n发布：${manifest.version}（${path.basename(manifest.release)}）。\n\n已安装到磁盘；当前 DSH 保持运行，下一次正常打开时生效，本次没有重启或热替换用户窗口。\n\n- 移除重复会话标题和 Sidebar 标题，保留透明的 8px 拖拽热区，移除矩形焦点框；键盘聚焦只加强短线提示。工作区顶部和底部各留 8px 真实间距。\n- Sidebar 使用 DSH 原生收起、全屏、还原控件，全屏仅占所属会话；关闭/移动分屏归入原生会话菜单。Sidebar 按冻结原型恢复 12px 圆角、1px、55% 原生边框色的轻边框，去除原生首列重复左边线、12px 内容间距与克制的静态阴影，并验证四个停靠方向。\n- 分屏工作区与左侧栏共用原生底色；聚焦会话使用独立的原生内容底色，非聚焦会话略向工作区底色靠近，每个会话的外壳、聊天与 Sidebar 内部同色。非聚焦文字通过 16% 同底色蒙层淡化。深浅主题均验证三层颜色、焦点切换和无框透明拖拽热区。\n- CSS Grid 直接处理内层尺寸；移除重复外层尺寸监听和逐像素全工作台广播，保留原生编辑器和 Sidebar 实例。\n\n## 验收\n\n${manifest.verification.testCount} 项测试通过。五种隔离启动场景（原版、启用、完整冷启动恢复、禁用、缺少补丁）全部通过，运行时错误为 0。另验证四方向停靠、Sidebar 局部全屏、原生菜单移动/关闭、窄边缘拖拽取消、窄屏恢复、三个编辑器独立草稿及刷新恢复。关闭分屏不删除会话。\n\n## 性能对比\n\n相同原生宿主、三个真实编辑器、每个会话 120 段合成文字，每项三轮，表中为脚本执行耗时中位数。\n\n| 场景 | 稳定版 | 新版 | 降低 |\n|---|---:|---:|---:|\n${rows}\n\n测试期间电脑仍在使用，帧间隔受负载影响；本报告确认脚本开销下降及原生编辑器不重建，不承诺所有历史会话下的固定帧率。详细原始帧间隔与布局耗时见 visual-refinement.json。\n\n启动证据：${path.join(manifest.release,'boot-validation.json')}\n\n回退凭据：${installed.receiptPath}\n\n![深色原生隔离测试](refinement-dark.png)\n\n![浅色原生隔离测试](refinement-light.png)\n`);
console.log(JSON.stringify({accepted:true,report:path.join(evidence,'visual-refinement.md'),scenarios,desktopRestartPerformed:false}));
