"use client";

type SpeechButtonProps = {
  disabled?: boolean;
  onClick?: () => void;
};

export function SpeechButton({ disabled, onClick }: SpeechButtonProps): React.ReactElement {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      Speech
    </button>
  );
}
