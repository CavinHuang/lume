import { parseModule } from "meriyah";
import { redactDiagnosticSource } from "./diagnostics.js";
export function parseCell(source) {
    try {
        return parseModule(source, {
            next: true,
            module: true,
            ranges: true,
            loc: false,
            disableWebCompat: true,
        });
    }
    catch (error) {
        if (error && typeof error === "object" && "message" in error) {
            throw new SyntaxError(String(error.message));
        }
        throw error;
    }
}
export function collectBindings(ast) {
    const bindings = new Map();
    for (const statement of ast.body ?? []) {
        if (statement.type === "VariableDeclaration") {
            for (const declaration of statement.declarations ?? []) {
                collectPatternNames(declaration.id, statement.kind, bindings);
            }
            continue;
        }
        if (statement.type === "FunctionDeclaration" && statement.id?.name) {
            bindings.set(statement.id.name, "function");
            continue;
        }
        if (statement.type === "ClassDeclaration" && statement.id?.name) {
            bindings.set(statement.id.name, "class");
            continue;
        }
        if (statement.type === "ForStatement" && statement.init?.type === "VariableDeclaration" && statement.init.kind === "var") {
            for (const declaration of statement.init.declarations ?? [])
                collectPatternNames(declaration.id, "var", bindings);
            continue;
        }
        if ((statement.type === "ForInStatement" || statement.type === "ForOfStatement") && statement.left?.type === "VariableDeclaration" && statement.left.kind === "var") {
            for (const declaration of statement.left.declarations ?? [])
                collectPatternNames(declaration.id, "var", bindings);
        }
    }
    return [...bindings].map(([name, kind]) => ({ name, kind }));
}
export function buildCellSource(code, priorBindings, options) {
    const diagnosticTokens = [];
    const diagnosticComments = [];
    let ast;
    try {
        ast = parseModule(code, {
            next: true,
            module: true,
            ranges: true,
            loc: false,
            disableWebCompat: true,
            onToken: diagnosticTokens,
            onComment(_kind, _value, start, end) {
                diagnosticComments.push({ start, end });
            },
        });
    }
    catch (error) {
        if (error && typeof error === "object" && "message" in error)
            throw new SyntaxError(String(error.message));
        throw error;
    }
    const currentBindings = collectBindings(ast);
    const markName = internalName("mark", options);
    const preludeDoneName = internalName("prelude", options);
    const helperDeclarations = [
        `const ${markName} = import.meta.__lumeMarkCommittedBindings;`,
        `const ${preludeDoneName} = import.meta.__lumeMarkPreludeCompleted;`,
        "delete import.meta.__lumeMarkCommittedBindings;",
        "delete import.meta.__lumeMarkPreludeCompleted;",
    ];
    const futureWriteReplacements = collectFutureVarWriteReplacements(code, ast, markName, helperDeclarations, options);
    const writeInstrumented = applyReplacements(code, futureWriteReplacements);
    const instrumentedAst = parseCell(writeInstrumented);
    const declarationReplacements = collectDeclarationReplacements(writeInstrumented, instrumentedAst, markName, options);
    const instrumentedCode = applyReplacements(writeInstrumented, declarationReplacements);
    let prelude = "";
    if (priorBindings.length > 0) {
        prelude += 'import * as __lumePrev from "@prev";\n';
        for (const binding of priorBindings) {
            const keyword = binding.kind === "var" ? "var" : binding.kind === "const" ? "const" : "let";
            prelude += `${keyword} ${binding.name} = __lumePrev.${binding.name};\n`;
        }
    }
    prelude += `${helperDeclarations.join("\n")}\n${preludeDoneName}();\n`;
    const merged = new Map();
    for (const binding of priorBindings)
        merged.set(binding.name, binding.kind);
    for (const binding of currentBindings)
        merged.set(binding.name, binding.kind);
    const nextBindings = [...merged].map(([name, kind]) => ({ name, kind }));
    const exportStatement = nextBindings.length > 0 ? `\nexport { ${nextBindings.map((binding) => binding.name).join(", ")} };` : "";
    return {
        source: `${prelude}${instrumentedCode}${exportStatement}`,
        redactedSource: redactDiagnosticSource(code, ast, currentBindings, priorBindings, diagnosticTokens, diagnosticComments, collectPatternBindingNames),
        currentBindings,
        nextBindings,
        priorBindings,
    };
}
function collectDeclarationReplacements(code, ast, markName, options) {
    const replacements = [];
    for (const statement of ast.body ?? []) {
        if (statement.type === "VariableDeclaration") {
            replacements.push({ start: statement.start, end: statement.end, text: instrumentVariableDeclaration(code, statement, markName, options) });
            continue;
        }
        if (statement.type === "FunctionDeclaration" && statement.id?.name) {
            replacements.push({
                start: statement.start,
                end: statement.end,
                text: `${code.slice(statement.start, statement.end)}\n${markName}(${JSON.stringify(statement.id.name)});`,
            });
            continue;
        }
        if (statement.type === "ClassDeclaration" && statement.id?.name) {
            replacements.push({
                start: statement.start,
                end: statement.end,
                text: `${code.slice(statement.start, statement.end)}\n${markName}(${JSON.stringify(statement.id.name)});`,
            });
            continue;
        }
        if (statement.type === "ForStatement" && statement.init?.type === "VariableDeclaration" && statement.init.kind === "var") {
            replacements.push({
                start: statement.init.start,
                end: statement.init.end,
                text: instrumentVariableDeclaration(code, statement.init, markName, options),
            });
            continue;
        }
        if ((statement.type === "ForInStatement" || statement.type === "ForOfStatement") && statement.left?.type === "VariableDeclaration" && statement.left.kind === "var") {
            const names = statement.left.declarations.flatMap((declaration) => collectPatternBindingNames(declaration.id));
            if (names.length === 0)
                continue;
            const guard = internalName("loop", options);
            const marker = `if (${guard}) { ${guard} = false; ${markName}(${names.map((name) => JSON.stringify(name)).join(", ")}); }`;
            const body = code.slice(statement.body.start, statement.body.end);
            const instrumentedBody = statement.body.type === "BlockStatement"
                ? `{ ${marker}${body.slice(1)}`
                : `{ ${marker} ${body} }`;
            replacements.push({
                start: statement.start,
                end: statement.end,
                text: `let ${guard} = true;\n${code.slice(statement.start, statement.body.start)}${instrumentedBody}`,
            });
        }
    }
    return replacements;
}
function instrumentVariableDeclaration(code, declaration, markName, options) {
    const declarations = declaration.declarations ?? [];
    if (declarations.length === 0)
        return code.slice(declaration.start, declaration.end);
    const prefix = code.slice(declaration.start, declarations[0].start);
    const suffix = code.slice(declarations.at(-1).end, declaration.end);
    const parts = [];
    for (const item of declarations) {
        parts.push(code.slice(item.start, item.end));
        const names = collectPatternBindingNames(item.id);
        if (names.length > 0) {
            const helper = internalName("commit", options);
            parts.push(`${helper} = (${markName}(${names.map((name) => JSON.stringify(name)).join(", ")}), undefined)`);
        }
    }
    return `${prefix}${parts.join(", ")}${suffix}`;
}
function collectFutureVarWriteReplacements(code, ast, markName, helperDeclarations, options) {
    const declarationStarts = new Map();
    for (const statement of ast.body ?? []) {
        const declarations = statement.type === "VariableDeclaration" && statement.kind === "var"
            ? statement.declarations ?? []
            : statement.type === "ForStatement" && statement.init?.type === "VariableDeclaration" && statement.init.kind === "var"
                ? statement.init.declarations ?? []
                : (statement.type === "ForInStatement" || statement.type === "ForOfStatement") && statement.left?.type === "VariableDeclaration" && statement.left.kind === "var"
                    ? statement.left.declarations ?? []
                    : [];
        for (const declaration of declarations) {
            for (const name of collectPatternBindingNames(declaration.id)) {
                const current = declarationStarts.get(name);
                if (current === undefined || declaration.start < current)
                    declarationStarts.set(name, declaration.start);
            }
        }
    }
    if (declarationStarts.size === 0)
        return [];
    const replacements = [];
    for (const statement of ast.body ?? []) {
        if (statement.type !== "ExpressionStatement")
            continue;
        const expression = statement.expression;
        if (expression.type === "AssignmentExpression" && expression.left?.type === "Identifier") {
            const declarationStart = declarationStarts.get(expression.left.name);
            if (declarationStart === undefined || expression.left.start >= declarationStart)
                continue;
            if (["&&=", "||=", "??="].includes(expression.operator))
                continue;
            const helper = internalName("write", options);
            helperDeclarations.push(`let ${helper};`);
            replacements.push({
                start: expression.start,
                end: expression.end,
                text: `(${helper} = (${code.slice(expression.start, expression.end)}), ${markName}(${JSON.stringify(expression.left.name)}), ${helper})`,
            });
            continue;
        }
        if (expression.type === "UpdateExpression" && expression.argument?.type === "Identifier") {
            const declarationStart = declarationStarts.get(expression.argument.name);
            if (declarationStart === undefined || expression.argument.start >= declarationStart)
                continue;
            const helper = internalName("write", options);
            helperDeclarations.push(`let ${helper};`);
            replacements.push({
                start: expression.start,
                end: expression.end,
                text: `(${helper} = (${code.slice(expression.start, expression.end)}), ${markName}(${JSON.stringify(expression.argument.name)}), ${helper})`,
            });
        }
    }
    return replacements;
}
function collectPatternNames(pattern, kind, target) {
    if (!pattern)
        return;
    if (pattern.type === "Identifier") {
        if (!target.has(pattern.name))
            target.set(pattern.name, kind);
        return;
    }
    if (pattern.type === "RestElement")
        return collectPatternNames(pattern.argument, kind, target);
    if (pattern.type === "AssignmentPattern")
        return collectPatternNames(pattern.left, kind, target);
    if (pattern.type === "ArrayPattern") {
        for (const element of pattern.elements ?? [])
            collectPatternNames(element, kind, target);
        return;
    }
    if (pattern.type === "ObjectPattern") {
        for (const property of pattern.properties ?? []) {
            if (property.type === "RestElement")
                collectPatternNames(property.argument, kind, target);
            else
                collectPatternNames(property.value, kind, target);
        }
    }
}
function collectPatternBindingNames(pattern) {
    const target = new Map();
    collectPatternNames(pattern, "let", target);
    return [...target.keys()];
}
function applyReplacements(source, replacements) {
    let result = source;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    }
    return result;
}
function internalName(label, options) {
    return `__lume_internal_${label}_${options.salt}_${options.nextInternalId()}`;
}
//# sourceMappingURL=cell-source.js.map