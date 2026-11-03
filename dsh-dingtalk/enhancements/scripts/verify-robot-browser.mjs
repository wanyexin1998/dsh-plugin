import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Actual React component; transport is synthetic. Real Desktop/OAuth acceptance is separate.
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{RelaySection}from'./lib/client/relay.js';import{connectionCss}from'./lib/client/styles.js';
const enterprise=location.search.includes('enterprise');let state=enterprise?{mode:'enterprise',displayName:'企业工作助手',configured:true,status:'disconnected'}:{mode:'personal',displayName:'个人机器人',configured:false,status:'unconfigured'};
window.calls=[];const store={async relay(method,payload){window.calls.push({method,keys:Object.keys(payload||{})});if(method==='configure')state={...state,configured:true,hosting:true,status:'disconnected',callbackUrl:'http://127.0.0.1:19878/relay/callback'};if(method==='connect')state={...state,status:'connected'};if(method==='stop')state={...state,hosting:false,status:'disconnected'};return state;}};
createRoot(document.getElementById('app')).render(React.createElement('main',{className:'dsh-dt'},React.createElement('style',null,connectionCss),React.createElement(RelaySection,{store})));`;
const result = await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'robot-browser.ts'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end(result.outputFiles[0].text);return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;margin:24px;background:Canvas;color:CanvasText}main{max-width:640px;margin:auto}html{color-scheme:light dark}</style><div id="app"></div><script src="/app.js"></script>');});
let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({executablePath:process.env.DSH_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:900,height:700}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:'+server.address().port;
 await page.goto(url);await page.getByRole('button',{name:'配置',exact:true}).click();
 const id=page.getByLabel('Client ID',{exact:true}), secret=page.getByLabel('Client Secret',{exact:true});
 await id.fill('test-app');await secret.fill('synthetic-value');
 const a=await id.boundingBox(),b=await secret.boundingBox();assert.equal(a.x,b.x);assert.equal(a.width,b.width);
 await mkdir('artifacts/browser',{recursive:true});
 await page.screenshot({path:'artifacts/browser/robot-personal.png',fullPage:true});
 await page.getByRole('button',{name:'下一步'}).click();await page.getByText('http://127.0.0.1:19878/relay/callback',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Client Secret',{exact:true}).count(),0);
 await page.goto(url+'?enterprise');await page.getByText('企业工作助手',{exact:true}).waitFor();
 assert.equal(await page.locator('input').count(),0);
 await page.setViewportSize({width:360,height:640});await page.emulateMedia({colorScheme:'dark'});
 await page.screenshot({path:'artifacts/browser/robot-enterprise-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByRole('status').filter({hasText:'已连接'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.calls.find(x=>x.method==='connect').keys),[]);
 assert.deepEqual(errors,[]);console.log('PASS: personal form alignment, secret clearing, enterprise no-input connection, mobile overflow; synthetic transport only');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
