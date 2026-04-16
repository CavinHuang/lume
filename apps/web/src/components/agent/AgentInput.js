import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { Send, Square, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { agentSend } from '@/lib/desktop-api';
import { openFileDialog, sidecarCall } from '@/lib/desktop-api';
import { MentionList } from './MentionList';
/** 获取各类 mention 的建议列表 */
async function fetchSuggestions(trigger, query, threadId) {
    try {
        if (trigger === '@') {
            const result = await sidecarCall('agent:list-directory', { threadId, path: '.' });
            const entries = result?.entries ?? [];
            return entries
                .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map((e) => ({ id: e.name, label: e.name, type: 'file' }));
        }
        if (trigger === '/') {
            const builtinSkills = [
                { id: 'commit', label: 'commit' },
                { id: 'review', label: 'review' },
                { id: 'test', label: 'test' },
                { id: 'debug', label: 'debug' },
                { id: 'simplify', label: 'simplify' },
            ];
            return builtinSkills
                .filter((s) => s.label.toLowerCase().includes(query.toLowerCase()))
                .map((s) => ({ ...s, type: 'skill' }));
        }
        if (trigger === '#') {
            const result = await sidecarCall('system:get-mcp-config', {});
            const servers = result?.servers ?? [];
            return servers
                .filter((s) => s.enabled && s.name.toLowerCase().includes(query.toLowerCase()))
                .slice(0, 10)
                .map((s) => ({ id: s.name, label: s.name, type: 'mcp' }));
        }
    }
    catch {
        // 静默
    }
    return [];
}
/** 用 DOM 定位的浮动面板渲染 mention 建议 */
function createSuggestionRenderer(trigger, threadId, char) {
    return {
        char,
        items: ({ query }) => fetchSuggestions(trigger, query, threadId),
        render: () => {
            let component = null;
            let wrapper = null;
            return {
                onStart: (props) => {
                    wrapper = document.createElement('div');
                    wrapper.style.position = 'fixed';
                    wrapper.style.zIndex = '9999';
                    document.body.appendChild(wrapper);
                    component = new ReactRenderer(MentionList, {
                        props,
                        editor: props.editor,
                    });
                    wrapper.appendChild(component.element);
                    updatePosition(wrapper, props);
                },
                onUpdate: (props) => {
                    component?.updateProps(props);
                    if (wrapper)
                        updatePosition(wrapper, props);
                },
                onKeyDown: (props) => {
                    if (props.event.key === 'Escape') {
                        wrapper?.remove();
                        return true;
                    }
                    return component?.ref?.onKeyDown(props) ?? false;
                },
                onExit: () => {
                    component?.destroy();
                    wrapper?.remove();
                },
            };
        },
    };
}
function updatePosition(wrapper, props) {
    const rect = props.clientRect?.();
    if (!rect)
        return;
    // 面板显示在光标上方
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    wrapper.style.top = 'auto';
}
export function AgentInput({ threadId, disabled }) {
    const editor = useEditor({
        extensions: [
            StarterKit.configure({ undoRedo: false }),
            Placeholder.configure({ placeholder: '输入任务... 支持 @文件 /Skill #MCP' }),
            Mention.configure({
                HTMLAttributes: {
                    class: 'mention bg-blue-500/10 text-blue-600 dark:text-blue-400 px-0.5 rounded font-medium text-[13px]',
                },
                suggestion: createSuggestionRenderer('@', threadId, '@'),
            }),
            Mention.extend({ name: 'skillMention' }).configure({
                HTMLAttributes: {
                    class: 'mention bg-orange-500/10 text-orange-600 dark:text-orange-400 px-0.5 rounded font-medium text-[13px]',
                },
                suggestion: createSuggestionRenderer('/', threadId, '/'),
            }),
            Mention.extend({ name: 'mcpMention' }).configure({
                HTMLAttributes: {
                    class: 'mention bg-purple-500/10 text-purple-600 dark:text-purple-400 px-0.5 rounded font-medium text-[13px]',
                },
                suggestion: createSuggestionRenderer('#', threadId, '#'),
            }),
        ],
        editorProps: {
            attributes: { class: 'outline-none min-h-[24px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
            handleKeyDown(_, event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                    return true;
                }
                return false;
            },
        },
    });
    const handleSend = async () => {
        if (!editor || disabled)
            return;
        const text = editor.getText().trim();
        if (!text)
            return;
        editor.commands.clearContent();
        await agentSend({ threadId, userMessage: text });
    };
    const handleStop = async () => {
        try {
            await sidecarCall('agent:stop-thread', { threadId });
        }
        catch (error) {
            console.error('[AgentInput] 停止失败:', error);
        }
    };
    const handleAttach = async () => {
        try {
            const result = await openFileDialog();
            if (result.files.length === 0)
                return;
            await sidecarCall('agent:save-files-to-thread', {
                threadId,
                files: result.files.map((f) => ({
                    filename: f.filename,
                    sourcePath: f.sourcePath,
                })),
            });
            toast.success(`已添加 ${result.files.length} 个文件`);
        }
        catch (error) {
            console.error('[AgentInput] 文件上传失败:', error);
            toast.error('文件上传失败');
        }
    };
    return (_jsx("div", { className: "px-4 pb-4 pt-2", children: _jsxs("div", { className: cn('rounded-2xl border border-border/60 bg-background shadow-sm transition-colors', disabled && 'opacity-60'), children: [_jsx("div", { className: "px-4 py-3", children: _jsx(EditorContent, { editor: editor }) }), _jsxs("div", { className: "flex items-center justify-between px-3 pb-2", children: [_jsx("button", { onClick: handleAttach, className: "p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors", title: "\u9644\u52A0\u6587\u4EF6", children: _jsx(Paperclip, { size: 15 }) }), disabled ? (_jsx("button", { onClick: handleStop, className: "p-1.5 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors", title: "\u505C\u6B62", children: _jsx(Square, { size: 14 }) })) : (_jsx("button", { onClick: handleSend, className: "p-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity", title: "\u53D1\u9001", children: _jsx(Send, { size: 14 }) }))] })] }) }));
}
