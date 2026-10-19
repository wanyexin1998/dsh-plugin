import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function checkSidebarChrome(browser,id,side) {
  const value=await browser.evaluate(`(()=>{
    const p=document.querySelector('[data-session-id="${id}"]'),s=p.querySelector('.v5-sidebar'),c=p.querySelector('.v5-conversation');
    const r=s.getBoundingClientRect(),q=c.getBoundingClientRect(),st=getComputedStyle(s),w=document.querySelector('[data-v5-workbench]').getBoundingClientRect(),e=document.querySelector('.v5-engine').getBoundingClientRect();
    const actual=p.querySelector('.v5-session-layout').dataset.side;
    const gap=actual==='right'?r.left-q.right:actual==='left'?q.left-r.right:actual==='top'?q.top-r.bottom:r.top-q.bottom;
    const edges=[...s.querySelectorAll('[data-dockkit-host="dock"][data-dockkit-column="0"] > [data-dockkit-content]')].map(el=>getComputedStyle(el).borderLeftWidth);
    return {side:actual,gap,radius:st.borderTopLeftRadius,border:st.borderTopWidth,borderColor:st.borderTopColor,edges,shadow:st.boxShadow,top:e.top-w.top,bottom:w.bottom-e.bottom,overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert.equal(value.side,side);assert.ok(Math.abs(value.gap-12)<.5,JSON.stringify(value));
  assert.equal(value.radius,'12px');assert.equal(value.border,'1px');assert.notEqual(value.shadow,'none');
  assert.equal(value.top,8);assert.equal(value.bottom,8);assert.equal(value.overflow,false);
  assert.ok(value.edges.length>0,'Native first dock column must be exercised');
  assert.ok(value.edges.every(width=>width==='0px'),'No doubled native left border');
  return value;
}

// Exercise real native surfaces, including focus transfer, in both themes.
export async function checkBackgrounds(browser, ids) {
  const chrome=await checkSidebarChrome(browser,ids[0],'right');
  const pane = `document.querySelector('[data-session-id="${ids[0]}"]')`;
  await browser.evaluate(`${pane}.querySelector('[contenteditable=true]').focus()`);
  await delay(180);
  const read = () => browser.evaluate(`(()=>{
    const color=value=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=value;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].join(',');};
    const bg=e=>color(getComputedStyle(e).backgroundColor);
    const workbench=document.querySelector('[data-v5-workbench]');
    const nav=document.querySelector('[class*="_sidebarCol"]');
    if(!nav)throw new Error('Native left sidebar column missing');
    const fill=getComputedStyle(workbench).getPropertyValue('--dsw-specific-sidebar-fill');
    const opaque=e=>{while(e&&bg(e)==='0,0,0,0')e=e.parentElement;return e?bg(e):null;};
    return {page:bg(document.body),workspace:bg(workbench),navigation:opaque(nav),sidebarToken:color(fill),theme:workbench.dataset.theme,
      panes:[...document.querySelectorAll('[data-session-panel]')].map(p=>({
        id:p.dataset.sessionId,active:p.dataset.active==='true',outer:bg(p),sidebar:bg(p.querySelector('.v5-sidebar')),
        native:bg(p.querySelector('.v5-native-conversation').firstElementChild),
        veil:{opacity:Number(getComputedStyle(p,'::after').opacity),color:color(getComputedStyle(p,'::after').backgroundColor),pointerEvents:getComputedStyle(p,'::after').pointerEvents,content:getComputedStyle(p,'::after').content}
      }))};
  })()`);
  const first=await read();
  assert.equal(first.workspace,first.sidebarToken,'Workspace must use native left sidebar fill');
  assert.equal(first.workspace,first.navigation,'Left sidebar and right canvas must match');
  const active=first.panes.find(p=>p.active),inactive=first.panes.find(p=>!p.active);
  assert.equal(active.id,ids[0]);
  assert.equal(new Set([first.workspace,active.outer,inactive.outer]).size,3,'Canvas, active and inactive surfaces must be distinct');
  for(const p of first.panes){
    assert.equal(p.outer,p.sidebar,'Sidebar shell belongs to its session surface');
    assert.equal(p.outer,p.native,'Native conversation inherits the session surface');
    assert.equal(p.veil.opacity,p.active?0:.16);
    assert.equal(p.veil.color,p.outer,'Text-dimming veil must not alter the chosen surface');
    assert.equal(p.veil.pointerEvents,'none');assert.notEqual(p.veil.content,'none');
  }
  await browser.evaluate(`document.querySelector('[data-session-id="${ids[1]}"] [contenteditable=true]').focus()`);
  await delay(180);
  const switched=await read();
  assert.equal(switched.page,first.page,'Focus must never recolor the native page');
  assert.equal(switched.workspace,first.workspace);assert.equal(switched.navigation,first.navigation);
  assert.equal(switched.panes.find(p=>p.active).outer,active.outer);
  assert.equal(switched.panes.find(p=>p.id===ids[0]).outer,inactive.outer);
  // Enter keyboard modality, then explicitly focus both narrow drag targets.
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  const handles=[];
  for(const selector of ['.v5-session-drag','.v5-sidebar-drag']){
    const h=await browser.evaluate(`(()=>{const h=${pane}.querySelector('${selector}');h.focus();const s=getComputedStyle(h);return {keyboard:h.matches(':focus-visible'),outline:s.outlineStyle,border:s.borderTopWidth,background:s.backgroundColor,height:h.getBoundingClientRect().height,hint:getComputedStyle(h,'::after').opacity};})()`);
    assert.equal(h.keyboard,true);assert.equal(h.outline,'none');assert.equal(h.border,'0px');
    assert.equal(h.background,'rgba(0, 0, 0, 0)');assert.equal(h.height,8);assert.equal(h.hint,'1');handles.push(h);
  }
  await browser.evaluate(`${pane}.querySelector('[contenteditable=true]').focus()`);
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
  await delay(180);
  return {threeBackgroundLayers:true,nativeSidebarCanvas:true,singleSidebarEdge:true,focusTransfer:true,transparentDragTargets:true,keyboardHint:true,workspaceInsets:true,sidebarChrome:true,chrome,first,switched,handles};
}
