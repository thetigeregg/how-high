import { beforeEach, describe, expect, it } from "vitest";
import { Cancelled, dismiss, enqueue, idle, isBeingReanalysed, listJobs, reset, type JobControls } from "./jobs.js";

const info = { kind: "hike" as const, label: "Test", reanalysisOf: null };
/** A task that waits to be told to finish, so a test can look at it mid-run. */
function held() {
  let release: (id: number) => void = () => {};
  let controls: JobControls | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const task = (c: JobControls) => {
    controls = c;
    markStarted();
    return new Promise<number>((done) => (release = done));
  };
  return { task, started, finish: (id = 1) => release(id), controls: () => controls! };
}

beforeEach(() => {
  process.env.LOG_LEVEL = "silent";
  reset();
});

describe("background jobs", () => {
  it("returns at once and reports progress as the task goes", async () => {
    const work = held();
    const job = enqueue(info, work.task);
    expect(job).toMatchObject({ state: "queued", stage: "Queued", done: 0, total: 0, analysisId: null });
    await work.started;
    expect(listJobs()[0]).toMatchObject({ state: "running" });
    work.controls().report({ stage: "Measuring, piece 3 of 8", done: 2, total: 8 });
    expect(listJobs()[0]).toMatchObject({ stage: "Measuring, piece 3 of 8", done: 2, total: 8 });
    // A report without counts changes the text only.
    work.controls().report({ stage: "Fetching map data, piece 3 of 8" });
    expect(listJobs()[0]).toMatchObject({ stage: "Fetching map data, piece 3 of 8", done: 2, total: 8 });
    work.finish(42);
    await idle();
    expect(listJobs()[0]).toMatchObject({ state: "done", analysisId: 42, error: null });
  });

  it("runs one job at a time, in the order they were added", async () => {
    const first = held();
    const order: string[] = [];
    enqueue(info, first.task);
    enqueue(info, async () => (order.push("second"), 2));
    enqueue(info, async () => (order.push("third"), 3));
    await first.started;
    expect(listJobs().map((j) => j.state)).toEqual(["running", "queued", "queued"]);
    expect(order).toEqual([]);
    first.finish();
    await idle();
    expect(order).toEqual(["second", "third"]);
  });

  it("keeps a failure with its reason and carries on with the next job", async () => {
    enqueue(info, async () => {
      throw new Error("Google found no route");
    });
    enqueue(info, async () => 7);
    await idle();
    expect(listJobs().map((j) => [j.state, j.error, j.analysisId])).toEqual([
      ["failed", "Google found no route", null],
      ["done", null, 7],
    ]);
  });

  it("drops a waiting job that is cancelled, without running it", async () => {
    const first = held();
    let ran = false;
    enqueue(info, first.task);
    const waiting = enqueue(info, async () => ((ran = true), 2));
    await first.started;
    expect(dismiss(waiting.id)).toBe(true);
    first.finish();
    await idle();
    expect(ran).toBe(false);
    expect(listJobs()).toHaveLength(1);
  });

  it("asks a running job to stop, and forgets it once it does", async () => {
    let controls!: JobControls;
    let step!: () => void;
    const job = enqueue(info, async (c) => {
      controls = c;
      await new Promise<void>((resolve) => (step = resolve));
      // What the measuring loop does between pieces.
      if (c.cancelled()) throw new Cancelled();
      return 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controls.cancelled()).toBe(false);
    dismiss(job.id);
    expect(listJobs()[0]).toMatchObject({ state: "running", stage: "Stopping" });
    step();
    await idle();
    expect(listJobs()).toEqual([]);
  });

  it("clears a finished or failed job on request, and knows what it does not have", async () => {
    const job = enqueue(info, async () => {
      throw new Error("no terrain");
    });
    await idle();
    expect(dismiss(job.id)).toBe(true);
    expect(listJobs()).toEqual([]);
    expect(dismiss(999)).toBe(false);
  });

  it("knows which entries are being measured again", async () => {
    const work = held();
    enqueue({ ...info, reanalysisOf: 5 }, work.task);
    expect(isBeingReanalysed(5)).toBe(true);
    expect(isBeingReanalysed(6)).toBe(false);
    await work.started;
    work.finish(5);
    await idle();
    expect(isBeingReanalysed(5)).toBe(false);
  });
});
