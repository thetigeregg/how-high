import type {
  AnalysisDetail,
  AnalysisSummary,
  Mark,
  MarkKind,
  Range,
  Rating,
  Settings,
  SettingsResponse,
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

export function updateAnalysis(id: number, patch: { name?: string; rating?: Rating | null }): Promise<AnalysisSummary> {
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

export function createMark(analysisId: number, kind: MarkKind, range: Range): Promise<Mark> {
  return request(`/api/analyses/${analysisId}/marks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...range }),
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
