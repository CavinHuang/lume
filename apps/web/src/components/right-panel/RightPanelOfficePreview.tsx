// Office 高保真预览容器：加载主进程 OfficeCLI 渲染出的临时 HTML
// （lume-file:// html-directory 作用域 + 严格 CSP）。文档滚动由 iframe 内部处理。
// 协议层注入的链接拦截桥会阻止 iframe 内导航；外部链接打开暂不接线，点击无效果。
export function RightPanelOfficePreview({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
      title={title}
    />
  )
}
