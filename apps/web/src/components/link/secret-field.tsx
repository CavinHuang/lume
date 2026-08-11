import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SecretField({
  label, value, onChange, secret, textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret: boolean;
  textarea?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {textarea ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input type={secret ? "password" : "text"} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
