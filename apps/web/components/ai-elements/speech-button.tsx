import { useCallback, useEffect, useRef, useState } from "react";
import { MicIcon, AlertCircleIcon } from "lucide-react";
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const speechCtor = getSpeechRecognitionCtor();
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
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

      // 用户友好的错误提示
      const errorMessages: Record<string, string> = {
        "not-allowed": "麦克风权限被拒绝，请在浏览器设置中允许访问麦克风",
        "no-speech": "未检测到语音，请重试",
        "audio-capture": "无法访问麦克风，请检查设备连接",
        "network": "网络连接错误，请检查网络后重试",
        "service-not-allowed": "语音识别服务不可用"
      };

      const message = errorMessages[event.error] || `语音识别错误: ${event.error}`;
      setErrorMessage(message);
      setIsRecording(false);

      // 3秒后清除错误提示
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
      errorTimeoutRef.current = setTimeout(() => {
        setErrorMessage(null);
      }, 3000);
    };
    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  }, [isRecording, speechCtor]);

  if (!speechCtor) {
    // 浏览器不支持语音识别，静默失败（不显示按钮）
    return null;
  }

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
            errorMessage && "bg-orange-500 text-white hover:bg-orange-600",
            className
          )}
          onClick={handleClick}
          disabled={disabled}
        >
          {errorMessage ? <AlertCircleIcon className="size-4" /> : <MicIcon className="size-4" />}
          {isRecording ? (
            <span className="absolute -right-1 -top-1 flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="max-w-xs">
          {errorMessage || (isRecording ? "停止录音" : "语音输入")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
