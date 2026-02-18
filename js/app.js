// Capacitor back button (no-op in browser, active in native)
const { App: CapApp } = window.Capacitor?.Plugins || {};

const isNative = !!(window.Capacitor?.isNativePlatform?.());
let NativeBiometric = null;
try {
  if (isNative && typeof window.Capacitor.registerPlugin === 'function') {
    NativeBiometric = window.Capacitor.registerPlugin('NativeBiometric');
  }
} catch (e) { /* plugin not available */ }
const APP_LOCK_KEY = "utang_tracker_app_lock";

const STORAGE_KEY = "utang_tracker_loans";
const FILTER_KEY = "utang_tracker_filters";
const ACCRUAL_KEY = "utang_tracker_last_accrual";
const LOAN_TYPES = [
  { key: "all", label: "All" },
  { key: "credit_card", label: "Credit Card" },
  { key: "personal", label: "Personal" }
];
const TYPE_LABELS = {
  credit_card: "Credit Cards",
  personal: "Personal"
};

let loans = [];
let activeTab = "all";
let editingId = null;
let paymentLoanId = null;
let paymentAttachmentData = null;
let chargeLoanId = null;
let calcLoanId = null;
let summaryFilters = {}; // { credit_card: true, housing: true, ... }

// ── Helpers ──

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatPHP(amount) {
  return "\u20B1" + Number(amount).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(loans));
}

function load() {
  try { loans = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { loans = []; }
  try { summaryFilters = JSON.parse(localStorage.getItem(FILTER_KEY)) || {}; }
  catch { summaryFilters = {}; }
}

function saveFilters() {
  localStorage.setItem(FILTER_KEY, JSON.stringify(summaryFilters));
}

function saveAccrual(ym) {
  localStorage.setItem(ACCRUAL_KEY, ym);
}

function loadAccrual() {
  return localStorage.getItem(ACCRUAL_KEY);
}

// ── Monthly Auto-Accrual ──

function getCurrentYearMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}

function monthsDiff(fromYM, toYM) {
  const [fy, fm] = fromYM.split("-").map(Number);
  const [ty, tm] = toYM.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function processMonthlyAccruals() {
  const currentYM = getCurrentYearMonth();
  let lastYM = loadAccrual();

  // First time: set to current month, no retroactive charges
  if (!lastYM) {
    saveAccrual(currentYM);
    return 0;
  }

  const missed = monthsDiff(lastYM, currentYM);
  if (missed <= 0) return 0;

  let totalAccruals = 0;

  for (let m = 1; m <= missed; m++) {
    // Calculate the date for this accrual month
    const [ly, lm] = lastYM.split("-").map(Number);
    const accrualDate = new Date(ly, lm - 1 + m, 1);
    const dateStr = accrualDate.toISOString();

    loans.forEach(loan => {
      if (Number(loan.balance) <= 0) return;
      if (!loan.history) loan.history = [];

      // 1. Interest accrual first
      const rate = Number(loan.interestRate) || 0;
      if (rate > 0) {
        const interestAmt = Number(loan.balance) * (rate / 100);
        loan.balance = Number(loan.balance) + interestAmt;
        loan.history.push({
          type: "interest",
          amount: interestAmt,
          note: "Monthly interest (" + rate + "%)",
          date: dateStr,
          balanceAfter: loan.balance
        });
        totalAccruals++;
      }

      // 2. Installment charges (credit cards)
      if (loan.type === "credit_card" && loan.installments && loan.installments.length > 0) {
        loan.installments.forEach(inst => {
          const paidMonths = Number(inst.paidMonths) || 0;
          const totalMonths = Number(inst.totalMonths) || 0;
          const monthlyAmt = Number(inst.monthlyAmount) || 0;
          if (paidMonths < totalMonths && monthlyAmt > 0) {
            loan.balance = Number(loan.balance) + monthlyAmt;
            inst.paidMonths = paidMonths + 1;
            loan.history.push({
              type: "installment",
              amount: monthlyAmt,
              note: "Installment: " + (inst.name || "Installment"),
              date: dateStr,
              balanceAfter: loan.balance
            });
            totalAccruals++;
          }
        });
      }
    });
  }

  if (totalAccruals > 0) {
    save();
  }
  saveAccrual(currentYM);
  return missed;
}

function ordinal(day) {
  const d = Number(day);
  if (!d) return "\u2014";
  const s = ["th", "st", "nd", "rd"];
  const v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function compressImage(dataURL, maxDim, quality, callback) {
  const img = new Image();
  img.onload = function() {
    const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL("image/jpeg", quality));
  };
  img.src = dataURL;
}

function openAttachment(src) {
  const w = window.open();
  w.document.write('<body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="' + src + '" style="max-width:100%;max-height:100vh;object-fit:contain;border-radius:8px;"></body>');
}

// ── Animated close helper ──
function animateClose(overlayId, onClosed) {
  const overlay = document.getElementById(overlayId);
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.classList.remove("open", "closing");
    if (onClosed) onClosed();
  }, 260);
}

// ── Payoff Calculation ──

function calcPayoffMonths(balance, monthlyPay, monthlyRatePct) {
  if (balance <= 0) return { months: 0, paidOff: true };
  if (monthlyPay <= 0) return { months: Infinity, paidOff: false };
  const r = (monthlyRatePct || 0) / 100;
  if (r > 0) {
    if (monthlyPay <= balance * r) return { months: Infinity, paidOff: false };
    const n = -Math.log(1 - (balance * r) / monthlyPay) / Math.log(1 + r);
    const months = Math.ceil(n);
    if (months > 360) return { months: Infinity, paidOff: false };
    return { months: months, paidOff: false };
  }
  const months = Math.ceil(balance / monthlyPay);
  if (months > 360) return { months: Infinity, paidOff: false };
  return { months: months, paidOff: false };
}

function calcPayoffDate(loan) {
  const result = calcPayoffMonths(
    Number(loan.balance) || 0,
    Number(loan.monthlyPayment) || 0,
    loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0
  );
  if (result.months > 0 && result.months < Infinity) {
    const date = new Date();
    date.setMonth(date.getMonth() + result.months);
    result.date = date;
  } else {
    result.date = null;
  }
  return result;
}

// Given target months, how much per month needed?
function calcRequiredPayment(balance, targetMonths, monthlyRatePct) {
  if (balance <= 0 || targetMonths <= 0) return 0;
  const r = (monthlyRatePct || 0) / 100;
  if (r > 0) {
    // P = B * r * (1+r)^n / ((1+r)^n - 1)
    const factor = Math.pow(1 + r, targetMonths);
    return balance * r * factor / (factor - 1);
  }
  return balance / targetMonths;
}

function formatPayoffDate(date) {
  if (!date) return null;
  return date.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
}

// ── Centralized Cycle-by-Cycle Projection ──
// Single source of truth for all projections, payoff plans, and goal breakdowns.
// Returns array of { startBal, interest, instCharge, payment, endBal } per cycle.

function simulatePayoff(balance, monthlyPayment, monthlyRatePct, installments, includeInstallments, maxCycles) {
  var cycles = [];
  var bal = Number(balance) || 0;
  var r = (Number(monthlyRatePct) || 0) / 100;
  var pay = Number(monthlyPayment) || 0;
  if (bal <= 0 || pay <= 0) return cycles;
  var max = maxCycles || 360;

  for (var i = 0; i < max; i++) {
    if (bal <= 0) break;
    var startBal = bal;

    // 1. Interest on current balance
    var interest = startBal * r;
    bal += interest;

    // 2. Installment charges (future only — remaining months for each)
    var instCharge = 0;
    if (includeInstallments && installments && installments.length > 0) {
      installments.forEach(function(inst) {
        var remaining = (Number(inst.totalMonths) || 0) - (Number(inst.paidMonths) || 0);
        if (i < remaining) {
          instCharge += Number(inst.monthlyAmount) || 0;
        }
      });
      bal += instCharge;
    }

    // 3. Payment (capped at balance)
    var actualPay = Math.min(pay, bal);
    bal = Math.max(0, bal - actualPay);

    cycles.push({
      startBal: startBal,
      interest: interest,
      instCharge: instCharge,
      payment: actualPay,
      endBal: bal
    });

    if (bal <= 0) break;

    // Bail early if balance is growing (payment doesn't cover charges)
    if (i >= 2 && bal >= cycles[0].startBal && bal >= startBal) break;
  }

  return cycles;
}

// Derive summary from simulation
function simulationSummary(cycles) {
  if (cycles.length === 0) return { months: Infinity, totalPaid: 0, totalInterest: 0, paidOff: false, balanceGrowing: false };
  var totalPaid = 0, totalInterest = 0;
  cycles.forEach(function(c) { totalPaid += c.payment; totalInterest += c.interest; });
  var paidOff = cycles[cycles.length - 1].endBal <= 0;
  var balanceGrowing = !paidOff && cycles.length > 1 && cycles[cycles.length - 1].endBal >= cycles[0].startBal;
  return { months: cycles.length, totalPaid: totalPaid, totalInterest: totalInterest, paidOff: paidOff, balanceGrowing: balanceGrowing };
}

// ── Summary Filter ──

function getActiveTypes() {
  const existing = {};
  loans.forEach(l => { existing[l.type || "other"] = true; });
  const types = Object.keys(existing);

  // If no filters set yet, all are active
  const hasAnyFilter = types.some(t => summaryFilters[t] !== undefined);
  if (!hasAnyFilter) return types;

  return types.filter(t => summaryFilters[t] !== false);
}

// ── Rendering ──

function renderSummary() {
  const totalEl = document.getElementById("summary-total");
  const breakdownEl = document.getElementById("summary-breakdown");
  const payoffEl = document.getElementById("summary-payoff");
  const filterEl = document.getElementById("summary-filter");

  // Build filter checkboxes
  const existingTypes = {};
  loans.forEach(l => { existingTypes[l.type || "other"] = true; });
  const typeKeys = Object.keys(existingTypes);

  filterEl.innerHTML = "";
  if (typeKeys.length > 1) {
    typeKeys.forEach(type => {
      const isChecked = summaryFilters[type] !== false;
      const label = document.createElement("label");
      label.className = "filter-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isChecked;
      cb.addEventListener("change", () => {
        summaryFilters[type] = cb.checked;
        saveFilters();
        renderSummary();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(TYPE_LABELS[type] || type));
      filterEl.appendChild(label);
    });
  }

  // Filtered total
  const activeTypes = getActiveTypes();
  const filteredLoans = loans.filter(l => activeTypes.includes(l.type || "other"));
  const total = filteredLoans.reduce((s, l) => s + Number(l.balance || 0), 0);
  totalEl.textContent = formatPHP(total);

  // Payoff estimate for filtered
  let latestPayoff = null;
  let hasUnpayable = false;
  filteredLoans.forEach(l => {
    if (l.balance > 0) {
      const p = calcPayoffDate(l);
      if (p.months === Infinity) hasUnpayable = true;
      if (p.date && (!latestPayoff || p.date > latestPayoff)) latestPayoff = p.date;
    }
  });

  if (total <= 0) {
    payoffEl.textContent = "";
  } else if (latestPayoff) {
    let text = "Est. all paid off by: " + formatPayoffDate(latestPayoff);
    if (hasUnpayable) text += " (some loans need higher payments)";
    payoffEl.textContent = text;
  } else {
    payoffEl.textContent = "Plan your payoff below.";
  }

  // Breakdown chips
  const byType = {};
  filteredLoans.forEach(l => {
    const t = l.type || "other";
    byType[t] = (byType[t] || 0) + Number(l.balance || 0);
  });

  breakdownEl.innerHTML = "";
  for (const [type, amount] of Object.entries(byType)) {
    const chip = document.createElement("span");
    chip.className = "summary-chip";
    chip.textContent = (TYPE_LABELS[type] || type) + ": " + formatPHP(amount);
    breakdownEl.appendChild(chip);
  }

  if (loans.length === 0) {
    breakdownEl.innerHTML = '<span class="summary-chip">No loans added yet</span>';
  }
}

function renderTabs() {
  const container = document.getElementById("tabs");
  container.innerHTML = "";
  LOAN_TYPES.forEach(t => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (activeTab === t.key ? " active" : "");
    btn.textContent = t.label;
    const count = t.key === "all" ? loans.length : loans.filter(l => l.type === t.key).length;
    if (count > 0) btn.textContent += " (" + count + ")";
    btn.addEventListener("click", () => {
      activeTab = t.key;
      renderTabs();
      renderLoans();
    });
    container.appendChild(btn);
  });
}

function renderLoans() {
  const container = document.getElementById("loan-list");
  const filtered = activeTab === "all" ? loans : loans.filter(l => l.type === activeTab);

  if (filtered.length === 0) {
    const typeText = activeTab === "all" ? "" : activeTab.replace("_", " ") + " ";
    container.innerHTML =
      '<div class="loan-list-empty">' +
        '<div class="empty-icon">\uD83D\uDCCB</div>' +
        '<p>No ' + typeText + 'loans yet.</p>' +
        '<p style="font-size:0.85rem;margin-top:6px;">Tap + to add one.</p>' +
      '</div>';
    return;
  }

  container.innerHTML = "";
  filtered.forEach(loan => {
    const card = document.createElement("div");
    card.className = "loan-card";
    card.dataset.type = loan.type;

    const isPaidOff = Number(loan.balance) <= 0;
    if (isPaidOff) card.classList.add("paid-off");

    const title = loan.nickname || loan.lenderName || loan.bank || "Loan";
    const bank = loan.bank || loan.lenderName || "";

    const history = loan.history || [];
    const totalPaid = history.filter(h => h.type === "payment").reduce((s, h) => s + h.amount, 0);

    // Payoff calculation — use full simulation when installments are included
    var payoff;
    var loanInclInst = loan.includeInstallments !== false;
    var hasActiveInst = loan.installments && loan.installments.some(function(inst) {
      return (Number(inst.paidMonths) || 0) < (Number(inst.totalMonths) || 0);
    });
    if (loanInclInst && hasActiveInst) {
      var loanRate = loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0;
      var sim = simulatePayoff(Number(loan.balance), Number(loan.monthlyPayment) || 0, loanRate, loan.installments, true, 360);
      var simSum = simulationSummary(sim);
      if (simSum.paidOff) {
        var d = new Date();
        d.setMonth(d.getMonth() + simSum.months);
        payoff = { months: simSum.months, date: d, paidOff: false };
      } else {
        payoff = { months: Infinity, date: null, paidOff: false };
      }
    } else {
      payoff = calcPayoffDate(loan);
    }

    // Details — vertical layout
    let detailsHTML = "";
    if (loan.type === "credit_card") {
      detailsHTML =
        '<div class="loan-card-detail"><span>Interest Rate</span><strong>' + loan.interestRate + '%/mo</strong></div>' +
        '<div class="loan-card-detail"><span>Due Date</span><strong>Every ' + ordinal(loan.dueDate) + '</strong></div>' +
        '<div class="loan-card-detail"><span>Monthly Payment</span><strong>' + formatPHP(loan.monthlyPayment || 0) + '</strong></div>' +
        '<div class="loan-card-detail"><span>Credit Limit</span><strong>' + formatPHP(loan.creditLimit || 0) + '</strong></div>';
    } else {
      detailsHTML =
        '<div class="loan-card-detail"><span>Interest Rate</span><strong>' + (loan.interestRate || 0) + '%</strong></div>' +
        '<div class="loan-card-detail"><span>Due Date</span><strong>Every ' + ordinal(loan.dueDate) + '</strong></div>' +
        '<div class="loan-card-detail"><span>Monthly Payment</span><strong>' + formatPHP(loan.monthlyPayment || 0) + '</strong></div>' +
        '<div class="loan-card-detail"><span>Term</span><strong>' + (loan.loanTerm ? (isNaN(Number(loan.loanTerm)) ? loan.loanTerm : loan.loanTerm + ' months') : 'N/A') + '</strong></div>';
    }

    // Payoff line
    let payoffHTML = "";
    if (isPaidOff) {
      payoffHTML = '<div class="loan-card-payoff">PAID OFF</div>';
    } else if (payoff.date) {
      payoffHTML = '<div class="loan-card-payoff">Est. paid off: ' + formatPayoffDate(payoff.date) + ' (' + payoff.months + ' months)</div>';
    } else if (payoff.months === Infinity && Number(loan.monthlyPayment) > 0) {
      payoffHTML = '<div class="loan-card-interest-note">Payment doesn\'t cover monthly charges. Increase your monthly payment.</div>';
    }

    // Interest note for CC
    let interestNote = "";
    if (loan.type === "credit_card" && loan.balance > 0) {
      const monthlyInterest = Number(loan.balance) * Number(loan.interestRate) / 100;
      interestNote = '<div class="loan-card-interest-note">' +
        'Est. monthly interest: <strong>' + formatPHP(monthlyInterest) + '</strong>' +
        '</div>';
    }

    // Installments section (credit card only) — simplified display
    let installmentsHTML = "";
    if (loan.type === "credit_card" && loan.installments && loan.installments.length > 0) {
      installmentsHTML = '<div class="loan-card-installments"><h5>Installments</h5>';
      loan.installments.forEach(inst => {
        const paidMonths = Number(inst.paidMonths) || 0;
        const totalMonths = Number(inst.totalMonths) || 1;
        const monthlyAmt = Number(inst.monthlyAmount) || 0;
        const pct = Math.min(100, Math.round((paidMonths / totalMonths) * 100));
        installmentsHTML +=
          '<div class="installment-item">' +
            '<div>' +
              '<div class="inst-name">' + escapeHtml(inst.name || "Installment") + '</div>' +
              '<div class="installment-progress"><div class="installment-progress-bar" style="width:' + pct + '%"></div></div>' +
            '</div>' +
            '<div class="inst-detail">' +
              formatPHP(monthlyAmt) + '/mo &middot; ' + paidMonths + '/' + totalMonths +
            '</div>' +
          '</div>';
      });
      installmentsHTML += '</div>';

      // Installment toggle for projections
      var hasActiveInstallments = loan.installments.some(function(inst) {
        return (Number(inst.paidMonths) || 0) < (Number(inst.totalMonths) || 0);
      });
      if (hasActiveInstallments && !isPaidOff) {
        var inclInst = loan.includeInstallments !== false; // default true
        installmentsHTML +=
          '<label class="inst-toggle">' +
            '<input type="checkbox" class="inst-toggle-cb" ' + (inclInst ? 'checked' : '') + '>' +
            '<span>Include future installment charges in projections</span>' +
          '</label>' +
          '<div class="inst-toggle-hint">' +
            (inclInst
              ? 'Upcoming installment charges will be included in payoff calculations.'
              : 'Payoff calculations will use current balance only.') +
          '</div>';
      }
    }

    // Personal loan segmented payment progress bar
    let personalProgressHTML = "";
    if (loan.type === "personal") {
      var termMonths = parseInt(loan.loanTerm) || 0;
      var plMonthlyPay = Number(loan.monthlyPayment) || 0;
      if (termMonths > 0 && plMonthlyPay > 0) {
        // Proportional fill per segment — based on total payments vs monthly target
        var plSegsHTML = "";
        for (var si = 0; si < termMonths; si++) {
          var plSegStart = si * plMonthlyPay;
          var plSegEnd = (si + 1) * plMonthlyPay;
          var plFillPct;
          if (totalPaid >= plSegEnd) {
            plFillPct = 100;
          } else if (totalPaid <= plSegStart) {
            plFillPct = 0;
          } else {
            plFillPct = Math.min(100, ((totalPaid - plSegStart) / plMonthlyPay) * 100);
          }
          plSegsHTML += '<div class="pl-seg"><div class="pl-seg-fill" style="width:' + plFillPct.toFixed(1) + '%"></div></div>';
        }
        var paidMonthsCount = Math.min(termMonths, Math.floor(totalPaid / plMonthlyPay));
        personalProgressHTML =
          '<div class="pl-progress-section">' +
            '<div class="pl-progress-header">' +
              '<span>Payment Progress</span>' +
              '<span class="pl-progress-count">' + paidMonthsCount + ' / ' + termMonths + ' months</span>' +
            '</div>' +
            '<div class="pl-progress-bar">' + plSegsHTML + '</div>' +
            '<div class="pl-progress-detail">' +
              formatPHP(totalPaid) + ' paid &bull; ' + formatPHP(plMonthlyPay * termMonths) + ' total' +
            '</div>' +
          '</div>';
      }
    }

    // Goal progress bar — debt-elimination-based
    // Source of truth: current balance vs start balance (never sums payments)
    let goalHTML = "";
    if (loan.goal) {
      const startBal = loan.goal.startBalance;
      const remainingDebt = Math.max(0, Number(loan.balance));
      const paidDown = Math.max(0, startBal - remainingDebt);
      const debtPct = startBal > 0 ? Math.min(100, Math.round((paidDown / startBal) * 100)) : 100;
      const targetDate = formatPayoffDate(new Date(loan.goal.targetDate));
      const totalSegs = loan.goal.targetMonths;
      const goalComplete = remainingDebt <= 0;

      // Count due date cycles elapsed since goal was set
      const dueDay = Number(loan.dueDate) || 1;
      const goalSetDate = new Date(loan.goal.setAt);
      const now = new Date();
      var firstDue = new Date(goalSetDate.getFullYear(), goalSetDate.getMonth(), dueDay);
      if (firstDue <= goalSetDate) {
        firstDue.setMonth(firstDue.getMonth() + 1);
      }
      var cyclesElapsed = 0;
      var checkDate = new Date(firstDue);
      while (checkDate <= now && cyclesElapsed < totalSegs) {
        cyclesElapsed++;
        checkDate.setMonth(checkDate.getMonth() + 1);
      }

      // Proportional segment fill — each segment represents one goal cycle payment
      // Fill is based on balance reduction (debt-elimination logic), not raw payments
      var goalSegTarget = Number(loan.goal.monthlyPayment);
      let segsHTML = '';
      for (let i = 0; i < totalSegs; i++) {
        var gSegStart = i * goalSegTarget;
        var gSegEnd = (i + 1) * goalSegTarget;
        var gFillPct;
        if (goalComplete || paidDown >= gSegEnd) {
          gFillPct = 100;
        } else if (paidDown <= gSegStart) {
          gFillPct = 0;
        } else {
          gFillPct = Math.min(100, ((paidDown - gSegStart) / goalSegTarget) * 100);
        }
        segsHTML += '<div class="goal-seg"><div class="goal-seg-fill" style="width:' + gFillPct.toFixed(1) + '%"></div></div>';
      }

      // Goal cycle breakdown (uses simulatePayoff)
      var inclInst = loan.includeInstallments !== false;
      var goalCycles = simulatePayoff(
        loan.goal.startBalance,
        loan.goal.monthlyPayment,
        loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0,
        loan.installments || [],
        inclInst,
        totalSegs
      );
      var breakdownHTML = '';
      goalCycles.forEach(function(c, idx) {
        breakdownHTML +=
          '<div class="goal-cycle-row">' +
            '<div class="goal-cycle-num">Month ' + (idx + 1) + '</div>' +
            '<div class="goal-cycle-details">' +
              '<div>Starting: <strong>' + formatPHP(c.startBal) + '</strong></div>' +
              '<div class="goal-cycle-add">+ Interest: ' + formatPHP(c.interest) + '</div>' +
              (c.instCharge > 0 ? '<div class="goal-cycle-add">+ Installments: ' + formatPHP(c.instCharge) + '</div>' : '') +
              '<div class="goal-cycle-sub">&minus; Payment: ' + formatPHP(c.payment) + '</div>' +
              '<div class="goal-cycle-end">= Ending: <strong>' + formatPHP(c.endBal) + '</strong></div>' +
            '</div>' +
          '</div>';
      });
      if (goalCycles.length > 0 && goalCycles[goalCycles.length - 1].endBal <= 0 && goalCycles.length < totalSegs) {
        breakdownHTML += '<div class="goal-cycle-early">Goal completed early at month ' + goalCycles.length + '!</div>';
      }

      goalHTML =
        '<div class="goal-bar-section' + (goalComplete ? ' goal-reached' : '') + '">' +
          '<div class="goal-bar-header">' +
            '<span>' + (goalComplete ? 'Goal reached!' : 'Goal: ' + formatPHP(loan.goal.monthlyPayment) + '/mo for ' + totalSegs + ' months') + '</span>' +
            '<button class="goal-remove" title="Remove goal">&times;</button>' +
          '</div>' +
          '<div class="goal-bar-segmented">' + segsHTML + '</div>' +
          '<div class="goal-bar-detail">' +
            'Debt progress: ' + debtPct + '% &bull; ' +
            'Cycle progress: ' + cyclesElapsed + '/' + totalSegs +
            (goalComplete ? '' : ' &bull; Target: ' + targetDate) +
          '</div>' +
          '<div class="goal-bar-remaining">' +
            '<div>Paid down: <strong>' + formatPHP(paidDown) + '</strong></div>' +
            '<div>' + (goalComplete ? 'Debt eliminated!' : 'Remaining debt: <strong>' + formatPHP(remainingDebt) + '</strong>') + '</div>' +
          '</div>' +
          '<div class="goal-bar-hint">Progress based on balance reduction, not payment totals.</div>' +
          '<button class="goal-breakdown-toggle">' +
            'View Goal Cycle Breakdown <span class="arrow">&#9660;</span>' +
          '</button>' +
          '<div class="goal-breakdown-content">' + breakdownHTML + '</div>' +
        '</div>';
    }

    // Action buttons — priority: Payment → Calculator → Charge → Payoff Plan
    let btnsHTML = '<div class="loan-card-btns">';
    if (!isPaidOff) {
      btnsHTML += '<button class="btn-pay">Make Payment</button>';
    }
    if (loan.type === "credit_card" && !isPaidOff) {
      btnsHTML += '<button class="btn-calc">Calculator</button>';
      btnsHTML += '<button class="btn-charge">Add Charge</button>';
    }
    if (!isPaidOff && Number(loan.balance) > 0) {
      btnsHTML += '<button class="btn-payoff-plan">Payoff Plan</button>';
    }
    btnsHTML += '<button class="btn-export">Export</button>';
    btnsHTML += '</div>';

    // Total paid line
    let paidLine = "";
    if (totalPaid > 0) {
      paidLine = '<div class="loan-card-paid">Total paid: ' + formatPHP(totalPaid) + '</div>';
    }

    // History toggle
    let historyToggleHTML = "";
    let historyContentHTML = "";
    if (history.length > 0) {
      historyToggleHTML =
        '<button class="loan-card-history-toggle" data-loan-id="' + loan.id + '">' +
          'Transaction History (' + history.length + ') <span class="arrow">\u25BC</span>' +
        '</button>';
      historyContentHTML = '<div class="loan-card-history" data-history-id="' + loan.id + '">';
      history.slice().reverse().forEach(entry => {
        const clsMap = { payment: "ih-payment", charge: "ih-charge", interest: "ih-interest", installment: "ih-installment" };
        const cls = clsMap[entry.type] || "ih-charge";
        const sign = entry.type === "payment" ? "-" : "+";
        historyContentHTML +=
          '<div class="inline-history-entry">' +
            '<div>' +
              '<span class="ih-amount ' + cls + '">' + sign + formatPHP(entry.amount) + '</span>' +
              (entry.note ? ' <span style="color:#6c757d;font-size:0.72rem;font-style:italic;">' + escapeHtml(entry.note) + '</span>' : '') +
            '</div>' +
            '<div class="ih-meta">' +
              formatDate(entry.date) +
              (entry.balanceAfter !== undefined ? '<br><span class="ih-balance">Bal: ' + formatPHP(entry.balanceAfter) + '</span>' : '') +
            '</div>' +
          '</div>';
      });
      historyContentHTML += '</div>';
    }

    card.innerHTML =
      '<div class="loan-card-header">' +
        '<div>' +
          '<div class="loan-card-title">' + escapeHtml(title) + '</div>' +
          '<div class="loan-card-bank">' + escapeHtml(bank) + '</div>' +
        '</div>' +
        '<div class="loan-card-actions">' +
          '<button class="btn-edit" title="Edit">\u270F\uFE0F</button>' +
          '<button class="btn-delete" title="Delete">\uD83D\uDDD1\uFE0F</button>' +
        '</div>' +
      '</div>' +
      '<div class="loan-card-amount">' + formatPHP(loan.balance) + '</div>' +
      paidLine +
      '<div class="loan-card-details">' + detailsHTML + '</div>' +
      payoffHTML +
      interestNote +
      installmentsHTML +
      personalProgressHTML +
      goalHTML +
      btnsHTML +
      historyToggleHTML +
      historyContentHTML;

    // Event listeners
    card.querySelector(".btn-edit").addEventListener("click", () => openModal(loan.id));
    card.querySelector(".btn-delete").addEventListener("click", () => confirmDelete(loan.id));

    const payBtn = card.querySelector(".btn-pay");
    if (payBtn) payBtn.addEventListener("click", () => openPaymentModal(loan.id));

    const chargeBtn = card.querySelector(".btn-charge");
    if (chargeBtn) chargeBtn.addEventListener("click", () => openChargeModal(loan.id));

    const calcBtn = card.querySelector(".btn-calc");
    if (calcBtn) calcBtn.addEventListener("click", () => openCalcModal(loan.id));

    const planBtn = card.querySelector(".btn-payoff-plan");
    if (planBtn) planBtn.addEventListener("click", () => openPayoffPlanModal(loan.id));

    const exportBtn = card.querySelector(".btn-export");
    if (exportBtn) exportBtn.addEventListener("click", () => openExportModal(loan.id));

    const instToggle = card.querySelector(".inst-toggle-cb");
    if (instToggle) {
      instToggle.addEventListener("change", () => {
        loan.includeInstallments = instToggle.checked;
        save();
        renderAll();
      });
    }

    const goalBreakdownToggle = card.querySelector(".goal-breakdown-toggle");
    if (goalBreakdownToggle) {
      goalBreakdownToggle.addEventListener("click", () => {
        goalBreakdownToggle.classList.toggle("expanded");
        const content = card.querySelector(".goal-breakdown-content");
        if (content) content.classList.toggle("open");
      });
    }

    const goalRemoveBtn = card.querySelector(".goal-remove");
    if (goalRemoveBtn) {
      goalRemoveBtn.addEventListener("click", () => {
        delete loan.goal;
        save();
        renderAll();
      });
    }

    const histToggle = card.querySelector(".loan-card-history-toggle");
    if (histToggle) {
      histToggle.addEventListener("click", () => {
        histToggle.classList.toggle("expanded");
        const content = card.querySelector('.loan-card-history[data-history-id="' + loan.id + '"]');
        if (content) content.classList.toggle("open");
      });
    }

    container.appendChild(card);
  });
}

// ── Add/Edit Loan Modal ──

let installmentRows = [];

function openModal(id) {
  editingId = id || null;
  const overlay = document.getElementById("modal-overlay");
  const form = document.getElementById("loan-form");
  const title = document.getElementById("modal-title-text");

  form.reset();
  document.getElementById("bank-info").style.display = "none";
  document.getElementById("bank-info").innerHTML = "";
  installmentRows = [];
  document.getElementById("installments-list").innerHTML = "";

  if (editingId) {
    title.textContent = "Edit Loan";
    const loan = loans.find(l => l.id === editingId);
    if (!loan) return;
    populateForm(loan);
  } else {
    title.textContent = "Add Loan";
    toggleFormFields("credit_card");
  }

  overlay.classList.add("open");
}

function closeModal() {
  animateClose("modal-overlay", () => { editingId = null; });
}

function populateForm(loan) {
  document.getElementById("loan-type").value = loan.type;
  toggleFormFields(loan.type);

  if (loan.type === "credit_card") {
    document.getElementById("loan-bank").value = loan.bank || "";
    onBankSelect();
    document.getElementById("loan-interest-rate").value = loan.interestRate || "";
    document.getElementById("loan-balance").value = loan.balance || "";
    document.getElementById("loan-credit-limit").value = loan.creditLimit || "";
    document.getElementById("loan-monthly-pay").value = loan.monthlyPayment || "";
    document.getElementById("loan-due-date").value = loan.dueDate || "";
    document.getElementById("loan-nickname").value = loan.nickname || "";

    // Populate installments
    installmentRows = [];
    document.getElementById("installments-list").innerHTML = "";
    if (loan.installments && loan.installments.length > 0) {
      loan.installments.forEach(inst => addInstallmentRow(inst));
    }
  } else {
    document.getElementById("loan-lender").value = loan.lenderName || "";
    document.getElementById("loan-total-amount").value = loan.totalAmount || "";
    document.getElementById("loan-balance-other").value = loan.balance || "";
    document.getElementById("loan-monthly-payment").value = loan.monthlyPayment || "";
    document.getElementById("loan-rate-other").value = loan.interestRate || "";
    document.getElementById("loan-term").value = loan.loanTerm || "";
    document.getElementById("loan-due-date-other").value = loan.dueDate || "";
  }
}

function addInstallmentRow(data) {
  const container = document.getElementById("installments-list");
  const idx = installmentRows.length;
  const row = document.createElement("div");
  row.className = "installment-row";
  row.innerHTML =
    '<button type="button" class="btn-remove-installment">&times;</button>' +
    '<div class="form-group">' +
      '<label>Item / Description</label>' +
      '<input type="text" class="inst-name" placeholder="e.g. iPhone 15, Laptop" value="' + escapeHtml((data && data.name) || "") + '">' +
    '</div>' +
    '<div class="form-row">' +
      '<div class="form-group">' +
        '<label>Monthly Amount (\u20B1)</label>' +
        '<input type="number" class="inst-monthly" step="0.01" min="0" placeholder="0.00" value="' + ((data && data.monthlyAmount) || "") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Total Months</label>' +
        '<input type="number" class="inst-total-months" min="1" placeholder="e.g. 12" value="' + ((data && data.totalMonths) || "") + '">' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Months Paid</label>' +
      '<input type="number" class="inst-paid-months" min="0" placeholder="0" value="' + ((data && data.paidMonths) || "0") + '">' +
    '</div>';

  row.querySelector(".btn-remove-installment").addEventListener("click", () => {
    row.remove();
    installmentRows = installmentRows.filter(r => r !== row);
  });

  container.appendChild(row);
  installmentRows.push(row);
}

function getInstallmentsFromForm() {
  return installmentRows.map(row => ({
    name: row.querySelector(".inst-name").value.trim(),
    monthlyAmount: parseFloat(row.querySelector(".inst-monthly").value) || 0,
    totalMonths: parseInt(row.querySelector(".inst-total-months").value) || 0,
    paidMonths: parseInt(row.querySelector(".inst-paid-months").value) || 0
  })).filter(i => i.name || i.monthlyAmount > 0);
}

function toggleFormFields(type) {
  const ccFields = document.getElementById("cc-fields");
  const otherFields = document.getElementById("other-fields");
  if (type === "credit_card") {
    ccFields.style.display = "block";
    otherFields.style.display = "none";
  } else {
    ccFields.style.display = "none";
    otherFields.style.display = "block";
  }
}

function onBankSelect() {
  const bankName = document.getElementById("loan-bank").value;
  const infoBox = document.getElementById("bank-info");

  if (!bankName) { infoBox.style.display = "none"; return; }
  const bank = PH_BANKS.find(b => b.name === bankName);
  if (!bank) { infoBox.style.display = "none"; return; }

  const rateText = bank.monthlyRateMin
    ? bank.monthlyRateMin + "% - " + bank.monthlyRate + "%"
    : bank.monthlyRate + "%";

  infoBox.style.display = "block";
  infoBox.innerHTML =
    "<strong>" + escapeHtml(bank.name) + "</strong><br>" +
    "Monthly Interest Rate: <strong>" + rateText + "</strong><br>" +
    "Late Payment Fee: " + escapeHtml(bank.lateFee) + "<br>" +
    "Cash Advance Fee: " + escapeHtml(bank.cashAdvanceFee) + "<br>" +
    "Annual Fee Range: " + escapeHtml(bank.annualFee);

  // Pre-fill interest rate field (user can override)
  const rateField = document.getElementById("loan-interest-rate");
  if (rateField && !rateField.value) {
    rateField.value = bank.monthlyRate;
  }
}

function handleSubmit(e) {
  e.preventDefault();
  const type = document.getElementById("loan-type").value;
  const existingLoan = editingId ? loans.find(l => l.id === editingId) : null;
  const existingHistory = existingLoan ? (existingLoan.history || []) : [];
  const existingGoal = existingLoan ? existingLoan.goal : undefined;
  const existingInclInst = existingLoan ? existingLoan.includeInstallments : undefined;

  let loan;
  if (type === "credit_card") {
    const bankName = document.getElementById("loan-bank").value;
    const bank = PH_BANKS.find(b => b.name === bankName);
    loan = {
      id: editingId || generateId(),
      type: "credit_card",
      bank: bankName,
      nickname: document.getElementById("loan-nickname").value.trim(),
      balance: parseFloat(document.getElementById("loan-balance").value) || 0,
      creditLimit: parseFloat(document.getElementById("loan-credit-limit").value) || 0,
      interestRate: parseFloat(document.getElementById("loan-interest-rate").value) || (bank ? bank.monthlyRate : 2.0),
      lateFee: bank ? bank.lateFee : "",
      monthlyPayment: parseFloat(document.getElementById("loan-monthly-pay").value) || 0,
      dueDate: parseInt(document.getElementById("loan-due-date").value) || 1,
      installments: getInstallmentsFromForm(),
      includeInstallments: existingInclInst,
      goal: existingGoal,
      history: existingHistory,
      createdAt: existingLoan ? existingLoan.createdAt : new Date().toISOString().split("T")[0]
    };
  } else {
    loan = {
      id: editingId || generateId(),
      type: type,
      lenderName: document.getElementById("loan-lender").value.trim(),
      balance: parseFloat(document.getElementById("loan-balance-other").value) || 0,
      totalAmount: parseFloat(document.getElementById("loan-total-amount").value) || 0,
      monthlyPayment: parseFloat(document.getElementById("loan-monthly-payment").value) || 0,
      interestRate: parseFloat(document.getElementById("loan-rate-other").value) || 0,
      loanTerm: parseInt(document.getElementById("loan-term").value) || 0,
      dueDate: parseInt(document.getElementById("loan-due-date-other").value) || 1,
      goal: existingGoal,
      history: existingHistory,
      createdAt: existingLoan ? existingLoan.createdAt : new Date().toISOString().split("T")[0]
    };
  }

  if (editingId) {
    const idx = loans.findIndex(l => l.id === editingId);
    if (idx !== -1) loans[idx] = loan;
  } else {
    loans.push(loan);
  }

  save();
  closeModal();
  renderAll();
}

// ── Payment Modal ──

function openPaymentModal(id) {
  paymentLoanId = id;
  const loan = loans.find(l => l.id === id);
  if (!loan) return;

  document.getElementById("payment-form").reset();
  paymentAttachmentData = null;
  document.getElementById("payment-attachment").value = "";
  document.getElementById("payment-attach-preview").innerHTML = "";
  const name = loan.nickname || loan.lenderName || loan.bank || "Loan";
  document.getElementById("payment-title").textContent = "Pay: " + name;
  document.getElementById("payment-loan-info").innerHTML =
    "Current balance: <strong>" + formatPHP(loan.balance) + "</strong>";

  renderPaymentHistory(loan);
  document.getElementById("payment-overlay").classList.add("open");
}

function closePaymentModal() {
  animateClose("payment-overlay", () => { paymentLoanId = null; });
}

function handlePayment(e) {
  e.preventDefault();
  if (!paymentLoanId) return;
  const loan = loans.find(l => l.id === paymentLoanId);
  if (!loan) return;

  const amount = parseFloat(document.getElementById("payment-amount").value) || 0;
  if (amount <= 0) return;
  const note = document.getElementById("payment-note").value.trim();

  loan.balance = Math.max(0, Number(loan.balance) - amount);
  if (!loan.history) loan.history = [];
  const entry = {
    type: "payment", amount, note,
    date: new Date().toISOString(),
    balanceAfter: loan.balance
  };
  if (paymentAttachmentData) entry.attachment = paymentAttachmentData;
  loan.history.push(entry);

  save();
  closePaymentModal();
  renderAll();
}

function renderPaymentHistory(loan) {
  const container = document.getElementById("payment-history");
  const history = (loan.history || []).slice().reverse();
  if (history.length === 0) { container.innerHTML = ""; return; }

  let html = "<h4>Transaction History</h4>";
  history.forEach(entry => {
    const amountClsMap = { payment: "pay-amount", charge: "charge-amount", interest: "interest-amount", installment: "installment-amount" };
    const amountClass = amountClsMap[entry.type] || "charge-amount";
    const sign = entry.type === "payment" ? "-" : "+";
    html +=
      '<div class="payment-entry">' +
        '<div>' +
          '<span class="' + amountClass + '">' + sign + formatPHP(entry.amount) + '</span>' +
          (entry.note ? ' <span class="pay-note">' + escapeHtml(entry.note) + '</span>' : '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          (entry.attachment ? '<img src="' + entry.attachment + '" class="pay-attach-thumb" title="View receipt" onclick="openAttachment(this.src)">' : '') +
          '<span class="pay-date">' + formatDate(entry.date) + '</span>' +
        '</div>' +
      '</div>';
  });
  container.innerHTML = html;
}

// ── Add Charge Modal ──

function openChargeModal(id) {
  chargeLoanId = id;
  const loan = loans.find(l => l.id === id);
  if (!loan) return;

  document.getElementById("charge-form").reset();
  document.getElementById("charge-installment-form").reset();
  const name = loan.nickname || loan.bank || "Credit Card";
  document.getElementById("charge-title").textContent = "Add Charge: " + name;

  const remaining = Math.max(0, (Number(loan.creditLimit) || 0) - (Number(loan.balance) || 0));
  document.getElementById("charge-loan-info").innerHTML =
    "Current balance: <strong>" + formatPHP(loan.balance) + "</strong><br>" +
    "Credit limit: <strong>" + formatPHP(loan.creditLimit || 0) + "</strong><br>" +
    "Available credit: <strong>" + formatPHP(remaining) + "</strong>";

  // Reset tabs to regular charge
  document.querySelectorAll(".charge-tab").forEach(t => t.classList.remove("active"));
  document.querySelector('.charge-tab[data-charge="regular"]').classList.add("active");
  document.getElementById("charge-form").style.display = "block";
  document.getElementById("charge-installment-form").style.display = "none";

  document.getElementById("charge-overlay").classList.add("open");
}

function closeChargeModal() {
  animateClose("charge-overlay", () => { chargeLoanId = null; });
}

function handleCharge(e) {
  e.preventDefault();
  if (!chargeLoanId) return;
  const loan = loans.find(l => l.id === chargeLoanId);
  if (!loan) return;

  const amount = parseFloat(document.getElementById("charge-amount").value) || 0;
  if (amount <= 0) return;
  const note = document.getElementById("charge-note").value.trim();

  loan.balance = Number(loan.balance) + amount;
  if (!loan.history) loan.history = [];
  loan.history.push({
    type: "charge", amount, note,
    date: new Date().toISOString(),
    balanceAfter: loan.balance
  });

  save();
  closeChargeModal();
  renderAll();
}

function handleChargeInstallment(e) {
  e.preventDefault();
  if (!chargeLoanId) return;
  const loan = loans.find(l => l.id === chargeLoanId);
  if (!loan) return;

  const name = document.getElementById("charge-inst-name").value.trim();
  const monthlyAmount = parseFloat(document.getElementById("charge-inst-monthly").value) || 0;
  const totalMonths = parseInt(document.getElementById("charge-inst-months").value) || 0;
  const paidMonths = parseInt(document.getElementById("charge-inst-paid").value) || 0;

  if (!name || monthlyAmount <= 0 || totalMonths <= 0) return;

  if (!loan.installments) loan.installments = [];
  loan.installments.push({ name, monthlyAmount, totalMonths, paidMonths });

  if (!loan.history) loan.history = [];
  loan.history.push({
    type: "installment",
    amount: 0,
    note: "New installment added: " + name + " (" + formatPHP(monthlyAmount) + "/mo x " + totalMonths + " months)",
    date: new Date().toISOString(),
    balanceAfter: loan.balance
  });

  save();
  closeChargeModal();
  renderAll();
}

// ── Payoff Calculator Modal ──

function openCalcModal(id) {
  calcLoanId = id;
  const loan = loans.find(l => l.id === id);
  if (!loan) return;

  const name = loan.nickname || loan.bank || "Credit Card";
  document.getElementById("calc-title").textContent = "Calculator: " + name;
  document.getElementById("calc-loan-info").innerHTML =
    "Balance: <strong>" + formatPHP(loan.balance) + "</strong><br>" +
    "Interest Rate: <strong>" + loan.interestRate + "% / month</strong>";

  document.getElementById("calc-monthly").value = "";
  document.getElementById("calc-target-months").value = "";
  document.getElementById("calc-months-result").innerHTML = "";
  document.getElementById("calc-amount-result").innerHTML = "";

  // Reset tabs
  document.querySelectorAll(".calc-tab").forEach(t => t.classList.remove("active"));
  document.querySelector('.calc-tab[data-calc="months"]').classList.add("active");
  document.getElementById("calc-months-section").style.display = "block";
  document.getElementById("calc-amount-section").style.display = "none";

  document.getElementById("calc-overlay").classList.add("open");
}

function closeCalcModal() {
  animateClose("calc-overlay", () => { calcLoanId = null; });
}

function calcMonthsResult() {
  const loan = loans.find(l => l.id === calcLoanId);
  if (!loan) return;

  const monthly = parseFloat(document.getElementById("calc-monthly").value) || 0;
  const bal = Number(loan.balance);
  const rate = Number(loan.interestRate) || 0;
  const monthlyInterest = bal * rate / 100;
  const el = document.getElementById("calc-months-result");

  if (monthly <= 0) {
    el.innerHTML = "Enter a monthly payment amount.";
    return;
  }

  // Check if payment doesn't cover interest + installment charges
  var instChargePerMonth = 0;
  var inclInst = loan.includeInstallments !== false;
  if (inclInst && loan.installments) {
    loan.installments.forEach(function(inst) {
      if ((Number(inst.paidMonths) || 0) < (Number(inst.totalMonths) || 0)) {
        instChargePerMonth += Number(inst.monthlyAmount) || 0;
      }
    });
  }
  var totalMonthlyCharges = monthlyInterest + instChargePerMonth;

  if (monthly <= totalMonthlyCharges && totalMonthlyCharges > 0) {
    var deficit = totalMonthlyCharges - monthly;
    el.innerHTML =
      '<div class="plan-warning">' +
        '<div class="pw-header"><span class="pw-icon">⚠</span>Payment does not cover monthly charges</div>' +
        '<div class="pw-body">' +
          '<div class="pw-section-label">Monthly Charges Breakdown</div>' +
          '<div class="pw-row"><span>Interest</span><span>' + formatPHP(monthlyInterest) + '</span></div>' +
          (instChargePerMonth > 0 ? '<div class="pw-row"><span>Installments</span><span>' + formatPHP(instChargePerMonth) + '</span></div>' : '') +
          '<div class="pw-divider"></div>' +
          '<div class="pw-row pw-total"><span>Total Charges</span><strong>' + formatPHP(totalMonthlyCharges) + '</strong></div>' +
          '<div class="pw-divider"></div>' +
          '<div class="pw-row"><span>Your Payment</span><span>' + formatPHP(monthly) + '</span></div>' +
          '<div class="pw-row pw-deficit"><span>Deficit</span><span>' + formatPHP(deficit) + '</span></div>' +
        '</div>' +
      '</div>';
    return;
  }

  const result = calcPayoffMonths(bal, monthly, rate);

  if (result.months === Infinity) {
    el.innerHTML =
      '<div class="plan-warning">' +
        '<div class="pw-header"><span class="pw-icon">⚠</span>Balance will not decrease</div>' +
        '<div class="pw-body">' +
          '<div class="pw-row"><span>Payment is too low to overcome compounding interest' + (instChargePerMonth > 0 ? ' and installment charges' : '') + '. Try a higher amount.</span></div>' +
        '</div>' +
      '</div>';
    return;
  }

  const totalPaid = monthly * result.months;
  const totalInterest = totalPaid - bal;
  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth() + result.months);

  el.innerHTML =
    'Paying <strong>' + formatPHP(monthly) + '/month</strong>:<br>' +
    'Paid off in <span class="calc-highlight">' + result.months + ' months</span><br>' +
    'Target date: <strong>' + formatPayoffDate(payoffDate) + '</strong><br>' +
    'Total paid: <strong>' + formatPHP(totalPaid) + '</strong><br>' +
    'Total interest: <strong style="color:var(--red);">' + formatPHP(totalInterest) + '</strong>' +
    '<button class="btn-set-goal" data-months="' + result.months + '" data-monthly="' + monthly + '">Set as My Goal</button>';
}

function calcAmountResult() {
  const loan = loans.find(l => l.id === calcLoanId);
  if (!loan) return;

  const targetMonths = parseInt(document.getElementById("calc-target-months").value) || 0;
  const el = document.getElementById("calc-amount-result");

  if (targetMonths <= 0) {
    el.innerHTML = "Enter how many months you want to pay it off in.";
    return;
  }

  if (targetMonths > 360) {
    el.innerHTML = '<div class="plan-warning">Maximum projection period is 30 years (360 months).</div>';
    return;
  }

  const required = calcRequiredPayment(Number(loan.balance), targetMonths, Number(loan.interestRate));
  const totalPaid = required * targetMonths;
  const totalInterest = totalPaid - Number(loan.balance);
  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth() + targetMonths);

  el.innerHTML =
    'To finish in <strong>' + targetMonths + ' months</strong>:<br>' +
    'Pay <span class="calc-highlight">' + formatPHP(required) + '/month</span><br>' +
    'Target date: <strong>' + formatPayoffDate(payoffDate) + '</strong><br>' +
    'Total paid: <strong>' + formatPHP(totalPaid) + '</strong><br>' +
    'Total interest: <strong style="color:var(--red);">' + formatPHP(totalInterest) + '</strong>' +
    '<button class="btn-set-goal" data-months="' + targetMonths + '" data-monthly="' + required + '">Set as My Goal</button>';
}

// ── Payoff Plan Modal ──

let planLoanId = null;
let planSelectedTier = "conservative";

function openPayoffPlanModal(id) {
  planLoanId = id;
  const loan = loans.find(l => l.id === id);
  if (!loan) return;

  const name = loan.nickname || loan.lenderName || loan.bank || "Loan";
  document.getElementById("plan-title").textContent = "Payoff Plan: " + name;

  const bal = Number(loan.balance) || 0;
  const rate = loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0;
  const inclInst = loan.includeInstallments !== false;
  const insts = loan.installments || [];
  const currentPay = Number(loan.monthlyPayment) || 0;

  document.getElementById("plan-loan-info").innerHTML =
    "Balance: <strong>" + formatPHP(bal) + "</strong><br>" +
    "Interest Rate: <strong>" + rate + "% / month</strong>" +
    (inclInst && insts.length > 0 ? "<br>Installments: <strong>Included in projections</strong>" : "");

  // Calculate minimum viable payment (must exceed monthly interest)
  var minViable = bal * (rate / 100) * 1.01; // just above interest
  var basePay = currentPay > minViable ? currentPay : Math.max(minViable * 1.1, bal * 0.03);

  // 3 strategy tiers
  var tiers = [
    { key: "conservative", label: "Conservative", pay: basePay },
    { key: "faster", label: "Faster", pay: basePay * 1.5 },
    { key: "aggressive", label: "Aggressive", pay: basePay * 2.5 }
  ];

  // Calculate total monthly charges (interest + active installments)
  var monthlyInterest = bal * (rate / 100);
  var instChargePerMonth = 0;
  if (inclInst && insts.length > 0) {
    insts.forEach(function(inst) {
      if ((Number(inst.paidMonths) || 0) < (Number(inst.totalMonths) || 0)) {
        instChargePerMonth += Number(inst.monthlyAmount) || 0;
      }
    });
  }

  var conservativeSim = simulatePayoff(bal, tiers[0].pay, rate, insts, inclInst, 360);
  var conservativeSummary = simulationSummary(conservativeSim);

  var strategiesHTML = '<div class="plan-strategies">';
  tiers.forEach(function(tier) {
    var sim = simulatePayoff(bal, tier.pay, rate, insts, inclInst, 360);
    var summary = simulationSummary(sim);
    var saved = Math.max(0, conservativeSummary.totalInterest - summary.totalInterest);
    var totalCharges = monthlyInterest + instChargePerMonth;
    var isLow = tier.pay <= totalCharges && totalCharges > 0;
    var isInvalid = isLow || summary.balanceGrowing;

    strategiesHTML +=
      '<div class="plan-tier' + (tier.key === planSelectedTier ? ' active' : '') + (isInvalid ? ' invalid' : '') + '" data-tier="' + tier.key + '" data-pay="' + tier.pay + '">' +
        '<div class="plan-tier-label">' + tier.label + '</div>' +
        '<div class="plan-tier-pay' + (isInvalid ? ' dim' : '') + '">' + formatPHP(tier.pay) + '<small>/mo</small></div>' +
        (isInvalid
          ? '<div class="plan-tier-badge plan-tier-badge--warn">⚠ Insufficient</div>'
          : !summary.paidOff
          ? '<div class="plan-tier-badge plan-tier-badge--long">30+ yrs</div>'
          : '<div class="plan-tier-months">' + summary.months + ' months</div>' +
            '<div class="plan-tier-interest">Interest: ' + formatPHP(summary.totalInterest) + '</div>' +
            (saved > 0 ? '<div class="plan-tier-saved">Save ' + formatPHP(saved) + '</div>' : '')) +
      '</div>';
  });
  strategiesHTML += '</div>';
  document.getElementById("plan-strategies").innerHTML = strategiesHTML;

  // Render projection table for selected tier
  renderPlanTable(loan, tiers[0].pay);

  // Tier click handlers
  document.querySelectorAll(".plan-tier").forEach(function(el) {
    el.addEventListener("click", function() {
      planSelectedTier = el.dataset.tier;
      document.querySelectorAll(".plan-tier").forEach(function(t) { t.classList.remove("active"); });
      el.classList.add("active");
      renderPlanTable(loan, Number(el.dataset.pay));
    });
  });

  document.getElementById("plan-overlay").classList.add("open");
}

function renderPlanTable(loan, monthlyPay) {
  var bal = Number(loan.balance) || 0;
  var rate = loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0;
  var inclInst = loan.includeInstallments !== false;
  var insts = loan.installments || [];
  var cycles = simulatePayoff(bal, monthlyPay, rate, insts, inclInst, 6);

  // Check if balance is growing
  var monthlyInterest = bal * (rate / 100);
  var instCharge = 0;
  if (inclInst && insts.length > 0) {
    insts.forEach(function(inst) {
      if ((Number(inst.paidMonths) || 0) < (Number(inst.totalMonths) || 0))
        instCharge += Number(inst.monthlyAmount) || 0;
    });
  }
  var isLow = monthlyPay <= (monthlyInterest + instCharge) && (monthlyInterest + instCharge) > 0;

  var html = '';
  if (isLow) {
    var totalCharges = monthlyInterest + instCharge;
    var deficit = totalCharges - monthlyPay;
    html = '<div class="plan-warning">' +
      '<div class="pw-header"><span class="pw-icon">⚠</span>Payment does not cover monthly charges</div>' +
      '<div class="pw-body">' +
        '<div class="pw-section-label">Monthly Charges Breakdown</div>' +
        '<div class="pw-row"><span>Interest</span><span>' + formatPHP(monthlyInterest) + '</span></div>' +
        (instCharge > 0 ? '<div class="pw-row"><span>Installments</span><span>' + formatPHP(instCharge) + '</span></div>' : '') +
        '<div class="pw-divider"></div>' +
        '<div class="pw-row pw-total"><span>Total Charges</span><strong>' + formatPHP(totalCharges) + '</strong></div>' +
        '<div class="pw-divider"></div>' +
        '<div class="pw-row"><span>Payment</span><span>' + formatPHP(monthlyPay) + '</span></div>' +
        '<div class="pw-row pw-deficit"><span>Deficit</span><span>' + formatPHP(deficit) + '</span></div>' +
      '</div>' +
    '</div>';
  } else {
    // Stacked cycle cards
    html = '<div class="plan-cycles">';
    cycles.forEach(function(c, idx) {
      html +=
        '<div class="plan-cycle-card">' +
          '<div class="plan-cycle-header">' +
            '<span class="plan-cycle-label">Cycle ' + (idx + 1) + '</span>' +
            '<span class="plan-cycle-start">Start: ' + formatPHP(c.startBal) + '</span>' +
          '</div>' +
          '<div class="plan-cycle-body">' +
            '<div class="plan-cycle-line plan-cycle-charge">+ Interest: <strong>' + formatPHP(c.interest) + '</strong></div>' +
            (inclInst && insts.length > 0 && c.instCharge > 0
              ? '<div class="plan-cycle-line plan-cycle-charge">+ Installments: <strong>' + formatPHP(c.instCharge) + '</strong></div>'
              : '') +
            '<div class="plan-cycle-line plan-cycle-payment">&minus; Payment: <strong>' + formatPHP(c.payment) + '</strong></div>' +
          '</div>' +
          '<div class="plan-cycle-footer">' +
            'Ending Balance: <strong>' + formatPHP(c.endBal) + '</strong>' +
          '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  document.getElementById("plan-table").innerHTML = html;
}

function closePayoffPlanModal() {
  animateClose("plan-overlay", () => {
    planLoanId = null;
    planSelectedTier = "conservative";
  });
}

// ── Set Goal ──

function setGoal(months, monthly) {
  const loan = loans.find(l => l.id === calcLoanId);
  if (!loan) return;

  const targetDate = new Date();
  targetDate.setMonth(targetDate.getMonth() + months);

  loan.goal = {
    monthlyPayment: monthly,
    targetMonths: months,
    startBalance: Number(loan.balance),
    targetDate: targetDate.toISOString().split("T")[0],
    setAt: new Date().toISOString()
  };

  save();
  renderAll();

  // Show confirmation in the active result area
  var activeSection = document.getElementById("calc-months-section");
  var resultEl;
  if (activeSection && activeSection.style.display !== "none") {
    resultEl = document.getElementById("calc-months-result");
  } else {
    resultEl = document.getElementById("calc-amount-result");
  }
  if (resultEl) {
    resultEl.innerHTML = '<div class="goal-set-confirm">Goal set!</div>';
  }
}

// ── Delete ──

let pendingDeleteId = null;

function confirmDelete(id) {
  pendingDeleteId = id;
  document.getElementById("confirm-overlay").classList.add("open");
}

function closeConfirm() {
  animateClose("confirm-overlay", () => { pendingDeleteId = null; });
}

// ── Settings ──

function openSettingsModal() {
  document.getElementById("settings-clear-section").style.display = "";
  document.getElementById("settings-clear-confirm").style.display = "none";
  document.getElementById("settings-overlay").classList.add("open");
}

function closeSettingsModal() {
  animateClose("settings-overlay");
}

function clearAllData() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(FILTER_KEY);
  localStorage.removeItem(ACCRUAL_KEY);
  localStorage.removeItem(APP_LOCK_KEY);
  location.reload();
}

// ── App Lock / Biometrics ──

function isAppLockEnabled() {
  return localStorage.getItem(APP_LOCK_KEY) === "true";
}

function showLockScreen() {
  document.getElementById("lock-screen").style.display = "flex";
}

function hideLockScreen() {
  document.getElementById("lock-screen").style.display = "none";
}

async function isBiometricAvailable() {
  if (!NativeBiometric) return false;
  try {
    const result = await NativeBiometric.isAvailable();
    return !!result.isAvailable;
  } catch { return false; }
}

async function promptBiometric() {
  if (!NativeBiometric) return false;
  try {
    await NativeBiometric.verifyIdentity({
      reason: "Unlock BayadNa",
      title: "BayadNa",
      subtitle: "Verify your identity",
      negativeButtonText: "Cancel"
    });
    return true;
  } catch { return false; }
}

async function tryUnlock() {
  document.getElementById("lock-hint").textContent = "";
  const success = await promptBiometric();
  if (success) {
    hideLockScreen();
  } else {
    document.getElementById("lock-hint").textContent = "Authentication failed. Tap to try again.";
  }
}

function doDelete() {
  if (pendingDeleteId) {
    loans = loans.filter(l => l.id !== pendingDeleteId);
    save();
    renderAll();
  }
  closeConfirm();
}

// ── Export ──

let exportLoanId = null;

function downloadFile(filename, content, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 100);
}

function getExportFilename(loan, ext) {
  var n = (loan.nickname || loan.bank || loan.lenderName || "Loan").replace(/[^a-zA-Z0-9]/g, "_");
  var d = new Date().toISOString().split("T")[0];
  return "ZeroDebt_" + n + "_" + d + "." + ext;
}

function generatePDFHTML(loan) {
  var name = loan.nickname || loan.bank || loan.lenderName || "Loan";
  var today = new Date();
  var dateStr = today.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
  var inclInst = loan.includeInstallments !== false;
  var rate = loan.type === "credit_card" ? (Number(loan.interestRate) || 0) : 0;
  var cycles = (Number(loan.monthlyPayment) > 0 && Number(loan.balance) > 0)
    ? simulatePayoff(Number(loan.balance), Number(loan.monthlyPayment), rate, loan.installments || [], inclInst, 6)
    : [];
  var txHistory = loan.history || [];
  var totalPaid = txHistory
    .filter(function(h) { return h.type === "payment"; })
    .reduce(function(s, h) { return s + h.amount; }, 0);

  // Minified print CSS
  var css = "@page{size:A4;margin:18mm 14mm}*{margin:0;padding:0;box-sizing:border-box}" +
    "body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#0f172a;line-height:1.55}" +
    ".rh{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:2px solid #1a2332;margin-bottom:22px}" +
    ".brand{font-size:20px;font-weight:800;color:#1a2332;letter-spacing:-.5px}.brand span{color:#d97706}" +
    ".meta{text-align:right}.card-name{font-size:15px;font-weight:700}.bank-name,.xdate{font-size:10px;color:#94a3b8;margin-top:2px}" +
    ".sec{margin-bottom:22px}.st{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;padding-bottom:5px;border-bottom:1px solid #e2e8f0;margin-bottom:12px}" +
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 20px}" +
    ".gi label{font-size:9px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:2px}" +
    ".gi .v{font-size:12px;font-weight:700;color:#0f172a}.gi .v.lg{font-size:20px;font-weight:800}.gi .v.gn{color:#16a34a}" +
    ".ir{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9}" +
    ".ir:last-child{border-bottom:none}.in{font-size:11px;font-weight:600}.id{font-size:10px;color:#475569;text-align:right}" +
    ".ib{width:80px;height:4px;background:#e2e8f0;border-radius:2px;margin-top:4px;margin-left:auto}" +
    ".ibf{height:100%;background:#3b82f6;border-radius:2px}" +
    "table{width:100%;border-collapse:collapse}" +
    "th{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;text-align:left;padding:6px 8px;background:#f8fafc;border-bottom:1px solid #e2e8f0}" +
    "th.r{text-align:right}td{font-size:10.5px;padding:7px 8px;border-bottom:1px solid #f1f5f9;color:#475569}" +
    "td.r{text-align:right;font-weight:600;color:#0f172a}td.rd{color:#b91c1c}td.bl{color:#3b82f6}td.gn{color:#16a34a}" +
    "tr:last-child td{border-bottom:none}" +
    ".foot{margin-top:28px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:9px;color:#94a3b8;text-align:center;line-height:1.6}" +
    "@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}";

  var h = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ZeroDebt \u2014 ' + escapeHtml(name) + '</title><style>' + css + '</style></head><body>';

  // ── Header ──
  h += '<div class="rh">';
  h += '<div class="brand"><span>\u20B1</span> ZeroDebt</div>';
  h += '<div class="meta"><div class="card-name">' + escapeHtml(name) + '</div>';
  if (loan.bank) h += '<div class="bank-name">' + escapeHtml(loan.bank) + '</div>';
  h += '<div class="xdate">Exported: ' + dateStr + '</div></div></div>';

  // ── Summary ──
  h += '<div class="sec"><div class="st">Summary</div><div class="grid">';
  h += '<div class="gi"><label>Outstanding Balance</label><div class="v lg">' + formatPHP(loan.balance) + '</div></div>';
  h += '<div class="gi"><label>Total Paid</label><div class="v gn">' + formatPHP(totalPaid) + '</div></div>';
  if (loan.type === "credit_card") {
    h += '<div class="gi"><label>Interest Rate</label><div class="v">' + (loan.interestRate || 0) + '% / month</div></div>';
    h += '<div class="gi"><label>Credit Limit</label><div class="v">' + formatPHP(loan.creditLimit || 0) + '</div></div>';
  }
  h += '<div class="gi"><label>Monthly Payment</label><div class="v">' + formatPHP(loan.monthlyPayment || 0) + '</div></div>';
  h += '<div class="gi"><label>Due Date</label><div class="v">Every ' + ordinal(loan.dueDate) + '</div></div>';
  if (loan.loanTerm) h += '<div class="gi"><label>Loan Term</label><div class="v">' + escapeHtml(loan.loanTerm) + '</div></div>';
  h += '</div></div>';

  // ── Installments ──
  if (loan.installments && loan.installments.length > 0) {
    h += '<div class="sec"><div class="st">Installments</div>';
    loan.installments.forEach(function(inst) {
      var paid = Number(inst.paidMonths) || 0;
      var total = Number(inst.totalMonths) || 1;
      var monthly = Number(inst.monthlyAmount) || 0;
      var remaining = Math.max(0, total - paid) * monthly;
      var pct = Math.min(100, Math.round((paid / total) * 100));
      h += '<div class="ir">';
      h += '<div><div class="in">' + escapeHtml(inst.name || "Installment") + '</div>';
      h += '<div class="ib"><div class="ibf" style="width:' + pct + '%"></div></div></div>';
      h += '<div class="id">' + formatPHP(monthly) + '/mo &bull; ' + paid + '/' + total + ' months<br>Remaining: ' + formatPHP(remaining) + '</div>';
      h += '</div>';
    });
    h += '</div>';
  }

  // ── Goal ──
  if (loan.goal) {
    var g = loan.goal;
    var paidDown = Math.max(0, g.startBalance - Math.max(0, Number(loan.balance)));
    var tgtDate = new Date(g.targetDate).toLocaleDateString("en-PH", { month: "long", year: "numeric" });
    h += '<div class="sec"><div class="st">Payoff Goal</div><div class="grid">';
    h += '<div class="gi"><label>Monthly Payment</label><div class="v">' + formatPHP(g.monthlyPayment) + '</div></div>';
    h += '<div class="gi"><label>Target Date</label><div class="v">' + tgtDate + '</div></div>';
    h += '<div class="gi"><label>Cycles Planned</label><div class="v">' + g.targetMonths + ' months</div></div>';
    h += '<div class="gi"><label>Starting Balance</label><div class="v">' + formatPHP(g.startBalance) + '</div></div>';
    h += '<div class="gi"><label>Debt Paid Down</label><div class="v gn">' + formatPHP(paidDown) + '</div></div>';
    h += '<div class="gi"><label>Remaining Debt</label><div class="v">' + formatPHP(Math.max(0, Number(loan.balance))) + '</div></div>';
    h += '</div></div>';
  }

  // ── 6-Cycle Projection ──
  if (cycles.length > 0) {
    var hasInstCols = inclInst && loan.installments && loan.installments.length > 0 &&
      cycles.some(function(c) { return c.instCharge > 0; });
    h += '<div class="sec"><div class="st">6-Cycle Projection (at ' + formatPHP(loan.monthlyPayment || 0) + '/mo)</div>';
    h += '<table><thead><tr>';
    h += '<th>Cycle</th><th class="r">Start Balance</th><th class="r">+ Interest</th>';
    if (hasInstCols) h += '<th class="r">+ Installments</th>';
    h += '<th class="r">\u2212 Payment</th><th class="r">End Balance</th>';
    h += '</tr></thead><tbody>';
    cycles.forEach(function(c, idx) {
      h += '<tr><td>Month ' + (idx + 1) + '</td>';
      h += '<td class="r">' + formatPHP(c.startBal) + '</td>';
      h += '<td class="r rd">' + formatPHP(c.interest) + '</td>';
      if (hasInstCols) h += '<td class="r bl">' + formatPHP(c.instCharge) + '</td>';
      h += '<td class="r gn">' + formatPHP(c.payment) + '</td>';
      h += '<td class="r">' + formatPHP(c.endBal) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  // ── Transaction History ──
  if (txHistory.length > 0) {
    h += '<div class="sec"><div class="st">Transaction History</div>';
    h += '<table><thead><tr><th>Date</th><th>Type</th><th>Note</th><th class="r">Amount</th><th class="r">Balance After</th></tr></thead><tbody>';
    txHistory.slice().reverse().forEach(function(entry) {
      var tl = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);
      var sign = entry.type === "payment" ? "\u2212" : "+";
      var cls = entry.type === "payment" ? "gn" : entry.type === "interest" ? "rd" : "bl";
      h += '<tr><td>' + formatDate(entry.date) + '</td><td>' + tl + '</td>';
      h += '<td>' + escapeHtml(entry.note || "") + '</td>';
      h += '<td class="r ' + cls + '">' + sign + formatPHP(entry.amount) + '</td>';
      h += '<td class="r">' + (entry.balanceAfter !== undefined ? formatPHP(entry.balanceAfter) : "\u2014") + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  h += '<div class="foot">Estimates only. Not financial advice. &nbsp;&bull;&nbsp; ZeroDebt &nbsp;&bull;&nbsp; ' + dateStr + '</div>';
  h += '</body></html>';
  return h;
}

function exportAsPDF(loan) {
  var win = window.open("", "_blank");
  if (!win) { alert("Allow popups to generate the PDF report."); return; }
  win.document.write(generatePDFHTML(loan));
  win.document.close();
  win.focus();
  setTimeout(function() { win.print(); }, 400);
}

function exportAsCSV(loan) {
  var rows = [["Date", "Type", "Amount", "Balance After", "Note"]];
  (loan.history || []).forEach(function(e) {
    var date = new Date(e.date).toLocaleDateString("en-PH");
    var type = e.type.charAt(0).toUpperCase() + e.type.slice(1);
    var amount = Number(e.amount).toFixed(2);
    var bal = e.balanceAfter !== undefined ? Number(e.balanceAfter).toFixed(2) : "";
    var note = (e.note || "").replace(/"/g, '""');
    rows.push([date, type, amount, bal, note]);
  });
  var csv = rows.map(function(r) {
    return r.map(function(c) { return '"' + c + '"'; }).join(",");
  }).join("\n");
  downloadFile(getExportFilename(loan, "csv"), "\uFEFF" + csv, "text/csv;charset=utf-8;");
}

function exportAsJSON(loan) {
  downloadFile(getExportFilename(loan, "json"), JSON.stringify(loan, null, 2), "application/json");
}

function openExportModal(id) {
  exportLoanId = id;
  var loan = loans.find(function(l) { return l.id === id; });
  if (!loan) return;
  var name = loan.nickname || loan.bank || loan.lenderName || "Loan";
  document.getElementById("export-title").textContent = "Export: " + name;
  document.getElementById("export-card-info").innerHTML =
    "Balance: <strong>" + formatPHP(loan.balance) + "</strong>" +
    (loan.type === "credit_card"
      ? " &nbsp;&bull;&nbsp; Rate: <strong>" + (loan.interestRate || 0) + "%/mo</strong>"
      : "") +
    "<br>Transactions: <strong>" + (loan.history || []).length + " records</strong>";
  document.getElementById("export-overlay").classList.add("open");
}

function closeExportModal() {
  animateClose("export-overlay", function() { exportLoanId = null; });
}

// ── Init ──

function renderAll() {
  renderSummary();
  renderTabs();
  renderLoans();
}

function initBankDropdown() {
  const select = document.getElementById("loan-bank");
  select.innerHTML = '<option value="">-- Select Bank --</option>';
  PH_BANKS.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    select.appendChild(opt);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  initBankDropdown();

  // Process monthly accruals and show banner if any were applied
  const accrualMonths = processMonthlyAccruals();
  if (accrualMonths > 0) {
    const banner = document.getElementById("accrual-banner");
    const bannerText = document.getElementById("accrual-banner-text");
    bannerText.textContent = "Auto-applied interest and installments for " + accrualMonths + " month(s).";
    banner.style.display = "block";
  }
  document.getElementById("accrual-banner-close").addEventListener("click", () => {
    document.getElementById("accrual-banner").style.display = "none";
  });

  renderAll();

  // FAB
  document.getElementById("fab").addEventListener("click", () => openModal());

  // Loan modal
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById("loan-type").addEventListener("change", e => toggleFormFields(e.target.value));
  document.getElementById("loan-bank").addEventListener("change", onBankSelect);
  document.getElementById("loan-form").addEventListener("submit", handleSubmit);
  document.getElementById("btn-add-installment").addEventListener("click", () => addInstallmentRow());

  // Payment modal
  document.getElementById("payment-close").addEventListener("click", closePaymentModal);
  document.getElementById("payment-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closePaymentModal();
  });
  document.getElementById("payment-form").addEventListener("submit", handlePayment);
  document.getElementById("payment-attach-btn").addEventListener("click", () => {
    document.getElementById("payment-attachment").click();
  });
  document.getElementById("payment-attachment").addEventListener("change", function() {
    const file = this.files[0];
    const preview = document.getElementById("payment-attach-preview");
    if (!file) { paymentAttachmentData = null; preview.innerHTML = ""; return; }
    const reader = new FileReader();
    reader.onload = function(e) {
      compressImage(e.target.result, 1200, 0.72, function(compressed) {
        paymentAttachmentData = compressed;
        preview.innerHTML =
          '<img src="' + compressed + '" class="attach-preview-img">' +
          '<button type="button" class="attach-clear-btn" id="payment-attach-clear">Remove</button>';
        document.getElementById("payment-attach-clear").addEventListener("click", () => {
          paymentAttachmentData = null;
          document.getElementById("payment-attachment").value = "";
          preview.innerHTML = "";
        });
      });
    };
    reader.readAsDataURL(file);
  });

  // Charge modal
  document.getElementById("charge-close").addEventListener("click", closeChargeModal);
  document.getElementById("charge-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeChargeModal();
  });
  document.getElementById("charge-form").addEventListener("submit", handleCharge);
  document.getElementById("charge-installment-form").addEventListener("submit", handleChargeInstallment);
  document.querySelectorAll(".charge-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".charge-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.charge;
      document.getElementById("charge-form").style.display = mode === "regular" ? "block" : "none";
      document.getElementById("charge-installment-form").style.display = mode === "installment" ? "block" : "none";
    });
  });

  // Payoff plan modal
  document.getElementById("plan-close").addEventListener("click", closePayoffPlanModal);
  document.getElementById("plan-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closePayoffPlanModal();
  });

  // Calculator modal
  document.getElementById("calc-close").addEventListener("click", closeCalcModal);
  document.getElementById("calc-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeCalcModal();
  });
  document.querySelectorAll(".calc-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".calc-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.calc;
      document.getElementById("calc-months-section").style.display = mode === "months" ? "block" : "none";
      document.getElementById("calc-amount-section").style.display = mode === "amount" ? "block" : "none";
    });
  });
  document.getElementById("calc-months-btn").addEventListener("click", calcMonthsResult);
  document.getElementById("calc-amount-btn").addEventListener("click", calcAmountResult);

  // Set as Goal buttons (event delegation)
  document.getElementById("calc-months-result").addEventListener("click", function(e) {
    var btn = e.target.closest(".btn-set-goal");
    if (btn) setGoal(Number(btn.dataset.months), Number(btn.dataset.monthly));
  });
  document.getElementById("calc-amount-result").addEventListener("click", function(e) {
    var btn = e.target.closest(".btn-set-goal");
    if (btn) setGoal(Number(btn.dataset.months), Number(btn.dataset.monthly));
  });

  // Confirm dialog
  document.getElementById("confirm-yes").addEventListener("click", doDelete);
  document.getElementById("confirm-no").addEventListener("click", closeConfirm);
  document.getElementById("confirm-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeConfirm();
  });

  // Export modal
  document.getElementById("export-close").addEventListener("click", closeExportModal);
  document.getElementById("export-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeExportModal();
  });
  document.getElementById("export-pdf").addEventListener("click", () => {
    const loan = loans.find(l => l.id === exportLoanId);
    if (loan) exportAsPDF(loan);
  });
  document.getElementById("export-csv").addEventListener("click", () => {
    const loan = loans.find(l => l.id === exportLoanId);
    if (loan) exportAsCSV(loan);
  });
  document.getElementById("export-json").addEventListener("click", () => {
    const loan = loans.find(l => l.id === exportLoanId);
    if (loan) exportAsJSON(loan);
  });

  // App lock
  if (isAppLockEnabled() && isNative) { showLockScreen(); tryUnlock(); }
  document.getElementById("lock-unlock-btn").addEventListener("click", tryUnlock);

  // App lock toggle
  const appLockToggle = document.getElementById("app-lock-toggle");
  appLockToggle.checked = isAppLockEnabled();
  appLockToggle.addEventListener("change", async () => {
    if (appLockToggle.checked) {
      const available = await isBiometricAvailable();
      if (!available) {
        appLockToggle.checked = false;
        document.getElementById("app-lock-unavailable").style.display = "";
        return;
      }
      const confirmed = await promptBiometric();
      if (confirmed) {
        localStorage.setItem(APP_LOCK_KEY, "true");
        document.getElementById("app-lock-unavailable").style.display = "none";
      } else {
        appLockToggle.checked = false;
      }
    } else {
      localStorage.setItem(APP_LOCK_KEY, "false");
    }
  });

  // Settings modal
  document.getElementById("settings-btn").addEventListener("click", openSettingsModal);
  document.getElementById("settings-close").addEventListener("click", closeSettingsModal);
  document.getElementById("settings-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });
  document.getElementById("btn-clear-data").addEventListener("click", () => {
    document.getElementById("settings-clear-section").style.display = "none";
    document.getElementById("settings-clear-confirm").style.display = "";
  });
  document.getElementById("btn-cancel-clear").addEventListener("click", () => {
    document.getElementById("settings-clear-section").style.display = "";
    document.getElementById("settings-clear-confirm").style.display = "none";
  });
  document.getElementById("btn-confirm-clear").addEventListener("click", clearAllData);

  // Android hardware back button — close modals instead of exiting
  document.addEventListener('backButton', (ev) => {
    const openModal = document.querySelector('.modal-overlay.open');
    if (openModal) {
      ev.detail.register(10, () => {
        animateClose(openModal.id);
      });
    }
  });
});
