"use client";

type CopyButtonProps = {
  value: string;
};

export function CopyButton({ value }: CopyButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
      }}
    >
      Copy
    </button>
  );
}
