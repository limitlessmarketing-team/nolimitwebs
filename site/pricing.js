/* Pricing cards: "Get started" jumps to the contact form (site.js handles the
 * smooth scroll) and, if the message box is empty, notes which plan they chose. */
(function () {
  "use strict";
  var msg = document.getElementById("f-message");
  if (!msg) return;
  document.querySelectorAll("[data-plan]").forEach(function (a) {
    a.addEventListener("click", function () {
      if (!msg.value.trim()) msg.value = "I'm interested in the " + a.getAttribute("data-plan") + " plan.";
    });
  });
})();
