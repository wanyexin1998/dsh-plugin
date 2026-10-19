import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const vendor=path.resolve(root,'../node_modules/dockview-core');
const umd=await fs.readFile(path.join(vendor,'dist/dockview-core.js'),'utf8');
const match=umd.match(/s\.textContent = ("(?:[^"\\]|\\.)*");/);
if(!match)throw new Error('Pinned Dockview CSS extraction anchor missing');
const base=JSON.parse(match[1]);
const own=await fs.readFile(path.join(root,'src/styles.css'),'utf8');
const css=`/* Dockview 8.5.1, MIT; isolated from the native Sidebar. */\n@scope ([data-v5-workbench]) to (.v5-native-conversation, .v5-native-sidebar) {\n${base}\n}\n${own}`;
await fs.mkdir(path.join(root,'lib'),{recursive:true});
await fs.writeFile(path.join(root,'lib/client.css'),css);
await fs.writeFile(path.join(root,'lib/THIRD-PARTY-NOTICES.txt'),'dockview-core 8.5.1\nLicense: MIT\nAuthor: mathuo\nSource: https://github.com/dockview/dockview\nThe original library license banner is preserved in client.js.\n');
const common={absWorkingDir:root,bundle:true,target:'chrome132',logLevel:'warning',jsx:'automatic'};
const compiled=await build({...common,entryPoints:['src/client.ts'],outfile:'lib/client.js',format:'cjs',platform:'browser',metafile:true,
  external:['react','react-dom','react/jsx-runtime','@deepseek-ai/dsh-client-ui-primitives'],
  plugins:[{name:'v5-css',setup(b){b.onResolve({filter:/^v5:styles$/},()=>({path:'v5-css',namespace:'v5-css'}));b.onLoad({filter:/.*/,namespace:'v5-css'},()=>({contents:css,loader:'text'}));}}],
  banner:{js:'window.__ModuleLoader__.load({id:"dsh-split",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer:{js:'return module.exports;}});'},
});
const productionInputs=Object.keys(compiled.metafile.inputs);
if(productionInputs.some(input=>input.startsWith('../')&&!input.startsWith('../node_modules/')))throw new Error('Production imports escaped the clean rebuild');
await fs.writeFile(path.join(root,'lib/build-inputs.json'),JSON.stringify({productionInputs,legacySourcesRead:false},null,2));
try {await fs.access(path.join(root,'src/index.ts'));await build({...common,entryPoints:['src/index.ts'],outfile:'lib/index.js',platform:'node',format:'cjs',packages:'external'});}catch(error){if(error.code!=='ENOENT')throw error;}
try {
  await fs.access(path.join(root,'tests/fixture.tsx'));
  await fs.mkdir(path.join(root,'dist'),{recursive:true});
  await build({...common,entryPoints:['tests/fixture.tsx'],outfile:'dist/fixture.js',platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'fixture-primitives',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'fixture-primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'import React from "react";export const MenuItemButton=({onSelect,children,...props})=>React.createElement("button",{...props,onClick:onSelect},children);export const IconCheckOutlineRegular=()=>null;export const IconCloseOutlineRegular=()=>null;',loader:'js',resolveDir:root}));}}]});
}catch(error){if(error.code!=='ENOENT')throw error;}
const code=await fs.readFile(path.join(root,'lib/client.js'));
console.log(JSON.stringify({entry:'rebuild-v5/lib/client.js',bytes:code.length,sha256:createHash('sha256').update(code).digest('hex'),legacySourcesRead:false}));
