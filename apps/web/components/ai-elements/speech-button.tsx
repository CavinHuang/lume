"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item: (index: number) => SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item: (index: number) => SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  };
  return (win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionInstance)
    | null;
}

type SpeechButtonProps = {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
};

export function SpeechButton({
  onTranscript,
  disabled = false,
  className
}: SpeechButtonProps): React.ReactElement | null {
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const speechCtor = getSpeechRecognitionCtor();

  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const handleClick = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    if (!speechCtor) return;

    const recognition = new speechCtor();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const result = event.results[event.resultIndex];
      const transcript = result?.isFinal ? result[0]?.transcript : "";
      if (transcript) onTranscriptRef.current(transcript);
    };
    recognition.onerror = (event) => {
      console.error("[SpeechButton] speech error:", event.error);
      setIsRecording(false);
    };
    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  }, [isRecording, speechCtor]);

  if (!speechCtor) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "relative size-8 transition-all duration-200",
            isRecording && "animate-pulse bg-red-500 text-white hover:bg-red-600",
            className
          )}
          onClick={handleClick}
          disabled={disabled}
        >
          <MicIcon className="size-4" />
          {isRecording ? (
            <span className="absolute -right-1 -top-1 flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{isRecording ? "停止录音" : "语音输入"}</p>
      </TooltipContent>
    </Tooltip>
  );
}
