import type {
  ReadingBook,
  ReadingNote,
  ReadingNoteInput,
  ReadingQuoteEvidence,
  ReadingRunTaskInput,
  ReadingTaskResult,
  ReadingUserReadingContext
} from "@lume/shared";
import { hasReachedWeeklyDeepNoteLimit, selectNextReadingBook } from "./book-selection";
import {
  createReadingNote,
  ensureReadingBootstrapBook,
  getReadingSettings,
  listReadingBooks,
  listReadingNotes,
  recordReadingBookProgress
} from "./reading-store";
import { buildDeepReadingNoteInput, buildSeedReadingNoteInput } from "./reading-prompts";
import { generateReadingNoteDraft } from "./reading-note-generator";
import {
  createReadingNoteGeneratorLlm,
  type ReadingNoteGeneratorLlmAttempt
} from "./reading-llm-adapter";
import {
  collectReadingUserContext,
  createReadingContextToolRunner,
  type ReadingContextToolsDeps,
  type ReadingContextToolRunner
} from "./reading-context-tools";
import {
  collectReadingEvidence,
  mergeReadingEvidence
} from "./reading-evidence";
import { createLogger } from "../infra/logger";

const log = createLogger("reading");

export interface ReadingNoteGenerationContext {
  book: ReadingBook;
  depth: "seed" | "deep";
  evidence: ReadingQuoteEvidence[];
  userContext: ReadingUserReadingContext;
  existingNoteSummaries: string[];
  manualQuoteText?: string;
  manualSource?: string;
}

export interface RunReadingTaskAsyncOptions {
  generateNote?: (context: ReadingNoteGenerationContext) => Promise<Partial<ReadingNoteInput> | null | undefined> | Partial<ReadingNoteInput> | null | undefined;
  collectUserContext?: (input: { book: ReadingBook; input: ReadingRunTaskInput }) => Promise<ReadingUserReadingContext> | ReadingUserReadingContext;
  collectEvidence?: (input: { book: ReadingBook; input: ReadingRunTaskInput }) => Promise<ReadingQuoteEvidence[]> | ReadingQuoteEvidence[];
  contextTools?: ReadingContextToolsDeps;
  runTool?: ReadingContextToolRunner;
  createLlmAttempt?: (input: { book: ReadingBook; depth: "seed" | "deep"; input: ReadingRunTaskInput }) => ReadingNoteGeneratorLlmAttempt | null | undefined;
}

interface PreparedReadingTask {
  book: ReadingBook;
  depth: "seed" | "deep";
  completedAt: number;
}

export async function runReadingTaskAsync(input: ReadingRunTaskInput = {}, options: RunReadingTaskAsyncOptions = {}): Promise<ReadingTaskResult> {
  const prepared = prepareReadingTask(input);
  if ("result" in prepared) {
    log.info("读书任务跳过", { status: prepared.result.status, message: prepared.result.message });
    return prepared.result;
  }
  log.info("开始异步读书任务", { bookId: prepared.book.id, title: prepared.book.title, depth: prepared.depth });
  try {
    let fallbackInput = buildFallbackNoteInput(prepared);
    fallbackInput = await enrichFallbackEvidence(prepared.book, input, fallbackInput, options);
    const userContext = await collectTaskUserContext(prepared.book, input, options);
    const context = buildGenerationContext(prepared, { ...input, userContext }, fallbackInput);
    const llmAttempt = resolveReadingLlmAttempt(prepared, input, options);
    if (!options.generateNote && !llmAttempt) {
      log.warn("读书模型未配置", { bookId: prepared.book.id });
      return {
        status: "failed",
        bookId: prepared.book.id,
        message: "读书模型未配置，无法生成读书笔记",
        completedAt: prepared.completedAt
      };
    }
    const generatedInput = options.generateNote
      ? await options.generateNote(context)
      : null;
    if (generatedInput) {
      const result = createTaskNote(prepared, fallbackInput, generatedInput);
      log.info("异步读书任务完成(自定义生成)", { status: result.status, bookId: result.bookId, noteId: result.noteId });
      return result;
    }
    const draftResult = await generateReadingNoteDraft(context, {
      ...llmAttempt,
      runTool: options.runTool ?? createReadingContextToolRunner(resolveReadingContextTools(input, options))
    });
    if (!draftResult.ok) {
      log.warn("AI 读书笔记生成失败", { bookId: prepared.book.id, reason: draftResult.reason });
      return {
        status: "failed",
        bookId: prepared.book.id,
        message: draftResult.reason ?? "AI 读书笔记生成失败",
        completedAt: prepared.completedAt
      };
    }
    const result = createTaskNote(prepared, fallbackInput, draftResult.draft);
    log.info("异步读书任务完成", { status: result.status, bookId: result.bookId, noteId: result.noteId });
    return result;
  } catch (error) {
    log.error("异步读书任务失败", { bookId: prepared.book.id, error: error instanceof Error ? error.message : String(error) });
    return {
      status: "failed",
      bookId: prepared.book.id,
      message: error instanceof Error ? error.message : String(error),
      completedAt: prepared.completedAt
    };
  }
}

async function enrichFallbackEvidence(
  book: ReadingBook,
  input: ReadingRunTaskInput,
  fallbackInput: ReadingNoteInput,
  options: RunReadingTaskAsyncOptions
): Promise<ReadingNoteInput> {
  const collected = options.collectEvidence
    ? await options.collectEvidence({ book, input })
    : await collectReadingEvidence({
      book,
      manualQuoteText: input.manualQuoteText,
      manualSource: input.manualSource
    });
  const evidence = mergeReadingEvidence(collected, fallbackInput.evidence ?? []);
  if (evidence.length === (fallbackInput.evidence ?? []).length) return fallbackInput;
  return {
    ...fallbackInput,
    evidence,
    originalQuote: evidence[0]?.quote ?? fallbackInput.originalQuote,
    excerpt: evidence[0]?.excerpt ?? fallbackInput.excerpt
  };
}

function resolveReadingLlmAttempt(
  prepared: PreparedReadingTask,
  input: ReadingRunTaskInput,
  options: RunReadingTaskAsyncOptions
): ReadingNoteGeneratorLlmAttempt | undefined {
  if (options.createLlmAttempt) {
    return options.createLlmAttempt({
      book: prepared.book,
      depth: prepared.depth,
      input
    }) ?? undefined;
  }
  return createReadingNoteGeneratorLlm({
    depth: prepared.depth,
    ...(input.workspaceSlug?.trim() ? { workspaceSlug: input.workspaceSlug.trim() } : {})
  });
}

async function collectTaskUserContext(
  book: ReadingBook,
  input: ReadingRunTaskInput,
  options: RunReadingTaskAsyncOptions
): Promise<ReadingUserReadingContext> {
  if (options.collectUserContext) {
    return options.collectUserContext({ book, input });
  }
  return collectReadingUserContext({
    ...resolveReadingContextTools(input, options),
    book,
    input
  });
}

function resolveReadingContextTools(
  input: ReadingRunTaskInput,
  options: RunReadingTaskAsyncOptions
): ReadingContextToolsDeps {
  return {
    ...(options.contextTools ?? {}),
    ...(input.workspaceSlug?.trim() ? { workspaceSlug: input.workspaceSlug.trim() } : {})
  };
}


function prepareReadingTask(input: ReadingRunTaskInput): PreparedReadingTask | { result: ReadingTaskResult } {
  const completedAt = Date.now();
  ensureReadingBootstrapBook();
  const books = listReadingBooks();
  const book = selectNextReadingBook(books, input);
  if (!book) {
    return {
      result: {
        status: "skipped",
        message: "暂无可读书籍",
        completedAt
      }
    };
  }

  const depth = input.depth ?? "seed";
  if (depth === "deep") {
    const settings = getReadingSettings();
    const notes = listReadingNotes({ includeHidden: true }) as ReadingNote[];
    if (hasReachedWeeklyDeepNoteLimit(notes, completedAt, settings.maxDeepNotesPerWeek)) {
      return {
        result: {
          status: "skipped",
          bookId: book.id,
          message: "本周深度读书笔记已达上限",
          completedAt
        }
      };
    }
  }

  return { book, depth, completedAt };
}

function buildFallbackNoteInput(prepared: PreparedReadingTask): ReadingNoteInput {
  return prepared.depth === "deep"
    ? buildDeepReadingNoteInput(prepared.book)
    : buildSeedReadingNoteInput(prepared.book);
}

function buildGenerationContext(
  prepared: PreparedReadingTask,
  input: ReadingRunTaskInput,
  fallbackInput: ReadingNoteInput
): ReadingNoteGenerationContext {
  return {
    book: prepared.book,
    depth: prepared.depth,
    evidence: fallbackInput.evidence ?? [],
    userContext: input.userContext ?? {},
    existingNoteSummaries: listReadingNotes({ bookId: prepared.book.id, includeHidden: true })
      .map(formatExistingNoteForGeneration)
      .filter(Boolean),
    manualQuoteText: input.manualQuoteText,
    manualSource: input.manualSource
  };
}

function formatExistingNoteForGeneration(note: ReadingNote): string {
  return [
    `${note.title}: ${note.summary}`,
    note.originalQuote ? `quote：${note.originalQuote}` : undefined,
    note.tags.length ? `tags：${note.tags.join(", ")}` : undefined,
    note.selfContext ? `selfContext：${note.selfContext}` : undefined,
    note.nextPlan ? `nextPlan：${note.nextPlan}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" / ");
}

function createTaskNote(
  prepared: PreparedReadingTask,
  fallbackInput: ReadingNoteInput,
  generatedInput: Partial<ReadingNoteInput>
): ReadingTaskResult {
  const noteInput: ReadingNoteInput = {
    ...fallbackInput,
    ...generatedInput,
    bookId: prepared.book.id,
    depth: prepared.depth,
    body: generatedInput.body?.trim() || fallbackInput.body,
    summary: generatedInput.summary?.trim() || fallbackInput.summary,
    title: generatedInput.title?.trim() || fallbackInput.title,
    excerpt: generatedInput.excerpt?.trim() || fallbackInput.excerpt,
    evidence: generatedInput.evidence ?? fallbackInput.evidence,
    tags: generatedInput.tags?.length ? generatedInput.tags : fallbackInput.tags,
    originalQuote: generatedInput.originalQuote ?? fallbackInput.evidence?.[0]?.quote,
    progressPercent: generatedInput.progressPercent ?? fallbackInput.progressPercent
  };
  const duplicate = findDuplicateTaskNote(noteInput);
  if (duplicate) {
    return {
      status: "skipped",
      bookId: prepared.book.id,
      noteId: duplicate.id,
      message: "这条读书笔记已经写过",
      completedAt: prepared.completedAt
    };
  }
  const note = createReadingNote(noteInput);
  recordReadingBookProgress({
    bookId: prepared.book.id,
    readAt: prepared.completedAt,
    progressPercent: noteInput.progressPercent
  });
  return {
    status: "completed",
    bookId: prepared.book.id,
    noteId: note.id,
    message: prepared.depth === "deep" ? "已写下深度读书笔记" : "已写下读书种子札记",
    completedAt: prepared.completedAt
  };
}

function findDuplicateTaskNote(input: ReadingNoteInput): ReadingNoteSummaryLike | null {
  const existingNotes = listReadingNotes({ bookId: input.bookId, includeHidden: true }) as ReadingNoteSummaryLike[];
  const signature = buildTaskNoteSignature(input);
  return existingNotes.find((note) => buildTaskNoteSignature(note) === signature) ?? null;
}

interface ReadingNoteSummaryLike {
  id: string;
  bookId: string;
  depth?: "seed" | "deep";
  title?: string;
  body: string;
  excerpt?: string;
  originalQuote?: string;
  progressPercent?: number;
  tags?: string[];
  evidence?: ReadingQuoteEvidence[];
}

function buildTaskNoteSignature(input: ReadingNoteSummaryLike | ReadingNoteInput): string {
  return JSON.stringify({
    bookId: input.bookId,
    depth: input.depth ?? "seed",
    title: normalizeSignatureText(input.title),
    body: normalizeSignatureText(input.body),
    excerpt: normalizeSignatureText(input.excerpt),
    originalQuote: normalizeSignatureText(input.originalQuote),
    progressPercent: typeof input.progressPercent === "number" ? Math.round(input.progressPercent) : null,
    tags: [...(input.tags ?? [])].map(normalizeSignatureText).sort(),
    evidence: (input.evidence ?? []).map((item) => ({
      quote: normalizeSignatureText(item.quote),
      sourceKind: item.sourceKind,
      sourceId: normalizeSignatureText(item.sourceId),
      location: normalizeSignatureText(item.location),
      excerpt: normalizeSignatureText(item.excerpt)
    }))
  });
}

function normalizeSignatureText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}
