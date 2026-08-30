// Office 高保真预览容器：加载主进程 OfficeCLI 渲染出的临时 HTML
// （lume-file:// html-directory 作用域 + 严格 CSP）。样式对齐 Proma 的
// .office-preview-iframe：满视口、灰底画布（officecli 文档版式自带同色 body），
// 滚动完全交给 iframe 内文档本身。
// 协议层注入的链接拦截桥会阻止 iframe 内导航；外部链接打开暂不接线，点击无效果。
export function RightPanelOfficePreview({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block h-full w-full min-h-0 border-0 bg-[#f0f0f0]"
      title={title}
    />
  )
}
