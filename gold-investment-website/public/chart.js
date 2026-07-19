// Gold price line chart — dependency-free SVG with crosshair tooltip.
// Exposes window.renderPriceChart(container, points) and
// window.renderPriceTable(tbody, points); points = [{ date, ratePerGram }].
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const money = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function monthLabel(dateStr) {
    const d = new Date(dateStr);
    return MONTHS[d.getMonth()] + " " + String(d.getFullYear()).slice(2);
  }
  function longLabel(dateStr) {
    const d = new Date(dateStr);
    return MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  window.renderPriceTable = function (tbody, points) {
    tbody.innerHTML = "";
    points.forEach((p) => {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = longLabel(p.date);
      const td2 = document.createElement("td");
      td2.textContent = money(p.ratePerGram);
      td2.className = "num";
      tr.append(td1, td2);
      tbody.appendChild(tr);
    });
  };

  window.renderPriceChart = function (container, points) {
    container.innerHTML = "";
    if (!points || points.length < 2) return;

    const W = 720, H = 300, padL = 64, padR = 24, padT = 20, padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const rates = points.map((p) => p.ratePerGram);
    const yMin = Math.floor((Math.min(...rates) * 0.97) / 500) * 500;
    const yMax = Math.ceil((Math.max(...rates) * 1.02) / 500) * 500;

    const x = (i) => padL + (i * plotW) / (points.length - 1);
    const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "price-chart-svg", role: "img" });

    // Gradient for the area fill
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: "goldGrad", x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#c9a24b", "stop-opacity": 0.35 }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#c9a24b", "stop-opacity": 0 }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Horizontal grid + y labels
    const tickCount = 4;
    for (let t = 0; t <= tickCount; t++) {
      const v = yMin + ((yMax - yMin) * t) / tickCount;
      const gy = y(v);
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "chart-grid" }));
      const label = svgEl("text", { x: padL - 8, y: gy + 4, "text-anchor": "end", class: "chart-axis-text" });
      label.textContent = money(v);
      svg.appendChild(label);
    }

    // X labels (about 6, always including the last)
    const step = Math.max(1, Math.round(points.length / 6));
    for (let i = 0; i < points.length; i += step) {
      const label = svgEl("text", { x: x(i), y: H - padB + 20, "text-anchor": "middle", class: "chart-axis-text" });
      label.textContent = monthLabel(points[i].date);
      svg.appendChild(label);
    }

    // Area + line
    const lineD = points.map((p, i) => (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(p.ratePerGram).toFixed(1)).join(" ");
    const areaD = lineD + ` L ${x(points.length - 1).toFixed(1)} ${y(yMin)} L ${padL} ${y(yMin)} Z`;
    svg.appendChild(svgEl("path", { d: areaD, fill: "url(#goldGrad)", stroke: "none" }));
    svg.appendChild(svgEl("path", { d: lineD, class: "chart-line" }));

    // Duty-hike annotation (May 2026)
    const dutyIdx = points.findIndex((p) => p.date.startsWith("2026-05"));
    if (dutyIdx > 0) {
      svg.appendChild(svgEl("line", {
        x1: x(dutyIdx), x2: x(dutyIdx), y1: padT, y2: H - padB, class: "chart-annotation-line",
      }));
      const note = svgEl("text", { x: x(dutyIdx) - 6, y: padT + 12, "text-anchor": "end", class: "chart-annotation-text" });
      note.textContent = "Import duty 6% → 15%";
      svg.appendChild(note);
    }

    // End marker + direct label
    const lastI = points.length - 1;
    const lastP = points[lastI];
    svg.appendChild(svgEl("circle", { cx: x(lastI), cy: y(lastP.ratePerGram), r: 4.5, class: "chart-end-dot" }));
    const endLabel = svgEl("text", {
      x: x(lastI) - 8, y: y(lastP.ratePerGram) - 12, "text-anchor": "end", class: "chart-end-label",
    });
    endLabel.textContent = money(lastP.ratePerGram);
    svg.appendChild(endLabel);

    // Crosshair + tooltip
    const crosshair = svgEl("line", { y1: padT, y2: H - padB, class: "chart-crosshair", visibility: "hidden" });
    const hoverDot = svgEl("circle", { r: 4.5, class: "chart-end-dot", visibility: "hidden" });
    svg.appendChild(crosshair);
    svg.appendChild(hoverDot);

    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    container.style.position = "relative";
    container.appendChild(tooltip);

    const overlay = svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" });
    overlay.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((mx - padL) / plotW) * (points.length - 1))));
      const p = points[i];
      crosshair.setAttribute("x1", x(i));
      crosshair.setAttribute("x2", x(i));
      crosshair.setAttribute("visibility", "visible");
      hoverDot.setAttribute("cx", x(i));
      hoverDot.setAttribute("cy", y(p.ratePerGram));
      hoverDot.setAttribute("visibility", "visible");
      tooltip.textContent = longLabel(p.date) + " · " + money(p.ratePerGram) + "/g";
      tooltip.hidden = false;
      const leftPct = (x(i) / W) * 100;
      tooltip.style.left = Math.min(88, Math.max(12, leftPct)) + "%";
      tooltip.style.top = ((y(p.ratePerGram) / H) * 100) + "%";
    });
    overlay.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      hoverDot.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });
    svg.appendChild(overlay);

    container.appendChild(svg);
  };
})();
