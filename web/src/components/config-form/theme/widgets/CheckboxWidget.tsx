// Checkbox Widget - maps to shadcn/ui Checkbox
import type { WidgetProps } from "@rjsf/utils";
import { Checkbox } from "@/components/ui/checkbox";

export function CheckboxWidget(props: Readonly<WidgetProps>) {
  const { id, value, disabled, readonly, onChange, label, schema } = props;

  return (
    <Checkbox
      id={id}
      checked={value === undefined ? false : value}
      disabled={disabled || readonly}
      onCheckedChange={(checked) => onChange(checked)}
      aria-label={label || schema.title || "Checkbox"}
    />
  );
}
