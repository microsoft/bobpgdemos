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

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: "same-origin" });
  const body = await response.json();
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

async function search(params = filters()) {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const stay = { check_in: params.get("check_in"), check_out: params.get("check_out") };
  get("search-status").textContent = "Looking for your escape…";
  cards.replaceChildren();
  cards.setAttribute("aria-busy", "true");
  try {
    const data = await request(`/api/campsites?${params}`, { signal: controller.signal });
    activeSearch = new URLSearchParams(params);
    cards.replaceChildren(...data.campsites.map((site) => showSite(site, stay)));
    get("search-status").textContent = data.campsites.length
      ? `${data.campsites.length} fictional campsite(s) · ${stay.check_in} to ${stay.check_out}`
      : "No matching fictional campsites. Try a wider radius, different dates or fewer filters.";
  } catch (error) {
    if (error.name !== "AbortError") {
      get("search-status").textContent = error.message;
      activeSearch = null;
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
    if (previousSearch) void search(previousSearch);
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
