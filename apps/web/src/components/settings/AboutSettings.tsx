/**
 * AboutSettings - 关于页面
 *
 * 显示应用版本号、运行时信息、开源协议等基本信息。
 */

import { ExternalLink } from 'lucide-react'
import { openExternal } from '@/lib/desktop-api'
import { Separator } from '@/components/ui/separator'
import { APP_VERSION } from '@/lib/app-version'

const GITHUB_URL = 'https://github.com/anthropics/lume'

export function AboutSettings() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold">关于 Lume</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">开源 AI Agent 桌面客户端</p>
      </div>

      {/* 基本信息 */}
      <div className="rounded-xl border divide-y">
        <InfoRow label="版本" value={<span className="font-mono">{APP_VERSION}</span>} />
        <InfoRow label="运行时" value="Electron 42 + React" />
        <InfoRow label="开源协议" value="MIT" />
        <InfoRow
          label="项目地址"
          value={
            <button
              onClick={() => openExternal(GITHUB_URL)}
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              GitHub
              <ExternalLink size={11} />
            </button>
          }
        />
      </div>

      <Separator />

      {/* 技术栈 */}
      <div>
        <h3 className="text-[13px] font-medium mb-3">技术栈</h3>
        <div className="grid grid-cols-2 gap-2">
          {[
            { name: 'Electron', desc: '桌面框架' },
            { name: 'React', desc: 'UI 框架' },
            { name: 'TypeScript', desc: '类型系统' },
            { name: 'Tailwind CSS', desc: '样式方案' },
            { name: 'Jotai', desc: '状态管理' },
            { name: 'shadcn/ui', desc: '组件库' },
          ].map((tech) => (
            <div key={tech.name} className="px-3 py-2 rounded-lg bg-muted/30 text-[12px]">
              <span className="font-medium text-foreground/80">{tech.name}</span>
              <span className="text-muted-foreground/60 ml-1.5">{tech.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      {/* 致谢 */}
      <div className="text-[12px] text-muted-foreground/60 text-center py-4">
        Made with Lume Agent SDK
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
  )
}
