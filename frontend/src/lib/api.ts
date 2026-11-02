import type {
  AttachmentRef,
  AuthConfig,
  AuthUser,
  Campaign,
  EmailDetail,
  EmailListResponse,
  EmailStats,
  EmailStatus,
  ParsedLeadsResponse,
  QueueStatus,
  ScheduleResponse,
  SendersResponse,
  SlackStatus,
} from '@/types/api';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Typed API client.
 *
 * One `request` helper owns credentials, the error envelope and JSON parsing, so
 * no component ever touches `fetch` directly or re-implements error handling.
 * `ApiError` carries the backend's code and message, which is what the toasts
 * display -- the user sees "No active senders configured", not "Request failed".
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the session is missing or expired. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      // The session is an httpOnly cookie, so every call must send credentials.
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // Distinguish "backend is down" from "backend said no" -- the fixes differ.
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the API at ${API_URL}`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const envelope = payload as ErrorEnvelope | null;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? 'UNKNOWN',
      envelope?.error?.message ?? `Request failed with ${res.status}`,
      envelope?.error?.details,
    );
  }

  return payload as T;
}

const qs = (params: Record<string, string | number | string[] | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) for (const item of v) search.append(k, item);
    else search.append(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const api = {
  // ---- auth ----
  authConfig: () => request<AuthConfig>('/api/auth/config'),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  devLogin: (body: { email: string; name: string }) =>
    request<{ user: AuthUser }>('/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  /** Full-page redirect: the OAuth consent screen cannot be fetched via XHR. */
  googleLoginUrl: () => `${API_URL}/api/auth/google`,

  // ---- emails ----
  emails: (params: {
    status?: EmailStatus[];
    q?: string;
    campaignId?: string;
    limit?: number;
    offset?: number;
    sort?: 'scheduled_asc' | 'scheduled_desc' | 'sent_desc';
  }) =>
    request<EmailListResponse>(
      `/api/emails${qs({
        status: params.status,
        q: params.q,
        campaignId: params.campaignId,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
        sort: params.sort,
      })}`,
    ),
  stats: () => request<{ stats: EmailStats }>('/api/emails/stats'),
  email: (id: string) => request<{ email: EmailDetail }>(`/api/emails/${id}`),
  setStarred: (id: string, starred: boolean) =>
    request<{ email: { id: string; starred: boolean } }>(`/api/emails/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred }),
    }),

  // ---- campaigns ----
  campaigns: () => request<{ campaigns: Campaign[] }>('/api/campaigns'),
  schedule: (body: {
    subject: string;
    body: string;
    name?: string;
    bodyHtml?: string;
    recipients?: { email: string; name: string | null }[];
    recipientsFile?: string;
    startAt?: string;
    minDelayMs?: number;
    maxPerHour?: number;
    senderId?: string;
    attachmentIds?: string[];
    idempotencyKey?: string;
  }) =>
    request<ScheduleResponse>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelCampaign: (id: string) =>
    request<{ cancelled: number }>(`/api/campaigns/${id}/cancel`, { method: 'POST' }),

  // ---- leads ----
  parseLeads: (content: string, filename?: string) =>
    request<ParsedLeadsResponse>('/api/leads/parse', {
      method: 'POST',
      body: JSON.stringify({ content, filename }),
    }),

  // ---- attachments ----
  /**
   * Multipart upload. `Content-Type` is deliberately NOT set: the browser must
   * generate it so it can include the multipart boundary.
   */
  uploadAttachments: async (files: File[]): Promise<{ attachments: AttachmentRef[] }> => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await fetch(`${API_URL}/api/attachments`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const text = await res.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const envelope = payload as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(
        res.status,
        envelope?.error?.code ?? 'UNKNOWN',
        envelope?.error?.message ?? 'Upload failed',
      );
    }
    return payload as { attachments: AttachmentRef[] };
  },
  deleteAttachment: (id: string) =>
    request<{ ok: boolean }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  // ---- senders ----
  senders: () => request<SendersResponse>('/api/senders'),
  createEtherealSender: (body?: { label?: string; maxEmailsPerHour?: number }) =>
    request<{
      sender: { id: string; label: string; fromEmail: string };
      etherealLogin: { user: string; pass: string; url: string };
    }>('/api/senders/ethereal', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  updateSender: (id: string, body: { isActive?: boolean; maxEmailsPerHour?: number | null }) =>
    request<unknown>(`/api/senders/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  // ---- slack ----
  slackStatus: () => request<SlackStatus>('/api/slack/status'),
  slackInstallUrl: () => `${API_URL}/api/slack/install`,
  slackTest: () => request<{ outcome: string }>('/api/slack/test', { method: 'POST' }),
  slackDisconnect: () => request<{ ok: boolean }>('/api/slack/disconnect', { method: 'POST' }),

  // ---- system ----
  queue: () => request<QueueStatus>('/api/system/queue'),
  reconcile: () =>
    request<{ report: { requeued: number; reclaimed: number } | null; skipped: boolean }>(
      '/api/system/reconcile',
      { method: 'POST' },
    ),
};
