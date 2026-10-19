/* BOOP — tiny, offline WebGL2 player for the supplied glTF asset.
 * No third-party runtime. This is an intentionally scoped GLB reader, NOT a general
 * glTF implementation (no skins/textures/extensions). boop.glb also loads in standard
 * glTF tools. State transitions are sampled from its actual animation channels.
 */
const STATES = new Set(['idle','listen','think','success','error']);
const I = () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const mix = (a,b,t) => a.map((v,i)=>v+(b[i]-v)*t);
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const norm = v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n)};
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
function mul(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
function trs(t,q,s){let[x,y,z,w]=q;const m=I();m[0]=(1-2*(y*y+z*z))*s[0];m[1]=2*(x*y+z*w)*s[0];m[2]=2*(x*z-y*w)*s[0];m[4]=2*(x*y-z*w)*s[1];m[5]=(1-2*(x*x+z*z))*s[1];m[6]=2*(y*z+x*w)*s[1];m[8]=2*(x*z+y*w)*s[2];m[9]=2*(y*z-x*w)*s[2];m[10]=(1-2*(x*x+y*y))*s[2];m[12]=t[0];m[13]=t[1];m[14]=t[2];return m;}
function slerp(a,b,t){let c=dot(a,b);if(c<0){b=b.map(v=>-v);c=-c}if(c>.9995)return norm(mix(a,b,t));const th=Math.acos(clamp(c,-1,1));const k=Math.sin(th);return a.map((v,i)=>(v*Math.sin((1-t)*th)+b[i]*Math.sin(t*th))/k);}
function lookAt(eye,target){const z=norm(sub(eye,target)),x=norm(cross([0,1,0],z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
function ortho(l,r,b,t,n,f){return new Float32Array([2/(r-l),0,0,0,0,2/(t-b),0,0,0,0,-2/(f-n),0,-(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1]);}
const VS=`#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aDelta;layout(location=3) in vec3 aNormalDelta;
uniform mat4 uModel,uVP;uniform float uMorph;
out vec3 vP,vN;
void main(){vec3 p=aPosition+aDelta*uMorph;vec3 n=normalize(aNormal+aNormalDelta*uMorph);vec4 wp=uModel*vec4(p,1.);vP=wp.xyz;vN=normalize(mat3(uModel)*n);gl_Position=uVP*wp;}`;
const FS=`#version 300 es
precision highp float;in vec3 vP,vN;uniform vec3 uColor,uEye;uniform float uRough;out vec4 frag;
vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){vec3 n=normalize(vN);vec3 v=normalize(uEye-vP);
vec3 l1=normalize(vec3(-3.0,5.,5.)),l2=normalize(vec3(4.,2.,3.)),l3=normalize(vec3(1.,4.,-4.));
float d1=max(dot(n,l1),0.),d2=max(dot(n,l2),0.),d3=max(dot(n,l3),0.);
float hemi=.33+.22*(n.y*.5+.5);vec3 lit=vec3(hemi)+vec3(.98,.97,.91)*(.64*d1)+vec3(.78,.90,1.)*(.26*d2)+vec3(.58,.92,1.)*(.48*d3);
float ao=mix(.85,1.,smoothstep(.23,1.3,vP.y));
float power=mix(145.,18.,uRough);float sp=pow(max(dot(n,normalize(l1+v)),0.),power)*mix(.65,.12,uRough)+pow(max(dot(n,normalize(l2+v)),0.),power)*.06;
float fres=pow(1.-max(dot(n,v),0.),4.)*.065;
vec3 col=uColor*lit*ao+vec3(sp)+vec3(.28,.60,.72)*fres;
frag=vec4(srgb(clamp(col,vec3(0.),vec3(1.))),1.);}`;
function shader(gl,type,code){const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw new Error(gl.getShaderInfoLog(s)||'Shader failed')}return s;}

export class BoopAssistant {
  constructor(canvas,{onStateChange=()=>{},onError=()=>{},fps=30,pixelRatio=1.5,reducedMotion=null}={}){
    if(!(canvas instanceof HTMLCanvasElement))throw new TypeError('A canvas element is required');
    this.canvas=canvas;this.onStateChange=onStateChange;this.onError=onError;this.fps=fps;this.maxDpr=pixelRatio;
    this.state='idle';this.elapsed=0;this.playing=true;this.active=true;this.accessories=true;this.disposed=false;
    this.yaw=-.46;this.pitch=.17;this.zoom=1;this._fade=null;this._last=0;this._lastPaint=0;this._raf=0;this._dirty=true;
    this._media=matchMedia('(prefers-reduced-motion: reduce)');this._motionOverride=reducedMotion;this.reducedMotion=reducedMotion??this._media.matches;
    this._visibility=()=>{this._last=0;this._schedule();};
    this._motion=()=>{if(this._motionOverride==null){this.reducedMotion=this._media.matches;this._last=0;this._dirty=true;this._schedule()}};
    this._lost=e=>{e.preventDefault();this._contextLost=true;cancelAnimationFrame(this._raf);this._raf=0;this.onError(new Error('WebGL context lost; waiting for restoration'))};
    this._restored=()=>{this._contextLost=false;try{this._gpu();this._buildDraws();this._dirty=true;this._schedule()}catch(e){this.onError(e)}};
    canvas.addEventListener('webglcontextlost',this._lost);canvas.addEventListener('webglcontextrestored',this._restored);
    document.addEventListener('visibilitychange',this._visibility);this._media.addEventListener('change',this._motion);
    this.gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'});
    if(!this.gl){this.dispose();throw new Error('This browser does not provide WebGL2. Use PNG fallback.');}
    this._gpu();this._resizeObserver=new ResizeObserver(()=>{this._dirty=true;this.resize();this._schedule()});this._resizeObserver.observe(canvas);
  }
  _gpu(){const gl=this.gl;this.program=gl.createProgram();const vs=shader(gl,gl.VERTEX_SHADER,VS),fs=shader(gl,gl.FRAGMENT_SHADER,FS);gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);gl.deleteShader(vs);gl.deleteShader(fs);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program));this.u={};for(const k of ['uModel','uVP','uMorph','uColor','uEye','uRough'])this.u[k]=gl.getUniformLocation(this.program,k);gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.clearColor(0,0,0,0);this.buffers=[];}
  async load(url){this._abort?.abort();this._abort=new AbortController();const timeout=setTimeout(()=>this._abort?.abort(),30000);try{const r=await fetch(url,{signal:this._abort.signal});if(!r.ok)throw new Error(`Model load: HTTP ${r.status}`);this.parse(await r.arrayBuffer());return this;}finally{clearTimeout(timeout)}}
  parse(buffer){if(this.disposed)throw new Error('Player disposed');const d=new DataView(buffer);if(d.getUint32(0,true)!==0x46546c67||d.getUint32(4,true)!==2)throw new Error('Not a glTF 2.0 GLB');if(d.getUint32(8,true)!==buffer.byteLength)throw new Error('Truncated GLB');let pos=12;while(pos<buffer.byteLength){const len=d.getUint32(pos,true),type=d.getUint32(pos+4,true);if(type===0x4e4f534a)this.gltf=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,pos+8,len)));if(type===0x004e4942)this.bin=buffer.slice(pos+8,pos+8+len);pos+=8+len;}if(!this.gltf||!this.bin)throw new Error('Missing GLB chunks');this.rest=this.gltf.nodes.map(n=>({t:[...(n.translation||[0,0,0])],r:[...(n.rotation||[0,0,0,1])],s:[...(n.scale||[1,1,1])],w:n.weights?.[0]||0}));this.animations=new Map(this.gltf.animations.map(a=>[a.name,{...a,tracks:a.channels.map(ch=>{const s=a.samplers[ch.sampler];return {node:ch.target.node,path:ch.target.path,times:this.read(s.input),values:this.read(s.output),size:ch.target.path==='rotation'?4:ch.target.path==='weights'?1:3}})}]));this._buildDraws();this._dirty=true;this.resize();this.render();this._schedule();return this;}
  read(ai){const a=this.gltf.accessors[ai],b=this.gltf.bufferViews[a.bufferView];const n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];const Type={5126:Float32Array,5123:Uint16Array,5125:Uint32Array}[a.componentType];if(!Type||!n)throw new Error('Unsupported accessor');return new Type(this.bin,(b.byteOffset||0)+(a.byteOffset||0),a.count*n);}
  _buildDraws(){const gl=this.gl;this.draws=[];for(let ni=0;ni<this.gltf.nodes.length;ni++){const no=this.gltf.nodes[ni];if(no.mesh==null)continue;for(const pr of this.gltf.meshes[no.mesh].primitives){const vao=gl.createVertexArray();gl.bindVertexArray(vao);let verts=0;const attributes=[pr.attributes.POSITION,pr.attributes.NORMAL,pr.targets?.[0]?.POSITION,pr.targets?.[0]?.NORMAL];attributes.forEach((ai,loc)=>{if(ai==null){gl.disableVertexAttribArray(loc);gl.vertexAttrib3f(loc,0,0,0);return;}const a=this.read(ai);if(loc===0)verts=a.length/3;const buf=gl.createBuffer();this.buffers.push(buf);gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,a,gl.STATIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);});const inds=this.read(pr.indices);const ib=gl.createBuffer();this.buffers.push(ib);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,inds,gl.STATIC_DRAW);const m=this.gltf.materials[pr.material].pbrMetallicRoughness;this.draws.push({ni,vao,count:inds.length,type:inds instanceof Uint16Array?gl.UNSIGNED_SHORT:gl.UNSIGNED_INT,color:m.baseColorFactor.slice(0,3),rough:m.roughnessFactor,triangles:inds.length/3});} }gl.bindVertexArray(null);}
  _clip(name,time){const pose=this.rest.map(p=>({t:[...p.t],r:[...p.r],s:[...p.s],w:p.w}));const a=this.animations.get(name);if(!a)return pose;for(const tr of a.tracks){const ts=tr.times;let lo=0,hi=ts.length-1;while(lo<hi-1){const mid=(lo+hi)>>1;if(ts[mid]<=time)lo=mid;else hi=mid}const j=Math.min(lo+1,ts.length-1),span=ts[j]-ts[lo];const t=span?clamp((time-ts[lo])/span,0,1):0;const x=Array.from(tr.values.subarray(lo*tr.size,(lo+1)*tr.size)),y=Array.from(tr.values.subarray(j*tr.size,(j+1)*tr.size));if(tr.path==='weights')pose[tr.node].w=x[0]+(y[0]-x[0])*t;else pose[tr.node][{translation:'t',rotation:'r',scale:'s'}[tr.path]]=tr.path==='rotation'?slerp(x,y,t):mix(x,y,t);}return pose;}
  _sample(state,t){let clip='Idle_Loop',ct=t%6;if(state==='listen'){clip=t<.48?'Listen_Enter':'Listen_Loop';ct=t<.48?t:(t-.48)%4;}if(state==='think'){clip=t<.6?'Think_Enter':'Think_Loop';ct=t<.6?t:(t-.6)%4.8;}if(state==='success'){clip='Success';ct=Math.min(t,2);}if(state==='error'){clip=t<.6?'Error_Enter':'Error_Hold';ct=t<.6?t:(t-.6)%5;}this.currentClip=clip;return this._clip(clip,ct);}
  currentPose(){if(!this.gltf)return null;const t=this.reducedMotion?({idle:0,listen:.9,think:1.0,success:.7,error:1.0}[this.state]):this.elapsed;let pose=this._sample(this.state,t);if(this._fade&&!this.reducedMotion){const f=clamp(this._fade.progress/.30,0,1);const old=this._fade.pose;pose=pose.map((p,i)=>({t:mix(old[i].t,p.t,f),r:slerp(old[i].r,p.r,f),s:mix(old[i].s,p.s,f),w:old[i].w+(p.w-old[i].w)*f}));if(f>=1)this._fade=null;}return pose;}
  setState(state,{immediate=false}={}){if(!STATES.has(state))throw new RangeError('State must be idle, listen, think, success or error');if(this.disposed)return;const old=this.currentPose();this._fade=immediate||!old||!this.playing?null:{pose:old,progress:0};this.state=state;this.elapsed=this.playing?0:({idle:0,listen:1,think:1,success:.75,error:1}[state]);this._dirty=true;this._last=0;this.onStateChange(state);this._schedule();this.render();}
  setPose(state,seconds=0){if(!STATES.has(state))throw new RangeError('Unknown state');this.state=state;this.elapsed=seconds;this._fade=null;this._dirty=true;this.render();}
  setReducedMotion(value){this._motionOverride=value;this.reducedMotion=value??this._media.matches;this._dirty=true;this._schedule();this.render();}
  setActive(value){this.active=Boolean(value);this._last=0;if(!this.active){cancelAnimationFrame(this._raf);this._raf=0;}else{this._dirty=true;this._schedule();}}
  pause(){this.playing=false;this._dirty=true;this.render();}
  play(){this.playing=true;this._last=0;this._schedule();}
  setAccessories(value){this.accessories=!!value;this._dirty=true;this.render();}
  setView(yaw=-.46,pitch=.17,zoom=1){this.yaw=yaw;this.pitch=clamp(pitch,-.15,.85);this.zoom=clamp(zoom,.65,1.5);this._dirty=true;this.render();}
  resize(){const w=this.canvas.clientWidth||512,h=this.canvas.clientHeight||512,dpr=Math.min(devicePixelRatio||1,this.maxDpr);const W=Math.round(w*dpr),H=Math.round(h*dpr);if(this.canvas.width!==W||this.canvas.height!==H){this.canvas.width=W;this.canvas.height=H;}this._dirty=true;}
  render(){if(!this.gltf||this.disposed||this._contextLost)return;const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(this.program);
    const target=[0,1.64,0],rad=8;const eye=[Math.sin(this.yaw)*rad,1.64+Math.sin(this.pitch)*rad,Math.cos(this.yaw)*rad];const aspect=this.canvas.width/this.canvas.height;const half=2.05/this.zoom/Math.min(1,aspect);const vp=mul(ortho(-half*aspect,half*aspect,-half,half,.1,40),lookAt(eye,target));gl.uniformMatrix4fv(this.u.uVP,false,vp);gl.uniform3fv(this.u.uEye,eye);
    const pose=this.currentPose();const worlds=[];const hidden=[];const visit=(id,parent,hide)=>{const p=pose[id],n=this.gltf.nodes[id];hidden[id]=hide||(!this.accessories&&n.extras?.accessory);worlds[id]=mul(parent,trs(p.t,p.r,p.s));for(const c of n.children||[])visit(c,worlds[id],hidden[id]);};for(const r of this.gltf.scenes[this.gltf.scene||0].nodes)visit(r,I(),false);
    let dc=0,tri=0;for(const d of this.draws){if(hidden[d.ni])continue;const m=worlds[d.ni];if(!m||Math.hypot(m[0],m[1],m[2])<.001)continue;gl.uniformMatrix4fv(this.u.uModel,false,m);gl.uniform1f(this.u.uMorph,pose[d.ni].w);gl.uniform3fv(this.u.uColor,d.color);gl.uniform1f(this.u.uRough,d.rough);gl.bindVertexArray(d.vao);gl.drawElements(gl.TRIANGLES,d.count,d.type,0);dc++;tri+=d.triangles;}gl.bindVertexArray(null);this.stats={drawCalls:dc,triangles:tri,clip:this.currentClip,state:this.state,time:this.elapsed};this._dirty=false;
  }
  _schedule(){if(this.disposed||this._raf||!this.active||document.hidden||this._contextLost||!this.gltf)return;this._raf=requestAnimationFrame(t=>this._tick(t));}
  _tick(t){this._raf=0;if(this.disposed||!this.active||document.hidden)return;const dt=this._last?Math.min((t-this._last)/1000,.1):0;this._last=t;const moving=this.playing&&!this.reducedMotion;if(moving){this.elapsed+=dt;if(this._fade)this._fade.progress+=dt;if(this.state==='success'&&this.elapsed>=2)this.setState('idle');}if(this._dirty||(moving&&t-this._lastPaint>=1000/this.fps-1)){this.render();this._lastPaint=t;}if(moving)this._schedule();}
  capture(){this.render();return this.canvas.toDataURL('image/png');}
  dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this._raf);this._abort?.abort();this._resizeObserver?.disconnect();document.removeEventListener('visibilitychange',this._visibility);this._media?.removeEventListener('change',this._motion);this.canvas.removeEventListener('webglcontextlost',this._lost);this.canvas.removeEventListener('webglcontextrestored',this._restored);if(this.gl){for(const d of this.draws||[])this.gl.deleteVertexArray(d.vao);for(const b of this.buffers||[])this.gl.deleteBuffer(b);if(this.program)this.gl.deleteProgram(this.program);}this.draws=[];this.animations?.clear();}
}
