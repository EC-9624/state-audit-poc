export type AnalyzerProfile = "core" | "press-release";

export interface CapabilityFlags {
  callbacks: boolean;
  wrappers: boolean;
  forwarding: boolean;
  storeApi: boolean;
}

const FLAGS: Record<AnalyzerProfile, CapabilityFlags> = {
  core: {
    callbacks: false,
    wrappers: false,
    forwarding: false,
    storeApi: false,
  },
  "press-release": {
    callbacks: true,
    wrappers: true,
    forwarding: true,
    storeApi: true,
  },
};

export function resolveProfile(input?: string): AnalyzerProfile {
  if (!input || input === "press-release") {
    return "press-release";
  }
  if (input === "core") {
    return "core";
  }
  throw new Error(`Unsupported profile: ${input}`);
}

export function getCapabilityFlags(profile: AnalyzerProfile): CapabilityFlags {
  return FLAGS[profile];
}
