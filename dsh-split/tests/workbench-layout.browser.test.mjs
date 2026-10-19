#!/usr/bin/env node
/**
 * Real-browser regression for the screenshot's two independent layout failures.
 * Uses the actual Dockview ESM and built workbench CSS in a synthetic host frame;
 * does not connect to DSH or load any user sessions. Requires installed Chrome.
 * Run: node tests/workbench-layout.browser.test.mjs
 * Override Chrome's path with DSH_TEST_CHROME where needed.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { readDockviewCss } from '../tools/dockview-css.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const chrome = process.env.DSH_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
assert.ok(existsSync(chrome), 'Set DSH_TEST_CHROME to an installed Chrome/Chromium executable')
const cssBuild = await build({
  absWorkingDir: root,
  entryPoints: ['src/styles.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  define: { __DSH_SPLIT_DOCKVIEW_CSS__: JSON.stringify(readDockviewCss()) },
})
const dockview = readFileSync(join(root, 'node_modules/dockview-core/dist/package/main.esm.mjs'), 'utf8')
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body { margin:0; height:100%; }
.frame { width:1200px; height:800px; box-sizing:border-box; display:grid;
  grid-template-columns:280px minmax(0,1fr) 320px; grid-template-rows:minmax(0,1fr);
  padding-top:40px; position:relative; overflow:hidden; }
.center { flex-direction:column; min-width:0; display:flex; overflow:hidden; }
</style></head><body><div class="frame">
<div>Native left sidebar<div class="dv-split-view-container"><div class="dv-view-container"><div class="dv-view" id="outside">Outside scope</div></div></div></div>
<div class="center"><div data-dsh-split-workbench></div></div><div>Native right sidebar</div>
</div><pre id="result">PENDING</pre><script>
(async()=>{
try {
  const { DockviewComponent } = await import('/dockview.js');
  const { WORKBENCH_CSS } = await import('/styles.js');
  const style=document.createElement('style'); style.textContent=WORKBENCH_CSS; document.head.append(style);
  const host=document.querySelector('[data-dsh-split-workbench]');
  const api=new DockviewComponent(host, {
    singleTabMode:'default', disableFloatingGroups:true, hideBorders:true, noPanelsOverlay:'emptyGroup',
    theme:{name:'dsh-split-workbench', className:'dsh-split-theme', gap:12},
    createComponent:({id})=>{
      const element=document.createElement('div'); element.dataset.dshSplitPanel=id;
      element.style.cssText='height:100%;width:100%;overflow:hidden';
      element.innerHTML='<div data-dsh-split-surface="'+id+'" style="display:flex;flex-direction:column;min-width:0;min-height:0;height:100%"><div data-dsh-split-titlebar>Session '+id+'</div><div data-dsh-split-body><div class="dsh-split-empty">Synthetic conversation</div><div data-dsh-sidebar-host></div></div></div>';
      return {element, init(){}, dispose(){}};
    }
  });
  const add=(id, direction)=>{
    if(api.panels.length===0) {
      api.addPanel({id,component:'surface'}); api.panels[0].group.header.hidden=true;
      api.panels[0].group.locked='no-drop-target';
    } else {
      const group=api.addGroup({referenceGroup:api.panels[0].group,direction,locked:'no-drop-target',hideHeader:true});
      api.addPanel({id,component:'surface',position:{referenceGroup:group}});
    }
  };
  const wait=async()=>{
    await new Promise(resolve=>requestAnimationFrame(resolve));
    await new Promise(resolve=>requestAnimationFrame(resolve));
    await new Promise(resolve=>setTimeout(resolve,60));
  };
  const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
  const snapshot=name=>({name, center:rect(document.querySelector('.center')), host:rect(host),
    surfaces:Object.fromEntries([...document.querySelectorAll('[data-dsh-split-surface]')].map(el=>[el.dataset.dshSplitSurface,rect(el)])),
    views:[...host.querySelectorAll('.dv-view')].map(el=>getComputedStyle(el).position),
    tabs:[...host.querySelectorAll('.dv-tabs-and-actions-container')].map(el=>getComputedStyle(el).display),
    sashes:[...host.querySelectorAll('.dv-sash')].map(el=>getComputedStyle(el).backgroundColor),
    outsidePosition:getComputedStyle(document.querySelector('#outside')).position});
  add('a'); add('b','right'); await wait(); const results=[snapshot('right')];
  add('c','below'); await wait(); results.push(snapshot('below'));
  document.querySelector('.frame').style.width='1000px'; await wait(); results.push(snapshot('resized'));
  document.querySelector('#result').textContent=JSON.stringify(results);
} catch(error) {document.querySelector('#result').textContent=JSON.stringify({error:error.stack});}
await fetch('/done');
})();
</script></body></html>`

let documentResponse
const server = createServer((req, res) => {
  if (req.url === '/done') {
    res.end('ok')
    documentResponse.end()
    return
  }
  const scripts = { '/dockview.js': dockview, '/styles.js': cssBuild.outputFiles[0].text }
  res.setHeader('Content-Type', req.url in scripts ? 'application/javascript' : 'text/html;charset=utf-8')
  if (req.url === '/') {
    // Keep navigation pending while real animation frames and ResizeObserver run.
    // Virtual-time dump-dom skips rendering between timers, masking resize work.
    documentResponse = res
    res.write(html)
  } else res.end(scripts[req.url] ?? '')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const profile = mkdtempSync(join(tmpdir(), 'dshsplit-layout-test-'))
try {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--dump-dom',
      '--run-all-compositor-stages-before-draw',
      `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}`,
    ], { windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Browser layout test timed out')) }, 25000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      code === 0 ? resolve(stdout) : reject(new Error(`Chrome exited ${code}: ${stderr.slice(-1000)}`))
    })
  })
  const encoded = output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1]
  assert.ok(encoded && encoded !== 'PENDING', 'Browser did not finish the layout fixture')
  const results = JSON.parse(encoded.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'))
  assert.ok(Array.isArray(results), JSON.stringify(results))
  console.log(JSON.stringify(results.map(({name,center,host,surfaces}) => ({name,center,host,surfaces})), null, 2))
  for (const result of results) {
    assert.deepEqual(result.host, result.center, `${result.name}: workbench must fill only the center column`)
    assert.equal(result.outsidePosition, 'static', 'Dockview CSS must not escape the workbench')
    assert.ok(result.views.length && result.views.every(value => value === 'absolute'), 'Base splitview CSS is required')
    assert.ok(result.tabs.every(value => value === 'none'), 'Frozen design hides Dockview headers')
    assert.ok(result.sashes.every(value => value === 'rgba(0, 0, 0, 0)'), 'Frozen design has transparent dividers')
    for (const pane of Object.values(result.surfaces)) {
      assert.ok(pane.w > 0 && pane.h > 200, `${result.name}: panels need real content height`)
      assert.ok(pane.x >= result.center.x && pane.y >= result.center.y)
      assert.ok(pane.x + pane.w <= result.center.x + result.center.w + 1, `${result.name}: pane exceeds center width: ${JSON.stringify(pane)} in ${JSON.stringify(result.center)}`)
      assert.ok(pane.y + pane.h <= result.center.y + result.center.h + 1, `${result.name}: pane exceeds center height: ${JSON.stringify(pane)} in ${JSON.stringify(result.center)}`)
    }
  }
  const [right, below, resized] = results
  assert.equal(right.surfaces.b.x - (right.surfaces.a.x + right.surfaces.a.w), 12, 'Right split has a 12px gap')
  assert.equal(right.surfaces.a.y, right.surfaces.b.y, 'Right split must not stack vertically')
  assert.equal(below.surfaces.c.y - (below.surfaces.a.y + below.surfaces.a.h), 12, 'Below split has a 12px gap')
  assert.equal(resized.host.w, 400, 'Host follows the center column on window resize')
  console.log('PASS: browser geometry, horizontal/vertical splits, resize, CSS scope, hidden headers and transparent dividers')
} finally {
  server.close()
  // Leave the isolated profile visible for caller-controlled cleanup; never touch
  // the user's normal browser profile or automatically recursively delete paths.
  console.log(`Isolated test profile: ${profile}`)
}
