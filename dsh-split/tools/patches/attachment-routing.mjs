/**
 * Append after P-3a/b/c. Keep native ComposerAttachments -> onAddFiles intake;
 * route by the nearest rendered conversation occurrence, never by focus or the
 * order in which document listeners mounted. The anchor adds no visible box.
 */
import { readFileSync } from 'node:fs'

const original = readFileSync(new URL('../../patches/originals/dsh-client-ui-attachment/lib/client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const start = original.indexOf('\t\tfunction installDocumentDropEvents(')
const end = original.indexOf('\n\t\t//#endregion', start)
if (start < 0 || end < 0) throw new Error('Attachment drop-events source boundary changed')
let previous = original.slice(start, end)
for (const event of ['onDragEnter', 'onDragOver', 'onDrop']) {
  const anchor = `\t\t\tconst ${event} = (event) => {\n`
  if (previous.split(anchor).length !== 2) throw new Error(`Attachment ${event} anchor changed`)
  previous = previous.replace(anchor, anchor + '\t\t\t\tif (event.defaultPrevented) return;\n')
}

// The upstream bundle uses tabs; author the replacement with two-space indents.
const hostCode = text => text.trim().split('\n').map(line => '\t\t' + line.replace(/^( *)/, spaces => '\t'.repeat(spaces.length / 2))).join('\n')
const routed = hostCode(`
function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, dropAnchor) {
  const asElement = (node) => node?.nodeType === 1 ? node : node?.parentElement ?? null;
  const regionFor = (node) => {
    const element = asElement(node);
    if (element === null) return null;
    const conversation = element.closest("[data-conversation-session]");
    const sidebar = element.closest("[data-dsh-sidebar-host]");
    if (conversation !== null) return sidebar !== null && !sidebar.contains(conversation) ? null : conversation;
    if (sidebar !== null || element.closest("[data-dsh-split-titlebar]") !== null) return null;
    const body = element.closest("[data-dsh-split-body]");
    const surface = element.closest("[data-dsh-split-session]");
    const content = body?.firstElementChild;
    return surface !== null && content?.contains(element) ? content : null;
  };
  const receiverFor = (event) => {
    const target = event.composedPath?.().find((node) => node?.nodeType === 1) ?? event.target;
    const region = regionFor(target);
    const anchors = [...document.querySelectorAll("[data-dsh-attachment-drop-anchor]")];
    if (region !== null) {
      const matches = anchors.filter((anchor) => regionFor(anchor) === region);
      return matches.length === 1 ? matches[0] : null;
    }
    const split = document.documentElement.hasAttribute("data-dsh-plugin-main-host") || anchors.some((anchor) => anchor.closest("[data-dsh-split-session]") !== null);
    return !split && anchors.length === 1 ? anchors[0] : null;
  };
  const fileTransfer = (event) => {
    const dataTransfer = event.dataTransfer;
    if (dataTransfer == null || !dataTransfer.types.includes("Files")) return null;
    return dataTransfer;
  };
  const reset = () => {
    dragDepth.current = 0;
    setDragActive(false);
  };
  const owns = (event, dataTransfer) => {
    const receiver = receiverFor(event);
    if (receiver === null) {
      // Refuse ambiguous/outside drops without letting the browser navigate to a file.
      event.preventDefault();
      dataTransfer.dropEffect = "none";
    }
    return receiver !== null && receiver === dropAnchor.current && receiver.isConnected;
  };
  const onDragEnter = (event) => {
    const dataTransfer = fileTransfer(event);
    if (dataTransfer === null) return;
    if (!owns(event, dataTransfer) || event.defaultPrevented) { reset(); return; }
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const onDragOver = (event) => {
    const dataTransfer = fileTransfer(event);
    if (dataTransfer === null) return;
    if (!owns(event, dataTransfer) || event.defaultPrevented) { reset(); return; }
    event.preventDefault();
    dataTransfer.dropEffect = canAcceptDrop ? "copy" : "none";
    dragDepth.current = Math.max(1, dragDepth.current);
    setDragActive(true);
  };
  const onDragLeave = (event) => {
    if (fileTransfer(event) === null) return;
    const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
    if ((event.target === document.documentElement || event.target === document.body) && leftViewport) { reset(); return; }
    // A's dragleave can arrive after B's dragenter; it must not clear B's overlay.
    if (receiverFor(event) !== dropAnchor.current) return;
    if (event.relatedTarget != null && regionFor(event.relatedTarget) !== regionFor(dropAnchor.current)) { reset(); return; }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (event) => {
    // Cleanup is unconditional, including a capture-phase veto or another receiver.
    reset();
    const dataTransfer = fileTransfer(event);
    if (dataTransfer === null || !owns(event, dataTransfer) || event.defaultPrevented) return;
    event.preventDefault();
    if (canAcceptDrop) {
      const files = [...dataTransfer.files];
      onAddFiles(files, droppedDirectories(dataTransfer, files));
    }
  };
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  window.addEventListener("dragend", reset);
  return () => {
    document.removeEventListener("dragenter", onDragEnter);
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("dragleave", onDragLeave);
    document.removeEventListener("drop", onDrop);
    window.removeEventListener("dragend", reset);
    reset();
  };
}
`)

export const attachmentRoutingEdits = [
  {
    id: 'P-3d', pkg: 'dsh-client-ui-attachment', file: 'lib/client.js',
    find: previous, replace: routed,
    why: '文件拖放按实际 conversation DOM 目标选唯一 Composer；非焦点、监听顺序、嵌套子会话不改变收件人；外部/歧义目标拒收，veto/离开/卸载清理覆盖层',
  },
  {
    id: 'P-3e', pkg: 'dsh-client-ui-attachment', file: 'lib/client.js',
    find: '\t\t\tconst dragDepth = (0, react.useRef)(0);',
    replace: '\t\t\tconst dragDepth = (0, react.useRef)(0);\n\t\t\tconst dropAnchor = (0, react.useRef)(null);',
    why: '每个原生 Composer 持有独立 DOM 锚点，保留原 onAddFiles 与目录识别链',
  },
  {
    id: 'P-3f', pkg: 'dsh-client-ui-attachment', file: 'lib/client.js',
    find: 'return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive);',
    replace: 'return installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive, dropAnchor);',
    why: '原生 Composer 的监听器绑定到自身 DOM 实例，不读取全局焦点',
  },
  {
    id: 'P-3g', pkg: 'dsh-client-ui-attachment', file: 'lib/client.js',
    find: '\t\t\treturn (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n\t\t\t\tdragActive &&',
    replace: '\t\t\treturn (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [\n\t\t\t\t(0, react_jsx_runtime.jsx)("span", { ref: dropAnchor, "data-dsh-attachment-drop-anchor": "", "aria-hidden": true, style: { display: "none" } }),\n\t\t\t\tdragActive &&',
    why: '在真实 conversation 子树放置零布局锚点；DropOverlay 保持原生外观和单窗行为',
  },
]
