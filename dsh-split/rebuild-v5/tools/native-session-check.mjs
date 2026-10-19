import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {checkLayoutPerformance} from './layout-performance-check.mjs';
import {checkBackgrounds,checkSidebarChrome} from './background-check.mjs';

export async function checkNativeSessions(browser, ids, home) {
  const wait = async (expression, label, timeout=12_000) => {
    const until=Date.now()+timeout;
    while(Date.now()<until){if(await browser.evaluate(expression))return;await delay(100);}
    throw new Error(`Native interaction timeout: ${label}`);
  };
  // A throwaway profile has no model credentials, so the product raises its own
  // onboarding panel whenever it decides a key is missing. It is modal (and not a
  // native <dialog>): while it is up the session rows are not rendered and typed
  // text lands in its key field. Clear it before every row lookup or keystroke — and
  // keep clicking until it is really gone, because a single click can land before the
  // panel's own handler is attached.
  const dismissOnboarding = async (timeout=20_000) => {
    const until=Date.now()+timeout;
    while(Date.now()<until){
      const state=await browser.evaluate(`(()=>{
        if(!['稍后配置','保存并继续'].some(text=>document.body.innerText.includes(text)))return 'clear';
        const target=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='稍后配置');
        if(target){target.click();return 'clicked';}
        return 'waiting';})()`);
      if(state==='clear')return;
      await delay(200);
    }
    throw new Error('Isolated onboarding panel did not close');
  };
  const fixtureRows = async () => {
    // Empty test sessions have no model-generated history. Make their native
    // catalog rows visible like existing conversations so the real menu can be
    // exercised without submitting a prompt. Bindings/editors stay fully native.
    await dismissOnboarding();
    // DSH 0.2.1: display blank is recomputed per render from the per-session
    // projection `sessionListMetadata.blank` — the older `list.set(byId)` trick
    // no longer survives, and blank rows are filtered out of the sidebar and
    // never render the row menu.
    // A cached write is discarded as soon as a host frame owns the key, so this
    // publishes with a high watermark (a lower-or-equal seq loses), targets the
    // known ids rather than only the currently listed ones (blank rows are
    // filtered out), and runs before every gesture because a refresh can
    // re-blank them mid-run.
    await browser.evaluate(`(()=>{
      const sessions = __splitProbe.sessions;
      for (const id of ${JSON.stringify(ids)}) {
        let binding = typeof sessions.binding === 'function' ? sessions.binding(id) : undefined;
        if (!binding?.session && typeof sessions.retain === 'function') {
          try { sessions.retain(id, { source: 'fixture' }); } catch {}
          binding = sessions.binding?.(id);
        }
        const session = binding?.session;
        const store = session?.options?.projections ?? session?.projections;
        // 1) 直接清掉 Session 的 blank 位
        if (typeof session?.handleBlank === 'function') session.handleBlank(false);
        // 2) 写投影，让列表投影持久认为非 blank（缓存写会被 host 帧丢弃，故用高水位）
        if (store) {
          if (typeof store.apply === 'function') store.apply('sessionListMetadata', { blank: false }, 9e15);
          else if (typeof store.applyCached === 'function') store.applyCached('sessionListMetadata', { blank: false });
        }
      }
    })()`);
    await delay(300);
  };
  // Activating a Session can raise the onboarding panel again: it hides the session rows and
  // dismisses an open row menu. Retry the whole native-menu gesture instead of racing it, and
  // fail closed (with the label) when it never lands.
  const chooseRowAction = async (id, label, timeout=30_000) => {
    const until=Date.now()+timeout;
    while(Date.now()<until){
      await dismissOnboarding();
      const opened=await browser.evaluate(`(()=>{const row=document.querySelector('[data-row-key="session:${id}"]');const button=row?.querySelector('button[aria-label*="操作"]');if(!button)return false;button.click();return true;})()`);
      if(opened&&await browser.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],button')).some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`)){
        const clicked=await browser.evaluate(`(()=>{const target=Array.from(document.querySelectorAll('[role=menuitem],button')).find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled);if(!target)return false;target.click();return true;})()`);
        if(clicked)return;
      }
      await delay(200);
    }
    throw new Error(`native row menu action ${label} for ${id} did not run`);
  };
  const split = async (id, label, count) => {
    await fixtureRows();
    await chooseRowAction(id,label);
    await wait(`document.querySelectorAll('[data-session-panel] [contenteditable=true]').length===${count}`,`${count} native editors`);
    await browser.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  };
  const geometry=()=>browser.evaluate(`Array.from(document.querySelectorAll('[data-session-panel]')).map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.sessionId,x:r.x,y:r.y,w:r.width,h:r.height,editors:e.querySelectorAll('[contenteditable=true]').length}})`);
  const settledGeometry=async()=>{
    let last='',stable=0,value;const until=Date.now()+5_000;
    while(Date.now()<until){value=await geometry();const next=JSON.stringify(value);stable=next===last?stable+1:0;last=next;if(stable>=3)return value;await delay(80);}
    throw new Error('Native pane geometry did not settle: '+last);
  };
  await split(ids[1],'向右分屏',2);
  const right=await geometry();
  assert.equal(right.length,2);assert.ok(right.find(p=>p.id===ids[1]).x>right.find(p=>p.id===ids[0]).x,JSON.stringify(right));assert.ok(right.every(p=>p.editors===1));
  await split(ids[2],'向下分屏',3);
  const below=await geometry();
  assert.equal(below.length,3);
  const b=below.find(p=>p.id===ids[1]),c=below.find(p=>p.id===ids[2]);
  assert.ok(c.y>b.y);assert.ok(below.every(p=>p.editors===1&&p.w>250&&p.h>150));
  // Prove the caret really sits in the target pane before typing, so a modal can never
  // again be mistaken for an empty draft. Activating a pane also makes the host open that
  // Session, and the host may restore focus once more after that; retry instead of racing.
  const focusEditor = async id => {
    const selector=`[data-session-id="${id}"] [contenteditable=true]`;
    const until=Date.now()+8_000;
    while(Date.now()<until){
      await browser.evaluate(`document.querySelector('${selector}').focus()`);
      if(await browser.evaluate(`document.activeElement?.closest?.('[data-session-id]')?.dataset.sessionId ?? null`)===id)return;
      await delay(150);
    }
    throw new Error(`pane ${id} could not hold the caret before typing`);
  };
  for(const [index,id] of ids.entries()){
    await dismissOnboarding();
    await focusEditor(id);
    await browser.send('Input.insertText',{text:`Isolated draft ${index+1}`});
  }
  const drafts=await browser.evaluate(`Array.from(document.querySelectorAll('[data-session-panel]')).map(e=>({id:e.dataset.sessionId,text:e.querySelector('[contenteditable=true]')?.innerText}))`);
  for(const [index,id] of ids.entries())assert.equal(drafts.find(d=>d.id===id)?.text,`Isolated draft ${index+1}`);
  // Keep the same native editable element while its own Sidebar is toggled.
  const refined=await browser.evaluate(`!!document.querySelector('.v5-session-drag')`);
  const pane=`document.querySelector('[data-session-id="${ids[0]}"]')`;
  await browser.evaluate(`globalThis.__editorBefore=${pane}.querySelector('[contenteditable=true]');${pane}.querySelector('button[aria-label="打开右侧边栏"]').click()`);
  await wait(`getComputedStyle(${pane}.querySelector('.v5-sidebar')).display!=='none'`,'Sidebar opens');
  let refinement;
  if(refined){
    const before=await geometry();
    await browser.evaluate(`${pane}.querySelector('[data-sidebar-right-mode="fullscreen"]').click()`);
    await wait(`${pane}.querySelector('.v5-session-layout').dataset.fullscreen==='true'`,'native Sidebar fullscreen');
    assert.deepEqual(await geometry(),before,'Sidebar fullscreen must not change other split panes');
    assert.equal(await browser.evaluate(`getComputedStyle(${pane}.querySelector('.v5-conversation')).display`),'none');
    await browser.evaluate(`${pane}.querySelector('[data-sidebar-right-mode="push"]').click()`);
    await wait(`getComputedStyle(${pane}.querySelector('.v5-conversation')).display!=='none'`,'native Sidebar restores');
    for(const [side,label] of [['left','左侧'],['top','上方'],['bottom','下方'],['right','右侧']]){
      await browser.evaluate(`${pane}.querySelector('.v5-sidebar-drag').click()`);
      await wait(`!!document.querySelector('.v5-menu')`,'Sidebar position menu');
      await browser.evaluate(`Array.from(document.querySelectorAll('.v5-menu [role=menuitemradio]')).find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);
      await wait(`${pane}.querySelector('.v5-session-layout').dataset.side===${JSON.stringify(side)}`,'Sidebar position '+side);
      await checkSidebarChrome(browser,ids[0],side);
    }
    const visual=[];
    for(const theme of ['light','dark']){
      await browser.evaluate(`__splitProbe.theme.setTheme(${JSON.stringify(theme)});void 0`);
      await wait(`__splitProbe.theme.host.getSnapshot().value?.preference===${JSON.stringify(theme)}&&document.body.hasAttribute('data-ds-dark-theme')===${theme==='dark'}&&document.querySelector('[data-v5-workbench]').dataset.theme===${JSON.stringify(theme)}`,'native persisted theme '+theme);
      await delay(220);
      const backgrounds=await checkBackgrounds(browser,ids);
      const values=await browser.evaluate(`(()=>{const p=${pane},s=p.querySelector('.v5-sidebar'),root=p.querySelector('.v5-native-conversation').firstElementChild;return {theme:document.querySelector('[data-v5-workbench]').dataset.theme,outer:getComputedStyle(p).backgroundColor,sidebar:getComputedStyle(s).backgroundColor,native:getComputedStyle(root).backgroundColor,base:getComputedStyle(p).getPropertyValue('--dsw-alias-bg-base').trim(),dragHeight:p.querySelector('.v5-session-drag').getBoundingClientRect().height,duplicateTitles:p.querySelectorAll('.v5-session-head,.v5-sidebar-head').length,controlsInSidebar:s.querySelectorAll('[data-sidebar-right-toggle],[data-sidebar-right-mode]').length,veil:Array.from(document.querySelectorAll('[data-session-panel][data-active=false]')).map(e=>({opacity:getComputedStyle(e,'::after').opacity,color:getComputedStyle(e,'::after').backgroundColor,pointerEvents:getComputedStyle(e,'::after').pointerEvents}))};})()`);
      assert.equal(values.theme,theme);assert.equal(values.outer,values.sidebar);assert.equal(values.outer,values.native);
      if(theme==='dark')assert.notEqual(values.outer,visual[0].outer,'native theme must actually change');
      assert.equal(values.dragHeight,8);assert.equal(values.duplicateTitles,0);assert.equal(values.controlsInSidebar,2);
      assert.ok(values.veil.every(v=>Number(v.opacity)===.16&&v.pointerEvents==='none'));
      values.backgrounds=backgrounds;
      visual.push(values);
      fs.writeFileSync(path.join(home,`refinement-${theme}.png`),Buffer.from((await browser.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    refinement={nativeSidebarControls:true,fullscreenIsLocal:true,fourSidebarPositions:true,sidebarFourSideChrome:true,visual};
  }
  await browser.evaluate(`${pane}.querySelector(${JSON.stringify('[data-sidebar-right-toggle],button[title="隐藏 Sidebar"]')}).click()`);
  await wait(`getComputedStyle(${pane}.querySelector('.v5-sidebar')).display==='none'`,'Sidebar collapses');
  assert.equal(await browser.evaluate(`__editorBefore===document.querySelector('[data-session-id="${ids[0]}"] [contenteditable=true]')`),true);
  await browser.evaluate(`__splitProbe.theme.setTheme('light');void 0`);await delay(200);
  const performance=await checkLayoutPerformance(browser,ids);
  fs.writeFileSync(path.join(home,'interaction-progress.json'),JSON.stringify({refinement,performance},null,2));
  if(refined){
    // Exercise the remaining pane actions through the actual native row menu.
    const rowAction=async(id,label)=>{
      await fixtureRows();await chooseRowAction(id,label);
    };
    await rowAction(ids[0],'移动分屏');await wait(`!!document.querySelector('.v5-dialog[open]')`,'native menu opens move dialog');
    await browser.evaluate(`document.querySelector('.v5-dialog button[data-side=left]').click()`);
    await browser.evaluate(`document.querySelector('.v5-dialog button[type=submit]').click()`);
    await wait(`!document.querySelector('.v5-dialog[open]')`,'move committed');
    assert.equal(await browser.evaluate(`__editorBefore===${pane}.querySelector('[contenteditable=true]')`),true,'native editor survives move');
    const cancelBefore=await settledGeometry();
    const source=await browser.evaluate(`(()=>{const r=${pane}.querySelector('.v5-session-drag').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+4};})()`);
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',...source,button:'left',buttons:1,clickCount:1});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:source.x+70,y:source.y+80,button:'left',buttons:1});
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',...source,button:'left',buttons:0,clickCount:1});
    assert.deepEqual(await settledGeometry(),cancelBefore,'Escape cancels dragging from thin edge');
    // The pane's close control must sit in the shipped header row, to the RIGHT of the shipped
    // Sidebar control, on the corner the widened header padding frees. The Sidebar control only
    // renders while that Sidebar is collapsed, so collapse it first when needed.
    const paneSelector=`[data-session-panel][data-session-id="${ids[2]}"]`;
    if(!await browser.evaluate(`!!document.querySelector('${paneSelector} [data-sidebar-right-expand]')`)){
      await browser.evaluate(`document.querySelector('${paneSelector} [data-sidebar-right-toggle],${paneSelector} button[title="隐藏 Sidebar"]')?.click()`);
    }
    await wait(`!!document.querySelector('${paneSelector} [data-sidebar-right-expand]')`,'shipped Sidebar control visible');
    const placement=await browser.evaluate(`(()=>{
      const pane=document.querySelector('${paneSelector}');
      const header=pane.querySelector('.v5-native-conversation [data-slot="conversation.header"] > header')??pane.querySelector('.v5-native-conversation > header');
      const close=pane.querySelector('[data-dsh-split-close]');
      const corner=header.querySelector('[data-sidebar-right-expand]');
      const box=e=>{const r=e.getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom)};};
      return {padRight:getComputedStyle(header).paddingRight,header:box(header),close:box(close),corner:box(corner)};})()`);
    assert.equal(placement.padRight,'64px','the pane control reserves the shipped header corner: '+JSON.stringify(placement));
    assert.ok(placement.close.l>placement.corner.r,`pane close control sits right of the shipped Sidebar control: ${JSON.stringify(placement)}`);
    assert.ok(placement.close.l-placement.corner.r>=6,`pane close control keeps a visible gap to it: ${JSON.stringify(placement)}`);
    assert.ok(placement.close.t<placement.header.b&&placement.close.b>placement.header.t,`pane close control shares the header row: ${JSON.stringify(placement)}`);
    // The pane's own control closes it as well; the native row menu entry is still covered
    // right below, so both paths to closing a pane are exercised in the real host.
    await wait(`!!document.querySelector('[data-session-panel][data-session-id=${JSON.stringify(ids[2])}] [data-dsh-split-close]')`,'pane close control');
    await browser.evaluate(`document.querySelector('[data-session-panel][data-session-id=${JSON.stringify(ids[2])}] [data-dsh-split-close]').click()`);
    await wait(`document.querySelectorAll('[data-session-panel]').length===2`,'pane close control removes one pane');
    assert.equal(await browser.evaluate(`!!__splitProbe.sessions.list.getSnapshot().byId[${JSON.stringify(ids[2])}]`),true,'pane close retains native session');
    await split(ids[2],'向下分屏',3);
    await rowAction(ids[2],'关闭此分屏');await wait(`document.querySelectorAll('[data-session-panel]').length===2`,'close only pane');
    assert.equal(await browser.evaluate(`!!__splitProbe.sessions.list.getSnapshot().byId[${JSON.stringify(ids[2])}]`),true,'closing pane retains native session');
    await split(ids[2],'向下分屏',3);
    const wide=await settledGeometry();
    await browser.send('Emulation.setDeviceMetricsOverride',{width:700,height:1000,deviceScaleFactor:1,mobile:false});
    await wait(`!!document.querySelector('.v5-projection-note')`,'narrow projection');
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await wait(`!document.querySelector('.v5-projection-note')`,'wide layout restored');
    const restored=await settledGeometry();
    assert.ok(restored.every(p=>{const before=wide.find(v=>v.id===p.id);return Math.abs(before.w-p.w)<2&&Math.abs(before.h-p.h)<2;}),JSON.stringify({wide,restored}));
    refinement={...refinement,nativeMoveAndClose:true,paneClose:true,paneCloseInline:true,thinEdgeDragCancel:true,narrowRestore:true};
  }
  await delay(600);
  await browser.send('Page.reload');
  await wait(`!document.querySelector('[data-dsh-boot]')&&document.querySelectorAll('[data-session-panel] [contenteditable=true]').length===3`,'reload restores three native sessions',20_000);
  const reloaded=await geometry();
  assert.deepEqual(reloaded.map(p=>p.id).sort(),[...ids].sort());
  return {right:true,below:true,independentDrafts:true,sidebarKeepsEditor:true,reload:true,refinement,performance,rightGeometry:right,belowGeometry:below,reloadedGeometry:reloaded,catalogFixture:'Blank test rows are made visible; native host sessions and renderer are unchanged.'};
}
