const $ = id => document.getElementById(id);
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const id = location.hash.slice(1);

// Load the matching client and clear stale checkout state when a proposal link changes.
window.addEventListener('hashchange', () => location.reload());

try {
  if (!/^(?:plink_[A-Za-z0-9]{12,100}|host_[a-f0-9]{64})$/.test(id)) throw new Error('Open the personal proposal link our team shared with you to see your agreed pricing.');
  const response = await fetch(`/api/proposal?id=${encodeURIComponent(id)}`, { cache: 'no-store', referrerPolicy: 'no-referrer' });
  const proposal = await response.json();
  if (!response.ok) throw new Error(proposal.error);
  $('proposal-title').textContent = proposal.title;
  for (const [element, value] of Object.entries({ total: proposal.buildTotal, balance: proposal.balance, hosting: proposal.monthlyHosting, deposit: proposal.deposit })) $(element).textContent = money(value);
  $('test-mode').hidden = !proposal.testMode;
  const full = proposal.paymentPlan === 'full_upfront';
  const hostingOnly = ['hosting_only_v1', 'hosting_domain_v1'].includes(proposal.kind);
  const domain = proposal.domainAmount > 0;
  if (hostingOnly) {
    $('intro-lead').textContent = 'Your website build is included. One clear monthly hosting price, starting when your website launches.';
    const steps = [
      ['Save your card', 'Accept your hosting plan and securely save your card with Stripe. Nothing due today.'],
      ['Launch your website', 'We notify you when your website is live. Your first monthly hosting payment is charged at launch.'],
      ['Keep your website online', 'Your agreed hosting rate renews monthly until canceled.']
    ];
    $('timeline').replaceChildren();
    steps.forEach(([title, copy], i) => {
      const li = document.createElement('li'), number = document.createElement('span'), div = document.createElement('div');
      number.className = 'step'; number.textContent = `0${i + 1}`;
      const h = document.createElement('h2'), p = document.createElement('p'); h.textContent = title; p.textContent = copy;
      div.append(h, p); li.append(number, div); $('timeline').append(li);
    });
    $('total').textContent = 'Included'; $('balance-row').hidden = true;
    $('hosting-start').textContent = 'First payment at website launch. Renews monthly until canceled.';
    $('due-label').textContent = 'Nothing due today';
    $('checkout').textContent = 'Accept plan & save card ↗';
    document.querySelector('.secure').textContent = 'Your card is saved securely by Stripe. No charge today.';
    $('closed').textContent = 'This proposal is no longer open for card setup. If you already saved your card, nothing is due until launch. Contact us if you need help.';
    document.querySelector('.terms a').href = '/hosting-terms/';
  }
  if (full) {
    $('intro-lead').textContent = 'One upfront website payment. No build balance at launch. Hosting starts 30 days after your website goes live.';
    $('balance-row').hidden = true;
    $('due-label').textContent = 'Full website payment due today';
    const headings = $('timeline').querySelectorAll('h2'), copies = $('timeline').querySelectorAll('p');
    headings[0].textContent = 'Pay for your website in full';
    copies[0].textContent = 'Review your proposal and pay the full website price securely through Stripe.';
    headings[1].textContent = 'Launch with no build balance';
    copies[1].textContent = 'We finish and launch your website. No additional website build payment is due.';
    document.querySelector('.terms a').href = '/full-payment-terms/';
  }
  if (!hostingOnly && proposal.monthlyHosting === 0) {
    document.querySelector('.hosting').hidden = true;
    $('timeline').lastElementChild.hidden = true;
    $('intro-lead').textContent = full ? 'One upfront website payment. No build balance at launch and no recurring hosting.' : 'A clear website build price: half upfront, half at launch. No recurring hosting.';
  }
  if (domain) {
    $('domain-row').hidden = false; $('domain-name').textContent = proposal.domainName;
    $('domain-price').textContent = money(proposal.domainAmount);
    $('domain-description').textContent = `${money(proposal.domainAmount)} due today for the first year. Renews automatically at ${money(proposal.domainAmount)}/year, starting one year after this payment, until canceled. Billed separately from monthly hosting.`;
    $('deposit').textContent = money(proposal.totalDue); $('due-label').textContent = 'Total due today';
    if (hostingOnly) {
      $('timeline').querySelector('h2').textContent = 'Register your domain';
      $('timeline').querySelector('p').textContent = 'Pay for the first year of your domain and save your card securely. Monthly hosting starts at launch.';
      $('checkout').textContent = 'Continue to secure checkout ↗';
      document.querySelector('.secure').textContent = 'Your payment is processed securely by Stripe.';
      $('closed').textContent = 'This proposal is no longer open for payment. Contact us if you need help.';
    }
  }
  if (proposal.kind === 'hosting_only_v1' && proposal.active) {
    $('checkout').href = '#';
    $('checkout').addEventListener('click', async event => {
      event.preventDefault();
      if ($('checkout').getAttribute('aria-disabled') === 'true') return;
      $('checkout').setAttribute('aria-disabled', 'true'); $('checkout').textContent = 'Opening secure card setup…';
      try {
        const response = await fetch('/api/hosting-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }), referrerPolicy: 'no-referrer' });
        const data = await response.json();
        if (!response.ok || !/^https:\/\/checkout\.stripe\.com\//.test(data.checkoutUrl || '')) throw new Error(data.error || 'Unable to open Stripe.');
        location.assign(data.checkoutUrl);
      } catch (error) {
        $('closed').textContent = error.message; $('closed').hidden = false;
        $('checkout').setAttribute('aria-disabled', 'false'); $('checkout').textContent = 'Accept plan & save card ↗';
      }
    });
  } else if (proposal.preview) {
    $('test-mode').textContent = 'Layout preview · Example pricing · Checkout disabled';
    $('checkout').setAttribute('aria-disabled', 'true');
  } else if (proposal.active && /^https:\/\/buy\.stripe\.com\//.test(proposal.checkoutUrl)) $('checkout').href = proposal.checkoutUrl;
  else { $('checkout').hidden = true; $('closed').hidden = false; }
  const paragraphs = hostingOnly ? [
    `My website build is included. ${domain ? 'The domain registration charge shown above is due today.' : 'Nothing is due today.'} I authorize Limitless Marketing Group LLC to securely save my card through Stripe.`,
    `I authorize $${(proposal.monthlyHosting / 100).toFixed(2)} USD in monthly hosting, with the first payment charged when my website launches, then monthly until canceled. The team will notify me when my website launches.`,
    'Additional services or hosting price changes require my separate approval. My bank may require additional verification.',
    'I can request cancellation of future hosting renewals by emailing contact@nolimitwebs.com before the next renewal. The service end date will be confirmed in writing.',
    'I will accept these hosting billing terms in Stripe before saving my card.'
  ] : full ? [
    `I authorize Limitless Marketing Group LLC to collect the full ${money(proposal.buildTotal)} USD website build price and securely save my card through Stripe.`,
    proposal.monthlyHosting > 0 ? `No build balance is due at launch. I authorize ${money(proposal.monthlyHosting)} USD in monthly hosting starting 30 days after my website launches, then monthly until canceled. The team will confirm my launch date and first hosting billing date.` : 'No build balance is due at launch and no recurring hosting is included.',
    'Additional services or hosting price changes require my separate approval. My bank may require further verification.',
    'I can request cancellation of future hosting renewals at contact@nolimitwebs.com before the next renewal. The service end date will be confirmed in writing.',
    'I will accept these full-payment billing terms in Stripe before paying.'
  ] : [
    `I authorize Limitless Marketing Group LLC to collect my ${money(proposal.deposit)} USD deposit and securely save the payment method I provide through Stripe.`,
    proposal.monthlyHosting > 0 ? `I authorize the remaining ${money(proposal.balance)} USD build balance to be charged when my website goes live, and ${money(proposal.monthlyHosting)} USD in monthly hosting starting 30 days after launch. Hosting continues monthly until canceled. The team will notify me of the launch date and first hosting billing date.` : `I authorize the remaining ${money(proposal.balance)} USD build balance to be charged when my website goes live. No recurring hosting is included.`,
    'Additional services or hosting price changes require my separate approval. A payment may require additional bank verification, and I agree to update my payment method if needed.',
    'I can request cancellation of future hosting renewals by emailing contact@nolimitwebs.com before the next renewal. Cancellation does not cancel an outstanding website build balance. The service end date will be confirmed in writing.',
    'I will be asked to accept these billing terms in Stripe before paying.',
  ];
  if (domain) paragraphs.push(`I authorize ${money(proposal.domainAmount)} USD today for the first year of ${proposal.domainName}, then automatic annual charges of the same amount starting one year after this payment until canceled. Domain renewals are billed separately from hosting. I can cancel future domain billing at contact@nolimitwebs.com before renewal. Price changes require separate approval. Canceling hosting does not cancel domain renewal billing.`);
  for (const text of paragraphs.filter(text => proposal.monthlyHosting > 0 || !text.startsWith('I can request cancellation'))) { const p = document.createElement('p'); p.textContent = text; $('authorization').append(p); }
  $('details').hidden = false; $('intro').hidden = false;
} catch (error) {
  $('error-text').textContent = error.message || 'We could not load your proposal. Please contact our team.';
  $('error').hidden = false;
} finally { $('loading').hidden = true; }
