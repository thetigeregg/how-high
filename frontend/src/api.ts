import type {
  AnalysisDetail,
  AnalysisSummary,
  Mark,
  MarkCause,
  MarkKind,
  Proposal,
  Range,
  Rating,
  Settings,
  SettingsResponse,
  Status,
} from "./types.js";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${url} failed: HTTP ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function fetchAnalyses(): Promise<AnalysisSummary[]> {
  return (await request<{ analyses: AnalysisSummary[] }>("/api/analyses")).analyses;
}

export function fetchAnalysis(id: number): Promise<AnalysisDetail> {
  return request(`/api/analyses/${id}`);
}

export function uploadGpx(file: File): Promise<AnalysisSummary> {
  const body = new FormData();
  body.append("file", file);
  return request("/api/analyses", { method: "POST", body });
}

export function updateAnalysis(
  id: number,
  patch: { name?: string; rating?: Rating | null; status?: Status },
): Promise<AnalysisSummary> {
  return request(`/api/analyses/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function reanalyse(id: number): Promise<AnalysisSummary> {
  return request(`/api/analyses/${id}/reanalyse`, { method: "POST" });
}

export function deleteAnalysis(id: number): Promise<void> {
  return request(`/api/analyses/${id}`, { method: "DELETE" });
}

export function createMark(analysisId: number, kind: MarkKind, range: Range, cause: MarkCause | null = null): Promise<Mark> {
  return request(`/api/analyses/${analysisId}/marks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, cause, ...range }),
  });
}

/** Says, or changes, what it was about a marked stretch. */
export function setMarkCause(analysisId: number, markId: number, cause: MarkCause | null): Promise<Mark> {
  return request(`/api/analyses/${analysisId}/marks/${markId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cause }),
  });
}

export function deleteMark(analysisId: number, markId: number): Promise<void> {
  return request(`/api/analyses/${analysisId}/marks/${markId}`, { method: "DELETE" });
}

/** A route from a shared Google Maps directions link. */
export function addRoute(url: string): Promise<AnalysisSummary> {
  return request("/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

/** Which optional features this installation has. */
export function fetchMeta(): Promise<{ googleMaps: boolean }> {
  return request("/api/meta");
}

export function fetchSettings(): Promise<SettingsResponse> {
  return request("/api/settings");
}

export function saveSettings(settings: Settings): Promise<SettingsResponse> {
  return request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

const postJson = (url: string, body?: unknown): RequestInit & { url: string } => ({
  url,
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

/** Settings that would fit your marks better, with their effect. Saves nothing. */
export function suggestSettings(profile: "hike" | "road"): Promise<Proposal> {
  const { url, ...init } = postJson("/api/settings/suggest", { profile });
  return request(url, init);
}

/** Saves a confirmed suggestion; the settings it replaces are kept so it can be undone. */
export function applySettings(settings: Settings): Promise<SettingsResponse> {
  const { url, ...init } = postJson("/api/settings/apply", settings);
  return request(url, init);
}

export function revertSettings(): Promise<SettingsResponse> {
  const { url, ...init } = postJson("/api/settings/revert");
  return request(url, init);
}
