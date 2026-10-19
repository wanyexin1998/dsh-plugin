import { edgeAt, containsPoint, hasDragThreshold, resizeSidebarRatio, sidebarGeometry, movePreviewRect, type Point, type Rect, type Side, type SidebarPlacement, type GeometryDockview } from './geometry';
import type { Workspace } from './workspace';

export interface Feedback { kind:'session'|'sidebar'|'resize'; point:Point; title:string; scope?:Rect; preview?:Rect; label?:string; axis?:'x'|'y' }
interface Gesture {
  kind:Feedback['kind']; paneId:string; epoch:number; start:Point; point:Point;
  pointerId:number; target:HTMLElement; active:boolean; original?:SidebarPlacement;
  body?:HTMLElement; source?:HTMLElement; drop?:{id:string;side:Side};
  geometry?:GeometryDockview;
}
export const rectOf = (el:Element):Rect => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
const names:Record<Side,string>={left:'左侧',right:'右侧',top:'上方',bottom:'下方'};

/** One pointer transaction, with cancellation before any layout commit. */
export class Gestures {
  current?:Gesture;
  suppressUntil=0;
  private clean?:()=>void;
  private frame=0;
  constructor(readonly workspace:Workspace,readonly feedback:(value:Feedback|null)=>void) {}
  blockedClick=()=>performance.now()<this.suppressUntil;
  begin(kind:Gesture['kind'],paneId:string,event:React.PointerEvent<HTMLElement>,body?:HTMLElement) {
    if(event.button!==0 || !event.isPrimary) return;
    this.cancel();
    const pane=this.workspace.panes.get(paneId);
    if(!pane) return;
    if(kind==='session'&&(this.workspace.narrow||this.workspace.maximized||this.workspace.panes.size<2)) return;
    const target=event.currentTarget;
    const start={x:event.clientX,y:event.clientY};
    const g:Gesture={kind,paneId,epoch:pane.epoch,start,point:start,pointerId:event.pointerId,target,active:kind==='resize',body,
      original:kind==='resize'?structuredClone(pane.sidebar):undefined,
      geometry:kind==='session'?this.workspace.geometry():undefined};
    this.current=g;
    this.workspace.focus(paneId);
    if(kind==='resize') { event.preventDefault(); this.workspace.resizing=true; this.paint(g); }
    try { target.setPointerCapture(event.pointerId); } catch { /* Synthetic fixture lacks pointer capture. */ }
    const move=(e:PointerEvent)=>{
      if(e.pointerId!==g.pointerId||this.current!==g) return;
      g.point={x:e.clientX,y:e.clientY};
      if(!g.active&&!hasDragThreshold(g.start,g.point)) return;
      g.active=true; e.preventDefault();
      if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;if(this.current===g)this.paint(g);});
    };
    const up=(e:PointerEvent)=>{if(e.pointerId===g.pointerId){
      g.point={x:e.clientX,y:e.clientY};
      if(g.active)this.paint(g);
      this.finish(false);
    }};
    const cancel=(e?:PointerEvent)=>{if(!e||e.pointerId===g.pointerId)this.finish(true);};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.finish(true);}};
    const blur=()=>this.finish(true);
    window.addEventListener('pointermove',move,{capture:true,passive:false});
    window.addEventListener('pointerup',up,true);
    window.addEventListener('pointercancel',cancel,true);
    window.addEventListener('keydown',key,true);
    window.addEventListener('blur',blur);
    target.addEventListener('lostpointercapture',cancel);
    this.clean=()=>{
      window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);
      window.removeEventListener('pointercancel',cancel,true);window.removeEventListener('keydown',key,true);
      window.removeEventListener('blur',blur);target.removeEventListener('lostpointercapture',cancel);
    };
  }
  private paint(g:Gesture) {
    const pane=this.workspace.panes.get(g.paneId);
    if(!pane||pane.epoch!==g.epoch){this.finish(true);return;}
    const fb:Feedback={kind:g.kind,point:g.point,title:this.workspace.title(pane)};
    g.drop=undefined;
    if(g.kind==='resize') {
      const original=g.original!;
      const size=rectOf(g.body!);
      const axis=original.side==='left'||original.side==='right'?'x':'y';
      this.workspace.sidebar(g.paneId,resizeSidebarRatio(original,size,g.point[axis]-g.start[axis]));
      fb.axis=axis;
    } else if(g.kind==='sidebar') {
      const r=rectOf(g.body!); fb.scope=r;
      const side=edgeAt(g.point,r);
      if(side) {
        const projected=sidebarGeometry(r,{...pane.sidebar,open:true},side).sidebar;
        g.drop={id:g.paneId,side}; fb.preview={...projected,x:r.x+projected.x,y:r.y+projected.y};fb.label=`Sidebar 移到${names[side]}`;
      }
    } else {
      for(const [id,mount] of this.workspace.mounts) {
        if(id===g.paneId||!this.workspace.visible(id))continue;
        const r=rectOf(mount); if(!containsPoint(g.point,r))continue;
        const side=edgeAt(g.point,r);
        if(side&&!this.workspace.moveUnavailable(g.paneId,id,side,g.geometry)) {
          g.drop={id,side};
          fb.preview=movePreviewRect(g.geometry!,g.paneId,id,side,rectOf(this.workspace.element!))??undefined;
          fb.label=`移动到${names[side]}`;
        }
        break;
      }
    }
    this.feedback(fb);
  }
  private finish(cancelled:boolean) {
    const g=this.current; if(!g)return;
    cancelAnimationFrame(this.frame);this.frame=0;
    this.current=undefined; this.clean?.();this.clean=undefined;
    try{if(g.target.hasPointerCapture(g.pointerId))g.target.releasePointerCapture(g.pointerId);}catch{}
    this.feedback(null);
    if(g.active)this.suppressUntil=performance.now()+100;
    if(g.kind==='resize')this.workspace.resizing=false;
    const pane=this.workspace.panes.get(g.paneId);
    if(!pane||pane.epoch!==g.epoch){if(g.kind==='resize')this.workspace.changed();return;}
    if(g.kind==='resize') {
      if(cancelled)this.workspace.sidebar(g.paneId,g.original!);
      this.workspace.changed();
    } else if(g.active&&!cancelled) {
      if(!g.drop) {this.workspace.inform(g.kind==='sidebar'?'请拖到本会话的四个边缘之一':'这里不能放置会话，布局保持不变');return;}
      if(g.kind==='sidebar') {
        this.workspace.bridge.setSidebarFullscreen(pane.sessionId,false);
        this.workspace.sidebar(g.paneId,{...pane.sidebar,side:g.drop.side,open:true});
        this.workspace.bridge.setSidebarExpanded(pane.sessionId,true);
      } else this.workspace.move(g.paneId,g.drop.id,g.drop.side);
    }
  }
  cancel(){this.finish(true);}
  dispose(){this.cancel();}
}
