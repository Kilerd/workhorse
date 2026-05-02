import { useCallback, useEffect, useMemo, useState } from "react";

import { BOARD_COLUMNS, type DisplayTaskColumn } from "@/lib/task-view";

const STORAGE_PREFIX = "workhorse:board:visible-columns:";

const ALL_COLUMN_IDS: DisplayTaskColumn[] = BOARD_COLUMNS.map((column) => column.id);

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function readStored(scope: string): DisplayTaskColumn[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const allowed = new Set<DisplayTaskColumn>(ALL_COLUMN_IDS);
    const filtered = parsed.filter(
      (entry): entry is DisplayTaskColumn =>
        typeof entry === "string" && allowed.has(entry as DisplayTaskColumn)
    );
    return filtered.length > 0 ? filtered : null;
  } catch {
    return null;
  }
}

function writeStored(scope: string, ids: DisplayTaskColumn[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(ids));
  } catch {
    // ignore storage errors (quota, privacy mode, etc.)
  }
}

export interface ColumnVisibilityState {
  visibleColumnIds: DisplayTaskColumn[];
  isVisible(id: DisplayTaskColumn): boolean;
  toggle(id: DisplayTaskColumn): void;
  reset(): void;
}

export function useColumnVisibility(scope: string): ColumnVisibilityState {
  const [ids, setIds] = useState<DisplayTaskColumn[]>(
    () => readStored(scope) ?? ALL_COLUMN_IDS
  );

  useEffect(() => {
    const next = readStored(scope) ?? ALL_COLUMN_IDS;
    setIds(next);
  }, [scope]);

  const visibleSet = useMemo(() => new Set(ids), [ids]);

  const toggle = useCallback(
    (id: DisplayTaskColumn) => {
      setIds((current) => {
        const has = current.includes(id);
        let next: DisplayTaskColumn[];
        if (has) {
          if (current.length === 1) {
            return current;
          }
          next = current.filter((entry) => entry !== id);
        } else {
          next = ALL_COLUMN_IDS.filter(
            (candidate) => current.includes(candidate) || candidate === id
          );
        }
        writeStored(scope, next);
        return next;
      });
    },
    [scope]
  );

  const reset = useCallback(() => {
    writeStored(scope, ALL_COLUMN_IDS);
    setIds(ALL_COLUMN_IDS);
  }, [scope]);

  const isVisible = useCallback((id: DisplayTaskColumn) => visibleSet.has(id), [visibleSet]);

  return {
    visibleColumnIds: ids,
    isVisible,
    toggle,
    reset
  };
}
