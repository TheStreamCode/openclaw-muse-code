/**
 * Static Muse Spark model catalog.
 *
 * Hand-maintained (there is no public unauthenticated catalog endpoint for
 * the Meta Model API): model ids and context windows mirror the official
 * `@openclaw/meta-provider` catalog. The live endpoint remains available at
 * runtime through the standard provider flow; this baseline covers
 * pre-credential discovery and the manifest catalog.
 */

export type MuseCodeBaselineRow = {
  id: string;
  name?: string;
  context_length?: number;
};

export const museCodeBaselineModels: MuseCodeBaselineRow[] = [
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", context_length: 1048576 },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    context_length: 1048576,
  },
  { id: "muse-spark-1.2", name: "Muse Spark 1.2", context_length: 1048576 },
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    context_length: 1048576,
  },
  { id: "muse-spark-1.1", name: "Muse Spark 1.1", context_length: 1048576 },
];
