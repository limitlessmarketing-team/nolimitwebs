import { createHash, randomUUID } from 'node:crypto';
import { ReviewRequired } from './close.mjs';

// All mutations for one project use a leased, fenced D1 lock. Stripe writes
// additionally have durable receipts and deterministic idempotency keys.
export class BillingStore {
  constructor(db, mode, now = () => Date.now()) { this.db = db; this.mode = mode; this.now = now; }
  async get(id) {
    const row = await this.db.prepare('SELECT * FROM close_billing_projects WHERE id = ? AND mode = ?').bind(id, this.mode).first();
    return row ? JSON.parse(row.state) : null;
  }
  async findDeposit(id) {
    const row = await this.db.prepare('SELECT id FROM close_billing_projects WHERE deposit_id = ? AND mode = ?').bind(id, this.mode).first();
    return row?.id;
  }
  async create(state) {
    await this.db.prepare('INSERT OR IGNORE INTO close_billing_projects (id, mode, lead_id, state) VALUES (?, ?, ?, ?)')
      .bind(state.id, this.mode, state.leadId, JSON.stringify(state)).run();
  }
  async withLock(id, fn) {
    const token = randomUUID();
    const row = await this.db.prepare('UPDATE close_billing_projects SET lock_token = ?, lock_until = ? WHERE id = ? AND mode = ? AND lock_until < ? RETURNING id')
      .bind(token, this.now() + 600000, id, this.mode, this.now()).first();
    if (!row) throw new Error('Billing project busy; retry');
    const fence = async () => {
      const result = await this.db.prepare('UPDATE close_billing_projects SET lock_until = ? WHERE id = ? AND mode = ? AND lock_token = ? AND lock_until > ?')
        .bind(this.now() + 600000, id, this.mode, token, this.now()).run();
      if (result.meta.changes !== 1) throw new Error('Billing lock expired');
    };
    const save = async state => {
      await fence();
      const result = await this.db.prepare('UPDATE close_billing_projects SET state = ?, deposit_id = ? WHERE id = ? AND mode = ? AND lock_token = ?')
        .bind(JSON.stringify(state), state.depositId || null, id, this.mode, token).run();
      if (result.meta.changes !== 1) throw new Error('Billing lock lost');
    };
    const post = async (step, path, params, api) => {
      await fence();
      const hash = createHash('sha256').update(JSON.stringify([path, params])).digest('hex');
      await this.db.prepare('INSERT OR IGNORE INTO close_billing_calls (project_id, step, request_hash, started_at) VALUES (?, ?, ?, ?)')
        .bind(id, step, hash, this.now()).run();
      const call = await this.db.prepare('SELECT * FROM close_billing_calls WHERE project_id = ? AND step = ?').bind(id, step).first();
      if (call.request_hash !== hash) throw new ReviewRequired('Billing inputs changed after processing began. Review this project in Stripe.');
      if (call.result) return JSON.parse(call.result);
      // Stripe may discard idempotency keys after 24 hours. Never blindly
      // replay an uncertain write outside that window, even days later.
      if (this.now() - call.started_at > 23 * 3600000) throw new ReviewRequired('An earlier billing request needs reconciliation in Stripe before retrying.');
      let receipt;
      try {
        const result = await api(path, params, `close-v1:${this.mode}:${id}:${step}`);
        receipt = { id: result.id };
        if (!receipt.id) throw new Error('Missing Stripe receipt');
      } catch (error) {
        // A declined card is a completed attempt. Preserve its invoice for
        // recovery; webhook retries must not make fresh payment attempts.
        if (error.status !== 402 || step !== 'final-pay') throw error;
        receipt = { declined: true };
      }
      await fence();
      await this.db.prepare('UPDATE close_billing_calls SET result = ? WHERE project_id = ? AND step = ? AND request_hash = ?')
        .bind(JSON.stringify(receipt), id, step, hash).run();
      return receipt;
    };
    try { return await fn(await this.get(id), { save, post, fence }); }
    finally {
      await this.db.prepare('UPDATE close_billing_projects SET lock_until = 0, lock_token = NULL WHERE id = ? AND mode = ? AND lock_token = ?')
        .bind(id, this.mode, token).run();
    }
  }
}
