const $ = id => document.getElementById(id);
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const id = location.hash.slice(1);

try {
  if (!/^plink_[A-Za-z0-9]{12,100}$/.test(id)) throw new Error('Open the personal proposal link our team shared with you to see your agreed pricing.');
  const response = await fetch(`/api/proposal?id=${encodeURIComponent(id)}`, { cache: 'no-store', referrerPolicy: 'no-referrer' });
  const proposal = await response.json();
  if (!response.ok) throw new Error(proposal.error);
  $('proposal-title').textContent = proposal.title;
  for (const [element, value] of Object.entries({ total: proposal.buildTotal, balance: proposal.balance, hosting: proposal.monthlyHosting, deposit: proposal.deposit })) $(element).textContent = money(value);
  $('test-mode').hidden = !proposal.testMode;
  if (proposal.preview) {
    $('test-mode').textContent = 'Layout preview · Example pricing · Checkout disabled';
    $('checkout').setAttribute('aria-disabled', 'true');
  } else if (proposal.active && /^https:\/\/buy\.stripe\.com\//.test(proposal.checkoutUrl)) $('checkout').href = proposal.checkoutUrl;
  else { $('checkout').hidden = true; $('closed').hidden = false; }
  const paragraphs = [
    `I authorize Limitless Marketing Group LLC to collect my ${money(proposal.deposit)} USD deposit and securely save the payment method I provide through Stripe.`,
    `I authorize the remaining ${money(proposal.balance)} USD build balance to be charged when my website goes live, and ${money(proposal.monthlyHosting)} USD in monthly hosting starting 30 days after launch. Hosting continues monthly until canceled. The team will notify me of the launch date and first hosting billing date.`,
    'Additional services or hosting price changes require my separate approval. A payment may require additional bank verification, and I agree to update my payment method if needed.',
    'I can request cancellation of future hosting renewals by emailing contact@nolimitwebs.com before the next renewal. Cancellation does not cancel an outstanding website build balance. The service end date will be confirmed in writing.',
    'I will be asked to accept these billing terms in Stripe before paying.',
  ];
  for (const text of paragraphs) { const p = document.createElement('p'); p.textContent = text; $('authorization').append(p); }
  $('details').hidden = false;
} catch (error) {
  $('error-text').textContent = error.message || 'We could not load your proposal. Please contact our team.';
  $('error').hidden = false;
} finally { $('loading').hidden = true; }
