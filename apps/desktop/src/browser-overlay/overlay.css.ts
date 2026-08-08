// overlay Shadow DOM 内样式（对齐 Codex comment-preload CSS）。
// 主色 #128dff；marker pin 编号样式；后续 plan 补 interaction-layer/highlight/editor 等。
export const overlayStyles = `
:host{all:initial;--annotation-accent:#128dff;--browser-sidebar-saved-marker-size:24px;--browser-sidebar-draft-marker-size:24px;--browser-sidebar-marker-label-offset:0px}
*{box-sizing:border-box}
.markers-layer{position:fixed;inset:0;z-index:1;pointer-events:none;font:12px system-ui,-apple-system,sans-serif;color:#fff}
.marker{position:fixed;transform:translate(-50%,-50%);pointer-events:auto;width:var(--browser-sidebar-saved-marker-size);height:var(--browser-sidebar-saved-marker-size);border-radius:999px;border:2px solid #fff;background:var(--annotation-accent);color:#fff;box-shadow:0 3px 12px #0006;display:flex;align-items:center;justify-content:center;font-weight:700;cursor:pointer}
.marker[data-selected="true"]{transform:translate(-50%,-50%) scale(1.08)}
.marker-label{color:#fff;font-weight:700}
.saved-marker{width:var(--browser-sidebar-saved-marker-size);height:var(--browser-sidebar-saved-marker-size)}
.draft-marker{width:var(--browser-sidebar-draft-marker-size);height:var(--browser-sidebar-draft-marker-size);border-style:dashed}
.annotation-box{position:fixed;border:2px solid var(--annotation-accent);border-radius:3px;background:color-mix(in srgb,var(--annotation-accent) 9%,transparent);box-shadow:0 0 0 1px #fff6 inset;pointer-events:none}
.interaction-layer{position:fixed;inset:0;z-index:1;pointer-events:none}
.selection{position:fixed;border:2px solid var(--annotation-accent);border-radius:3px;background:color-mix(in srgb,var(--annotation-accent) 9%,transparent);box-shadow:0 0 0 1px #fff6 inset;pointer-events:none}
.cursor-badge{position:fixed;display:flex;width:28px;height:28px;align-items:center;justify-content:center;border:2px solid #fff;border-radius:999px;background:var(--annotation-accent);color:#fff;box-shadow:0 5px 15px #0004;pointer-events:none}
.cursor-badge svg{width:15px;height:15px;fill:currentColor}
.preview{position:fixed;max-width:300px;padding:8px 10px;border:1px solid #ffffff33;border-radius:9px;background:#17181c;color:#f5f5f5;box-shadow:0 10px 30px #0005;pointer-events:auto;white-space:pre-wrap;line-height:1.45}
.region-box{position:fixed;border:2px dashed var(--annotation-accent);background:color-mix(in srgb,var(--annotation-accent) 3%,transparent);pointer-events:none}
.editor-card{position:fixed;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #ffffff33;border-radius:10px;background:#17181c;color:#f5f5f5;box-shadow:0 12px 32px #0006;pointer-events:auto;min-width:240px;z-index:3}
.editor-input{background:transparent;border:0;color:#f5f5f5;font:13px system-ui,-apple-system,sans-serif;outline:none;padding:4px 2px;min-width:200px}
.editor-actions{display:flex;gap:6px;align-items:center}
.editor-btn{background:#ffffff1a;border:0;border-radius:6px;color:#f5f5f5;cursor:pointer;font:12px system-ui,sans-serif;padding:4px 10px}
.editor-btn:disabled{opacity:.4;cursor:default}
.editor-delete{color:#f87171}
.design-editor{position:fixed;display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid #ffffff33;border-radius:10px;background:#17181c;color:#f5f5f5;box-shadow:0 12px 32px #0006;pointer-events:auto;min-width:280px;max-height:60vh;z-index:3}
.design-editor-header{display:flex;align-items:center;gap:6px;justify-content:space-between}
.design-editor-title{font-weight:600;font-size:13px}
.design-editor-hold{background:#ffffff1a;border:0;border-radius:6px;color:#f5f5f5;cursor:pointer;font:11px system-ui;padding:4px 8px}
.design-editor-delete{background:0;border:0;color:#f87171;cursor:pointer;font:11px system-ui}
.design-editor-body{display:flex;flex-direction:column;gap:6px;overflow-y:auto}
.design-section{display:flex;flex-direction:column;gap:2px;font-size:12px}
.design-section-fields{display:flex;flex-wrap:wrap;gap:4px}
.design-label{color:#aaa;font-size:11px;margin-right:2px}
.decl-row{display:inline-flex;align-items:center;gap:2px}
.decl-color{width:24px;height:24px;padding:0;border:0;background:0}
.decl-color-text,.decl-text,.decl-number{background:#ffffff0d;border:1px solid #ffffff26;border-radius:4px;color:#f5f5f5;font:12px system-ui;padding:3px 4px;width:70px}
.decl-unit{color:#aaa;font-size:11px}
.design-editor-comment{background:#ffffff0d;border:1px solid #ffffff26;border-radius:6px;color:#f5f5f5;font:12px system-ui;padding:6px}
.design-editor-submit{background:var(--annotation-accent);border:0;border-radius:6px;color:#fff;cursor:pointer;font:600 12px system-ui;padding:6px}
.design-lock-btn{background:#ffffff1a;border:1px solid #ffffff26;border-radius:4px;color:#aaa;cursor:pointer;font:10px system-ui;padding:2px 6px}
.design-lock-btn[data-locked="true"]{color:#fff;background:color-mix(in srgb,var(--annotation-accent) 30%,transparent);border-color:var(--annotation-accent)}
[data-scrub-value-cell="true"]{outline:2px solid var(--annotation-accent);outline-offset:1px;border-radius:4px}
[data-peer="true"]{outline:2px dashed var(--annotation-accent);outline-offset:1px;border-radius:4px}
`
