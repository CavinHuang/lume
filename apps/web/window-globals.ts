export {};

declare global {
  interface Window {
    __pendingAttachmentData?: Map<string, string>;
    __pendingAgentFileData?: Map<string, string>;
    webkitSpeechRecognition?: new () => EventTarget;
    SpeechRecognition?: new () => EventTarget;
  }
}
