import fs from 'node:fs';
import path from 'node:path';
import {sha256} from './read-asar.mjs';
import {verifyPackageFiles} from './native-package.mjs';

export function assertBootAdmission(releaseFile) {
  const manifest = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
  for (const item of manifest.replacements) verifyPackageFiles(item);
  const evidencePath = path.join(path.dirname(releaseFile), 'boot-validation.json');
  if (!fs.existsSync(evidencePath)) throw new Error('Real native host + browser boot validation is required before installation');
  const report = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  if (report.releaseSha256 !== sha256(fs.readFileSync(releaseFile)) || report.passed !== true) throw new Error('Real boot validation is stale or failed');
  for (const mode of ['baseline','enabled','restart','disabled','without-patches']) {
    if (!report.checks.some(check => check.mode === mode && check.passed === true)) throw new Error(`Missing successful boot scenario: ${mode}`);
  }
  if (!report.checks.some(check => check.mode === 'enabled' && check.interactions?.right && check.interactions?.below && check.interactions?.reload)) throw new Error('Real session split and reload verification is required');
  if(['0.5.0-rebuild.3','0.5.0-rebuild.4','0.5.0-rebuild.5','0.5.0-rebuild.6'].includes(manifest.version)){
    const interaction=report.checks.find(check=>check.mode==='enabled')?.interactions;
    for(const key of ['nativeSidebarControls','fullscreenIsLocal','fourSidebarPositions','nativeMoveAndClose','thinEdgeDragCancel','narrowRestore']){
      if(interaction?.refinement?.[key]!==true)throw new Error(`Missing refinement acceptance: ${key}`);
    }
    if(interaction.refinement.visual.length!==2||!interaction.performance?.nativeEditorsPreserved)throw new Error('Missing visual/performance acceptance');
    for(const name of ['outer-resize','sidebar-resize','left-sidebar-toggle'])if(interaction.performance.runs.filter(run=>run.name===name).length<3)throw new Error(`Missing repeated performance scenario: ${name}`);
    if(['0.5.0-rebuild.4','0.5.0-rebuild.5','0.5.0-rebuild.6'].includes(manifest.version))for(const visual of interaction.refinement.visual){
      const canvasKeys=manifest.version==='0.5.0-rebuild.6'?['nativeSidebarCanvas','singleSidebarEdge']:['transparentWorkspace'];
      for(const key of ['threeBackgroundLayers',...canvasKeys,'focusTransfer','transparentDragTargets','keyboardHint'])if(visual.backgrounds?.[key]!==true)throw new Error(`Missing background acceptance: ${visual.theme}/${key}`);
    }
    if(['0.5.0-rebuild.5','0.5.0-rebuild.6'].includes(manifest.version)){
      if(!interaction.refinement.sidebarFourSideChrome)throw new Error('Missing four-side Sidebar geometry acceptance');
      for(const v of interaction.refinement.visual)if(!v.backgrounds.workspaceInsets||!v.backgrounds.sidebarChrome)throw new Error('Missing Sidebar chrome and workspace insets acceptance');
    }
  }
  return report;
}
