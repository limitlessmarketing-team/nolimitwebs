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
    if (data.kind === 'hosting_only_v1' && data.setupComplete) {
      paid = true; $('mark').textContent = '✓'; $('title').textContent = 'Your card is saved.';
      $('status').textContent = 'Nothing was charged today. Your website build is included.';
      $('next').textContent = 'We’ll notify you when your website launches. Your first monthly hosting payment will be charged at launch, then monthly until canceled.';
      if (data.paymentPlan === 'full_upfront') $('next').textContent = data.monthlyHosting > 0 ? 'No build balance is due at launch. We’ll confirm your launch date; monthly hosting starts 30 days later.' : 'No build balance is due at launch and no monthly hosting is scheduled.';
      $('next').hidden = false; break;
    }
    if (data.paid) {
      paid = true; $('mark').textContent = '✓'; $('title').textContent = data.paymentPlan === 'full_upfront' ? 'Your website is paid in full.' : 'Your deposit is paid.';
      $('status').textContent = 'Thank you. Your payment has been confirmed by Stripe.';
      if (data.paymentPlan === 'full_upfront') $('next').textContent = data.monthlyHosting > 0 ? 'No build balance is due at launch. We’ll confirm your launch date; monthly hosting starts 30 days later.' : 'No build balance is due at launch and no monthly hosting is scheduled.';
      $('next').hidden = false;
      if (data.invoiceUrl) { $('invoice').href = data.invoiceUrl; $('invoice').hidden = false; }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!paid) throw new Error('Your confirmation is still processing. Contact our team before trying again.');
} catch (error) {
  $('mark').textContent = '·'; $('title').textContent = 'Check your payment status';
  $('status').textContent = error.message || 'Please check your Stripe receipt or contact our team.';
}
