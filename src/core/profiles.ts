export type AnalyzerProfile = "core" | "extended";

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
  extended: {
    callbacks: true,
    wrappers: true,
    forwarding: true,
    storeApi: true,
  },
};

export function resolveProfile(input?: string): AnalyzerProfile {
  if (!input || input === "extended") {
    return "extended";
  }
  if (input === "core") {
    return "core";
  }
  throw new Error(`Unsupported profile: ${input}`);
}

export function getCapabilityFlags(profile: AnalyzerProfile): CapabilityFlags {
  return FLAGS[profile];
}
