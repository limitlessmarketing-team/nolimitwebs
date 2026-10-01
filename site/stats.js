/* "By the numbers" count-up stats, ported from freebuiltwebs.com.
 * Each number counts with easeOutExpo over 2s once the row is 20% in view,
 * staggered left to right. The $0 counts DOWN from the agency price, then the
 * agency price is struck through and a lime swoosh draws under $0. Final
 * values are in the HTML, so without JS (or with reduced motion) it reads fine. */
(function () {
  "use strict";
  var root = document.querySelector(".stats");
  if (!root) return;
  var nums = Array.prototype.slice.call(root.querySelectorAll("[data-to]"));
  if (!nums.length) return;
  var DURATION = 2000, STAGGER = 150;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  function fmt(v) { return Math.round(v).toLocaleString("en-US"); }
  if (reduce || !("IntersectionObserver" in window) || !window.requestAnimationFrame) {
    root.classList.add("is-done");
    return;
  }
  nums.forEach(function (el) { el.textContent = fmt(+el.getAttribute("data-from") || 0); });
  function run() {
    var start = performance.now();
    function frame(now) {
      var finished = true;
      nums.forEach(function (el, i) {
        var from = +el.getAttribute("data-from") || 0, to = +el.getAttribute("data-to");
        var t = Math.min(Math.max((now - start - i * STAGGER) / DURATION, 0), 1);
        el.textContent = fmt(from + (to - from) * easeOutExpo(t));
        if (t < 1) finished = false;
      });
      if (finished) {
        nums.forEach(function (el) { el.textContent = fmt(+el.getAttribute("data-to")); });
        root.classList.add("is-done");
      } else {
        requestAnimationFrame(frame);
      }
    }
    requestAnimationFrame(frame);
  }
  var io = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) { io.disconnect(); run(); }
  }, { threshold: 0.2 });
  io.observe(root.querySelector(".stats__row") || root);
})();
