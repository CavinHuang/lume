import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { HighlightedCode } from './highlighted-code';
/** 从文件路径推断语言 */
function inferLanguage(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map = {
        ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
        java: 'java', kt: 'kotlin', swift: 'swift',
        c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
        cs: 'csharp', php: 'php', lua: 'lua',
        sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
        json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
        xml: 'xml', html: 'html', css: 'css', scss: 'scss',
        sql: 'sql', md: 'markdown', graphql: 'graphql',
        dockerfile: 'docker', tf: 'terraform',
    };
    return map[ext] ?? 'text';
}
export function ReadResult({ input, result }) {
    const content = result?.content ?? String(result ?? '');
    const filePath = String(input.file_path ?? '');
    const language = inferLanguage(filePath);
    return (_jsxs("div", { className: "rounded-lg overflow-hidden", children: [_jsx("div", { className: "px-3 py-1.5 text-[11px] text-foreground/50 bg-muted/40 font-mono truncate", children: filePath }), _jsx(HighlightedCode, { code: String(content), language: language, showLineNumbers: true, maxLines: 30 })] }));
}
