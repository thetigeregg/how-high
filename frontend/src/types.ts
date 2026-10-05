export type Level = "green" | "yellow" | "orange" | "red";
export type Rating = "fine" | "uneasy" | "bad";

export interface AnalysisSummary {
  id: number;
  name: string;
  createdAt: string;
  lengthM: number;
  level: Level;
  maxScore: number;
  terrainSource: string;
  confidence: "high" | "low";
  rating: Rating | null;
}

export interface PointMetrics {
  elevation: number;
  slopeDeg: number;
  crossSlopeDeg: number;
  fallLeft: number;
  fallRight: number;
  drop10: number;
  drop30: number;
  drop100: number;
  dropLeft30: number;
  dropRight30: number;
  trackGradeDeg: number;
  bridgeGap: number;
}

export interface AnalysedPoint {
  dist: number;
  lon: number;
  lat: number;
  score: number | null;
  scoreLow: number | null;
  scoreHigh: number | null;
  level: Level | null;
  metrics: PointMetrics | null;
}

export interface Section {
  level: Level;
  startM: number;
  endM: number;
  lengthM: number;
  maxScore: number;
  robustScore: number;
  maxFallM: number;
  maxDrop30M: number;
  maxCrossSlopeDeg: number;
  side: "left" | "right" | "both";
  dropTowards: string;
  possibleBridge: boolean;
  worst: { dist: number; lon: number; lat: number; elevation: number };
  links: { swisstopo: string | null; google: string };
}

export interface Analysis {
  name: string | null;
  lengthM: number;
  spacingM: number;
  terrain: { source: string; cellSize: number; confidence: "high" | "low" };
  summary: {
    maxScore: number;
    level: Level;
    lengthByLevelM: Record<Level, number>;
    noDataM: number;
  };
  sections: Section[];
  points: AnalysedPoint[];
}

export interface AnalysisDetail {
  summary: AnalysisSummary;
  result: Analysis;
}
