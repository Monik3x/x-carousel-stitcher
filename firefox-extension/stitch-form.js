(function () {
  "use strict";

  const input = document.getElementById("url-input");
  document.getElementById("clear-source").addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });

  globalThis.updateStitchLayoutFields = function (direction) {
    const grid = direction === "grid";
    document.getElementById("cols-field").classList.toggle("hidden", !grid);
    document.getElementById("overlap-input").disabled = grid;
    document.getElementById("trim-help").textContent = grid
      ? "Grid keeps every panel uncropped."
      : `Crop the ${direction === "vertical" ? "top" : "left"} edge after the first panel.`;
  };
})();
