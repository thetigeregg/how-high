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

export interface PointContext {
  forest: boolean;
  matched: boolean;
  tunnel: boolean;
  bridge: boolean;
  wide: boolean;
  sacGrade: number | null;
  aided: boolean;
  cliff: boolean;
}

export interface AnalysedPoint {
  dist: number;
  lon: number;
  lat: number;
  score: number | null;
  /** Terrain-only score, before forest, tunnels and track width are applied. */
  rawScore?: number | null;
  context?: PointContext | null;
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
  rawMaxScore?: number;
  context?: {
    forest: boolean;
    tunnel: boolean;
    bridge: boolean;
    wideTrack: boolean;
    sacGrade: number | null;
    aided: boolean;
    cliff: boolean;
  } | null;
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
  /** Absent on hikes analysed before map context existed. */
  mapContext?: boolean;
  summary: {
    maxScore: number;
    level: Level;
    lengthByLevelM: Record<Level, number>;
    noDataM: number;
  };
  sections: Section[];
  points: AnalysedPoint[];
}

export type MarkKind = "fine" | "uneasy" | "bad" | "turned_back";

/** How a stretch of the hike felt in reality; a point when startM equals endM. */
export interface Mark {
  id: number;
  kind: MarkKind;
  startM: number;
  endM: number;
  note: string | null;
  createdAt: string;
}

/** A stretch of the route, in metres from the start. */
export interface Range {
  startM: number;
  endM: number;
}

export interface AnalysisDetail {
  summary: AnalysisSummary;
  marks: Mark[];
  result: Analysis;
}
