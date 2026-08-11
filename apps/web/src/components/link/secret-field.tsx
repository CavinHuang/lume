import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SecretField({
  label, value, onChange, secret, textarea, required, placeholder, description,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret: boolean;
  textarea?: boolean;
  required?: boolean;
  placeholder?: string;
  description?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}{required ? <span className="ml-1 text-destructive">*</span> : null}</Label>
      {textarea ? (
        <Textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input type={secret ? "password" : "text"} value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      )}
      {description ? <p className="text-xs leading-relaxed text-[var(--text-3)]">{description}</p> : null}
    </div>
  );
}
