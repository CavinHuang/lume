const MAX_REDACTED_SOURCE_LENGTH = 16_384;
export function redactDiagnosticSource(code, ast, currentBindings, priorBindings, tokens, comments, collectPatternNames) {
    const bindingNames = collectBindingNames(ast, currentBindings, priorBindings, collectPatternNames);
    const redactedIdentifierStarts = collectIdentifierStarts(ast, bindingNames);
    const identifierAliases = new Map();
    const replacements = [];
    const aliasFor = (raw) => {
        const normalized = raw.startsWith("#") ? raw.slice(1) : raw;
        let alias = identifierAliases.get(normalized);
        if (!alias) {
            alias = `id${identifierAliases.size}`;
            identifierAliases.set(normalized, alias);
        }
        return raw.startsWith("#") ? `#${alias}` : alias;
    };
    for (const token of tokens) {
        const raw = code.slice(token.start, token.end);
        if (token.token === "Identifier" && redactedIdentifierStarts.has(token.start)) {
            replacements.push({ start: token.start, end: token.end, text: aliasFor(raw) });
        }
        else if (token.token === "StringLiteral") {
            replacements.push({ start: token.start, end: token.end, text: '""' });
        }
        else if (token.token === "TemplateLiteral") {
            replacements.push({ start: token.start, end: token.end, text: redactTemplateChunk(raw) });
        }
        else if (token.token === "RegularExpression") {
            replacements.push({ start: token.start, end: token.end, text: "/(?:)/" });
        }
    }
    for (const comment of comments) {
        replacements.push({ start: comment.start, end: comment.end, text: "/* */" });
    }
    const redacted = applyReplacements(code, replacements);
    return redacted.length <= MAX_REDACTED_SOURCE_LENGTH
        ? redacted
        : `${redacted.slice(0, MAX_REDACTED_SOURCE_LENGTH)}\n/* truncated */`;
}
function redactTemplateChunk(raw) {
    if (raw.startsWith("`"))
        return raw.endsWith("${") ? "`${" : "``";
    return raw.endsWith("${") ? "}${" : "}`";
}
function collectBindingNames(ast, currentBindings, priorBindings, collectPatternNames) {
    const names = new Set([...currentBindings, ...priorBindings].map((binding) => binding.name));
    const addPattern = (pattern) => {
        for (const name of collectPatternNames(pattern))
            names.add(name);
    };
    walk(ast, (node) => {
        switch (node.type) {
            case "VariableDeclaration":
                for (const declaration of node.declarations ?? [])
                    addPattern(declaration.id);
                break;
            case "FunctionDeclaration":
            case "FunctionExpression":
                if (node.id?.name)
                    names.add(node.id.name);
                for (const parameter of node.params ?? [])
                    addPattern(parameter);
                break;
            case "ArrowFunctionExpression":
                for (const parameter of node.params ?? [])
                    addPattern(parameter);
                break;
            case "ClassDeclaration":
            case "ClassExpression":
                if (node.id?.name)
                    names.add(node.id.name);
                break;
            case "CatchClause":
                if (node.param)
                    addPattern(node.param);
                break;
            default:
                break;
        }
    });
    return names;
}
function collectIdentifierStarts(ast, bindingNames) {
    const starts = new Set();
    walkWithParent(ast, null, null, (node, parent, key) => {
        if (node.type !== "Identifier" || !bindingNames.has(node.name))
            return;
        const isPlainMemberProperty = parent?.type === "MemberExpression" && key === "property" && parent.computed !== true;
        const isPlainPropertyKey = (parent?.type === "Property" || parent?.type === "MethodDefinition")
            && key === "key" && parent.computed !== true && parent.shorthand !== true;
        if (!isPlainMemberProperty && !isPlainPropertyKey)
            starts.add(node.start);
    });
    return starts;
}
function walk(node, visit) {
    if (!node || typeof node !== "object")
        return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value)
                walk(child, visit);
        }
        else if (value && typeof value === "object" && "type" in value) {
            walk(value, visit);
        }
    }
}
function walkWithParent(node, parent, key, visit) {
    if (!node || typeof node !== "object")
        return;
    visit(node, parent, key);
    for (const [childKey, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
            for (const child of value)
                walkWithParent(child, node, childKey, visit);
        }
        else if (value && typeof value === "object" && "type" in value) {
            walkWithParent(value, node, childKey, visit);
        }
    }
}
function applyReplacements(source, replacements) {
    let result = source;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    }
    return result;
}
//# sourceMappingURL=diagnostics.js.map