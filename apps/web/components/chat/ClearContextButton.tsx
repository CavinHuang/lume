"use client";

type ClearContextButtonProps = {
  disabled?: boolean;
  onClear: () => void;
};

export function ClearContextButton({ disabled, onClear }: ClearContextButtonProps): React.ReactElement {
  return (
    <button type="button" disabled={disabled} onClick={onClear}>
      Clear Context
    </button>
  );
}
