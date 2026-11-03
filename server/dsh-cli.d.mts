export interface DshCliOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface FindDshCliOptions extends DshCliOptions {
  exists?: (p: string) => boolean;
  which?: (name: string) => string | undefined;
}

export function dshCliCandidates(opts?: DshCliOptions): string[];
export function findDshCli(opts?: FindDshCliOptions): string | undefined;
