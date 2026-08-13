export function locatorAst(...steps) {
    return { version: 1, steps };
}
export function appendLocator(ast, step) {
    return { version: 1, steps: [...ast.steps, step] };
}
