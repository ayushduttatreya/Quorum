// quorum ops topology — fetches and renders live cluster state

async function topology(_namespace: string): Promise<void> {
  throw new Error("not implemented");
}

const ns = process.argv[2] ?? "default";
topology(ns).catch(console.error);
