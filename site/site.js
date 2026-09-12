(function () {
  var EMAIL = "contact@nolimitwebs.com";
  var TEL   = "+13855272738";
  var SB_URL = "https://sdpmvuedcfepbedntdev.supabase.co";
  var SB_KEY = "sb_publishable_Bp9zkkMoU2Sg728Lzh1p1g_TsOqsBqn";

  var nav = document.querySelector('.nav');
  var bar = document.querySelector('.mobileBar');
  var hero = document.getElementById('top');

  function onScroll(){ if (nav) nav.setAttribute('data-scrolled', String(window.scrollY > 12)); }
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  var navToggle = document.querySelector('.navToggle');
  var navMenu = document.querySelector('.navMenu');
  if (navToggle && navMenu && nav) {
    navToggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      navToggle.setAttribute('aria-expanded', String(!open));
      navToggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    });
    navMenu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.setAttribute('data-open', 'false');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.setAttribute('aria-label', 'Open menu');
      });
    });
  }

  if (bar && hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (e) {
      bar.setAttribute('data-visible', e[0].isIntersecting ? 'false' : 'true');
    }, { rootMargin: '-40px 0px 0px 0px' }).observe(hero);
  }

  // Reviews carousel: slow continuous drift, seamless loop, pauses on hover/touch,
  // arrows nudge by one card. Falls back to a plain scrollable row when the
  // visitor prefers reduced motion.
  (function () {
    var wrap = document.querySelector('[data-carousel]');
    var rail = wrap && wrap.querySelector('.quoteRail');
    if (!rail) return;
    var cards = Array.prototype.slice.call(rail.children);
    if (cards.length < 2) return;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    cards.forEach(function (c) { var d = c.cloneNode(true); d.setAttribute('aria-hidden', 'true'); rail.appendChild(d); });
    rail.classList.add('isCarousel');
    var x = 0, paused = false, last = null, speed = reduce ? 0 : 28; // px per second
    function loopWidth(){ var first = cards[0], gap = parseFloat(getComputedStyle(rail).columnGap || getComputedStyle(rail).gap) || 0; return (first.offsetWidth + gap) * cards.length; }
    function apply(){ var w = loopWidth(); if (w > 0) { x = ((x % w) + w) % w; } rail.style.transform = 'translate3d(' + (-x) + 'px,0,0)'; }
    function tick(ts){ if (last !== null && !paused) { x += speed * (ts - last) / 1000; apply(); } last = ts; requestAnimationFrame(tick); }
    if (speed) requestAnimationFrame(tick);
    wrap.addEventListener('mouseenter', function(){ paused = true; });
    wrap.addEventListener('mouseleave', function(){ paused = false; });
    wrap.addEventListener('focusin', function(){ paused = true; });
    wrap.addEventListener('focusout', function(){ paused = false; });
    var startX = null, startOffset = 0;
    rail.addEventListener('touchstart', function(e){ paused = true; startX = e.touches[0].clientX; startOffset = x; }, { passive: true });
    rail.addEventListener('touchmove', function(e){ if (startX === null) return; x = startOffset + (startX - e.touches[0].clientX); apply(); }, { passive: true });
    rail.addEventListener('touchend', function(){ startX = null; setTimeout(function(){ paused = false; }, 1500); });
    function step(dir){ var w = loopWidth() / cards.length; var target = Math.round(x / w) * w + dir * w; var from = x, t0 = null;
      function anim(ts){ if (t0 === null) t0 = ts; var p = Math.min(1, (ts - t0) / 420); x = from + (target - from) * easeInOutCubic(p); apply(); if (p < 1) requestAnimationFrame(anim); }
      requestAnimationFrame(anim); }
    wrap.querySelector('.carouselPrev').addEventListener('click', function(){ step(-1); });
    wrap.querySelector('.carouselNext').addEventListener('click', function(){ step(1); });
    window.addEventListener('resize', apply);
    apply();
  })();

  // Reveal on scroll
  var rv = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    rv.forEach(function (el) { if (el.getBoundingClientRect().top > window.innerHeight) el.classList.add('revealPending'); io.observe(el); });
  } else { rv.forEach(function (el) { el.classList.add('in'); }); }

  // In-page scrolling with a proper header offset, identical in every browser.
  function headerOffset(){ return (nav ? nav.offsetHeight : 74) + 10; }
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function easeInOutCubic(t){ return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  function scrollToY(targetY, done){
    targetY = Math.max(0, Math.min(targetY, document.documentElement.scrollHeight - window.innerHeight));
    var startY = window.pageYOffset, delta = targetY - startY;
    if (reduceMotion || Math.abs(delta) < 2){ window.scrollTo(0, targetY); if(done) done(); return; }
    var dur = Math.min(900, Math.max(380, Math.abs(delta) * 0.5)), t0 = null;
    function step(ts){
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      window.scrollTo(0, Math.round(startY + delta * easeInOutCubic(p)));
      if (p < 1) requestAnimationFrame(step); else if (done) done();
    }
    requestAnimationFrame(step);
  }
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    var y = el.getBoundingClientRect().top + window.pageYOffset - headerOffset();
    scrollToY(y, function(){
      history.replaceState(null, '', '#' + id);
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    });
  }, false);
  if (location.hash.length > 1) {
    var initial = document.getElementById(location.hash.slice(1));
    if (initial) {
      window.scrollTo(0, 0);
      setTimeout(function(){ scrollToY(initial.getBoundingClientRect().top + window.pageYOffset - headerOffset()); }, 60);
    }
  }

  // Lead form -> Supabase (portfolio_leads), same pipeline as before.
  var form = document.querySelector('form.formPanel');
  if (!form) return;
  var val = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ''; };
  function clearErrors(){
    form.querySelectorAll('.fieldError').forEach(function(n){ n.remove(); });
    form.querySelectorAll('[aria-invalid="true"]').forEach(function(n){ n.setAttribute('aria-invalid','false'); });
    var fe = form.querySelector('.formError'); if (fe) fe.remove();
  }
  function fail(field, msg){
    var el = form.querySelector('[name="' + field + '"]');
    if (!el) return;
    el.setAttribute('aria-invalid','true');
    var s = document.createElement('span'); s.className = 'fieldError'; s.textContent = msg;
    el.parentNode.appendChild(s); el.focus();
  }
  function formLevelError(msg){
    var p = document.createElement('p'); p.className = 'formError'; p.setAttribute('role','alert');
    p.innerHTML = msg + ' You can also call <a href="tel:' + TEL + '">(385) 527-2738</a> or email <a href="mailto:' + EMAIL + '">' + EMAIL + '</a>.';
    form.appendChild(p);
  }
  function done(){
    var d = document.createElement('div'); d.className = 'formPanel formDone'; d.setAttribute('role','status');
    d.innerHTML = '<b>Request received.</b><p>We&rsquo;ll be in touch within one business day to set up your free mockup. If it&rsquo;s urgent, call <a href="tel:' + TEL + '">(385) 527-2738</a>.</p>';
    form.replaceWith(d);
    d.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (val('company_website')) { done(); return; }
    clearErrors();
    var name = val('name'), phone = val('phone'), email = val('email');
    if (!name) return fail('name', 'Please add your name.');
    if (!phone && !email) return fail('phone', 'Add a phone number or an email so we can reach you.');
    var btn = form.querySelector('button[type=submit]');
    var label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Sending&hellip;'; }
    fetch(SB_URL + '/rest/v1/portfolio_leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'apikey': SB_KEY, 'authorization': 'Bearer ' + SB_KEY, 'prefer': 'return=minimal' },
      body: JSON.stringify({ name: name, business: val('business'), phone: phone, email: email, message: val('message'), source: 'portfolio' })
    }).then(function (r) {
      if (r.ok) { done(); return; }
      throw new Error('status ' + r.status);
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
      formLevelError("We couldn't send that just now.");
    });
  });
})();
