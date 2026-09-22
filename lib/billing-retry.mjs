// Checkout confirmation and Stripe notifications can overlap briefly. Retry only
// transient readiness/lock failures; validation and authorization failures remain errors.
export async function retryBilling(work, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      const transient = ['Billing project busy; retry', 'Invoice not ready', 'Saved payment method not ready'].includes(error.message) ||
        error.code === 'idempotency_key_in_use';
      if (!transient || attempt >= 3) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}
