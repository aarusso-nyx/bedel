import { declareClassPlugin, PluginKind } from "@stryker-mutator/api/plugin";
// Stryker ignore reasons propagate to descendants. Retain overlapping ancestors;
// completed ancestor observations are reused through the source checkpoint.
export class BatchIgnorer {
  shouldIgnore(path) {
    const loc = path.node?.loc;
    if (
      loc &&
      (loc.end.line < Number(process.env.BEDEL_START) ||
        loc.start.line > Number(process.env.BEDEL_END))
    )
      return "bedel-other-batch";
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.Ignore, "bedel-batch", BatchIgnorer),
];
