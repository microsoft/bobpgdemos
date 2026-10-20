"use strict";

const get = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing page element.");
  return element;
};
const searchForm = get("search-form");
const dialog = get("booking-dialog");
const cards = get("campsites");
let selected = null;
let bookingSaved = false;
let activeSearch = null;
let searchController = null;
let nameController = null;
const executions = [];
const executionLabels = { search: "Campsite search", name: "Typo-tolerant name lookup", booking: "Create fictional booking" };
const executionExplanations = {
  search: "ST_DWithin filters the geography in meters. ST_X / ST_Y return the stored coordinates for the map. Full-text search and JSONB filter the same rows; && checks overlapping date ranges.",
  name: "The pg_trgm % operator finds similar names. similarity() ranks candidates even when the campsite name is misspelled.",
  booking: "The INSERT uses a [check-in, checkout) daterange. PostgreSQL's no_double_booking exclusion constraint rejects overlapping stays atomically (SQLSTATE 23P01). Checkout-day arrivals remain valid.",
};
const debugPanel = get("debug-panel");
const debugToggle = get("debug-toggle");

function setDebug(open, moveFocus = true) {
  debugPanel.hidden = !open;
  document.body.classList.toggle("debug-open", open);
  debugToggle.setAttribute("aria-expanded", String(open));
  debugToggle.textContent = open ? "Hide debug" : "Debug";
  if (open && moveFocus) {
    get("debug-close").focus({ preventScroll: true });
    if (matchMedia("(max-width:1100px)").matches) debugPanel.scrollIntoView({ block: "start" });
  } else if (!open && moveFocus) {
    debugToggle.focus({ preventScroll: true });
  }

}

function showActivity(title, instruction, result) {
  get("activity-title").textContent = title;
  get("activity-instruction").textContent = instruction;
  get("activity-result").textContent = result;
  setDebug(true, false);
  debugPanel.scrollTop = 0;
}
debugToggle.addEventListener("click", () => setDebug(debugPanel.hidden));
get("debug-close").addEventListener("click", () => setDebug(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !debugPanel.hidden && !dialog.open) setDebug(false);
});

function showExecution(index) {
  const entry = executions[index];
  if (!entry) return;
  const execution = entry.execution;
  get("execution-summary").textContent = `${executionLabels[execution.operation]} · ${execution.outcome} · ${execution.rows} row(s) · ${execution.elapsed_ms} ms`;
  get("execution-request").textContent = `${entry.method} ${entry.path} · HTTP ${entry.status}`;
  get("execution-sql").textContent = execution.sql;
  get("execution-parameters").replaceChildren(...execution.parameters.flatMap((parameter) => [
    node("dt", parameter.parameter), node("dd", JSON.stringify(parameter.value)),
  ]));
  get("execution-explanation").textContent = executionExplanations[execution.operation];
}

function recordExecution(execution, url, method, status) {
  executions.unshift({ execution, path: url.split("?")[0], method, status });
  executions.length = Math.min(executions.length, 8);
  get("execution-history").replaceChildren(...executions.map((entry, index) => {
    const option = node("option", `${index === 0 ? "Latest · " : ""}${executionLabels[entry.execution.operation]} · ${entry.execution.outcome}`);
    option.value = String(index);
    return option;
  }));
  showExecution(0);
}
get("execution-history").addEventListener("change", (event) => {
  const index = Number(event.target.value);
  showExecution(index);
  const entry = executions[index];
  if (entry) showActivity("Recorded action selected", "Recent actions replays the recorded SQL; it does not run it again.",
    `${executionLabels[entry.execution.operation]}: ${entry.execution.outcome}, ${entry.execution.rows} row(s).`);
});

let campsiteMap = null;
let mapMarkers = null;
let searchCircle = null;
if (typeof L === "undefined") {
  get("map-status").textContent = "The map library could not load. Campsite search still works; reload to retry the map.";
} else {
  campsiteMap = L.map("campsite-map", { scrollWheelZoom: false }).setView([47.608, -122.335], 9);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  let tileFailure = false;
  tiles.on("loading", () => { tileFailure = false; });
  tiles.on("tileerror", () => {
    tileFailure = true;
    get("map-status").textContent = "Some street-map tiles could not load. Campsite markers and the search ring still use real database coordinates; pan or zoom to retry tiles.";
  });
  tiles.on("load", () => {
    if (!tileFailure) get("map-status").textContent = "Street map loaded. Campsites are fictional; their coordinates and search results come from PostGIS.";
  });
  tiles.addTo(campsiteMap);
  mapMarkers = L.layerGroup().addTo(campsiteMap);
  L.circleMarker([47.608, -122.335], { radius: 7, color: "#fff", weight: 2, fillColor: "#b17a20", fillOpacity: 1 })
    .bindTooltip("Seattle · search origin").addTo(campsiteMap);
  new ResizeObserver(() => campsiteMap.invalidateSize({ pan: false })).observe(get("campsite-map"));
}

function resetMap() {
  if (campsiteMap && searchCircle) campsiteMap.fitBounds(searchCircle.getBounds(), { padding: [15, 15], animate: false });
}
get("map-reset").addEventListener("click", () => {
  resetMap();
  showActivity("Map view reset", "Click Reset view to fit the map to the applied search radius.",
    "Map view updated only. No SQL ran; the SQL below is the last completed database action.");
});

function clearMap() {
  if (!mapMarkers) return;
  mapMarkers.clearLayers();
  if (searchCircle) { campsiteMap.removeLayer(searchCircle); searchCircle = null; }
}

function showMap(sites, params) {
  if (!campsiteMap) return;
  clearMap();
  const radius = Number(params.get("radius_km"));
  searchCircle = L.circle([Number(params.get("latitude")), Number(params.get("longitude"))], {
    radius: radius * 1000, color: "#14675b", weight: 2, fillOpacity: 0.05,
  }).addTo(campsiteMap);
  for (const site of sites) {
    const popup = node("div", undefined, "map-popup");
    popup.append(node("strong", site.name), node("p",
      `${Number(site.km_from_seattle).toFixed(1)} km from Seattle · Sleeps ${site.capacity} · ${site.available ? "Available" : "Unavailable"}`));
    const locate = node("button", "View campsite");
    locate.type = "button";
    locate.addEventListener("click", () => {
      const card = get(`campsite-${site.campsite_id}`);
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.focus({ preventScroll: true });
      showActivity("Campsite selected", "Click View campsite on a map marker.",
        `${site.name} is highlighted in the results. No SQL ran; the SQL below is the last completed database action.`);
    });
    popup.append(locate);
    const marker = L.circleMarker([site.latitude, site.longitude], {
      radius: 8, color: "#fff", weight: 2, fillColor: site.available ? "#14675b" : "#9e6750", fillOpacity: 1,
    }).bindPopup(popup).bindTooltip(site.name).addTo(mapMarkers);
    marker.on("click", () => showActivity("Map marker opened", "Click a campsite marker to see its details.",
      `${site.name}: coordinates and availability come from the last search. No new SQL ran.`));
  }
  get("map-caption").textContent = `${sites.length} matching fictional campsite(s) · ${radius} km radius from Seattle · Coordinates read from PostGIS geography. The ring is a visual guide; PostgreSQL calculates the matches.`;
  resetMap();
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

class RequestError extends Error {}

async function request(url, options = {}) {
  const { recordExecution: shouldRecord = true, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, credentials: "same-origin" });
  const body = await response.json();
  if (shouldRecord && body.execution) recordExecution(body.execution, url, fetchOptions.method || "GET", response.status);
  if (!response.ok) throw new RequestError(body.error || "The service is unavailable. Please try again later.");
  return body;
}

function filters() {
  const data = new FormData(searchForm);
  const params = new URLSearchParams();
  for (const key of ["text", "capacity", "radius_km", "check_in", "check_out"]) {
    params.set(key, String(data.get(key) ?? ""));
  }
  for (const key of ["pet_friendly", "kayak_rental", "available_only"]) {
    params.set(key, String(data.has(key)));
  }
  params.set("longitude", "-122.335");
  params.set("latitude", "47.608");
  return params;
}

function showSite(site, stay) {
  const card = node("article", undefined, "card");
  card.id = `campsite-${site.campsite_id}`;
  card.tabIndex = -1;
  const art = node("div", undefined, "card-art");
  art.setAttribute("aria-hidden", "true");
  art.append(node("span", "FICTIONAL WASHINGTON"));
  const body = node("div", undefined, "card-body");
  body.append(node("h3", site.name), node("div",
    `${Number(site.km_from_seattle).toFixed(1)} km from Seattle · Sleeps ${site.capacity}`, "card-meta"),
  node("p", site.description));
  const amenities = node("div", undefined, "amenities");
  for (const [key, label] of [["pet_friendly", "Pet-friendly"], ["kayak_rental", "Kayak rental"],
    ["electric_hookup", "Electric hookup"], ["fire_pit", "Fire pit"]]) {
    if (site.amenities[key]) amenities.append(node("span", label, "amenity"));
  }
  body.append(amenities);
  const bottom = node("div", undefined, "card-bottom");
  const price = node("strong", new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(site.nightly_price));
  price.append(node("small", " / night"));
  const button = node("button", site.available ? "Book demo stay ↗" : "Unavailable");
  button.type = "button";
  button.classList.add("book-stay");
  button.disabled = !site.available;
  button.addEventListener("click", () => {
    selected = { campsite_id: site.campsite_id, check_in: stay.check_in, check_out: stay.check_out };
    get("booking-site").textContent = site.name;
    get("booking-dates").textContent = `${stay.check_in} → ${stay.check_out} (checkout exclusive)`;
    get("booking-status").textContent = "";
    get("guest-alias").value = "";
    get("booking-confirm").checked = false;
    get("booking-submit").disabled = false;
    get("booking-submit").textContent = "Create demo booking";
    get("booking-close").textContent = "Close";
    bookingSaved = false;
    dialog.showModal();
    showActivity("Booking form opened", "Enter a demo alias, tick the confirmation, then click Create demo booking.",
      `Selected ${site.name}, ${stay.check_in} to ${stay.check_out}. No booking has been saved by opening this form.`);
    if (guideStep !== null && guideSteps[guideStep].id === "choose") guideStep = guideSteps.findIndex((step) => step.id === "book");
    if (guideStep !== null) renderGuide();
  });
  bottom.append(price, button);
  body.append(bottom);
  card.append(art, body);
  return card;
}

async function search(params = filters(), recordExecution = true, userInitiated = false) {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const stay = { check_in: params.get("check_in"), check_out: params.get("check_out") };
  const radius = params.get("radius_km");
  const previousRadius = activeSearch?.get("radius_km");
  get("search-status").classList.remove("search-complete");
  get("search-status").textContent = `Searching within ${radius} km of Seattle…`;
  if (userInitiated) {
    showActivity("Campsite search", "Click Find my escape to apply the filters.",
      `Running: ${radius} km radius. Waiting for PostgreSQL; previous SQL is shown below until the response arrives.`);
    get("execution-summary").textContent = `Running campsite search within ${radius} km… The SQL below will update when the response arrives.`;
  }
  cards.replaceChildren();
  clearMap();
  get("map-caption").textContent = "Waiting for this search's database results…";
  cards.setAttribute("aria-busy", "true");
  try {
    const data = await request(`/api/campsites?${params}`, { signal: controller.signal, recordExecution });
    activeSearch = new URLSearchParams(params);
    cards.replaceChildren(...data.campsites.map((site) => showSite(site, stay)));
    showMap(data.campsites, params);
    const change = previousRadius && previousRadius !== radius ? ` Radius changed from ${previousRadius} to ${radius} km.` : "";
    get("search-status").textContent = `Search complete: ${data.campsites.length} fictional campsite(s) within ${radius} km of Seattle.${change} Map and results updated for ${stay.check_in} to ${stay.check_out}.${data.campsites.length ? "" : " Try a wider radius, different dates or fewer filters."}`;
    get("search-status").classList.add("search-complete");
    if (userInitiated) {
      showActivity("Campsite search complete", "Map, result cards, and SQL now describe the same completed search.",
        `${get("search-status").textContent} In the SQL below, $6 = ${radius} km; $7 controls availability.`);
      const result = matchMedia("(max-width:1100px)").matches ? debugPanel : get("search-status");
      result.scrollIntoView({ block: "start", behavior: "instant" });
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      get("search-status").textContent = error.message;
      activeSearch = null;
      get("map-caption").textContent = "No map results: the search failed. Correct the filters or retry.";
      if (userInitiated) {
        get("execution-summary").textContent = "Search failed. The SQL below belongs to a previous action; check the search error and retry.";
        showActivity("Campsite search failed", "The new filters were not successfully applied.", error.message);
      }
    }
  } finally {
    if (searchController === controller) cards.setAttribute("aria-busy", "false");
  }
}

searchForm.addEventListener("submit", (event) => { event.preventDefault(); void search(filters(), true, true); });
get("radius").addEventListener("input", () => {
  get("search-status").classList.remove("search-complete");
  get("search-status").textContent = `Radius edited to ${get("radius").value} km. Click Find my escape to apply it; the displayed results have not changed yet.`;
});
searchForm.addEventListener("input", () => showActivity("Filters edited, not applied",
  "Click Find my escape to run the new filters.",
  `Draft radius: ${get("radius").value} km. Applied radius: ${activeSearch?.get("radius_km") ?? "none"} km. Map, results, and SQL still describe the last completed search.`));
get("name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  nameController?.abort();
  const controller = new AbortController();
  nameController = controller;
  get("name-status").textContent = "Comparing names…";
  get("name-matches").replaceChildren();
  showActivity("Typo-tolerant name lookup", "Click Find name to run pg_trgm independently of the campsite filters.",
    "Comparing names in PostgreSQL. Previous SQL remains below until the response arrives.");
  try {
    const params = new URLSearchParams({ name: get("name-query").value });
    const data = await request(`/api/name-search?${params}`, { signal: controller.signal });
    get("name-matches").replaceChildren(...data.matches.map((match) =>
      node("li", `${match.name} · similarity ${Number(match.similarity).toFixed(2)}`)));
    get("name-status").textContent = data.matches.length ? "Closest name matches:" : "No similar names found.";
    showActivity("Name lookup complete", "Results and SQL now show the pg_trgm lookup.",
      `${data.matches.length} match(es). ${data.matches.map((match) => `${match.name} (similarity ${Number(match.similarity).toFixed(2)})`).join("; ") || "No similar names found."}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      get("name-status").textContent = error.message;
      showActivity("Name lookup failed", "No new name results are available; SQL below may be from a previous action.", error.message);
    }
  }
});
get("booking-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  dialog.before(get("demo-guide"));
  if (bookingSaved) {
    setDebug(true, false);
    if (guideStep !== null && ["choose", "book"].includes(guideSteps[guideStep].id)) {
      guideStep = guideSteps.findIndex((step) => step.id === "receipt");
    }
    if (guideStep === null) debugPanel.scrollIntoView({ block: "start", behavior: "instant" });
  }
  if (guideStep !== null) renderGuide();
});
get("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return;
  if (!get("booking-confirm").checked) {
    get("booking-status").textContent = "Confirm that this booking will persist in the shared database before saving.";
    return;
  }
  const booking = { ...selected, guest_alias: get("guest-alias").value };
  const previousSearch = activeSearch ? new URLSearchParams(activeSearch) : null;
  const button = get("booking-submit");
  button.disabled = true;
  button.textContent = "Saving booking…";
  get("booking-status").textContent = "Creating fictional booking…";
  showActivity("Saving booking", "One INSERT has been submitted. Do not submit again.",
    "Waiting for a booking receipt. Previous SQL remains below until PostgreSQL responds.");
  try {
    const data = await request("/api/bookings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(booking),
      signal: AbortSignal.timeout(20_000),
    });
    get("booking-status").textContent = `Demo booking ${data.booking.reservation_id} created. This is not a real reservation.`;
    bookingSaved = true;
    showActivity("Booking saved", "The INSERT succeeded. The alias is redacted in the SQL parameters below.",
      `Receipt ${data.booking.reservation_id}: campsite ${booking.campsite_id}, ${booking.check_in} to ${booking.check_out}. Availability is refreshing automatically; its SELECT does not replace this INSERT.`);
    button.textContent = "Booking saved";
    get("booking-close").textContent = "View results & SQL";
    selected = null;
    dialog.close();
    if (previousSearch) void search(previousSearch, false);
  } catch (error) {
    if (error instanceof RequestError) {
      get("booking-status").textContent = error.message;
      button.disabled = false;
      button.textContent = "Create demo booking";
      showActivity("Booking rejected", "No successful receipt was returned. Read the error before trying again.", error.message);
    } else {
      get("booking-status").textContent = "No booking confirmation was received. The outcome is unknown: the reservation may have saved. Do not submit it again until it has been checked. Close this dialog to continue; availability will refresh.";
      selected = null;
      button.textContent = "Confirmation unavailable";
      showActivity("Booking outcome unknown", "Do not resubmit until the reservation has been checked.", get("booking-status").textContent);
      if (previousSearch) void search(previousSearch, false);
    }
  }
});

async function checkReadiness() {
  const status = get("service-status");
  try {
    const response = await fetch("/readyz", { credentials: "same-origin" });
    if (!response.ok) throw new Error("not_ready");
    status.textContent = "PostgreSQL service ready · all sites and bookings are fictional.";
    status.classList.remove("warning");
    void search();
  } catch {
    status.textContent = "Campsite data is temporarily unavailable. Please try again shortly; no sample results or bookings are fabricated.";
    status.classList.add("warning");
  }
}

const guide = get("demo-guide");
let guideStep = null;
let guideTarget = null;
const guideSteps = [
  { id: "map", title: "Reset the map", target: "#map-reset",
    instruction: "CLICK Reset view. EXPECT the map to fit the current search ring. Debug explains that this is a map-only action: no SQL runs." },
  { id: "search", title: "Run the campsite search", target: "#search-submit",
    instruction: "CLICK Find my escape. EXPECT a completed-search message with radius and match count, updated markers/cards, and the actual SELECT and parameters in Debug." },
  { id: "radius", title: "Change and apply the radius", target: "#radius",
    instruction: "SET Distance from Seattle to 60, then CLICK Find my escape. EXPECT Debug to distinguish the draft edit from the completed 60 km search; $6 becomes 60 and the map ring updates." },
  { id: "choose", title: "Open a booking", target: ".book-stay:not(:disabled)",
    instruction: "CLICK Book demo stay on an available campsite. EXPECT the booking form with that site's dates. Opening it does not save anything. If none are available, change dates or filters and search." },
  { id: "book", title: "Confirm and save once", target: "#booking-form",
    instruction: "ENTER a demo alias, TICK the shared-database confirmation, then CLICK Create demo booking ONCE. EXPECT the dialog to close on success and Debug to show the receipt and INSERT. This booking persists." },
  { id: "receipt", title: "Read the booking result", target: "#activity-result", debug: true,
    instruction: "READ the receipt and INSERT in Debug, then the refreshed map/cards. EXPECT the booked site to disappear with Available only checked. No second click or booking is needed; Next does not write data." },
  { id: "typo", title: "Run the typo lookup", target: "#name-form",
    instruction: "ENTER Lake Samamish Heron, then CLICK Find name. EXPECT Lake Sammamish Heron and similarity scores, with pg_trgm SQL automatically replacing the INSERT in Debug." },
  { id: "history", title: "Compare the recorded SQL", target: "#execution-history", debug: true,
    instruction: "SELECT a search, booking, or name lookup in Recent actions. EXPECT its recorded SQL and parameters to appear. This does not rerun SQL. Finish exits the guide, without deleting bookings." },
];

function clearGuideTarget() {
  guideTarget?.classList.remove("guide-target");
  guideTarget?.removeAttribute("aria-describedby");
  guideTarget = null;
}

function updateGuideHeight() {
  document.body.style.setProperty("--guide-height", guide.hidden || dialog.open ? "0px" : `${guide.offsetHeight}px`);
}

function renderGuide() {
  clearGuideTarget();
  const step = guideSteps[guideStep];
  if (!dialog.open && debugPanel.hidden) setDebug(true, false);
  if (dialog.open) dialog.prepend(guide);
  else dialog.before(guide);
  guide.hidden = false;
  get("guide-progress").textContent = `LIVE DEMO · ${guideStep + 1} / ${guideSteps.length}`;
  get("guide-title").textContent = step.title;
  get("guide-instruction").textContent = step.instruction;
  get("activity-instruction").textContent = `Step ${guideStep + 1}: ${step.instruction}`;
  get("guide-back").disabled = guideStep === 0;
  get("guide-next").textContent = guideStep === guideSteps.length - 1 ? "Finish" : "Next";
  guideTarget = dialog.open
    ? (step.id === "receipt" ? get("booking-close") : get("booking-form"))
    : document.querySelector(step.target);
  if (guideTarget === debugToggle && !debugPanel.hidden) {
    guideTarget = get("debug-close");
    get("guide-instruction").textContent = "Debug is already open. Inspect the live SQL sidebar, then choose Next. Use its Close button whenever you want to hide it.";
  }
  if (guideTarget?.closest("dialog") && !dialog.open) guideTarget = null;
  if (!guideTarget) {
    get("guide-instruction").textContent += " Open an available campsite's booking form to continue this part, or use Next to skip without writing data.";
    guideTarget = document.querySelector(".book-stay:not(:disabled)") ?? searchForm;
  }
  guideTarget.classList.add("guide-target");
  guideTarget.setAttribute("aria-describedby", "guide-instruction");
  updateGuideHeight();
  const scrollTarget = guideStep === 0 && !dialog.open ? get("campsite-map").closest(".map-panel") : guideTarget;
  if (dialog.open) {
    guide.scrollTop = 0;
    if (guideTarget === get("booking-form")) guideTarget.scrollTop = 0;
    else guideTarget.scrollIntoView({ block: "nearest", behavior: "instant" });
  } else {
    scrollTarget.scrollIntoView({ block: guideStep === 0 ? "start" : "center", behavior: "instant" });
  }
  get("guide-title").focus({ preventScroll: true });
}

function exitGuide() {
  clearGuideTarget();
  guideStep = null;
  guide.hidden = true;
  document.body.classList.remove("guide-open");
  document.body.style.removeProperty("--guide-height");
  get("guide-start").setAttribute("aria-expanded", "false");
  (dialog.open ? get("guest-alias") : get("guide-start")).focus({ preventScroll: true });
}

get("guide-start").addEventListener("click", () => {
  guideStep = 0;
  document.body.classList.add("guide-open");
  get("guide-start").setAttribute("aria-expanded", "true");
  renderGuide();
});
get("guide-back").addEventListener("click", () => {
  if (guideStep > 0) { guideStep--; renderGuide(); }
});
get("guide-next").addEventListener("click", () => {
  if (guideStep === guideSteps.length - 1) exitGuide();
  else { guideStep++; renderGuide(); }
});
get("guide-exit").addEventListener("click", exitGuide);
new ResizeObserver(updateGuideHeight).observe(guide);
void checkReadiness();
