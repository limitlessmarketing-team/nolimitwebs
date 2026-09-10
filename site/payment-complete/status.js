const $ = id => document.getElementById(id);
// Store only for this tab so refreshing doesn't leak the bearer token into URLs/referrers.
const fragment = new URLSearchParams(location.hash.slice(1));
const id = fragment.get('session_id') || sessionStorage.getItem('limitless_checkout');
if (fragment.has('session_id')) { sessionStorage.setItem('limitless_checkout', id); history.replaceState(null, '', location.pathname); }
let paid = false;
try {
  if (!id) throw new Error('Open this page from your Stripe payment confirmation, or check your emailed receipt.');
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`/api/payment-status?session_id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (data.paid) {
      paid = true; $('mark').textContent = '✓'; $('title').textContent = 'Your deposit is paid.';
      $('status').textContent = 'Thank you. Your payment has been confirmed by Stripe.';
      $('next').hidden = false;
      if (data.invoiceUrl) { $('invoice').href = data.invoiceUrl; $('invoice').hidden = false; }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!paid) throw new Error('Your payment is still processing. Check your Stripe receipt before attempting another payment.');
} catch (error) {
  $('mark').textContent = '·'; $('title').textContent = 'Check your payment status';
  $('status').textContent = error.message || 'Please check your Stripe receipt or contact our team.';
}
