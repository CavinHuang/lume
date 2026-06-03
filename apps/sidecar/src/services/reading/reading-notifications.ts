import { READING_IPC_CHANNELS, type ReadingNoteGenerationNotification, type ReadingRunTaskInput, type ReadingTaskResult } from "@lume/shared";
import { listReadingBooks } from "./reading-store";

export type ReadingNotificationWriter = (method: string, params: unknown) => void;

export function emitReadingGenerationNotification(
  writeNotification: ReadingNotificationWriter | undefined,
  result: ReadingTaskResult,
  input: ReadingRunTaskInput
): void {
  if (!writeNotification) return;
  const book = result.bookId ? listReadingBooks().find((item) => item.id === result.bookId) : undefined;
  const payload: ReadingNoteGenerationNotification = {
    ...result,
    ...(book?.title ? { bookTitle: book.title } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.depth ? { depth: input.depth } : {})
  };
  writeNotification(
    result.status === "completed" ? READING_IPC_CHANNELS.NOTE_GEN_DONE : READING_IPC_CHANNELS.NOTE_GEN_FAILED,
    payload
  );
}
