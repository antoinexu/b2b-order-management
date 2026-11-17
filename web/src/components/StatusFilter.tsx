import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { capitalize } from '@/lib/format';

/** Status tabs; the empty string means "all". */
export function StatusFilter<S extends string>({ statuses, value, onChange }: { statuses: readonly S[]; value: S | ''; onChange: (s: S | '') => void }) {
  return (
    <div className="mb-4 overflow-x-auto">
      <Tabs value={value} onValueChange={(v) => onChange(v as S | '')}>
        <TabsList>
          <TabsTrigger value="">All</TabsTrigger>
          {statuses.map((s) => <TabsTrigger key={s} value={s}>{capitalize(s)}</TabsTrigger>)}
        </TabsList>
      </Tabs>
    </div>
  );
}
