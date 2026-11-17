import type { ReactNode } from 'react';

/** Small label/value pair for detail sidebars. */
export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div>{value}</div>
    </div>
  );
}
