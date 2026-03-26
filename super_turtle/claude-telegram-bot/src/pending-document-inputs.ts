export interface PendingDocumentBatch {
  paths: string[];
  stagedAt: number;
}

const pendingDocumentInputs = new Map<number, PendingDocumentBatch>();

export function stagePendingDocuments(chatId: number, paths: string[]): PendingDocumentBatch {
  const existing = pendingDocumentInputs.get(chatId);
  const next: PendingDocumentBatch = {
    paths: [...(existing?.paths || []), ...paths],
    stagedAt: existing?.stagedAt || Date.now(),
  };
  pendingDocumentInputs.set(chatId, next);
  return next;
}

export function peekPendingDocuments(chatId: number): PendingDocumentBatch | null {
  return pendingDocumentInputs.get(chatId) || null;
}

export function consumePendingDocuments(chatId: number): PendingDocumentBatch | null {
  const batch = pendingDocumentInputs.get(chatId) || null;
  if (batch) {
    pendingDocumentInputs.delete(chatId);
  }
  return batch;
}

export function clearPendingDocuments(chatId: number): void {
  pendingDocumentInputs.delete(chatId);
}
