import { useEffect } from 'react';

/** Reconcile a page after deletions or other changes reduce the result count. */
export function usePageBounds(page: number, pageSize: number, total: number | undefined, onChange: (page: number) => void) {
  useEffect(() => {
    if (total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > lastPage) onChange(lastPage);
  }, [page, pageSize, total, onChange]);
}
