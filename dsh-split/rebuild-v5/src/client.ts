import {installNativeHost} from './host';
import {Workbench,SessionPane} from './workbench';
import styles from 'v5:styles';

export const inject=['slots','sessions','uiSession','uiWorkspace','layout','connection'];
export function apply(ctx:any) {
  // An absent/incompatible optional patch must never keep the app's boot pending.
  // Cordis scopes this callback to the service lifetime and disposes it on loss.
  ctx.inject(['sidebarRightHost'], (scope:any) => {
    const style=document.createElement('style');
    style.dataset.dshSplit='v5-clean-rebuild';style.textContent=styles;
    try {
      const bridge=installNativeHost(scope,Workbench,SessionPane);
      document.head.append(style);
      scope.effect(()=>()=>{bridge.dispose();style.remove();},'dsh-split: v5 chrome');
    } catch(error) {
      style.remove();
      console.warn('DSH Split was not activated; the native conversation remains available.',error);
    }
  });
}
