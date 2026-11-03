/** Production styles for the approved standalone prototype; scoped to plugin surfaces. */
export const connectionCss = `
.dsh-dt,.dsh-dt-shell{--dt-line:color-mix(in srgb,currentColor 13%,transparent);--dt-soft:color-mix(in srgb,currentColor 4%,transparent);--dt-muted:color-mix(in srgb,currentColor 64%,transparent);--dt-accent:light-dark(#235fc9,#a6c4ff);--dt-accent-bg:light-dark(#edf3ff,#273956);--dt-success:light-dark(#387760,#8dceb4);color:inherit;font-family:inherit;font-size:13px;line-height:1.6;overflow-wrap:anywhere;box-sizing:border-box}
.dsh-dt *,.dsh-dt-shell *{box-sizing:border-box}
.dsh-dt{width:100%;max-width:574px;margin-inline:auto;padding:24px 20px}
.dsh-dt-shell{width:100%;max-width:440px;padding:8px 0}
.dsh-dt svg,.dsh-dt-shell svg{display:block;width:16px;height:16px;flex:none;pointer-events:none}
.dsh-dt button,.dsh-dt a,.dsh-dt-shell button,.dsh-dt-shell a{font:inherit;text-decoration:none;cursor:pointer;color:inherit}
.dsh-dt button:disabled,.dsh-dt-shell button:disabled{cursor:default;opacity:.55}
.dsh-dt :focus-visible,.dsh-dt-shell :focus-visible{outline:2px solid #5797ff;outline-offset:3px}
.dsh-dt .dsh-dt-icon,.dsh-dt-shell .dsh-dt-icon{display:inline-flex;align-items:center;justify-content:center;gap:5px;width:28px;height:29px;flex:none;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dt-muted);font-size:11px;line-height:1.3;vertical-align:middle}
.dsh-dt .dsh-dt-caption,.dsh-dt-shell .dsh-dt-caption{width:auto;padding-inline:8px;white-space:nowrap}
.dsh-dt-robot .dsh-dt-action{display:inline-flex;align-items:center;justify-content:center;min-width:64px;min-height:29px;padding:4px 12px;border:0;border-radius:5px;background:var(--dt-accent-bg);color:var(--dt-accent);font:inherit}
.dsh-dt-icon:hover:not(:disabled){background:var(--dt-soft)}
.dsh-dt-strip{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;min-height:70px;margin:0;padding:13px 14px;border:1px solid var(--dt-line);border-radius:9px;background:transparent}
.dsh-dt-card{max-width:440px}
.dsh-dt-symbol{display:grid;place-items:center;align-self:center;width:22px;height:22px;margin:0;color:var(--dt-muted)}
.dsh-dt-symbol svg{width:18px;height:18px}
.dsh-dt-strip[data-tone=success] .dsh-dt-symbol{color:var(--dt-success)}
.dsh-dt-strip[data-tone=warning] .dsh-dt-symbol{color:light-dark(#987039,#d8b276)}
.dsh-dt-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-dt-copy strong{font-size:13px;font-weight:550;line-height:1.5}
.dsh-dt-copy p{font-size:11px;line-height:1.6;color:var(--dt-muted);margin:0}
.dsh-dt-download-size{font-variant-numeric:tabular-nums}
.dsh-dt-progress{width:100%;max-width:260px;height:3px;margin-top:6px;border-radius:2px;overflow:hidden;background:var(--dt-line)}
.dsh-dt-progress span{display:block;height:100%;background:var(--dt-accent);border-radius:inherit;transition:width .2s ease}
.dsh-dt-actions.dsh-dt-preparing-actions{min-width:22px}
@media(prefers-reduced-motion:reduce){.dsh-dt-progress span{transition:none}}
.dsh-dt-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:99px;margin:0}
.dsh-dt-actions .dsh-dt-action,.dsh-dt-actions .dsh-dt-caption{display:inline-flex;align-items:center;justify-content:center;gap:4px;width:72px;min-height:29px;padding:4px 5px;border:0;border-radius:5px;font-size:11px;line-height:1.3;text-align:center;background:var(--dt-soft);white-space:normal}
.dsh-dt-actions .dsh-dt-icon:not(.dsh-dt-caption),.dsh-dt-action-spacer{width:22px;flex:none}
.dsh-dt-actions .dsh-dt-ready{background:transparent;color:var(--dt-success)}
.dsh-dt-actions .dsh-dt-primary,.dsh-dt-dialog .dsh-dt-primary{background:var(--dt-accent-bg);color:var(--dt-accent)}
.dsh-dt-primary:hover{filter:brightness(.96)}
.dsh-dt-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:24px}
.dsh-dt h2{font-size:22px;line-height:1.4;font-weight:550;margin:0}
.dsh-dt-heading p{font-size:12px;color:var(--dt-muted);line-height:1.8;margin:6px 0 0}
.dsh-dt-menu-anchor{position:relative;flex:none}
.dsh-dt-menu{position:absolute;right:0;top:34px;z-index:5;width:160px;padding:5px;background:Canvas;color:CanvasText;border:1px solid var(--dt-line);border-radius:7px;box-shadow:0 6px 18px #0000000a}
.dsh-dt-menu[hidden]{display:none}
.dsh-dt-menu .dsh-dt-icon{width:100%;justify-content:flex-start;gap:8px;height:34px;font-size:12px}
.dsh-dt-account{display:flex;align-items:center;gap:13px;padding:17px;background:var(--dt-soft);border-radius:9px}
.dsh-dt-avatar{display:grid;place-items:center;width:38px;height:38px;background:Canvas;border-radius:50%;color:var(--dt-muted);flex:none}
.dsh-dt-avatar svg{width:20px;height:20px}
.dsh-dt-account-copy{min-width:0;flex:1}
.dsh-dt-account strong{font-size:14px;font-weight:550;line-height:1.5}
.dsh-dt-account p{font-size:11px;line-height:1.6;color:var(--dt-muted);margin:3px 0 0}
.dsh-dt-connected{display:flex;align-items:center;gap:4px;color:var(--dt-success);font-size:11px;flex:none}
.dsh-dt-connected svg{width:13px;height:13px}
.dsh-dt-list-label{font-size:11px;color:var(--dt-muted);margin:26px 0 8px}
.dsh-dt-scope{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:37px;padding:9px 0;border-bottom:1px solid var(--dt-line);font-size:12px;line-height:1.5}
.dsh-dt-scope svg,.dsh-dt-scope small{color:var(--dt-muted)}
.dsh-dt-scope small{font-size:11px;text-align:right;max-width:140px}
.dsh-dt-privacy{display:flex;align-items:flex-start;gap:7px;font-size:11px;line-height:1.7;color:var(--dt-muted);margin:17px 0 0}
.dsh-dt-privacy svg{width:14px;height:14px;margin-top:2px}
.dsh-dt-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dt-line);margin-top:25px;padding-top:13px;color:var(--dt-muted);font-size:10px}
.dsh-dt-bottom .dsh-dt-icon{color:var(--dt-accent);padding-right:0}
.dsh-dt-dialog{color:CanvasText;background:Canvas;width:360px;max-width:calc(100vw - 32px);padding:22px;border:1px solid var(--dt-line);border-radius:12px;box-shadow:0 12px 44px #11182716;font:13px/1.7 system-ui,sans-serif}
.dsh-dt-dialog::backdrop{background:#18203035}
.dsh-dt-dialog-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;color:var(--dt-muted);font-size:10px}
.dsh-dt-dialog h3{font-size:18px;line-height:1.5;font-weight:550;margin:0}
.dsh-dt-dialog p{font-size:12px;line-height:1.8;color:var(--dt-muted);margin:10px 0 22px}
.dsh-dt-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.dsh-dt-dialog-actions .dsh-dt-icon{min-height:33px;font-size:12px}
.dsh-dt-copy-fallback{font-size:11px;margin-top:10px;color:var(--dt-muted)}
.dsh-dt-copy-fallback textarea{font:inherit;width:100%;min-height:90px;padding:10px;border:1px solid var(--dt-line);border-radius:6px;background:Canvas;color:CanvasText;resize:vertical}
.dsh-dt-row{display:flex;align-items:baseline;min-width:0;max-width:100%;font:inherit;font-size:13px;opacity:.72;padding:4px 0;white-space:nowrap}
.dsh-dt-row-fixed{flex:none;white-space:pre}
.dsh-dt-tool-name{flex:0 1 auto;min-width:0;max-width:18em;overflow:hidden;text-overflow:ellipsis}
.dsh-dt-tool-state{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
@media(max-width:480px){.dsh-dt{padding:16px 4px}.dsh-dt-strip{grid-template-columns:18px minmax(0,1fr) auto;gap:9px;padding:12px 11px;min-height:74px}.dsh-dt-symbol{width:18px}.dsh-dt-copy strong{font-size:12px}.dsh-dt-copy p{font-size:10px}.dsh-dt-actions{gap:3px;min-width:91px}.dsh-dt-actions .dsh-dt-action,.dsh-dt-actions .dsh-dt-caption{width:66px;font-size:10px}.dsh-dt-account{padding:14px;gap:9px}.dsh-dt-connected{font-size:10px}.dsh-dt-account strong{font-size:13px}}
`;
