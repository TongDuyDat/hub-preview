import type { ReviewUpdates } from "../core/src/types";

interface SessionState {
  cursor: string;
  notifyCursor: string;
  dirty: Set<string>;
  reset: number;
  reads: Map<string, number>;
  consume: Promise<unknown>;
}
export const REVIEW_FEEDBACK_INSTRUCTION = "The user reviewed changes. Read affected files with read_file before editing again. Keep accepted code, respect rejected hunks, and do not re-propose rejected edits without a new user request. Inspect get_change for per-hunk state; get_review_updates supports cursor replay. This notification does not start a model turn.";

/** Independent tool and notification cursors: a log never consumes actionable feedback. */
export class ReviewFeedback {
  private sessions = new Map<string, Promise<SessionState>>();
  private polling = false;
  constructor(private readonly fetchUpdates: (workspace: string, after?: string, latest?: boolean) => Promise<ReviewUpdates>) {}
  private state(workspace: string): Promise<SessionState> {
    let state = this.sessions.get(workspace);
    if (!state) {
      state = this.fetchUpdates(workspace, undefined, true).then(page => ({
        cursor: page.cursor, notifyCursor: page.cursor, dirty: new Set<string>(), reset: 0,
        reads: new Map<string, number>(), consume: Promise.resolve(),
      }));
      this.sessions.set(workspace, state);
      state.catch(() => { if (this.sessions.get(workspace) === state) this.sessions.delete(workspace); });
    }
    return state;
  }
  async take(workspace: string): Promise<ReviewUpdates> {
    const state = await this.state(workspace);
    const request = state.consume.then(async () => {
      const page = await this.fetchUpdates(workspace, state.cursor);
      state.cursor = page.cursor;
      for (const event of page.events) state.dirty.add(event.path);
      if (page.reset || page.hasMore) state.reset++;
      return page;
    });
    state.consume = request.catch(() => undefined);
    return request;
  }
  async requiresRead(workspace: string, path: string): Promise<boolean> {
    const state = await this.state(workspace);
    return state.dirty.has(path) || (state.reset > 0 && state.reads.get(path) !== state.reset);
  }
  async didRead(workspace: string, path: string): Promise<void> {
    const state = await this.state(workspace);
    state.dirty.delete(path); state.reads.set(path, state.reset);
  }
  async poll(notify: (page: ReviewUpdates) => Promise<void>): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [workspace, ready] of this.sessions) {
        try {
          const state = await ready;
          const page = await this.fetchUpdates(workspace, state.notifyCursor);
          if (page.events.length || page.reset) await notify(page);
          state.notifyCursor = page.cursor;
        } catch { /* Disconnected/older Hub or client: next tool can retry; no noise on stdout. */ }
      }
    } finally { this.polling = false; }
  }
}
