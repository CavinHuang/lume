import { jsx as _jsx } from "react/jsx-runtime";
import { BashResult } from './bash-result';
import { ReadResult } from './read-result';
import { EditResult } from './edit-result';
import { WriteResult } from './write-result';
import { GrepResult } from './grep-result';
import { GlobResult } from './glob-result';
import { WebSearchResult } from './web-search-result';
import { WebFetchResult } from './web-fetch-result';
import { DefaultResult } from './default-result';
export function ToolResultRenderer({ toolName, input, result }) {
    switch (toolName) {
        case 'Bash': return _jsx(BashResult, { input: input, result: result });
        case 'Read': return _jsx(ReadResult, { input: input, result: result });
        case 'Edit': return _jsx(EditResult, { input: input, result: result });
        case 'Write': return _jsx(WriteResult, { input: input, result: result });
        case 'Grep': return _jsx(GrepResult, { input: input, result: result });
        case 'Glob': return _jsx(GlobResult, { input: input, result: result });
        case 'WebSearch': return _jsx(WebSearchResult, { input: input, result: result });
        case 'WebFetch': return _jsx(WebFetchResult, { input: input, result: result });
        default: return _jsx(DefaultResult, { toolName: toolName, input: input, result: result });
    }
}
