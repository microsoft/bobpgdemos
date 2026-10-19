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

function setDebug(open) {
  debugPanel.hidden = !open;
  document.body.classList.toggle("debug-open", open);
  debugToggle.setAttribute("aria-expanded", String(open));
  debugToggle.textContent = open ? "Hide debug" : "Debug";
  if (open) {
    get("debug-close").focus({ preventScroll: true });
    if (matchMedia("(max-width:1100px)").matches) debugPanel.scrollIntoView({ block: "start" });
  } else {
    debugToggle.focus({ preventScroll: true });
  }
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
get("execution-history").addEventListener("change", (event) => showExecution(Number(event.target.value)));

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
get("map-reset").addEventListener("click", resetMap);

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
    });
    popup.append(locate);
    L.circleMarker([site.latitude, site.longitude], {
      radius: 8, color: "#fff", weight: 2, fillColor: site.available ? "#14675b" : "#9e6750", fillOpacity: 1,
    }).bindPopup(popup).bindTooltip(site.name).addTo(mapMarkers);
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

async function request(url, options = {}) {
  const { recordExecution: shouldRecord = true, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, credentials: "same-origin" });
  const body = await response.json();
  if (shouldRecord && body.execution) recordExecution(body.execution, url, fetchOptions.method || "GET", response.status);
  if (!response.ok) throw new Error(body.error || "The service is unavailable. Please try again later.");
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
  button.disabled = !site.available;
  button.addEventListener("click", () => {
    selected = { campsite_id: site.campsite_id, check_in: stay.check_in, check_out: stay.check_out };
    get("booking-site").textContent = site.name;
    get("booking-dates").textContent = `${stay.check_in} → ${stay.check_out} (checkout exclusive)`;
    get("booking-status").textContent = "";
    get("guest-alias").value = "";
    get("booking-submit").disabled = false;
    dialog.showModal();
  });
  bottom.append(price, button);
  body.append(bottom);
  card.append(art, body);
  return card;
}

async function search(params = filters(), recordExecution = true) {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const stay = { check_in: params.get("check_in"), check_out: params.get("check_out") };
  get("search-status").textContent = "Looking for your escape…";
  cards.replaceChildren();
  clearMap();
  get("map-caption").textContent = "Waiting for this search's database results…";
  cards.setAttribute("aria-busy", "true");
  try {
    const data = await request(`/api/campsites?${params}`, { signal: controller.signal, recordExecution });
    activeSearch = new URLSearchParams(params);
    cards.replaceChildren(...data.campsites.map((site) => showSite(site, stay)));
    showMap(data.campsites, params);
    get("search-status").textContent = data.campsites.length
      ? `${data.campsites.length} fictional campsite(s) · ${stay.check_in} to ${stay.check_out}`
      : "No matching fictional campsites. Try a wider radius, different dates or fewer filters.";
  } catch (error) {
    if (error.name !== "AbortError") {
      get("search-status").textContent = error.message;
      activeSearch = null;
      get("map-caption").textContent = "No map results: the search failed. Correct the filters or retry.";
    }
  } finally {
    if (searchController === controller) cards.setAttribute("aria-busy", "false");
  }
}

searchForm.addEventListener("submit", (event) => { event.preventDefault(); void search(); });
get("name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  nameController?.abort();
  const controller = new AbortController();
  nameController = controller;
  get("name-status").textContent = "Comparing names…";
  get("name-matches").replaceChildren();
  try {
    const params = new URLSearchParams({ name: get("name-query").value });
    const data = await request(`/api/name-search?${params}`, { signal: controller.signal });
    get("name-matches").replaceChildren(...data.matches.map((match) =>
      node("li", `${match.name} · similarity ${Number(match.similarity).toFixed(2)}`)));
    get("name-status").textContent = data.matches.length ? "Closest name matches:" : "No similar names found.";
  } catch (error) {
    if (error.name !== "AbortError") get("name-status").textContent = error.message;
  }
});
get("booking-close").addEventListener("click", () => dialog.close());
get("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return;
  const booking = { ...selected, guest_alias: get("guest-alias").value };
  const previousSearch = activeSearch ? new URLSearchParams(activeSearch) : null;
  const button = get("booking-submit");
  button.disabled = true;
  get("booking-status").textContent = "Creating fictional booking…";
  try {
    const data = await request("/api/bookings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(booking),
    });
    get("booking-status").textContent = `Demo booking ${data.booking.reservation_id} created. This is not a real reservation.`;
    selected = null;
    if (previousSearch) void search(previousSearch, false);
  } catch (error) {
    get("booking-status").textContent = error.message;
    button.disabled = false;
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
void checkReadiness();
