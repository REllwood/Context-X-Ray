// Tracks which analysis belongs to the bundle source currently in the viewer. Any change to the
// source discards the analysis, and work started before that change can no longer publish or use
// a result, so comparisons and exports never describe a stale bundle.
export function createAnalysisSession() {
  let revision = 0;
  let current = null;
  return {
    get bundle() {
      return current?.bundle ?? null;
    },
    get analysis() {
      return current?.analysis ?? null;
    },
    // Taken when work starts: records the source revision and the analysis it is based on.
    begin() {
      return { revision, bundle: current?.bundle ?? null, analysis: current?.analysis ?? null, current };
    },
    isCurrent(ticket) {
      return ticket.revision === revision && ticket.current === current;
    },
    // Publishes a finished analysis unless the source changed after the work began.
    commit(ticket, bundle, analysis) {
      if (ticket.revision !== revision) return false;
      current = { bundle, analysis };
      return true;
    },
    discard() {
      revision += 1;
      current = null;
    }
  };
}
