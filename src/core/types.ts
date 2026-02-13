export type RuleId = "R001" | "R002" | "R003" | "R004";

export type OutputFormat = "text" | "json";

export type Store = "recoil" | "jotai";

export type StateKind =
  | "atom"
  | "selector"
  | "atomFamily"
  | "selectorFamily"
  | "derivedAtom"
  | "atomWithDefault";

export interface AnalyzerConfig {
  rootDir: string;
  tsconfigPath?: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  format: OutputFormat;
  profile: import("./profiles").AnalyzerProfile;
  capabilities: import("./profiles").CapabilityFlags;
}

export interface StateSymbol {
  id: string;
  name: string;
  store: Store;
  kind: StateKind;
  filePath: string;
  line: number;
  column: number;
  exported: boolean;
  isRecoilPlainAtom: boolean;
}

export interface UsageEvent {
  type: "read" | "runtimeWrite" | "initWrite";
  phase: "runtime" | "dependency";
  stateId: string;
  actorType: "state" | "function" | "unknown";
  actorName: string;
  actorStateId?: string;
  filePath: string;
  line: number;
  column: number;
  via: string;
}

export interface DependencyEdge {
  fromStateId: string;
  toStateId: string;
  filePath: string;
  line: number;
  column: number;
  via: "recoil:get" | "jotai:get";
}

export interface ReferenceSite {
  filePath: string;
  line: number;
  column: number;
}

export interface Violation {
  rule: RuleId;
  state: string;
  file: string;
  line: number;
  message: string;
  metrics?: Record<string, number>;
}

export interface AuditReport {
  ok: boolean;
  summary: {
    violations: number;
  };
  violations: Violation[];
}

export interface ImpactSite {
  actor: string;
  file: string;
  line: number;
  column: number;
  via: string;
}

export interface ImpactDependent {
  state: string;
  file: string;
  line: number;
  column: number;
  depth: number;
}

export interface ImpactItem {
  state: string;
  store: Store;
  kind: StateKind;
  definition: {
    file: string;
    line: number;
    column: number;
  };
  directReaders: ImpactSite[];
  runtimeWriters: ImpactSite[];
  initWriters: ImpactSite[];
  transitiveDependents: ImpactDependent[];
}

export interface ImpactReport {
  ok: boolean;
  query: {
    mode: "state" | "file";
    value: string;
    depth: number;
  };
  items: ImpactItem[];
}
