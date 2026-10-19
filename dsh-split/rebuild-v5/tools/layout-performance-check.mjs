import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

// Reproducible native-host stress case. Only disposable DOM is added, never
// message history. CDP sends actual trusted input through Chromium's dispatcher.
export async function checkLayoutPerformance(browser,ids){
  const pane=`document.querySelector('[data-session-id="${ids[0]}"]')`;
  await browser.evaluate(`(()=>{
    globalThis.__perfEditors=Array.from(document.querySelectorAll('[data-session-panel] [contenteditable=true]'));
    for(const panel of document.querySelectorAll('[data-session-panel]')){
      const content=panel.querySelector('.v5-native-conversation');const layer=document.createElement('div');layer.dataset.resizeStress='';
      layer.style.cssText='position:absolute;inset:55px 16px 150px;overflow:auto;background:var(--dsw-alias-bg-base);pointer-events:none';
      for(let i=0;i<120;i++){const p=document.createElement('p');p.textContent='布局压力验证 '+i+'：这是一段可换行的合成会话文字，用于检查分屏连续调整时的排版成本。'.repeat(3);layer.append(p);}
      content.append(layer);
    }
  })()`);
  await browser.send('Performance.enable');
  const metrics=async()=>Object.fromEntries((await browser.send('Performance.getMetrics')).metrics.map(v=>[v.name,v.value]));
  const point=async selector=>browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing performance target: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
  const drag=async(selector,amplitude=75)=>{
    const p=await point(selector);assert.ok(p.w>0&&p.h>0,'visible drag target');
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});
    for(let i=1;i<=48;i++){
      await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+Math.sin(i/48*Math.PI*2)*amplitude,y:p.y,button:'left',buttons:1});
      await delay(12);
    }
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});
  };
  const measure=async(name,operation)=>{
    await delay(180);
    await browser.evaluate(`globalThis.__frames=[];globalThis.__collectFrames=true;globalThis.__previousFrame=0;requestAnimationFrame(function tick(t){if(!__collectFrames)return;if(__previousFrame)__frames.push(t-__previousFrame);__previousFrame=t;requestAnimationFrame(tick);})`);
    const before=await metrics();await operation();await delay(80);const after=await metrics();
    const frames=await browser.evaluate(`__collectFrames=false;__frames`);frames.sort((a,b)=>a-b);
    const p95=frames[Math.floor(frames.length*.95)]??0;
    return {name,frames:frames.length,p95FrameMs:+p95.toFixed(2),framesOver34ms:frames.filter(x=>x>34).length,
      scriptMs:+((after.ScriptDuration-before.ScriptDuration)*1000).toFixed(2),layoutMs:+((after.LayoutDuration-before.LayoutDuration)*1000).toFixed(2),
      layoutCount:after.LayoutCount-before.LayoutCount};
  };
  const runs=[];
  await drag('.v5-outer-separator[data-axis=x]',20);
  for(let i=0;i<3;i++)runs.push(await measure('outer-resize',()=>drag('.v5-outer-separator[data-axis=x]')));
  await browser.evaluate(`${pane}.querySelector('button[aria-label="打开右侧边栏"]').click()`);await delay(200);
  for(let i=0;i<3;i++)runs.push(await measure('sidebar-resize',()=>drag('[data-session-id="'+ids[0]+'"] .v5-inner-divider',45)));
  const nav=await browser.evaluate(`Array.from(document.querySelectorAll('button')).filter(e=>!e.closest('[data-session-panel]')).map(e=>({label:e.getAttribute('aria-label'),title:e.title})).filter(e=>/侧边栏|Sidebar/i.test(e.label??e.title))`);
  const navLabel=nav.find(e=>/收起.*侧边栏|隐藏.*侧边栏|Collapse sidebar/i.test(e.label??''))?.label;
  if(navLabel){
    await browser.evaluate(`globalThis.__navToggle=document.querySelector('button[aria-label=${JSON.stringify(navLabel)}]');void 0`);
    for(let i=0;i<3;i++)runs.push(await measure('left-sidebar-toggle',async()=>{
      for(let n=0;n<4;n++){await browser.evaluate('__navToggle.click()');await delay(300);}
    }));
  }
  const identity=await browser.evaluate(`__perfEditors.every(e=>e.isConnected)&&__perfEditors.length===document.querySelectorAll('[data-session-panel] [contenteditable=true]').length`);
  assert.equal(identity,true,'resizing must preserve every native editor instance');
  const overflow=await browser.evaluate(`Array.from(document.querySelectorAll('[data-session-panel]')).map(p=>({id:p.dataset.sessionId,overflow:p.scrollWidth-p.clientWidth}))`);
  assert.ok(overflow.every(p=>p.overflow<=1),'no pane overflow after resizing');
  await browser.evaluate(`document.querySelectorAll('[data-resize-stress]').forEach(e=>e.remove());${pane}.querySelector('[data-sidebar-right-toggle],button[title="隐藏 Sidebar"]').click()`);
  return {scope:'Same isolated native DSH host; 3 actual editors, 120 synthetic paragraphs per pane, 48 pointer samples per drag, 3 repeats. Chrome headless; not a guarantee for arbitrary user histories.',nativeEditorsPreserved:identity,runs,navCandidates:nav,overflow};
}
