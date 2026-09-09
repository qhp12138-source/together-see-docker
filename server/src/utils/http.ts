export function sendJson(res: import('express').Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
