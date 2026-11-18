import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface TimelineEntry {
  label: string;
  /** ISO timestamp; omitted for derived events that were never recorded. */
  at?: string;
  by?: string;
  detail?: string | null;
}

/** Vertical status history, oldest first; the latest entry is highlighted. */
export function StatusTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="relative grid gap-4 border-l pl-5">
      {entries.map((entry, i) => (
        <li key={i} className="relative">
          <span className={cn('absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-background',
            i === entries.length - 1 ? 'bg-primary' : 'bg-muted-foreground/40')} aria-hidden />
          <p className="text-sm font-medium">{entry.label}</p>
          {(entry.at || entry.by) && (
            <p className="text-xs text-muted-foreground">
              {[entry.at && formatDateTime(entry.at), entry.by && `by ${entry.by}`].filter(Boolean).join(' · ')}
            </p>
          )}
          {entry.detail && <p className="mt-1 text-sm">{entry.detail}</p>}
        </li>
      ))}
    </ol>
  );
}
