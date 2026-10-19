import * as React from 'react';
import {createPortal} from 'react-dom';
import {Workspace,type Pane} from './workspace';
import {Gestures,type Feedback} from './gestures';
import {sidebarGeometry,setSidebarRatio,LAYOUT,sidebarAxis} from './geometry';
import {renderNativeConversation,renderNativeSidebar,SESSION_SLOT,type NativeBridge,type NativeRenderProps,type SessionReference,type SidebarPresentation} from './host';
import {SidebarMenu,MoveDialog,DragOverlay,Toast} from './overlays';
import {installOuterResize} from './outer-resize';

interface WorkbenchProps {
  bridge:NativeBridge;
  SessionProvider:React.ComponentType<{session:SessionReference;children:React.ReactNode}>;
  renderSlot(name:string,owner:Record<string,unknown>):React.ReactNode;
}
function useWorkspace(w:Workspace){React.useSyncExternalStore(w.subscribe,w.getSnapshot,w.getSnapshot);}
function useTheme(){
  const get=()=>[document.documentElement,document.body].some(node=>node.classList.contains('dark')||node.dataset.theme==='dark'||node.hasAttribute('data-ds-dark-theme'))||getComputedStyle(document.documentElement).colorScheme==='dark'?'dark':'light';
  const [theme,setTheme]=React.useState(get);
  React.useEffect(()=>{const observer=new MutationObserver(()=>setTheme(get()));for(const node of [document.documentElement,document.body])observer.observe(node,{attributes:true,attributeFilter:['class','style','data-theme','data-ds-dark-theme']});return()=>observer.disconnect();},[]);
  return theme;
}

/** Pane close glyph: the frozen prototype's stroke cross, at the session-action icon size. */
function CloseGlyph(){return <svg viewBox="0 0 17 17" width="15" height="15" aria-hidden="true">
  <path d="M4 4l9 9M13 4l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/></svg>;}

export function Workbench(props:WorkbenchProps) {
  const engine=React.useRef<HTMLDivElement>(null);
  const [workspace]=React.useState(()=>{let storage:Storage|undefined;try{storage=localStorage;}catch{}return new Workspace(props.bridge,props.bridge.storageScope??'local',storage);});
  const [feedback,setFeedback]=React.useState<Feedback|null>(null);
  const [gestures]=React.useState(()=>new Gestures(workspace,setFeedback));
  const theme=useTheme();useWorkspace(workspace);
  React.useSyncExternalStore(props.bridge.catalogStore.subscribe,props.bridge.catalogStore.getSnapshot,props.bridge.catalogStore.getSnapshot);
  React.useLayoutEffect(()=>{
    workspace.attach(engine.current!);
    const cleanup=installOuterResize(engine.current!,workspace.api!,{
      onStart:()=>{gestures.cancel();workspace.resizing=true;},
      onEnd:()=>{workspace.resizing=false;workspace.geometrySettled();},
    });
    const iframeFocus=()=>queueMicrotask(()=>{
      const active=document.activeElement;
      if(active?.tagName==='IFRAME') {
        const pane=active.closest<HTMLElement>('[data-session-panel]');
        if(pane?.dataset.sessionPanel)workspace.focus(pane.dataset.sessionPanel);
      }
    });
    window.addEventListener('blur',iframeFocus);
    return()=>{window.removeEventListener('blur',iframeFocus);gestures.dispose();cleanup();workspace.dispose();};
  },[workspace,gestures]);
  const moving=workspace.movingId?workspace.panes.get(workspace.movingId):undefined;
  return <div data-v5-workbench data-theme={theme}>
    <div className="v5-engine" ref={engine}/>
    {[...workspace.panes.values()].map(pane=>{
      const mount=workspace.mounts.get(pane.id);
      return mount?createPortal(<SessionBoundary key={pane.sessionId} onClose={()=>workspace.close(pane.id)}>
        <RetainedPane {...props} pane={pane} workspace={workspace} gestures={gestures} theme={theme}/>
      </SessionBoundary>,mount,pane.id):null;
    })}
    {!workspace.panes.size&&<div className="v5-empty"><h2>打开一个会话</h2><p>从左侧选择会话，通过会话菜单向右或向下分屏。</p></div>}
    {workspace.narrow&&<div className="v5-projection-note">当前仅显示一个会话，加宽窗口后恢复分屏</div>}
    {createPortal(<div data-v5-overlay data-theme={theme}>
      {feedback&&<DragOverlay {...feedback}/>}<Toast message={workspace.toast}/>
      {moving&&<MoveDialog title={`移动会话 ${workspace.title(moving)}`} targets={[...workspace.panes.values()].filter(p=>p.id!==moving.id).map(p=>({id:p.id,title:workspace.title(p)}))}
        unavailable={(id,side)=>workspace.moveUnavailable(moving.id,id,side)} onMove={(id,side)=>workspace.move(moving.id,id,side)}
        onClose={()=>{workspace.movingId=null;workspace.changed(false);}}/>}
    </div>,document.body)}
  </div>;
}

const RetainedPane=React.memo(function RetainedPane({bridge,SessionProvider,renderSlot,pane,workspace,gestures,theme}:WorkbenchProps&{pane:Pane;workspace:Workspace;gestures:Gestures;theme:string}) {
  const [reference,setReference]=React.useState<SessionReference|null>(null);
  const [error,setError]=React.useState('');
  React.useLayoutEffect(()=>{
    let live=true;let retained:SessionReference;
    try {retained=bridge.retain(pane.sessionId);setReference(retained);void retained.ready.catch(()=>{if(live)setError('会话加载失败，请从左侧重新打开。');});}
    catch{setError('会话暂不可用，请从左侧重新打开。');return;}
    return()=>{live=false;retained.release();};
  },[bridge,pane.sessionId]);
  if(error)return <div className="v5-empty" role="alert">{error}<button onClick={()=>workspace.close(pane.id)}>关闭此分屏</button></div>;
  if(!reference)return <div className="v5-empty" role="status">正在打开会话…</div>;
  return <SessionProvider session={reference}>{renderSlot(SESSION_SLOT,{pane,workspace,gestures,theme})}</SessionProvider>;
});

// Only Sidebar's native dock needs measured numbers for its floating-tab bounds.
// CSS handles conversation sizing directly; no React round trip on every resize.
const NativeSidebar=React.memo(function NativeSidebar({renderFactorySlot,bridge,sessionId,active}:NativeRenderProps&{active:boolean}) {
  const root=React.useRef<HTMLDivElement>(null);
  const [size,setSize]=React.useState({width:0,height:0});
  React.useLayoutEffect(()=>{
    const node=root.current!;
    const observer=new ResizeObserver(entries=>{
      const box=entries[0]?.contentRect;
      if(!box)return;
      const width=Math.round(box.width),height=Math.round(box.height);
      setSize(previous=>previous.width===width&&previous.height===height?previous:{width,height});
    });
    observer.observe(node);return()=>observer.disconnect();
  },[]);
  const onPresentation=React.useCallback((value:SidebarPresentation)=>bridge.reportSidebar(sessionId,value),[bridge,sessionId]);
  const content=React.useMemo(()=>renderNativeSidebar({renderFactorySlot,bridge,sessionId},{...size,active,onPresentation}),[renderFactorySlot,bridge,sessionId,size,active,onPresentation]);
  return <div ref={root} className="v5-native-sidebar">{content}</div>;
});

export function SessionPane(props:NativeRenderProps&{pane:Pane;workspace:Workspace;gestures:Gestures;theme:string}) {
  const {pane,workspace:w,gestures,theme}=props;
  const readPane=React.useCallback(()=>w.panes.get(pane.id)??pane,[w,pane]);
  const latest=React.useSyncExternalStore(w.subscribe,readPane,readPane);
  const readActive=React.useCallback(()=>w.activeId===pane.id,[w,pane.id]);
  const active=React.useSyncExternalStore(w.subscribe,readActive,readActive);
  const readVisible=React.useCallback(()=>w.visible(pane.id),[w,pane.id]);
  const visible=React.useSyncExternalStore(w.subscribe,readVisible,readVisible);
  const body=React.useRef<HTMLDivElement>(null);
  const title=w.title(latest);
  const [menu,setMenu]=React.useState<HTMLElement|null>(null);
  const focus=()=>{if(w.activeId!==pane.id)w.focus(pane.id);};
  const conversation=React.useMemo(()=>renderNativeConversation(props),[props.renderFactorySlot,props.sessionId]);
  const onKey=(e:React.KeyboardEvent)=>{
    const size={width:body.current!.clientWidth,height:body.current!.clientHeight};
    const geometry=sidebarGeometry(size,latest.sidebar);
    const vertical=geometry.axis==='y';
    const sign=latest.sidebar.side==='left'||latest.sidebar.side==='top'?1:-1;
    let next=geometry.ratio;
    if(e.key==='Home')next=0;else if(e.key==='End')next=1;
    else if(e.key===(vertical?'ArrowDown':'ArrowRight'))next+=LAYOUT.sidebarKeyboardStep*sign*(e.shiftKey?3:1);
    else if(e.key===(vertical?'ArrowUp':'ArrowLeft'))next-=LAYOUT.sidebarKeyboardStep*sign*(e.shiftKey?3:1);
    else return;
    e.preventDefault();w.sidebar(pane.id,setSidebarRatio(latest.sidebar,size,next));
  };
  const axis=sidebarAxis(latest.sidebar.side);
  const track=axis==='x'
    ? `clamp(${LAYOUT.sidebarMinWidth}px, calc((100% - ${LAYOUT.gap}px) * ${latest.sidebar.ratios.x}), calc(100% - ${LAYOUT.gap+LAYOUT.chatMinWidth}px))`
    : `clamp(${LAYOUT.sidebarMinHeight}px, calc((100% - ${LAYOUT.gap}px) * ${latest.sidebar.ratios.y}), calc(100% - ${LAYOUT.gap+LAYOUT.chatMinHeight}px))`;
  return <section className="v5-session" data-session-panel={pane.id} data-session-id={pane.sessionId} data-active={active}
    onPointerDownCapture={focus} onFocusCapture={focus} aria-label={title}>
    <button className="v5-session-drag" aria-label={`移动会话：${title}`} title="拖动调整分屏位置；点击选择位置"
      onPointerDown={e=>gestures.begin('session',pane.id,e)} onClick={()=>{if(!gestures.blockedClick())w.requestMove(pane.id);}}/>
    <div ref={body} className="v5-session-body">
      <div className="v5-session-layout" data-side={latest.sidebar.side} data-axis={axis} data-sidebar-open={latest.sidebar.open}
        data-fullscreen={Boolean(latest.fullscreen&&latest.sidebar.open)} style={{'--v5-sidebar-track':track} as React.CSSProperties}>
        <div className="v5-conversation">
          <div className="v5-native-conversation">{conversation}</div>
          {/* One pane of a real split is a window that may be closed on its own; the single pane
              is the normal view and gets no control. It is anchored to the conversation column so
              it stays on the shipped header's right end while that column moves with the Sidebar
              dock, and it takes the corner the shipped header frees for it (visual-contract §边界
              例外). Closing removes the presentation, never the Session. */}
          {w.panes.size>1&&<button type="button" className="v5-session-close" data-dsh-split-close
            aria-label={`关闭此分屏：${title}`} title="关闭此分屏（不删除会话）"
            onClick={()=>w.close(pane.id)}><CloseGlyph/></button>}
        </div>
        <div className="v5-inner-divider" role="separator" tabIndex={latest.sidebar.open&&!latest.fullscreen?0:-1}
          aria-label={`调整 ${title} 的 Sidebar 大小`} aria-orientation={axis==='x'?'vertical':'horizontal'}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(latest.sidebar.ratios[axis]*100)} data-axis={axis} onKeyDown={onKey}
          onPointerDown={e=>gestures.begin('resize',pane.id,e,body.current!)}
          onDoubleClick={()=>w.sidebar(pane.id,setSidebarRatio(latest.sidebar,{width:body.current!.clientWidth,height:body.current!.clientHeight},.5))}/>
        <aside className="v5-sidebar" aria-label={`${title} 的 Sidebar`}>
          <button className="v5-sidebar-drag" aria-label="移动 Sidebar" title="拖到本会话边缘，或点击选择停靠位置" aria-haspopup="menu" aria-expanded={Boolean(menu)}
            onPointerDown={e=>gestures.begin('sidebar',pane.id,e,body.current!)} onClick={e=>{if(!gestures.blockedClick())setMenu(e.currentTarget);}}/>
          <div className="v5-sidebar-content"><NativeSidebar renderFactorySlot={props.renderFactorySlot} bridge={props.bridge} sessionId={props.sessionId} active={visible}/></div>
        </aside>
        <button className="v5-mobile-return" onClick={()=>w.toggleSidebar(pane.id)}>返回会话</button>
      </div>
    </div>
    {createPortal(<div data-v5-overlay data-theme={theme}>
      {menu&&<SidebarMenu anchor={menu} side={latest.sidebar.side} title={title} onClose={()=>setMenu(null)} onSelect={side=>{w.bridge.setSidebarFullscreen(pane.sessionId,false);w.sidebar(pane.id,{...latest.sidebar,side,open:true});w.bridge.setSidebarExpanded(pane.sessionId,true);}}/>}
    </div>,document.body)}
  </section>;
}

class SessionBoundary extends React.Component<React.PropsWithChildren<{onClose:()=>void}>,{error:boolean}> {
  state={error:false};static getDerivedStateFromError(){return{error:true};}
  render(){return this.state.error?<div className="v5-empty" role="alert">会话组件加载失败。其他分屏仍可使用。<button onClick={this.props.onClose}>关闭此分屏</button></div>:this.props.children;}
}
