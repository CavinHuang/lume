export function createCursorUpdateScript(x: number, y: number, pulse: boolean): string {
  return `(function updateCursor(x,y,pulse){const el=document.getElementById("cursor");if(!el)throw new Error("cursor_missing");el.style.left=String(x)+"px";el.style.top=String(y)+"px";el.classList.toggle("pulse",pulse);if(pulse)requestAnimationFrame(()=>el.classList.remove("pulse"));})(${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(pulse)})`
}
