import { Badge } from '@/components/ui/badge';
import type { OrderStatus, QuoteStatus } from '@/api/types';
import { capitalize } from '@/lib/format';
import { cn } from '@/lib/utils';

const STYLES: Record<QuoteStatus | OrderStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  accepted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  expired: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  shipped: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

export function StatusBadge({ status }: { status: QuoteStatus | OrderStatus }) {
  return <Badge className={cn('border-transparent', STYLES[status])}>{capitalize(status)}</Badge>;
}
