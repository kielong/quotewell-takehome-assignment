// Entry point for the Email -> AMS submission pipeline.
// Phase 0 scaffold: orchestration is implemented in later phases.

async function main(): Promise<void> {
  console.log("pipeline scaffold ready");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
