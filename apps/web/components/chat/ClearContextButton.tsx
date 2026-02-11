"use client";

import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ClearContextButtonProps = {
  disabled?: boolean;
  onClick?: () => void;
};

export function ClearContextButton({ disabled, onClick }: ClearContextButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={disabled} onClick={onClick}>
          <Eraser className="h-4 w-4 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>清除上下文</p>
      </TooltipContent>
    </Tooltip>
  );
}
