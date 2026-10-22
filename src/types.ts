/** Minimal shapes of the Sigma data model spec this action passes through untouched. */
export interface SigmaDataModel {
  name?: string;
  schemaVersion?: number;
  pages: unknown[];
}

/** Common converter result shape (mirrors sigma-data-model-mcp's ConversionResult). */
export interface ConversionResult {
  model: SigmaDataModel;
  warnings: string[];
  stats: Record<string, number>;
}
