/** Local, credential-free placeholder shown only until the authorization URL is ready. */
export function showAuthorizationLoading(popup: Window): void {
  const doc = popup.document;
  doc.title = '钉钉连接';
  doc.documentElement.lang = 'zh-CN';
  const viewport = doc.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  const style = doc.createElement('style');
  style.textContent = `
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;background:Canvas;color:CanvasText;font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
    main{min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center}
    .spinner{width:24px;height:24px;border:2px solid color-mix(in srgb,CanvasText 12%,transparent);border-top-color:light-dark(#5277ae,#8caee0);border-radius:50%;animation:turn .9s linear infinite}
    p{margin:0;color:color-mix(in srgb,CanvasText 65%,transparent)}
    @keyframes turn{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
  `;
  doc.head.append(viewport, style);
  const main = doc.createElement('main');
  main.setAttribute('role', 'status');
  main.setAttribute('aria-live', 'polite');
  main.setAttribute('aria-busy', 'true');
  main.setAttribute('data-dsh-dingtalk-loading', '');
  const spinner = doc.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('p');
  label.textContent = '正在连接钉钉…';
  main.append(spinner, label);
  doc.body.replaceChildren(main);
}
