import type { AnalysisDetail, AnalysisSummary, Rating } from "./types.js";

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

export function deleteAnalysis(id: number): Promise<void> {
  return request(`/api/analyses/${id}`, { method: "DELETE" });
}
