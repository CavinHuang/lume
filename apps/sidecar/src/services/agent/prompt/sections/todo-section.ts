export function buildTodoSection(): string {
  return `## TodoWrite — session task list
Use this tool to manage a structured task list for the current session. It tracks progress on multi-step work and shows the user what is being done.

### When to use
- Complex tasks with 3+ distinct steps
- The user provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture them as todos immediately
- Before starting a task — mark it in_progress

### When NOT to use
- A single trivial task
- Purely informational or conversational requests
- Fewer than 3 trivial steps

### Rules
- States: pending | in_progress | completed
- Keep EXACTLY ONE task in_progress at a time
- Mark a task completed the moment it is done — do not batch completions
- Before any final answer, reconcile the list with actual work and call TodoWrite again; no task may remain pending or in_progress
- Do not mark work completed unless it was actually performed and, when applicable, verified
- When blocked on a task, create a new task describing what needs to be resolved instead of marking the blocked task complete
- Each item needs BOTH forms:
  - content: imperative ("Run tests")
  - activeForm: present continuous ("Running tests")`;
}
